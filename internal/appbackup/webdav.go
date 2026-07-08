package appbackup

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"
)

// WebDAVClient 是应用数据备份使用的 WebDAV 客户端。
type WebDAVClient struct {
	httpClient *http.Client
}

// NewWebDAVClient 创建 WebDAV 客户端。
func NewWebDAVClient() *WebDAVClient {
	return &WebDAVClient{httpClient: &http.Client{Timeout: 30 * time.Second}}
}

// Test 验证 WebDAV 目标可访问，必要时创建根目录。
func (c *WebDAVClient) Test(target WebDAVTarget) error {
	rootURL, err := targetRootURL(target)
	if err != nil {
		return err
	}
	req, err := http.NewRequest("MKCOL", rootURL.String(), nil)
	if err != nil {
		return fmt.Errorf("创建 WebDAV 测试请求失败: %w", err)
	}
	setBasicAuth(req, target)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("WebDAV 连接失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusCreated || resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusMethodNotAllowed || resp.StatusCode == http.StatusConflict {
		return nil
	}
	return webDAVStatusError(resp.StatusCode, "测试 WebDAV 连接")
}

// Upload 上传加密后的备份包到 WebDAV 根目录。
func (c *WebDAVClient) Upload(target WebDAVTarget, fileName string, packageBytes []byte) (RemoteBackup, error) {
	rootURL, err := targetRootURL(target)
	if err != nil {
		return RemoteBackup{}, err
	}
	if err := c.Test(target); err != nil {
		return RemoteBackup{}, err
	}
	remoteURL := *rootURL
	remoteURL.Path = path.Join(rootURL.Path, path.Base(fileName))
	req, err := http.NewRequest(http.MethodPut, remoteURL.String(), bytes.NewReader(packageBytes))
	if err != nil {
		return RemoteBackup{}, fmt.Errorf("创建 WebDAV 上传请求失败: %w", err)
	}
	setBasicAuth(req, target)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return RemoteBackup{}, fmt.Errorf("WebDAV 上传失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return RemoteBackup{}, webDAVStatusError(resp.StatusCode, "WebDAV 上传失败")
	}
	return RemoteBackup{
		Name:       path.Base(remoteURL.Path),
		Path:       remoteURL.Path,
		Size:       int64(len(packageBytes)),
		ModifiedAt: time.Now().UTC().Format(time.RFC3339),
	}, nil
}

// Download 下载 WebDAV 远端备份包。
func (c *WebDAVClient) Download(target WebDAVTarget, remotePath string) ([]byte, error) {
	remoteURL, err := targetRemoteURL(target, remotePath)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest(http.MethodGet, remoteURL.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("创建 WebDAV 下载请求失败: %w", err)
	}
	setBasicAuth(req, target)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("WebDAV 下载失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, webDAVStatusError(resp.StatusCode, "WebDAV 下载失败")
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("读取 WebDAV 下载内容失败: %w", err)
	}
	return body, nil
}

// List 列出 WebDAV 根目录下的 .csbackup 文件。
func (c *WebDAVClient) List(target WebDAVTarget) ([]RemoteBackup, error) {
	rootURL, err := targetRootURL(target)
	if err != nil {
		return nil, err
	}
	ensureCollectionURL(rootURL)
	req, err := http.NewRequest("PROPFIND", rootURL.String(), strings.NewReader(`<?xml version="1.0"?><propfind xmlns="DAV:"><prop><getcontentlength/><getlastmodified/></prop></propfind>`))
	if err != nil {
		return nil, fmt.Errorf("创建 WebDAV 列表请求失败: %w", err)
	}
	req.Header.Set("Depth", "1")
	req.Header.Set("Content-Type", "application/xml")
	setBasicAuth(req, target)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("WebDAV 列表读取失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 207 && (resp.StatusCode < 200 || resp.StatusCode >= 300) {
		return nil, webDAVStatusError(resp.StatusCode, "WebDAV 列表读取失败")
	}
	var multi webDAVMultiStatus
	if err := xml.NewDecoder(resp.Body).Decode(&multi); err != nil {
		return nil, fmt.Errorf("解析 WebDAV 列表失败: %w", err)
	}
	out := make([]RemoteBackup, 0)
	for _, item := range multi.Responses {
		remotePath := item.Href
		if !strings.HasSuffix(remotePath, ".csbackup") {
			continue
		}
		remotePath = decodeURLPath(remotePath)
		out = append(out, RemoteBackup{
			Name:       path.Base(remotePath),
			Path:       remotePath,
			Size:       item.ContentLength(),
			ModifiedAt: item.LastModified(),
		})
	}
	return out, nil
}

