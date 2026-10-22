package updatecheck

// 产物选择与出路的测试。
//
// 这一组判据钉的是"谁该拿到哪个包"：过去只有 runtime.GOOS-GOARCH 一处判据，
// 结果是 linux-*-deb / linux-*-rpm 两条永远选不到，安装版和便携版拿同一个包。
// 现在按平台 + 运行形态 + 包格式三件事算，出路（handoff）跟着条目走。

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"confscope/internal/portabledata"
)

func fullManifest() Manifest {
	return Manifest{
		Version: "1.9.6",
		Platforms: map[string]PlatformAsset{
			"windows-amd64":      {DownloadURL: "https://example.com/ConfScope.exe", SHA256: "aa"},
			InstallerPlatformKey: {DownloadURL: "https://example.com/confscope-windows-amd64-installer.exe", SHA256: "bb"},
			"linux-amd64":        {DownloadURL: "https://example.com/confscope-linux-amd64.tar.gz", SHA256: "cc"},
			"linux-amd64-deb":    {DownloadURL: "https://example.com/confscope_1.9.6_amd64.deb", SHA256: "dd"},
			"linux-amd64-rpm":    {DownloadURL: "https://example.com/confscope-1.9.6.x86_64.rpm", SHA256: "ee"},
			"darwin-amd64":       {DownloadURL: "https://example.com/confscope-darwin-amd64.dmg", SHA256: "ff"},
			"darwin-arm64":       {DownloadURL: "https://example.com/confscope-darwin-arm64.dmg", SHA256: "gg"},
		},
	}
}

func assertPicked(t *testing.T, res SelectionResult, key string, handoff Handoff, downgraded bool) {
	t.Helper()
	if !res.Resolved {
		t.Fatalf("Resolved = false, reason = %q", res.Reason)
	}
	if res.PlatformKey != key {
		t.Fatalf("PlatformKey = %q, want %q", res.PlatformKey, key)
	}
	if res.Handoff != handoff {
		t.Fatalf("Handoff = %q, want %q", res.Handoff, handoff)
	}
	if res.Downgraded != downgraded {
		t.Fatalf("Downgraded = %v, want %v (reason=%q)", res.Downgraded, downgraded, res.Reason)
	}
	if strings.TrimSpace(res.Asset.DownloadURL) == "" {
		t.Fatal("Asset.DownloadURL 为空")
	}
}

func TestSelectAssetByPlatformAndRuntimeShape(t *testing.T) {
	cases := []struct {
		name       string
		selection  Selection
		wantKey    string
		wantAction Handoff
	}{
		{
			name:       "windows 安装版拿安装包",
			selection:  Selection{Platform: "windows-amd64", Mode: portabledata.RuntimeModeInstalled},
			wantKey:    InstallerPlatformKey,
			wantAction: HandoffInstaller,
		},
		{
			// 便携版拿安装包 = 逼用户多跑一次安装程序，而他只需要覆盖一个 exe
			name:       "windows 便携版仍是裸 exe",
			selection:  Selection{Platform: "windows-amd64", Mode: portabledata.RuntimeModePortable},
			wantKey:    "windows-amd64",
			wantAction: HandoffReveal,
		},
		{
			name:       "windows 形态未知按便携处理",
			selection:  Selection{Platform: "windows-amd64"},
			wantKey:    "windows-amd64",
			wantAction: HandoffReveal,
		},
		{
			name:       "linux deb 装的下 deb",
			selection:  Selection{Platform: "linux-amd64", Mode: portabledata.RuntimeModeInstalled, PackageFormat: "deb"},
			wantKey:    "linux-amd64-deb",
			wantAction: HandoffCommand,
		},
		{
			name:       "linux rpm 装的下 rpm",
			selection:  Selection{Platform: "linux-amd64", Mode: portabledata.RuntimeModeInstalled, PackageFormat: "rpm"},
			wantKey:    "linux-amd64-rpm",
			wantAction: HandoffCommand,
		},
		{
			name:       "linux 包格式未知退回 tar.gz",
			selection:  Selection{Platform: "linux-amd64", Mode: portabledata.RuntimeModeInstalled},
			wantKey:    "linux-amd64",
			wantAction: HandoffReveal,
		},
		{
			name:       "mac 拿镜像",
			selection:  Selection{Platform: "darwin-arm64", Mode: portabledata.RuntimeModeInstalled},
			wantKey:    "darwin-arm64",
			wantAction: HandoffImage,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			assertPicked(t, SelectAsset(fullManifest(), tc.selection), tc.wantKey, tc.wantAction, false)
		})
	}
}

