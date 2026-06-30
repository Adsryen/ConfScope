package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"confscope/internal/nacos"
	"confscope/internal/provider"
	"confscope/internal/ssh"
	"confscope/internal/updatecheck"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

var appVersion = "1.1.0"

var errUnsupportedProvider = errors.New("unsupported config center provider")

type AppInfo struct {
	Name          string               `json:"name"`
	Version       string               `json:"version"`
	UpdateSources []updatecheck.Source `json:"updateSources"`
}

type LocalSnapshotValidation struct {
	Valid          bool     `json:"valid"`
	Path           string   `json:"path"`
	Message        string   `json:"message"`
	ConfigCount    int      `json:"configCount"`
	HasManifest    bool     `json:"hasManifest"`
	MatchedMarkers []string `json:"matchedMarkers"`
	CheckedAt      string   `json:"checkedAt"`
}

// App 是 Wails 暴露给前端的应用服务。
//
// 这一层只做桌面端方法绑定和参数转发，具体 Nacos HTTP 协议适配由
// internal/nacos.Client 负责，避免前端绑定层混入业务解析逻辑。
type App struct {
	ctx       context.Context
	nacos     *nacos.Client
	sshMgr    *ssh.Manager
	providers map[provider.ProviderType]provider.ConfigProvider

	downloadMu       sync.Mutex
	downloadProgress updatecheck.DownloadProgress
	downloadErr      string
	downloadedFile   string
}

// NewApp 创建应用服务实例。
func NewApp() *App {
	nacosClient := nacos.NewClient()
	return &App{
		nacos:  nacosClient,
		sshMgr: ssh.NewManager(),
		providers: map[provider.ProviderType]provider.ConfigProvider{
			provider.ProviderNacos: provider.NewNacosProvider(nacosClient),
			provider.ProviderLocal: provider.NewLocalProvider(),
		},
	}
}

func (a *App) providerFor(providerType provider.ProviderType) (provider.ConfigProvider, error) {
	p, ok := a.providers[providerType]
	if !ok || p == nil {
		return nil, fmt.Errorf("%w: %s", errUnsupportedProvider, providerType)
	}
	return p, nil
}

func (a *App) ConfigCenterListNamespaces(profile provider.ConnectionProfile) ([]provider.Namespace, error) {
	p, err := a.providerFor(profile.Provider)
	if err != nil {
		return nil, err
	}
	return p.ListNamespaces(profile)
}

func (a *App) ConfigCenterListConfigs(profile provider.ConnectionProfile, req provider.ListConfigsRequest) (provider.ConfigPage, error) {
	p, err := a.providerFor(profile.Provider)
	if err != nil {
		return provider.ConfigPage{}, err
	}
	return p.ListConfigs(profile, req)
}

func (a *App) ConfigCenterGetConfig(profile provider.ConnectionProfile, ref provider.ConfigRef) (provider.ConfigDocument, error) {
	p, err := a.providerFor(profile.Provider)
	if err != nil {
		return provider.ConfigDocument{}, err
	}
	return p.GetConfig(profile, ref)
}

func (a *App) ConfigCenterPublishConfig(profile provider.ConnectionProfile, req provider.PublishConfigRequest) error {
	p, err := a.providerFor(profile.Provider)
	if err != nil {
		return err
	}
	return p.PublishConfig(profile, req)
}

func (a *App) ConfigCenterDeleteConfig(profile provider.ConnectionProfile, ref provider.ConfigRef) error {
	p, err := a.providerFor(profile.Provider)
	if err != nil {
		return err
	}
	return p.DeleteConfig(profile, ref)
}

func (a *App) ConfigCenterListHistory(profile provider.ConnectionProfile, ref provider.ConfigRef, page provider.PageRequest) (provider.HistoryPage, error) {
	p, err := a.providerFor(profile.Provider)
	if err != nil {
		return provider.HistoryPage{}, err
	}
	return p.ListHistory(profile, ref, page)
}

func (a *App) ConfigCenterGetHistoryDetail(profile provider.ConnectionProfile, ref provider.ConfigRef, id string) (provider.HistoryDetail, error) {
	p, err := a.providerFor(profile.Provider)
	if err != nil {
		return provider.HistoryDetail{}, err
	}
	return p.GetHistoryDetail(profile, ref, id)
}

func (a *App) ConfigCenterTestConnection(profile provider.ConnectionProfile) error {
	p, err := a.providerFor(profile.Provider)
	if err != nil {
		return err
	}
	return p.TestConnection(profile)
}

// GetAppInfo 返回应用基础信息和内置更新源。
func (a *App) GetAppInfo() AppInfo {
	return AppInfo{
		Name:          "ConfScope",
		Version:       appVersion,
		UpdateSources: updatecheck.DefaultSources,
	}
}