type webDAVMultiStatus struct {
	Responses []webDAVResponse `xml:"response"`
}

type webDAVResponse struct {
	Href     string             `xml:"href"`
	Propstat []webDAVPropStatus `xml:"propstat"`
}

type webDAVPropStatus struct {
	Prop webDAVProp `xml:"prop"`
}

type webDAVProp struct {
	ContentLength int64  `xml:"getcontentlength"`
	LastModified  string `xml:"getlastmodified"`
}

func (r webDAVResponse) ContentLength() int64 {
	for _, stat := range r.Propstat {
		if stat.Prop.ContentLength > 0 {
			return stat.Prop.ContentLength
		}
	}
	return 0
}

func (r webDAVResponse) LastModified() string {
	for _, stat := range r.Propstat {
		if stat.Prop.LastModified != "" {
			return stat.Prop.LastModified
		}
	}
	return ""
}

func targetRootURL(target WebDAVTarget) (*url.URL, error) {
	rawURL := strings.TrimSpace(target.URL)
	if rawURL == "" {
		return nil, fmt.Errorf("WebDAV 地址不能为空")
	}
	baseURL, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("WebDAV 地址无效: %w", err)
	}
	rootPath := strings.TrimSpace(target.RootPath)
	if rootPath == "" || rootPath == "/" {
		return baseURL, nil
	}
	if !strings.HasPrefix(rootPath, "/") {
		rootPath = "/" + rootPath
	}
	baseURL.Path = path.Join(baseURL.Path, rootPath)
	return baseURL, nil
}

func targetRemoteURL(target WebDAVTarget, remotePath string) (*url.URL, error) {
	baseURL, err := url.Parse(strings.TrimSpace(target.URL))
	if err != nil {
		return nil, fmt.Errorf("WebDAV 地址无效: %w", err)
	}
	cleanPath := strings.TrimSpace(remotePath)
	if cleanPath == "" {
		return nil, fmt.Errorf("WebDAV 远端路径不能为空")
	}
	baseURL.Path = cleanPath
	return baseURL, nil
}

func ensureCollectionURL(value *url.URL) {
	if value.Path == "" {
		value.Path = "/"
		return
	}
	if !strings.HasSuffix(value.Path, "/") {
		value.Path += "/"
	}
}

func setBasicAuth(req *http.Request, target WebDAVTarget) {
	if target.Username != "" || target.Password != "" {
		req.SetBasicAuth(target.Username, target.Password)
	}
}

func decodeURLPath(value string) string {
	parsed, err := url.PathUnescape(value)
	if err != nil {
		return value
	}
	return parsed
}

func webDAVStatusError(statusCode int, context string) error {
	switch statusCode {
	case http.StatusUnauthorized:
		return fmt.Errorf("WebDAV 认证失败: %s 返回 %d", context, statusCode)
	case http.StatusForbidden:
		return fmt.Errorf("WebDAV 权限不足: %s 返回 %d", context, statusCode)
	case http.StatusNotFound:
		return fmt.Errorf("WebDAV 路径不存在: %s 返回 %d", context, statusCode)
	default:
		return fmt.Errorf("%s 返回 %d", context, statusCode)
	}
}
