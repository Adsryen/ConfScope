package main

import (
	"embed"
	"os"
	"path/filepath"

	"confscope/internal/app"
	"confscope/internal/portabledata"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

// assets 嵌入 Vite 构建后的前端静态资源，Wails 打包时会随 exe 一起分发。
//
//go:embed all:dist
var assets embed.FS

// main 启动 Wails 桌面应用并绑定 Go 后端服务。
func main() {
	appInstance := app.NewApp()
	exePath := mustExePath()
	// 先把「数据落在哪个目录、命中哪一档、为什么」写进日志：
	// 用户看不到数据时第一手证据是日志，不是猜（轮62 验收 3）。
	if layout, layoutErr := portabledata.LayoutFor(exePath); layoutErr == nil {
		portabledata.LogRuntimeLayout(layout)
		// 顺手清掉安装程序让位覆盖留下的旧副本（轮100）。best-effort，且只在安装态动手，
		// 清不动也不算错：那是「旧窗口还开着」的正常形态，下次启动再试。
		portabledata.CleanParkedExecutables(layout, exePath)
	} else {
		println("Resolve runtime layout error:", layoutErr.Error())
	}
	webviewDataPath, err := portabledata.PrepareWebviewData()
	if err != nil {
		println("Prepare portable data error:", err.Error())
	}
	if _, err := portabledata.PrepareSnapshotData(); err != nil {
		println("Prepare portable snapshot data error:", err)
	}
	if _, err := portabledata.PrepareAppDataRecoveryPointData(); err != nil {
		println("Prepare portable app data recovery point error:", err)
	}

	err = wails.Run(&options.App{
		Title:     "ConfScope - 配置中心管理工具",
		Width:     1280,
		Height:    820,
		MinWidth:  960,
		MinHeight: 600,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 30, G: 30, B: 30, A: 1},
		Windows: &windows.Options{
			WebviewUserDataPath: webviewDataPath,
		},
		OnStartup:  appInstance.Startup,
		OnShutdown: appInstance.Shutdown,
		Bind: []interface{}{
			appInstance,
		},
	})
	if err != nil {
		println("Error:", err.Error())
	}
}

// mustExePath 取当前可执行文件路径；取不到时退回占位路径，
// 让解析链仍能给出「exe 同级 ConfScopeData」这一档而不是整体失败。
func mustExePath() string {
	exePath, err := os.Executable()
	if err != nil {
		println("Get executable path error:", err.Error())
		return filepath.Join(".", "ConfScope")
	}
	return exePath
}