// CheckForUpdates 检查 ConfScope 是否有可用新版本。
func (a *App) CheckForUpdates(req updatecheck.Request) updatecheck.Result {
	if req.CurrentVersion == "" {
		req.CurrentVersion = appVersion
	}
	return updatecheck.Check(context.Background(), req)
}

// GetCurrentPlatform 返回当前平台标识，如 "windows-amd64"。
func (a *App) GetCurrentPlatform() string {
	return updatecheck.CurrentPlatform()
}

// DownloadUpdate 下载更新文件，通过 Wails 事件报告进度。
// 返回下载后的临时文件路径。
func (a *App) DownloadUpdate(downloadURL string, sha256 string) (string, error) {
	a.downloadMu.Lock()
	a.downloadProgress = updatecheck.DownloadProgress{}
	a.downloadErr = ""
	a.downloadedFile = ""
	a.downloadMu.Unlock()

	ctx := context.Background()
	if a.ctx != nil {
		ctx = a.ctx
	}

	filePath, err := updatecheck.Download(ctx, downloadURL, sha256, func(p updatecheck.DownloadProgress) {
		a.downloadMu.Lock()
		a.downloadProgress = p
		a.downloadMu.Unlock()

		if a.ctx != nil {
			runtime.EventsEmit(a.ctx, "update:download-progress", p)
		}
	})

	a.downloadMu.Lock()
	if err != nil {
		a.downloadErr = err.Error()
		a.downloadProgress.Error = err.Error()
		a.downloadMu.Unlock()
		if a.ctx != nil {
			runtime.EventsEmit(a.ctx, "update:download-progress", updatecheck.DownloadProgress{Error: err.Error()})
		}
		return "", err
	}
	a.downloadedFile = filePath
	a.downloadMu.Unlock()
	return filePath, nil
}

// GetDownloadProgress 返回当前下载进度（供前端轮询）。
func (a *App) GetDownloadProgress() updatecheck.DownloadProgress {
	a.downloadMu.Lock()
	defer a.downloadMu.Unlock()
	return a.downloadProgress
}

// InstallAndRestart 安装更新并重启应用。
func (a *App) InstallAndRestart(downloadedFile string) error {
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("get executable path: %w", err)
	}
	return updatecheck.InstallAndRestart(downloadedFile, exePath)
}

func (a *App) SelectLocalSnapshotDirectory() (string, error) {
	if a.ctx == nil {
		return "", errors.New("wails runtime is not ready")
	}
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "选择本地快照目录",
	})
}

func (a *App) ValidateLocalSnapshotDirectory(path string) LocalSnapshotValidation {
	return validateLocalSnapshotDirectory(path)
}

// startup 保存 Wails 运行上下文，供后续需要调用运行时能力时使用。
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// shutdown 停止所有 SSH 隧道。
func (a *App) shutdown(ctx context.Context) {
	a.sshMgr.StopAll()
}

// NacosDetectVersion 探测目标 Nacos 服务应使用 v1 还是 v3 OpenAPI。
func (a *App) NacosDetectVersion(baseUrl string) (string, error) {
	return a.nacos.DetectVersion(baseUrl)
}

// NacosLogin 使用账号密码登录 Nacos，并返回 accessToken 与过期时间。
func (a *App) NacosLogin(baseUrl string, username string, password string, apiVersion string) (nacos.LoginResult, error) {
	return a.nacos.Login(baseUrl, username, password, apiVersion)
}

// NacosNamespaces 查询命名空间列表。
func (a *App) NacosNamespaces(baseUrl string, accessToken string, apiVersion string) ([]nacos.Namespace, error) {
	return a.nacos.Namespaces(baseUrl, accessToken, apiVersion)
}

// NacosListConfigs 按 dataId/group 模糊查询配置列表。
func (a *App) NacosListConfigs(
	baseUrl string,
	accessToken string,
	apiVersion string,
	namespace string,
	dataId string,
	group string,
	pageNo int64,
	pageSize int64,
) (nacos.ConfigPage, error) {
	return a.nacos.ListConfigs(baseUrl, accessToken, apiVersion, namespace, dataId, group, pageNo, pageSize)
}

// NacosGetConfig 获取指定配置的完整内容。
func (a *App) NacosGetConfig(
	baseUrl string,
	accessToken string,
	apiVersion string,
	namespace string,
	dataId string,
	group string,
) (string, error) {
	return a.nacos.GetConfig(baseUrl, accessToken, apiVersion, namespace, dataId, group)
}

// NacosHistoryList 查询指定配置的历史版本列表。
func (a *App) NacosHistoryList(
	baseUrl string,
	accessToken string,
	apiVersion string,
	namespace string,
	dataId string,
	group string,
	pageNo int64,
	pageSize int64,
) (nacos.HistoryPage, error) {
	return a.nacos.HistoryList(baseUrl, accessToken, apiVersion, namespace, dataId, group, pageNo, pageSize)
}

