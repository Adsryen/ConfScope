package app

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"confscope/internal/portabledata"
	"confscope/internal/revisions"
)

// 本机配置版本历史（config-revisions.jsonl）的 Wails 绑定层。
//
// 这一层只做三件事：解析数据目录、补 appVersion、把错误如实回传。
// 摘要口径、超限裁剪、判重、配额钳制与钉住命中全在 internal/revisions，避免绑定层长业务（backend 规约）。
//
// 目录跟着主数据文件走（<数据根>/app-data/），换根迁移按整目录递归搬运，
// 这份日志因此自动随迁，不需要在迁移清单里另立一条。

// revisionsStore 挂在 App 实例上：包级可变全局是 backend 规约明令禁止的。
// 它是加速器不是判据——进程重启后索引丢了，最坏只是多一条重复，绝不会漏一版。
func (a *App) revisionsStore() *revisions.Store {
	a.revisionsOnce.Do(func() {
		a.revisions = revisions.NewStore()
	})
	return a.revisions
}

// revisionsDataDir 解析版本历史所在目录 = <当前数据根>/app-data。
func revisionsDataDir() (string, error) {
	exePath, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("get executable path: %w", err)
	}
	root := portabledata.DataRootFor(exePath)
	if root == "" {
		return "", errors.New("config revisions data dir unavailable")
	}
	return filepath.Join(root, portabledata.AppDataDirName), nil
}

// AppendConfigRevision 记一版：读到正文且与本机最后一版不同（observed），或写后回读确认（confirmed-write）。
//
// 返回值里的 appended=false + reason="duplicate" 是常态（批量刷新同一版），不是错误。
func (a *App) AppendConfigRevision(input revisions.Input) (revisions.AppendResult, error) {
	dir, err := revisionsDataDir()
	if err != nil {
		return revisions.AppendResult{}, err
	}
	if input.AppVersion == "" {
		input.AppVersion = appVersion
	}
	return a.revisionsStore().Append(dir, input)
}

// ReadConfigRevisions 读取最近 limit 条（跨键混排，最新在前；limit<=0 取默认上限）。
//
// 错误必须回传（轮67 R57-WP15）：目录解析不出来、日志文件打不开、扫描中断，
// 以前一律回 nil ⇒ 前端拿到空数组 ⇒ 界面说「本机还没记过这一版」。那是假话，
// 而且正好在数据可能出问题的时候说。文件不存在不算失败（那是真的还没记过）。
func (a *App) ReadConfigRevisions(limit int) ([]revisions.Record, error) {
	dir, err := revisionsDataDir()
	if err != nil {
		return nil, err
	}
	records, err := a.revisionsStore().Read(dir, limit)
	if err != nil {
		return nil, err
	}
	if records == nil {
		return []revisions.Record{}, nil
	}
	return records, nil
}

// ReadConfigRevisionsForKey 读取某个配置键的本机版本历史（最新在前）。
//
// 与 ReadConfigRevisions 同一口径：读不出来就报错，绝不回空数组冒充「这个配置没历史」。
func (a *App) ReadConfigRevisionsForKey(connectionID, namespace, group, dataID string, limit int) ([]revisions.Record, error) {
	dir, err := revisionsDataDir()
	if err != nil {
		return nil, err
	}
	records, err := a.revisionsStore().ReadKey(dir, connectionID, namespace, group, dataID, limit)
	if err != nil {
		return nil, err
	}
	if records == nil {
		return []revisions.Record{}, nil
	}
	return records, nil
}

// PruneConfigRevisions 按**磁盘上生效的保留策略**压缩这份日志，返回删掉的条数。
//
// 不收 keepPerKey：配额的钳制点必须只有一个（internal/revisions 的 clampKeepPerKey），
// 绑定层再收一个数就等于开一条「绕过策略直接删用户数据」的路。
// 界面改配额的正当路径是先 SaveConfigRevisionPolicy 落盘、再按需要调这一颗清理。
func (a *App) PruneConfigRevisions() (int, error) {
	dir, err := revisionsDataDir()
	if err != nil {
		return 0, err
	}
	return a.revisionsStore().Prune(dir)
}

// GetConfigRevisionPolicy 给出当前生效的保留策略：配额、来源档、合法区间与钉住清单。
//
// 区间与默认值由这里回给界面，前端不再自己抄一份常量——抄一次就多一个判据源，
// 下一轮改动就是「界面说合法而落盘又钳了一道」。
func (a *App) GetConfigRevisionPolicy() (revisions.PolicyView, error) {
	dir, err := revisionsDataDir()
	if err != nil {
		return revisions.PolicyView{}, err
	}
	return a.revisionsStore().Policy(dir), nil
}

// SaveConfigRevisionPolicy 保存「每个配置保留多少版」。越界先钳到合法区间再落盘，
// 返回的是磁盘上回读到的生效值——界面必须念实际存下的那个数，不能念用户刚敲的那个。
//
// 存盘不顺手删任何历史：调小配额只改变下一次裁剪的落点，删除动作要么由用户按
// 「按新上限清理」，要么等到自动裁剪触发。误删不该是一个输入框的副作用。
func (a *App) SaveConfigRevisionPolicy(keepPerKey int) (revisions.PolicyView, error) {
	dir, err := revisionsDataDir()
	if err != nil {
		return revisions.PolicyView{}, err
	}
	return a.revisionsStore().SetPolicyKeepPerKey(dir, keepPerKey)
}

// SetConfigRevisionPinned 钉住/取消钉住某一版本机正文（身份 = 配置键 + 正文摘要）。
//
// 钉住的版本不参与裁剪、不受配额影响。钉不住（本机已没有这一版正文）不报错，
// 返回 hits=0 让界面如实说明原因。
func (a *App) SetConfigRevisionPinned(connectionID, namespace, group, dataID, hash string, pinned bool) (revisions.PinResult, error) {
	dir, err := revisionsDataDir()
	if err != nil {
		return revisions.PinResult{}, err
	}
	return a.revisionsStore().SetPinned(dir, revisions.PinnedRef{
		ConnectionID: connectionID,
		Namespace:    namespace,
		Group:        group,
		DataID:       dataID,
		Hash:         hash,
	}, pinned)
}

// ClearConfigRevisions 清除本机版本历史，连钉住清单一起清（配额保留）。
//
// 这是用户数据，走设置页独立入口，绝不与开发者「清理缓存」混为一谈（R11）：
// 清理缓存只清缓存并从主数据文件重新水合，不碰任何数据文件。
// 正文都没了之后，钉住清单里那些标记没有落点，留着只会让界面亮一排「已钉住」而点不到东西。
func (a *App) ClearConfigRevisions() error {
	dir, err := revisionsDataDir()
	if err != nil {
		return err
	}
	return a.revisionsStore().Clear(dir)
}

// GetConfigRevisionFacts 给出这份日志的体量事实（设置页如实展示用）。
func (a *App) GetConfigRevisionFacts() revisions.Facts {
	dir, err := revisionsDataDir()
	if err != nil {
		return revisions.Facts{}
	}
	return a.revisionsStore().GetFacts(dir)
}
