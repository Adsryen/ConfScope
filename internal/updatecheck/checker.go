package updatecheck

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"confscope/internal/portabledata"
)

const officialManifestURL = "https://github.com/Adsryen/ConfScope/releases/latest/download/update.json"

// officialRepoReleasePrefix 是「本仓库 Release 产物」的公共地址前缀，
// 从官方清单地址推导，避免仓库 slug 在两处各写一遍。
var officialRepoReleasePrefix = func() string {
	index := strings.Index(officialManifestURL, "/releases/")
	if index < 0 {
		return ""
	}
	return officialManifestURL[:index+len("/releases/")]
}()

// mirrorAssetURL 按「这次是命中哪个源才拿到清单的」改写产物下载地址。
//
// 内置镜像源的形态都是 <镜像前缀> + 官方清单地址，所以前缀能直接复用到产物上。
// 改写只在三个条件都成立时发生：源是带前缀的镜像形态、产物确实指向本仓库 Release、
// 产物地址还没被拼过前缀。sha256 永远沿用清单原值——镜像要是换了包，
// 校验就会失败（fail closed），不会静默装上一个来路不明的包。
func mirrorAssetURL(sourceURL, assetURL string) string {
	if sourceURL == "" || assetURL == "" {
		return assetURL
	}
	prefix := strings.TrimSuffix(sourceURL, officialManifestURL)
	if prefix == "" || prefix == sourceURL {
		// 官方源本身（没有前缀），或不是「<前缀>+官方清单」形态的自建源。
		return assetURL
	}
	if officialRepoReleasePrefix == "" || !strings.HasPrefix(assetURL, officialRepoReleasePrefix) {
		// 指向别处的产物地址，硬拼镜像前缀只会拼出一个 404。
		return assetURL
	}
	if strings.HasPrefix(assetURL, prefix) {
		return assetURL
	}
	return prefix + assetURL
}

var DefaultSources = []Source{
	{Name: "GitHub 官方", URL: officialManifestURL},
	{Name: "gh.llkk.cc 国内加速", URL: "https://gh.llkk.cc/" + officialManifestURL},
	{Name: "gh-proxy.com 国内加速", URL: "https://gh-proxy.com/" + officialManifestURL},
	{Name: "ghfast.top 国内加速", URL: "https://ghfast.top/" + officialManifestURL},
}

type Source struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

type ProxyConfig struct {
	HTTPProxy  string `json:"httpProxy"`
	HTTPSProxy string `json:"httpsProxy"`
	NoProxy    string `json:"noProxy"`
}

type Request struct {
	CurrentVersion string      `json:"currentVersion"`
	Sources        []Source    `json:"sources"`
	Proxy          ProxyConfig `json:"proxy"`
	// Mode / PackageFormat 决定取哪个产物条目、下载完走哪条出路。
	// 两者都由 internal/app 从 portabledata 解析器与系统事实填入，前端传什么都被覆盖。
	Mode          portabledata.RuntimeMode `json:"mode"`
	PackageFormat string                   `json:"packageFormat"`
}

// PlatformAsset 描述单个平台的下载信息。
type PlatformAsset struct {
	DownloadURL string `json:"downloadUrl"`
	SHA256      string `json:"sha256"`
	FileName    string `json:"fileName"`
}

// Manifest 是 update.json 的结构。
// 兼容旧版单一下载地址格式和新版多平台格式。
type Manifest struct {
	Version     string                   `json:"version"`
	Notes       string                   `json:"notes"`
	DownloadURL string                   `json:"downloadUrl,omitempty"`
	PublishedAt string                   `json:"publishedAt"`
	SHA256      string                   `json:"sha256,omitempty"`
	Mandatory   bool                     `json:"mandatory"`
	Platforms   map[string]PlatformAsset `json:"platforms,omitempty"`
}

