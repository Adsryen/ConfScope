package updatecheck

// 轮65 WP-B：镜像源此前只作用于 update.json，不作用于产物。
//
// 用户故事是「查得到版本、下不动包」：国内网络靠 gh-proxy.com 才把清单取回来，
// 点「下载并安装」时程序仍然拿着清单里的 GitHub 原址直连。
// 口径：命中哪个源，产物就按那个源的前缀改写；官方源前缀为空即不改写；
// 不是「<前缀>+官方清单」形态的自定义源不改写；sha256 永远按清单值校验，
// 镜像换了包就必须 fail closed。

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

const officialReleaseAsset = "https://github.com/Adsryen/ConfScope/releases/download/v1.9.6/ConfScope_1.9.6_windows_x64-portable.exe"

func TestMirrorAssetURL(t *testing.T) {
	cases := []struct {
		name      string
		sourceURL string
		assetURL  string
		want      string
	}{
		{
			name:      "官方源命中：产物地址原样不动",
			sourceURL: officialManifestURL,
			assetURL:  officialReleaseAsset,
			want:      officialReleaseAsset,
		},
		{
			name:      "gh-proxy 形态命中：产物走同一个镜像前缀",
			sourceURL: "https://gh-proxy.com/" + officialManifestURL,
			assetURL:  officialReleaseAsset,
			want:      "https://gh-proxy.com/" + officialReleaseAsset,
		},
		{
			name:      "清单里的地址已经带镜像前缀：不重复叠加",
			sourceURL: "https://gh-proxy.com/" + officialManifestURL,
			assetURL:  "https://gh-proxy.com/" + officialReleaseAsset,
			want:      "https://gh-proxy.com/" + officialReleaseAsset,
		},
		{
			name:      "自建源不是「<前缀>+官方清单」形态：不改写",
			sourceURL: "https://mirror.internal.example/confscope/update.json",
			assetURL:  officialReleaseAsset,
			want:      officialReleaseAsset,
		},
		{
			name:      "产物本身不是 GitHub 地址：交给源前缀拼不出有意义的路径，原样返回",
			sourceURL: "https://gh-proxy.com/" + officialManifestURL,
			assetURL:  "https://example.com/ConfScope.exe",
			want:      "https://example.com/ConfScope.exe",
		},
		{
			name:      "空地址不处理",
			sourceURL: "https://gh-proxy.com/" + officialManifestURL,
			assetURL:  "",
			want:      "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := mirrorAssetURL(tc.sourceURL, tc.assetURL); got != tc.want {
				t.Fatalf("mirrorAssetURL = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestCheckDownloadURLFollowsMatchedMirrorSource(t *testing.T) {
	official := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "bad gateway", http.StatusBadGateway)
	}))
	platformKey := CurrentPlatform()
	manifest := fmt.Sprintf(`{
		"version":"1.9.6",
		"notes":"mirror hit",
		"platforms":{%q:{"downloadUrl":%q,"sha256":"deadbeef","fileName":"ConfScope_1.9.6_portable.exe"}}
	}`, platformKey, officialReleaseAsset)
	mirror := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(manifest))
	}))

	// 镜像源的 URL 形态就是「镜像前缀 + 官方清单地址」，产物改写沿用同一个前缀。
	mirrorSourceURL := mirror.URL + "/" + officialManifestURL
	result := Check(context.Background(), Request{
		CurrentVersion: "1.9.5",
		Sources: []Source{
			{Name: "GitHub 官方", URL: official.URL + "/" + officialManifestURL},
			{Name: "gh-proxy 国内加速", URL: mirrorSourceURL},
		},
	})

	// 测试里的"镜像"是本机 http 服务，所以 HTTPS 闸门会红——这恰好是改写生效的证据：
	// 闸门校验的是真正要下载的镜像地址，而不是清单里那条官方 https 原址。
	if result.Error != "更新下载地址必须使用 HTTPS" {
		t.Fatalf("Error = %q, result=%+v", result.Error, result)
	}
	wantDownload := mirror.URL + "/" + officialReleaseAsset
	if result.DownloadURL != wantDownload {
		t.Fatalf("DownloadURL = %q, want %q（命中镜像源却仍从官方原址下载）", result.DownloadURL, wantDownload)
	}
	if result.SHA256 != "deadbeef" {
		t.Fatalf("SHA256 = %q, want 清单原值（改写只动地址不动校验值）", result.SHA256)
	}
	if result.FileName != "ConfScope_1.9.6_portable.exe" {
		t.Fatalf("FileName = %q, want 清单里的 fileName", result.FileName)
	}
	if result.SourceName != "gh-proxy 国内加速" {
		t.Fatalf("SourceName = %q", result.SourceName)
	}
}

// 官方清单地址被镜像前缀拼过之后，产物地址必须落在同一个 host 上——
// 这条是「查得到版本、下不动包」的直接反证。
func TestDefaultMirrorSourcesProduceUsableAssetPrefix(t *testing.T) {
	asset := officialReleaseAsset
	for _, source := range DefaultSources {
		prefix := strings.TrimSuffix(source.URL, officialManifestURL)
		if prefix == "" {
			if got := mirrorAssetURL(source.URL, asset); got != asset {
				t.Fatalf("官方源不该改写产物地址: %q", got)
			}
			continue
		}
		if prefix == source.URL {
			t.Fatalf("内置源 %s 的 URL 不再是「<前缀>+官方清单」形态，改写规则失效", source.Name)
		}
		got := mirrorAssetURL(source.URL, asset)
		if !strings.HasPrefix(got, prefix) || !strings.HasSuffix(got, asset) {
			t.Fatalf("%s 改写结果不对: %q", source.Name, got)
		}
	}
}