func TestSelectAssetDowngradesWhenPreferredEntryMissing(t *testing.T) {
	m := fullManifest()
	delete(m.Platforms, InstallerPlatformKey)

	res := SelectAsset(m, Selection{Platform: "windows-amd64", Mode: portabledata.RuntimeModeInstalled})
	assertPicked(t, res, "windows-amd64", HandoffReveal, true)
	if !strings.Contains(res.Reason, InstallerPlatformKey) {
		t.Fatalf("Reason = %q, 应说明哪个首选条目缺失", res.Reason)
	}

	m2 := fullManifest()
	delete(m2.Platforms, "linux-amd64-deb")
	res2 := SelectAsset(m2, Selection{Platform: "linux-amd64", PackageFormat: "deb"})
	assertPicked(t, res2, "linux-amd64", HandoffReveal, true)
}

func TestSelectAssetFallsBackToLegacySingleDownloadURL(t *testing.T) {
	// 旧 tag 的 update.json 只有顶层 downloadUrl，新客户端不许崩，也不许报"没有更新"
	m := Manifest{Version: "1.9.0", DownloadURL: "https://example.com/ConfScope.exe", SHA256: "old"}
	res := SelectAsset(m, Selection{Platform: "windows-amd64", Mode: portabledata.RuntimeModeInstalled})
	assertPicked(t, res, "legacy", HandoffReveal, true)
	if res.Asset.FileName != "ConfScope.exe" {
		t.Fatalf("FileName = %q", res.Asset.FileName)
	}
}

func TestSelectAssetWithoutAnyUsableAssetGivesPageHandoff(t *testing.T) {
	res := SelectAsset(Manifest{Version: "1.9.6"}, Selection{Platform: "linux-arm64"})
	if res.Resolved {
		t.Fatal("Resolved = true，什么条目都没有时不该成立")
	}
	if res.Handoff != HandoffPage {
		t.Fatalf("Handoff = %q, want %q", res.Handoff, HandoffPage)
	}
	if res.Reason != "no-asset-for-platform" {
		t.Fatalf("Reason = %q", res.Reason)
	}
}

func TestNormalizeAssetFillsReadableFileName(t *testing.T) {
	m := Manifest{Platforms: map[string]PlatformAsset{
		"linux-amd64-deb": {DownloadURL: "https://example.com/confscope_1.9.6_amd64.deb"},
	}}
	res := SelectAsset(m, Selection{Platform: "linux-amd64", PackageFormat: "deb"})
	if res.Asset.FileName != "confscope_1.9.6_amd64.deb" {
		t.Fatalf("FileName = %q，应能从 URL 补出来", res.Asset.FileName)
	}

	// 补不出名字时也要有个可读的兜底，界面不能显示空白
	if got := defaultFileName(InstallerPlatformKey); got != "confscope-windows-amd64-installer.exe" {
		t.Fatalf("defaultFileName(installer) = %q", got)
	}
	if got := defaultFileName("windows-amd64"); got != "ConfScope.exe" {
		t.Fatalf("defaultFileName(windows) = %q", got)
	}
	if got := defaultFileName("linux-arm64"); got != "confscope-linux-arm64" {
		t.Fatalf("defaultFileName(其他) = %q", got)
	}
}

func TestCheckCarriesRuntimeShapeIntoSelection(t *testing.T) {
	// 这一条钉的是接线：Check 必须把 Mode/PackageFormat 带进产物选择。
	// 清单按"当前平台的候选键"生成，任何 GOOS/GOARCH 上跑结论都一样。
	installed := Selection{Platform: CurrentPlatform(), Mode: portabledata.RuntimeModeInstalled, PackageFormat: "deb"}
	keys := installed.CandidateKeys()
	if len(keys) == 0 {
		t.Fatal("候选键为空，选择逻辑失效")
	}

	var sb strings.Builder
	sb.WriteString(`{"version":"1.9.6","platforms":{`)
	for i, key := range keys {
		if i > 0 {
			sb.WriteString(",")
		}
		sb.WriteString(`"` + key + `":{"downloadUrl":"https://example.com/` + key + `.bin","sha256":"sha-` + key + `","fileName":"` + key + `.bin"}`)
	}
	sb.WriteString("}}")

	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(sb.String()))
	}))

	res := Check(context.Background(), Request{
		CurrentVersion: "1.9.5",
		Sources:        []Source{{Name: "official", URL: server.URL + "/update.json"}},
		Mode:           portabledata.RuntimeModeInstalled,
		PackageFormat:  "deb",
	})
	if res.Error != "" {
		t.Fatalf("Error = %q", res.Error)
	}
	if !res.HasUpdate {
		t.Fatal("HasUpdate = false")
	}
	if res.PlatformKey != keys[0] {
		t.Fatalf("PlatformKey = %q, want 首选 %q", res.PlatformKey, keys[0])
	}
	if res.Handoff != string(handoffFor(installed, keys[0])) {
		t.Fatalf("Handoff = %q, want %q", res.Handoff, handoffFor(installed, keys[0]))
	}
	if res.FileName != keys[0]+".bin" || res.SHA256 != "sha-"+keys[0] {
		t.Fatalf("FileName/SHA256 = %q/%q", res.FileName, res.SHA256)
	}
	if res.Downgraded {
		t.Fatal("首选条目存在时不该标记降级")
	}
	portable := Check(context.Background(), Request{
		CurrentVersion: "1.9.5",
		Sources:        []Source{{Name: "official", URL: server.URL + "/update.json"}},
		Mode:           portabledata.RuntimeModePortable,
	})
	wantKeys := Selection{Platform: CurrentPlatform(), Mode: portabledata.RuntimeModePortable}.CandidateKeys()
	if portable.PlatformKey != wantKeys[0] {
		t.Fatalf("便携形态选了 %q，应为 %q", portable.PlatformKey, wantKeys[0])
	}
}