type Result struct {
	CurrentVersion string `json:"currentVersion"`
	LatestVersion  string `json:"latestVersion"`
	HasUpdate      bool   `json:"hasUpdate"`
	SourceName     string `json:"sourceName"`
	SourceURL      string `json:"sourceUrl"`
	DownloadURL    string `json:"downloadUrl"`
	ReleaseNotes   string `json:"releaseNotes"`
	PublishedAt    string `json:"publishedAt"`
	SHA256         string `json:"sha256"`
	Mandatory      bool   `json:"mandatory"`
	CheckedAt      string `json:"checkedAt"`
	Error          string `json:"error"`
	// 下面三个是"下载完怎么装上去"的依据：条目键、产物文件名、出路类型。
	// 前端只认 handoff 分流，不许自己按文件后缀猜形态。
	PlatformKey string `json:"platformKey"`
	FileName    string `json:"fileName"`
	Handoff     string `json:"handoff"`
	Downgraded  bool   `json:"downgraded"`
	// Reason 说明"为什么没拿到首选条目"（如旧 tag 缺 installer 条目）。
	// 降级不静默：界面把它翻成人话，用户才知道手里的包为什么长这样。
	Reason string `json:"reason"`
}

// DownloadProgress 下载进度信息。
type DownloadProgress struct {
	Downloaded int64  `json:"downloaded"`
	Total      int64  `json:"total"`
	Percent    int    `json:"percent"`
	Done       bool   `json:"done"`
	Error      string `json:"error,omitempty"`
}

// ProgressCallback 用于报告下载进度。
type ProgressCallback func(DownloadProgress)

func Check(ctx context.Context, req Request) Result {
	current := strings.TrimSpace(req.CurrentVersion)
	if current == "" {
		current = "0.0.0"
	}
	result := Result{
		CurrentVersion: current,
		CheckedAt:      time.Now().Format(time.RFC3339),
	}

	sources := req.Sources
	if len(sources) == 0 {
		sources = DefaultSources
	}

	client := &http.Client{
		Timeout:   8 * time.Second,
		Transport: &http.Transport{Proxy: proxyFunc(req.Proxy)},
	}

	var failures []string
	for _, source := range sources {
		manifest, err := fetchManifest(ctx, client, source.URL)
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", source.Name, err))
			continue
		}
		if strings.TrimSpace(manifest.Version) == "" {
			failures = append(failures, fmt.Sprintf("%s: 清单缺少 version 字段", source.Name))
			continue
		}

		selection := CurrentSelection(req.Mode, req.PackageFormat)
		picked := SelectAsset(manifest, selection)
		if !picked.Resolved {
			failures = append(failures, fmt.Sprintf("%s: 没有适用于当前运行形态的更新产物（%s）", source.Name, selection.Platform))
			continue
		}

		result.LatestVersion = manifest.Version
		result.SourceName = source.Name
		result.SourceURL = source.URL
		// 命中哪个源就从哪个源下载产物：以前只把清单取回来，产物仍是官方原址，
		// 靠镜像才检查成功的用户点「下载并安装」照样连不上 GitHub。
		result.DownloadURL = mirrorAssetURL(source.URL, picked.Asset.DownloadURL)
		result.ReleaseNotes = manifest.Notes
		result.PublishedAt = manifest.PublishedAt
		result.SHA256 = picked.Asset.SHA256
		result.Mandatory = manifest.Mandatory
		result.PlatformKey = picked.PlatformKey
		result.FileName = picked.Asset.FileName
		result.Handoff = string(picked.Handoff)
		result.Downgraded = picked.Downgraded
		result.Reason = picked.Reason
		result.HasUpdate = CompareVersions(manifest.Version, current) > 0

		if result.HasUpdate && !isHTTPS(result.DownloadURL) {
			// 校验的是真正要下载的那条地址（可能被镜像前缀改写过），不是清单原值。
			result.Error = "更新下载地址必须使用 HTTPS"
		}
		return result
	}

	if len(failures) == 0 {
		result.Error = "没有可用的更新源"
	} else {
		result.Error = strings.Join(failures, "; ")
	}
	return result
}

