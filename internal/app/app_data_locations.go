package app

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"confscope/internal/audit"
	"confscope/internal/portabledata"
	"confscope/internal/revisions"
)

// 数据位置 key（白名单，与设置页展示条目一一对应）。
// OpenDataFolder 只接受这些 key，路径全部由 Go 侧按既有规则解析，不接受任意路径。
const (
	dataLocKeyDataRoot       = "dataRoot"
	dataLocKeyAppDataFile    = "appDataFile"
	dataLocKeyWebview        = "webview"
	dataLocKeySnapshots      = "snapshots"
	dataLocKeyRecoveryPoints = "recoveryPoints"
	dataLocKeyAudit          = "audit"
	dataLocKeyLogs           = "logs"
	// dataLocKeyRevisions 是轮57 的本机配置版本历史（只追加日志）。它与主数据文件同住
	// app-data，靠换根迁移整目录搬运，不需要在迁移清单里另立一条——但设置页必须看得见它，
	// 里面装的是配置正文（常含密钥），用户有权知道它在哪、有多大、怎么清掉。
	dataLocKeyRevisions = "revisions"
)

// DataLocationEntry 是设置页展示的一条数据位置。
type DataLocationEntry struct {
	Key    string `json:"key"`
	Path   string `json:"path"`
	IsFile bool   `json:"isFile"`
	Exists bool   `json:"exists"`
}

// DataLocations 是本机数据位置清单（路径解析与展示语义均由 Go 侧负责）。
//
// mode/source/notes 是轮62 附加字段：老前端只读 entries/dataRoot，多出来不影响；
// 新前端据此告诉用户「现在是便携还是安装形态、数据根命中哪一档」。
type DataLocations struct {
	DataRoot string              `json:"dataRoot"`
	Entries  []DataLocationEntry `json:"entries"`
	Mode     string              `json:"mode"`
	Source   string              `json:"source"`
	Notes    []string            `json:"notes"`
}

func dataLocationEntry(key, path string, isFile bool) DataLocationEntry {
	_, err := os.Stat(path)
	return DataLocationEntry{Key: key, Path: path, IsFile: isFile, Exists: err == nil}
}

// GetDataLocations 返回本机各数据位置（只读，不创建任何目录/文件）。
func (a *App) GetDataLocations() DataLocations {
	root, err := a.appDataRoot()
	if err != nil {
		return DataLocations{}
	}
	layout := a.GetRuntimeLayout()
	auditDir := auditDataDir()
	entries := []DataLocationEntry{
		dataLocationEntry(dataLocKeyDataRoot, root, false),
		dataLocationEntry(dataLocKeyAppDataFile, appDataDocPath(root), true),
		dataLocationEntry(dataLocKeyRevisions, filepath.Join(root, portabledata.AppDataDirName, revisions.TrailFileName), true),
		dataLocationEntry(dataLocKeyWebview, filepath.Join(root, portabledata.WebviewDirName), false),
		dataLocationEntry(dataLocKeySnapshots, filepath.Join(root, portabledata.SnapshotDirName), false),
		dataLocationEntry(dataLocKeyRecoveryPoints, filepath.Join(root, portabledata.AppDataRecoveryPointDirName), false),
	}
	if auditDir != "" {
		entries = append(entries, dataLocationEntry(dataLocKeyAudit, filepath.Join(auditDir, audit.TrailFileName), true))
	}
	// 换根判据的自证据：data-root.log 在解析出根之后才出现，未创建时按「不存在」展示。
	if root != "" {
		entries = append(entries, dataLocationEntry(dataLocKeyLogs, filepath.Join(root, portabledata.LogsDirName), false))
	}
	return DataLocations{
		DataRoot: root,
		Entries:  entries,
		Mode:     layout.Mode,
		Source:   layout.Source,
		Notes:    nonNilStrings(layout.Notes),
	}
}

// OpenDataFolder 在系统文件管理器中打开指定数据位置（目录直接打开，文件在目录中定位）。
// 出于安全只接受白名单 key；目标不存在时返回错误。
func (a *App) OpenDataFolder(key string) error {
	locs := a.GetDataLocations()
	var entry *DataLocationEntry
	for i := range locs.Entries {
		if locs.Entries[i].Key == key {
			entry = &locs.Entries[i]
			break
		}
	}
	if entry == nil {
		return fmt.Errorf("unknown data location key: %s", key)
	}
	if !entry.Exists {
		return fmt.Errorf("data location not found: %s", entry.Path)
	}
	switch runtime.GOOS {
	case "windows":
		if entry.IsFile {
			return openDesktopApp("explorer", "/select,"+entry.Path)
		}
		return openDesktopApp("explorer", entry.Path)
	case "darwin":
		if entry.IsFile {
			return openDesktopApp("open", "-R", entry.Path)
		}
		return openDesktopApp("open", entry.Path)
	default:
		return openDesktopApp("xdg-open", entry.Path)
	}
}

// openDesktopApp 启动文件管理器进程。不等待进程结束
// （explorer / xdg-open 可能常驻），退出结果忽略。
func openDesktopApp(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("cannot open file manager: %w", err)
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
