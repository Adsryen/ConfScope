package updatecheck

// arm64 发布档的判据。
//
// 验收线是一句话：绝不让 arm64 客户端拿到 amd64 资产。钉住三种失效形态：
// 1. 候选键本身跨架构——windows-arm64 安装版若把 windows-amd64-installer 键排进候选，
//    而清单里这个条目恒存在，客户端就会静默下载 x86 安装程序（修复前正是这条路径）；
// 2. 选择结果的资产名带错架构标识——界面显示错、人工核对错；
// 3. 旧 tag 的清单没有 arm64 条目时，不许回退到同系统的 amd64 条目，只能给「打开下载页」。
// 清单用固定夹具，选择用 Selection{Platform: ...} 显式构造，不依赖本机的
// GOOS/GOARCH——CI 机器是什么架构，结论都一样。

import (
	"fmt"
	"strings"
	"testing"

	"confscope/internal/portabledata"
)

// fullManifestAllPlatforms 是「所有已发布条目齐全」的清单。
// 条目从 publishedAssetNames 生成：fileName 与 release.yml 同源的那张表保持单一事实源，
// 表扩键时这里的夹具自动跟着扩，不会漏一条。
func fullManifestAllPlatforms() Manifest {
	platforms := make(map[string]PlatformAsset, len(publishedAssetNames))
	i := 0
	for key, name := range publishedAssetNames {
		i++
		platforms[key] = PlatformAsset{
			DownloadURL: "https://example.com/" + name,
			SHA256:      fmt.Sprintf("sha%d", i),
			FileName:    name,
		}
	}
	return Manifest{Version: "1.10.0", Platforms: platforms}
}

// 候选键层：arm64 平台给出的每一个候选键都必须派生自本平台。
func TestArm64CandidateKeysStayOnOwnArch(t *testing.T) {
	cases := []struct {
		name      string
		selection Selection
	}{
		{"windows-arm64 安装版", Selection{Platform: "windows-arm64", Mode: portabledata.RuntimeModeInstalled}},
		{"windows-arm64 便携版", Selection{Platform: "windows-arm64", Mode: portabledata.RuntimeModePortable}},
		{"linux-arm64 deb 安装", Selection{Platform: "linux-arm64", Mode: portabledata.RuntimeModeInstalled, PackageFormat: "deb"}},
		{"linux-arm64 rpm 安装", Selection{Platform: "linux-arm64", Mode: portabledata.RuntimeModeInstalled, PackageFormat: "rpm"}},
		{"linux-arm64 形态未知", Selection{Platform: "linux-arm64"}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			keys := tc.selection.CandidateKeys()
			if len(keys) == 0 {
				t.Fatal("候选键为空，选择逻辑失效")
			}
			for _, key := range keys {
				if !strings.HasPrefix(key, tc.selection.Platform) {
					t.Fatalf("候选键 %q 没有派生自平台 %q：arm64 客户端会因此选到 amd64 资产", key, tc.selection.Platform)
				}
			}
		})
	}
}

// 选择结果层：全条目清单下，arm64 客户端拿到的必须是 arm64 资产，且就是首选条目。
func TestArm64SelectionResolvesArm64Asset(t *testing.T) {
	m := fullManifestAllPlatforms()
	cases := []struct {
		name      string
		selection Selection
		wantKey   string
		wantHand  Handoff
	}{
		{"windows-arm64 便携版", Selection{Platform: "windows-arm64", Mode: portabledata.RuntimeModePortable}, "windows-arm64", HandoffReveal},
		{"windows-arm64 安装版", Selection{Platform: "windows-arm64", Mode: portabledata.RuntimeModeInstalled}, "windows-arm64", HandoffReveal},
		{"linux-arm64 deb", Selection{Platform: "linux-arm64", Mode: portabledata.RuntimeModeInstalled, PackageFormat: "deb"}, "linux-arm64-deb", HandoffCommand},
		{"linux-arm64 rpm", Selection{Platform: "linux-arm64", Mode: portabledata.RuntimeModeInstalled, PackageFormat: "rpm"}, "linux-arm64-rpm", HandoffCommand},
		{"linux-arm64 退回 tar.gz", Selection{Platform: "linux-arm64"}, "linux-arm64", HandoffReveal},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := SelectAsset(m, tc.selection)
			assertPicked(t, res, tc.wantKey, tc.wantHand, false)
			if strings.Contains(res.Asset.FileName, "amd64") {
				t.Fatalf("arm64 客户端的资产名是 %q：带 amd64 标识，发错架构了", res.Asset.FileName)
			}
			if !strings.Contains(res.Asset.FileName, "arm64") {
				t.Fatalf("arm64 客户端的资产名是 %q：没带 arm64 标识", res.Asset.FileName)
			}
			if got := tc.selection.ExpectedAssetName(); got != res.Asset.FileName {
				t.Fatalf("ExpectedAssetName = %q，与选择结果 %q 不一致", got, res.Asset.FileName)
			}
		})
	}
}

// 回归钉：windows-arm64 安装版的候选里不得出现 amd64 安装包键。
// 修复前安装版形态恒把 InstallerPlatformKey 排第一，ARM 机器于是静默拿到 x86 安装程序。
func TestWindowsArm64InstalledDoesNotPreferAmd64Installer(t *testing.T) {
	keys := Selection{Platform: "windows-arm64", Mode: portabledata.RuntimeModeInstalled}.CandidateKeys()
	for _, key := range keys {
		if key == InstallerPlatformKey {
			t.Fatalf("windows-amd64-installer 出现在 windows-arm64 安装版候选里：会把 x86 安装程序静默发给 ARM 机器")
		}
	}

	// 对照组不许回归：windows-amd64 安装版仍以安装包为首选
	got := Selection{Platform: "windows-amd64", Mode: portabledata.RuntimeModeInstalled}.CandidateKeys()
	if len(got) != 2 || got[0] != InstallerPlatformKey || got[1] != "windows-amd64" {
		t.Fatalf("windows-amd64 安装版候选 = %v，首选规则被改动了", got)
	}
}

// 旧 tag 的清单没有 arm64 条目：结论必须是「去下载页」，
// 不许回退到同系统的 amd64 条目——那是把旧版本发错架构。
func TestArm64OnLegacyManifestGoesToPage(t *testing.T) {
	legacy := fullManifest() // 7 条目清单，无 arm64
	for _, sel := range []Selection{
		{Platform: "windows-arm64", Mode: portabledata.RuntimeModePortable},
		{Platform: "linux-arm64", Mode: portabledata.RuntimeModeInstalled, PackageFormat: "deb"},
		{Platform: "linux-arm64"},
	} {
		res := SelectAsset(legacy, sel)
		if res.Resolved {
			t.Fatalf("%+v 命中了 %q：旧清单没有 arm64 条目时不许回退到 amd64 资产", sel, res.PlatformKey)
		}
		if res.Handoff != HandoffPage {
			t.Fatalf("Handoff = %q, want %q", res.Handoff, HandoffPage)
		}
	}
}
