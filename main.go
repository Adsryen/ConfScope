package main

import (
	"embed"

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
