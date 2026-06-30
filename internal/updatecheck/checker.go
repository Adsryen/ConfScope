package updatecheck

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const officialManifestURL = "https://github.com/Adsryen/ConfScope/releases/latest/download/update.json"

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

// PlatformAsset 返回当前平台对应的资产信息。
// 优先从 platforms 字段查找，fallback 到旧版顶级字段。
func (m Manifest) PlatformAsset() (PlatformAsset, bool) {
	key := CurrentPlatform()
	if m.Platforms != nil {
		if asset, ok := m.Platforms[key]; ok && asset.DownloadURL != "" {
			return asset, true
		}
	}
	if m.DownloadURL != "" {
		return PlatformAsset{
			DownloadURL: m.DownloadURL,
			SHA256:      m.SHA256,
			FileName:    filepath.Base(m.DownloadURL),
		}, true
	}
	return PlatformAsset{}, false
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
			failures = append(failures, fmt.Sprintf("%s: missing version", source.Name))
			continue
		}

		asset, ok := manifest.PlatformAsset()
		if !ok {
			failures = append(failures, fmt.Sprintf("%s: no asset for platform %s", source.Name, CurrentPlatform()))
			continue
		}

		result.LatestVersion = manifest.Version
		result.SourceName = source.Name
		result.SourceURL = source.URL
		result.DownloadURL = asset.DownloadURL
		result.ReleaseNotes = manifest.Notes
		result.PublishedAt = manifest.PublishedAt
		result.SHA256 = asset.SHA256
		result.Mandatory = manifest.Mandatory
		result.HasUpdate = CompareVersions(manifest.Version, current) > 0

		if result.HasUpdate && !isHTTPS(asset.DownloadURL) {
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

// Download 下载更新文件到临时目录，通过回调报告进度。
// 返回下载后的文件路径。
func Download(ctx context.Context, downloadURL string, expectedSHA256 string, onProgress ProgressCallback) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
	if err != nil {
		return "", fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("User-Agent", "ConfScope update downloader")

	client := &http.Client{
		Timeout: 30 * time.Minute,
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("download failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	total := resp.ContentLength
	fileName := filepath.Base(downloadURL)
	if fileName == "" || fileName == "." || fileName == "/" {
		fileName = "ConfScope-update"
	}
	tmpDir := os.TempDir()
	tmpFile, err := os.CreateTemp(tmpDir, "confscope-update-*"+filepath.Ext(fileName))
	if err != nil {
		return "", fmt.Errorf("create temp file: %w", err)
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
				return "", fmt.Errorf("write file: %w", writeErr)
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
			return "", fmt.Errorf("read body: %w", readErr)
		}
	}
	tmpFile.Close()

	// 最终进度报告
	if onProgress != nil {
		pct := 100
		if total > 0 {
			pct = int(downloaded * 100 / total)
		}
		onProgress(DownloadProgress{
			Downloaded: downloaded,
			Total:      total,
			Percent:    pct,
			Done:       true,
		})
	}

	// 校验 SHA256
	if expectedSHA256 != "" {
		actual := hex.EncodeToString(hasher.Sum(nil))
		if !strings.EqualFold(actual, expectedSHA256) {
			os.Remove(tmpPath)
			return "", fmt.Errorf("SHA256 校验失败\n期望: %s\n实际: %s", expectedSHA256, actual)
		}
	}

	return tmpPath, nil
}

// InstallAndRestart 执行安装并重启应用。
// downloadedFile 是下载的更新文件路径。
// exePath 是当前运行的可执行文件路径。
func InstallAndRestart(downloadedFile string, exePath string) error {
	switch runtime.GOOS {
	case "windows":
		return installWindows(downloadedFile, exePath)
	case "linux":
		return installLinux(downloadedFile, exePath)
	default:
		return fmt.Errorf("unsupported OS: %s", runtime.GOOS)
	}
}

func installWindows(downloadedFile string, exePath string) error {
	// 如果是 .exe 直接替换，否则解压 tar.gz
	newExe := downloadedFile
	if strings.HasSuffix(downloadedFile, ".tar.gz") || strings.HasSuffix(downloadedFile, ".tgz") {
		extracted, err := extractTarGz(downloadedFile)
		if err != nil {
			return fmt.Errorf("extract tar.gz: %w", err)
		}
		newExe = extracted
	}

	batPath := filepath.Join(os.TempDir(), "confscope-update.bat")
	script := fmt.Sprintf(
		"@echo off\r\n"+
			"chcp 65001 >nul\r\n"+
			"echo 正在更新 ConfScope...\r\n"+
			":wait\r\n"+
			"ping 127.0.0.1 -n 2 >nul\r\n"+
			"if exist \"%s\" (\r\n"+
			"  ping 127.0.0.1 -n 2 >nul\r\n"+
			"  goto wait\r\n"+
			")\r\n"+
			"move /Y \"%s\" \"%s\"\r\n"+
			"if errorlevel 1 (\r\n"+
			"  echo 更新失败，请手动替换\r\n"+
			"  pause\r\n"+
			"  exit /b 1\r\n"+
			")\r\n"+
			"echo 更新完成，正在启动...\r\n"+
			"start \"\" \"%s\"\r\n"+
			"del \"%%~f0\"\r\n",
		exePath, newExe, exePath, exePath,
	)

	if err := os.WriteFile(batPath, []byte(script), 0644); err != nil {
		return fmt.Errorf("write batch script: %w", err)
	}

	cmd := exec.Command("cmd.exe", "/C", batPath)
	cmd.SysProcAttr = windowsDetachProcess()
	return cmd.Start()
}

func installLinux(downloadedFile string, exePath string) error {
	newBin := downloadedFile
	if strings.HasSuffix(downloadedFile, ".tar.gz") || strings.HasSuffix(downloadedFile, ".tgz") {
		extracted, err := extractTarGz(downloadedFile)
		if err != nil {
			return fmt.Errorf("extract tar.gz: %w", err)
		}
		newBin = extracted
	}

	shPath := filepath.Join(os.TempDir(), "confscope-update.sh")
	script := fmt.Sprintf(
		"#!/bin/bash\n"+
			"sleep 1\n"+
			"while kill -0 %d 2>/dev/null; do sleep 0.5; done\n"+
			"cp \"%s\" \"%s\"\n"+
			"chmod +x \"%s\"\n"+
			"nohup \"%s\" >/dev/null 2>&1 &\n"+
			"rm -f \"$0\"\n",
		os.Getpid(), newBin, exePath, exePath, exePath,
	)

	if err := os.WriteFile(shPath, []byte(script), 0755); err != nil {
		return fmt.Errorf("write shell script: %w", err)
	}

	cmd := exec.Command("nohup", "bash", shPath)
	cmd.SysProcAttr = linuxDetachProcess()
	return cmd.Start()
}

// extractTarGz 从 tar.gz 中提取第一个可执行文件。
func extractTarGz(tarPath string) (string, error) {
	// 使用系统 tar 命令解压
	tmpDir, err := os.MkdirTemp("", "confscope-extract-*")
	if err != nil {
		return "", err
	}

	cmd := exec.Command("tar", "xzf", tarPath, "-C", tmpDir)
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		os.RemoveAll(tmpDir)
		return "", fmt.Errorf("tar extract: %w", err)
	}

	// 找第一个可执行文件
	entries, err := os.ReadDir(tmpDir)
	if err != nil {
		os.RemoveAll(tmpDir)
		return "", err
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		path := filepath.Join(tmpDir, entry.Name())
		info, _ := entry.Info()
		if info != nil && info.Mode()&0111 != 0 {
			return path, nil
		}
		// 也接受非可执行文件（Windows 下载的 .exe 可能没有执行位）
		if filepath.Ext(entry.Name()) == ".exe" || entry.Name() == "ConfScope" {
			return path, nil
		}
	}

	// fallback: 返回第一个文件
	for _, entry := range entries {
		if !entry.IsDir() {
			return filepath.Join(tmpDir, entry.Name()), nil
		}
	}

	os.RemoveAll(tmpDir)
	return "", fmt.Errorf("no file found in tar.gz")
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