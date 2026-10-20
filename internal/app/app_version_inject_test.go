package app

import (
	"os"
	"strings"
	"testing"
)

// TestAppVersionInjectionLandsInThisPackage 把「构建期 -ldflags 注入能不能打中」
// 变成可执行证据。
//
// 为什么需要这条测试：Go 链接器对不存在的 -X 目标**静默忽略**
// （`-X nope.nope.NotThere=1` 一样 exit 0、零警告）。77fa451 把 appVersion 从 package main
// 迁进本包后，release.yml 的注入路径没跟着改，v1.9.1 起所有发布产物都带着默认值 "dev"，
// 而 parseVersion("dev") 等价 0.0.0 ⇒「检查更新」永远显示有新版本、关于页显示 vdev。
// 静态守卫（tests/ux/buildVersionSymbolResolvesToGoDeclaration）钉符号路径，
// 这条测试钉注入动作本身，两者都要跑：见 scripts/verify-release-version.sh。
//
// 用法（期望值与注入值必须一致才绿）：
//
//	CONFSCOPE_EXPECT_APP_VERSION=9.9.9 \
//	  go test -ldflags "-X confscope/internal/app.appVersion=9.9.9" \
//	  -run TestAppVersionInjectionLandsInThisPackage ./internal/app/
//
// 只设期望值不带 -ldflags（就是本轮 release.yml 的错法）必须红。
func TestAppVersionInjectionLandsInThisPackage(t *testing.T) {
	want := strings.TrimSpace(os.Getenv("CONFSCOPE_EXPECT_APP_VERSION"))
	if want == "" {
		// 常规 go test 不注入，默认值必须是 dev——它同时是「未发布构建」的哨兵，
		// 前端后台更新检查靠它判断版本号可不可比（src/lib/appVersion.ts）。
		if appVersion != "dev" {
			t.Fatalf("appVersion = %q，常规构建应保持默认 dev（改默认值要同步改 src/lib/appVersion.ts 的判据）", appVersion)
		}
		return
	}
	if appVersion != want {
		t.Fatalf("appVersion = %q，期望注入值 %q：-X 的包路径与变量所在包不一致，链接器只会静默忽略", appVersion, want)
	}
	if got := NewApp().GetAppInfo().Version; got != want {
		t.Fatalf("GetAppInfo().Version = %q，期望透传注入值 %q", got, want)
	}
}
