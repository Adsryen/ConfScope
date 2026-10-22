package app

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"confscope/internal/portabledata"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// 数据根的运行形态与换根迁移（轮62 R1/R-B/R-C）。
//
// 判据全部住在 portabledata，这里只做「绑定层」该做的事：
// 取 exe 路径、开目录选择器、把 error 折成前端可原地显示的字段。

// RuntimeLayoutInfo 是设置页/关于页需要的运行形态快照。
type RuntimeLayoutInfo struct {
	Mode           string   `json:"mode"`
	DataRoot       string   `json:"dataRoot"`
	Source         string   `json:"source"`
	ExeDir         string   `json:"exeDir"`
	ExeDirWritable bool     `json:"exeDirWritable"`
	PointerPath    string   `json:"pointerPath"`
	PreviousRoot   string   `json:"previousRoot"`
	OsDataDir      string   `json:"osDataDir"`
	Notes          []string `json:"notes"`
	Error          string   `json:"error"`
}

func currentRuntimeLayout() (portabledata.RuntimeLayout, error) {
	exePath, err := os.Executable()
	if err != nil {
		return portabledata.RuntimeLayout{}, fmt.Errorf("获取程序路径失败: %w", err)
	}
	return portabledata.LayoutFor(exePath)
}

// GetRuntimeLayout 返回当前运行形态与数据根档位（只读，不创建任何目录）。
func (a *App) GetRuntimeLayout() RuntimeLayoutInfo {
	layout, err := currentRuntimeLayout()
	if err != nil {
		return RuntimeLayoutInfo{Error: err.Error(), Notes: nonNilStrings(nil)}
	}
	return RuntimeLayoutInfo{
		Mode:           string(layout.Mode),
		DataRoot:       layout.DataRoot,
		Source:         string(layout.Source),
		ExeDir:         layout.ExeDir,
		ExeDirWritable: layout.ExeDirWritable,
		PointerPath:    layout.PointerPath,
		PreviousRoot:   layout.PreviousRoot,
		OsDataDir:      layout.OsDataDir,
		Notes:          nonNilStrings(layout.Notes),
	}
}

// SelectDataRootDirectory 打开系统目录选择器，供「更改位置」使用。
func (a *App) SelectDataRootDirectory() (string, error) {
	if a.ctx == nil {
		return "", errors.New("wails runtime is not ready")
	}
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title:            "选择 ConfScope 数据目录",
		DefaultDirectory: currentDataRootForDialog(),
	})
}

// PlanDataRootMigration 预览换根影响（条目数/字节数/警告/校验失败原因），不写任何文件。
func (a *App) PlanDataRootMigration(target string) portabledata.DataRootMigrationPlan {
	plan := portabledata.PlanDataRootMigration(target)
	plan.Warnings = nonNilStrings(plan.Warnings)
	return plan
}

// MigrateDataRoot 执行换根迁移。错误折进返回值，前端原地显示中文原因。
func (a *App) MigrateDataRoot(target string) portabledata.DataRootMigrationResult {
	result, err := portabledata.MigrateDataRoot(target)
	if err != nil {
		if result.Target == "" {
			result.Target = filepath.Clean(target)
		}
		result.Error = err.Error()
	}
	result.Notes = nonNilStrings(result.Notes)
	return result
}

// CheckDataRootRollback 判断能否回退到上一个数据根（并带回两侧主数据信息供确认）。
func (a *App) CheckDataRootRollback() portabledata.DataRootRollbackStatus {
	return portabledata.CheckDataRootRollback()
}

// RollbackDataRoot 把数据根指回上一个位置；只改指针，不搬不删任何文件。
func (a *App) RollbackDataRoot() portabledata.DataRootMigrationResult {
	result, err := portabledata.RollbackDataRoot()
	if err != nil {
		result.Error = err.Error()
	}
	result.Notes = nonNilStrings(result.Notes)
	return result
}

// nonNilStrings 保证 JSON 里是 [] 而不是 null：前端直接 .map 才不会偶发崩溃。
func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func currentDataRootForDialog() string {
	layout, err := currentRuntimeLayout()
	if err != nil {
		return ""
	}
	return layout.DataRoot
}
