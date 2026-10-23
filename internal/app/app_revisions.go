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
// 摘要口径、超限裁剪、保留策略、判重全在 internal/revisions，避免绑定层长业务（backend 规约）。
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

// PruneConfigRevisions 按保留策略压缩这份日志，返回删掉的条数。
func (a *App) PruneConfigRevisions(keepPerKey int) (int, error) {
	dir, err := revisionsDataDir()
	if err != nil {
		return 0, err
	}
	return a.revisionsStore().Prune(dir, keepPerKey)
}

// ClearConfigRevisions 清除本机版本历史。
//
// 这是用户数据，走设置页独立入口，绝不与开发者「清理缓存」混为一谈（R11）：
// 清理缓存只清缓存并从主数据文件重新水合，不碰任何数据文件。
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