func TestCheckAggregatesSourceFailureWhenNoAssetMatchesRuntimeShape(t *testing.T) {
	// 清单里既没有本机平台条目、也没有旧的单一 downloadUrl：
	// 结论必须是"没有适用于当前运行形态的产物"，而不是静默"已是最新"。
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"version":"1.9.6","platforms":{"solaris-sparc":{"downloadUrl":"https://example.com/a.tar.gz","sha256":"x"}}}`))
	}))
	res := Check(context.Background(), Request{
		CurrentVersion: "1.9.5",
		Sources:        []Source{{Name: "official", URL: server.URL + "/update.json"}},
	})
	if res.HasUpdate {
		t.Fatal("没有可用产物时不该报有更新")
	}
	if !strings.Contains(res.Error, "没有适用于当前运行形态的更新产物") {
		t.Fatalf("Error = %q", res.Error)
	}
}

func TestDetectPackageFormatUsesInjectedFacts(t *testing.T) {
	cases := []struct {
		name    string
		exe     string
		exists  map[string]bool
		queryOK bool
		want    string
	}{
		{
			name:   "dpkg 清单在就是 deb",
			exe:    "/usr/bin/confscope",
			exists: map[string]bool{"/var/lib/dpkg/info/confscope.list": true},
			want:   "deb",
		},
		{
			name:    "rpm 查得到就是 rpm",
			exe:     "/opt/ConfScope/confscope",
			queryOK: true,
			want:    "rpm",
		},
		{
			name:   "rpm 命令没了但 rpm 库还在，按 rpm 给命令",
			exe:    "/usr/local/bin/confscope",
			exists: map[string]bool{"/usr/lib/sysimage/rpm/Packages": true},
			want:   "rpm",
		},
		{
			// 用户自己解压到 ~/apps 的裸产物：给 apt/dnf 命令就是错的
			name:   "不在系统目录就不认包格式",
			exe:    "/home/ryen/apps/confscope/confscope",
			exists: map[string]bool{"/var/lib/dpkg/info/confscope.list": true},
			want:   "",
		},
		{
			name: "系统目录但没有任何包管理器痕迹",
			exe:  "/usr/bin/confscope",
			want: "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := detectPackageFormat(tc.exe, func(path string) bool { return tc.exists[path] }, func(string) bool { return tc.queryOK })
			if got != tc.want {
				t.Fatalf("detectPackageFormat(%q) = %q, want %q", tc.exe, got, tc.want)
			}
		})
	}
}

func TestInstallCommandForOnlyCoversPackageFormats(t *testing.T) {
	cases := []struct {
		path   string
		format string
		want   string
	}{
		{"/tmp/confscope-update-1234.deb", "deb", `sudo apt install "/tmp/confscope-update-1234.deb"`},
		{"/tmp/confscope-update-1234.rpm", "rpm", `sudo rpm -Uvh "/tmp/confscope-update-1234.rpm"`},
		// 包格式没探到时按后缀兜底，至少要给出能对上的命令
		{"/tmp/confscope-update-1234.deb", "", `sudo apt install "/tmp/confscope-update-1234.deb"`},
		{"/tmp/confscope-update-1234.tar.gz", "", ""},
		{"", "deb", ""},
	}
	for _, tc := range cases {
		got := InstallCommandFor(tc.path, tc.format)
		if got != tc.want {
			t.Fatalf("InstallCommandFor(%q,%q) = %q, want %q", tc.path, tc.format, got, tc.want)
		}
	}
}

func TestDownloadRefusesArtifactWithoutChecksum(t *testing.T) {
	hits := 0
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		_, _ = w.Write([]byte("payload"))
	}))

	var progress []DownloadProgress
	_, err := Download(context.Background(), server.URL+"/installer.exe", "  ", ProxyConfig{}, func(p DownloadProgress) {
		progress = append(progress, p)
	})
	if err == nil {
		t.Fatal("缺少 sha256 时下载必须失败")
	}
	if !strings.Contains(err.Error(), "校验值") {
		t.Fatalf("err = %q，应说明缺校验值", err.Error())
	}
	if hits != 0 {
		t.Fatalf("请求了 %d 次：fail closed 必须发生在发起请求之前", hits)
	}
	if len(progress) != 0 {
		t.Fatalf("不该报告任何进度：%+v", progress)
	}
}

func TestDownloadReportsDoneOnlyWhenChecksumMatches(t *testing.T) {
	payload := []byte("confscope installer bytes")
	sum := sha256.Sum256(payload)
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(payload)
	}))

	var last DownloadProgress
	badPath, badErr := Download(context.Background(), server.URL+"/pkg.deb", strings.Repeat("0", 64), ProxyConfig{}, func(p DownloadProgress) {
		last = p
	})
	if badErr == nil {
		t.Fatal("校验值不匹配必须失败")
	}
	if last.Done {
		t.Fatal("校验失败却报了 Done：UI 会据此去起安装程序")
	}
	if last.Error == "" {
		t.Fatal("校验失败必须带 error 文案")
	}
	if _, err := os.Stat(badPath); err == nil {
		t.Fatalf("校验失败的临时文件没被清理：%s", badPath)
	}

	goodPath, err := Download(context.Background(), server.URL+"/pkg.deb", hex.EncodeToString(sum[:]), ProxyConfig{}, func(p DownloadProgress) {
		last = p
	})
	if err != nil {
		t.Fatalf("Download: %v", err)
	}
	if !last.Done || last.Error != "" {
		t.Fatalf("进度终态 = %+v", last)
	}
	if filepath.Ext(goodPath) != ".deb" {
		t.Fatalf("临时文件应保留原后缀，得到 %q", goodPath)
	}
	_ = os.Remove(goodPath)
}

func TestHandoffHelpersRejectEmptyAndForeignPlatform(t *testing.T) {
	if err := LaunchUpdateInstaller("   "); err == nil {
		t.Fatal("空路径必须报错")
	}
	if err := RevealDownloadedArtifact(""); err == nil {
		t.Fatal("空路径必须报错")
	}
	if err := AttachUpdateImage("/tmp/not-exist.dmg"); err == nil {
		t.Fatal("mac 以外平台/不存在的镜像都必须报错")
	}
}

func TestSelfReplacingInstallerHelpersAreGone(t *testing.T) {
	// 永久定调：程序不写 bat/sh 去覆盖自己的二进制。
	// 这条判据不是风格问题——它把一个用户看不见的进程当成了升级的责任方。
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	scanned := 0
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		code := goCodeOnly(t, name)
		scanned++
		for _, banned := range []string{"InstallAndRestart", "extractTarGz", "installWindows", "installLinux", "taskkill", ".old"} {
			if strings.Contains(code, banned) {
				t.Fatalf("%s 里仍有 %s：自替换安装路径必须整体删除", name, banned)
			}
		}
	}
	if scanned < 3 {
		t.Fatalf("只扫到 %d 个源文件，守卫口径失效", scanned)
	}
}

// goCodeOnly 返回去掉注释后的代码文本（token 拼接）。
// 直接用整份文件会把"这里以前叫 InstallAndRestart，已删除"这类说明当成违规。
func goCodeOnly(t *testing.T, name string) string {
	t.Helper()
	src, err := os.ReadFile(name)
	if err != nil {
		t.Fatalf("ReadFile %s: %v", name, err)
	}
	// 不解析注释（无 parser.ParseComments），说明性文字不会被判成违规；
	// 标识符和字符串字面量都收进来，删除的函数若被重新调用照样抓到。
	file, err := parser.ParseFile(token.NewFileSet(), name, src, 0)
	if err != nil {
		t.Fatalf("ParseFile %s: %v", name, err)
	}
	var parts []string
	ast.Inspect(file, func(n ast.Node) bool {
		switch v := n.(type) {
		case *ast.Ident:
			parts = append(parts, v.Name)
		case *ast.BasicLit:
			parts = append(parts, v.Value)
		}
		return true
	})
	return strings.Join(parts, " ")
}