// Download 下载更新文件到临时目录，通过回调报告进度，返回落盘路径。
//
// 两条硬纪律（2026-10-22 与"检查更新即完成升级"同批定下）：
//  1. 下载必须走应用内代理。过去 Check 走代理、Download 不走，直连不通的用户
//     查得到版本却下不动包，链路第二步就断。
//  2. 没有 sha256 就中止。既然下一步要自动起安装程序，
//     "清单里没写校验值也照样报校验通过"这种静默跳过不能再有（fail closed）。
func Download(ctx context.Context, downloadURL string, expectedSHA256 string, proxy ProxyConfig, onProgress ProgressCallback) (string, error) {
	expectedSHA256 = strings.TrimSpace(expectedSHA256)
	if expectedSHA256 == "" {
		return "", errors.New("更新包缺少校验值（sha256），已中止下载")
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
	if err != nil {
		return "", fmt.Errorf("发起下载请求失败：%w", err)
	}
	req.Header.Set("User-Agent", "ConfScope update downloader")

	client := &http.Client{
		Timeout:   30 * time.Minute,
		Transport: &http.Transport{Proxy: proxyFunc(proxy)},
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("下载失败：%w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("下载失败：服务端返回 HTTP %d", resp.StatusCode)
	}

	total := resp.ContentLength
	fileName := filepath.Base(downloadURL)
	if fileName == "" || fileName == "." || fileName == "/" {
		fileName = "ConfScope-update"
	}
	tmpDir := os.TempDir()
	tmpFile, err := os.CreateTemp(tmpDir, "confscope-update-*"+filepath.Ext(fileName))
	if err != nil {
		return "", fmt.Errorf("创建临时文件失败：%w", err)
	}
	tmpPath := tmpFile.Name()

	hasher := sha256.New()
	writer := io.MultiWriter(tmpFile, hasher)

	var downloaded int64
	buf := make([]byte, 32*1024)
	lastReport := time.Now()

	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, writeErr := writer.Write(buf[:n]); writeErr != nil {
				tmpFile.Close()
				os.Remove(tmpPath)
				return "", fmt.Errorf("写入下载文件失败：%w", writeErr)
			}
			downloaded += int64(n)

			// 每 200ms 报告一次进度
			if onProgress != nil && time.Since(lastReport) > 200*time.Millisecond {
				pct := 0
				if total > 0 {
					pct = int(downloaded * 100 / total)
				}
				onProgress(DownloadProgress{
					Downloaded: downloaded,
					Total:      total,
					Percent:    pct,
				})
				lastReport = time.Now()
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			tmpFile.Close()
			os.Remove(tmpPath)
			return "", fmt.Errorf("读取下载内容失败：%w", readErr)
		}
	}
	tmpFile.Close()

	actual := hex.EncodeToString(hasher.Sum(nil))
	if !strings.EqualFold(actual, expectedSHA256) {
		os.Remove(tmpPath)
		failErr := fmt.Errorf("SHA256 校验失败，安装包可能已损坏\n期望: %s\n实际: %s", expectedSHA256, actual)
		reportDone(onProgress, downloaded, total, failErr)
		return "", failErr
	}

	// 只有校验通过才报 done：UI 的"校验通过 → 交给安装程序"这条链以此为准
	reportDone(onProgress, downloaded, total, nil)
	return tmpPath, nil
}

func reportDone(onProgress ProgressCallback, downloaded, total int64, failErr error) {
	if onProgress == nil {
		return
	}
	pct := 100
	if total > 0 {
		pct = int(downloaded * 100 / total)
	}
	p := DownloadProgress{Downloaded: downloaded, Total: total, Percent: pct, Done: failErr == nil}
	if failErr != nil {
		p.Error = failErr.Error()
	}
	onProgress(p)
}

// CurrentPlatform 返回当前平台标识，如 "windows-amd64"、"linux-amd64"。
func CurrentPlatform() string {
	return fmt.Sprintf("%s-%s", runtime.GOOS, runtime.GOARCH)
}

func fetchManifest(ctx context.Context, client *http.Client, rawURL string) (Manifest, error) {
	var manifest Manifest
	if strings.TrimSpace(rawURL) == "" {
		return manifest, fmt.Errorf("empty source URL")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return manifest, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "ConfScope update checker")

	resp, err := client.Do(req)
	if err != nil {
		return manifest, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return manifest, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	if err := json.NewDecoder(resp.Body).Decode(&manifest); err != nil {
		return manifest, err
	}
	return manifest, nil
}

func isHTTPS(rawURL string) bool {
	u, err := url.Parse(rawURL)
	return err == nil && u.Scheme == "https" && u.Host != ""
}

func proxyFunc(config ProxyConfig) func(*http.Request) (*url.URL, error) {
	return func(req *http.Request) (*url.URL, error) {
		if req == nil || req.URL == nil || noProxyMatch(req.URL.Hostname(), config.NoProxy) {
			return nil, nil
		}

		rawProxy := ""
		switch req.URL.Scheme {
		case "https":
			rawProxy = firstNonEmpty(config.HTTPSProxy, config.HTTPProxy)
		case "http":
			rawProxy = config.HTTPProxy
		}
		if strings.TrimSpace(rawProxy) == "" {
			return nil, nil
		}
		return url.Parse(rawProxy)
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func noProxyMatch(host string, patterns string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "" || strings.TrimSpace(patterns) == "" {
		return false
	}
	for _, pattern := range strings.Split(patterns, ",") {
		pattern = strings.ToLower(strings.TrimSpace(pattern))
		if pattern == "" {
			continue
		}
		if pattern == "*" || host == pattern {
			return true
		}
		if strings.HasPrefix(pattern, ".") && strings.HasSuffix(host, pattern) {
			return true
		}
		if strings.HasSuffix(host, "."+pattern) {
			return true
		}
		if _, cidr, err := net.ParseCIDR(pattern); err == nil {
			if ip := net.ParseIP(host); ip != nil && cidr.Contains(ip) {
				return true
			}
		}
	}
	return false
}

func CompareVersions(a string, b string) int {
	av := parseVersion(a)
	bv := parseVersion(b)
	for i := 0; i < 3; i++ {
		if av.parts[i] > bv.parts[i] {
			return 1
		}
		if av.parts[i] < bv.parts[i] {
			return -1
		}
	}
	if av.pre == bv.pre {
		return 0
	}
	if av.pre == "" {
		return 1
	}
	if bv.pre == "" {
		return -1
	}
	return comparePrerelease(av.pre, bv.pre)
}

type version struct {
	parts [3]int
	pre   string
}

func parseVersion(raw string) version {
	raw = strings.TrimSpace(raw)
	if candidate := semverCandidate(raw); candidate != "" {
		raw = candidate
	}
	raw = strings.TrimPrefix(strings.TrimPrefix(raw, "v"), "V")
	if plus := strings.Index(raw, "+"); plus >= 0 {
		raw = raw[:plus]
	}
	pre := ""
	if dash := strings.Index(raw, "-"); dash >= 0 {
		pre = raw[dash+1:]
		raw = raw[:dash]
	}

	var out version
	out.pre = pre
	for i, p := range strings.Split(raw, ".") {
		if i >= 3 {
			break
		}
		n, _ := strconv.Atoi(p)
		out.parts[i] = n
	}
	return out
}

func semverCandidate(raw string) string {
	pattern := regexp.MustCompile(`[vV]?[0-9]+(?:\.[0-9]+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`)
	return pattern.FindString(strings.TrimSpace(raw))
}

func comparePrerelease(a string, b string) int {
	as := strings.Split(a, ".")
	bs := strings.Split(b, ".")
	for i := 0; i < len(as) || i < len(bs); i++ {
		if i >= len(as) {
			return -1
		}
		if i >= len(bs) {
			return 1
		}
		ai, aErr := strconv.Atoi(as[i])
		bi, bErr := strconv.Atoi(bs[i])
		if aErr == nil && bErr == nil {
			if ai > bi {
				return 1
			}
			if ai < bi {
				return -1
			}
			continue
		}
		if as[i] > bs[i] {
			return 1
		}
		if as[i] < bs[i] {
			return -1
		}
	}
	return 0
}