// NacosHistoryDetail 获取指定历史版本的详情。
func (a *App) NacosHistoryDetail(
	baseUrl string,
	accessToken string,
	apiVersion string,
	namespace string,
	dataId string,
	group string,
	nid string,
) (nacos.HistoryDetail, error) {
	return a.nacos.HistoryDetail(baseUrl, accessToken, apiVersion, namespace, dataId, group, nid)
}

// NacosPublishConfig 发布或更新指定配置。
func (a *App) NacosPublishConfig(
	baseUrl string,
	accessToken string,
	apiVersion string,
	namespace string,
	dataId string,
	group string,
	content string,
	configType string,
) error {
	return a.nacos.PublishConfig(baseUrl, accessToken, apiVersion, namespace, dataId, group, content, configType)
}

// NacosDeleteConfig 删除指定配置。
func (a *App) NacosDeleteConfig(
	baseUrl string,
	accessToken string,
	apiVersion string,
	namespace string,
	dataId string,
	group string,
) error {
	return a.nacos.DeleteConfig(baseUrl, accessToken, apiVersion, namespace, dataId, group)
}

// CreateSSHTunnel 创建并启动 SSH 隧道。
// connectionId 是连接的唯一标识，config 是 SSH 隧道配置。
// 返回本地监听端口。
func (a *App) CreateSSHTunnel(connectionId string, config ssh.Config) (int, error) {
	return a.sshMgr.CreateTunnel(connectionId, config)
}

func (a *App) TestSSHConnection(config ssh.Config) (ssh.TestResult, error) {
	return ssh.TestConnection(config)
}

// StopSSHTunnel 停止指定连接的 SSH 隧道。
func (a *App) StopSSHTunnel(connectionId string) {
	a.sshMgr.StopTunnel(connectionId)
}

// StopAllSSHTunnels 停止所有 SSH 隧道。
func (a *App) StopAllSSHTunnels() {
	a.sshMgr.StopAll()
}

// GetSSHTunnelLocalPort 获取指定连接的 SSH 隧道本地端口。
func (a *App) GetSSHTunnelLocalPort(connectionId string) (int, error) {
	return a.sshMgr.GetLocalPort(connectionId)
}

func validateLocalSnapshotDirectory(path string) LocalSnapshotValidation {
	result := LocalSnapshotValidation{
		Path:      strings.TrimSpace(path),
		CheckedAt: time.Now().Format(time.RFC3339),
	}
	if result.Path == "" {
		result.Message = "本地快照目录不能为空"
		return result
	}

	info, err := os.Stat(result.Path)
	if err != nil {
		if os.IsNotExist(err) {
			result.Message = "目录不存在"
		} else {
			result.Message = err.Error()
		}
		return result
	}
	if !info.IsDir() {
		result.Message = "路径不是文件夹"
		return result
	}

	manifestNames := map[string]struct{}{
		"confscope.snapshot.json": {},
		"manifest.json":           {},
		"metadata.json":           {},
		".metadata.yml":           {},
		".metadata.yaml":          {},
	}
	structureDirs := map[string]struct{}{
		"configs":    {},
		"namespaces": {},
	}
	configExts := map[string]struct{}{
		".json":       {},
		".yaml":       {},
		".yml":        {},
		".properties": {},
		".xml":        {},
		".toml":       {},
		".ini":        {},
		".txt":        {},
	}

	entries, err := os.ReadDir(result.Path)
	if err != nil {
		result.Message = err.Error()
		return result
	}
	for _, entry := range entries {
		name := strings.ToLower(entry.Name())
		if entry.IsDir() {
			if _, ok := structureDirs[name]; ok {
				result.MatchedMarkers = append(result.MatchedMarkers, entry.Name()+"/")
			}
			continue
		}
		if _, ok := manifestNames[name]; ok {
			result.HasManifest = true
			result.MatchedMarkers = append(result.MatchedMarkers, entry.Name())
		}
	}

	configCount := 0
	_ = filepath.WalkDir(result.Path, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		name := strings.ToLower(d.Name())
		if _, ok := manifestNames[name]; ok {
			return nil
		}
		if _, ok := configExts[strings.ToLower(filepath.Ext(path))]; ok {
			configCount++
		}
		return nil
	})
	result.ConfigCount = configCount

	if !result.HasManifest && len(result.MatchedMarkers) == 0 {
		result.Message = "未找到快照清单或标准目录结构"
		return result
	}
	if result.ConfigCount == 0 {
		result.Message = "未找到可对比的配置文件"
		return result
	}

	result.Valid = true
	result.Message = "本地快照目录结构有效"
	return result
}
