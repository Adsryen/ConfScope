package updatecheck

import (
	"testing"

	"confscope/internal/portabledata"
)

// 反馈信息里那行「包形态」全靠这个函数，形态判据一旦与 SelectAsset 走的路分叉，
// 用户报的就是个不存在的产品，维护者照着查会查歪。
func TestExpectedAssetNameFollowsCandidateOrder(t *testing.T) {
	cases := []struct {
		name string
		sel  Selection
		want string
	}{
		{
			name: "windows 便携版拿裸 exe，不拿安装包",
			sel:  Selection{Platform: "windows-amd64", Mode: portabledata.RuntimeModePortable},
			want: "confscope-windows-amd64-portable.exe",
		},
		{
			name: "windows 安装版拿 installer",
			sel:  Selection{Platform: "windows-amd64", Mode: portabledata.RuntimeModeInstalled},
			want: "confscope-windows-amd64-installer.exe",
		},
		{
			name: "linux deb",
			sel:  Selection{Platform: "linux-amd64", Mode: portabledata.RuntimeModeInstalled, PackageFormat: "deb"},
			want: "confscope-linux-amd64.deb",
		},
		{
			name: "linux rpm",
			sel:  Selection{Platform: "linux-amd64", Mode: portabledata.RuntimeModeInstalled, PackageFormat: "rpm"},
			want: "confscope-linux-amd64.rpm",
		},
		{
			name: "linux 无包管理器痕迹回落 tar.gz",
			sel:  Selection{Platform: "linux-amd64", Mode: portabledata.RuntimeModePortable},
			want: "confscope-linux-amd64.tar.gz",
		},
		{
			name: "darwin 只有 dmg 一种形态",
			sel:  Selection{Platform: "darwin-arm64", Mode: portabledata.RuntimeModeInstalled},
			want: "confscope-macos-arm64.dmg",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.sel.ExpectedAssetName(); got != tc.want {
				t.Fatalf("ExpectedAssetName() = %q，期望 %q", got, tc.want)
			}
		})
	}
}

// 与 SelectAsset 的键序必须一致：同一个 Selection，反馈里说的名字必须是真会下下来的那个。
func TestExpectedAssetNameMatchesSelectedAssetWhenManifestComplete(t *testing.T) {
	sel := Selection{Platform: "windows-amd64", Mode: portabledata.RuntimeModeInstalled}
	m := Manifest{Platforms: map[string]PlatformAsset{
		"windows-amd64":      {DownloadURL: "https://example/x1", FileName: defaultFileName("windows-amd64")},
		InstallerPlatformKey: {DownloadURL: "https://example/x2", FileName: defaultFileName(InstallerPlatformKey)},
	}}
	got := SelectAsset(m, sel)
	if !got.Resolved {
		t.Fatalf("SelectAsset 没解析成功：%+v", got)
	}
	if got.Asset.FileName != sel.ExpectedAssetName() {
		t.Fatalf("manifest 选中的是 %q，反馈却说 %q：两套判据已经分叉", got.Asset.FileName, sel.ExpectedAssetName())
	}
}
