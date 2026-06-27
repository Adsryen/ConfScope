package updatecheck

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
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

type Manifest struct {
	Version     string `json:"version"`
	Notes       string `json:"notes"`
	DownloadURL string `json:"downloadUrl"`
	PublishedAt string `json:"publishedAt"`
	SHA256      string `json:"sha256"`
	Mandatory   bool   `json:"mandatory"`
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

		result.LatestVersion = manifest.Version
		result.SourceName = source.Name
		result.SourceURL = source.URL
		result.DownloadURL = manifest.DownloadURL
		result.ReleaseNotes = manifest.Notes
		result.PublishedAt = manifest.PublishedAt
		result.SHA256 = manifest.SHA256
		result.Mandatory = manifest.Mandatory
		result.HasUpdate = CompareVersions(manifest.Version, current) > 0

		if result.HasUpdate && !isHTTPS(manifest.DownloadURL) {
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
