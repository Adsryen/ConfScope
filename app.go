package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"confscope/internal/appbackup"
	"confscope/internal/nacos"
	"confscope/internal/provider"
	"confscope/internal/snapshotwebdav"
	"confscope/internal/ssh"
	"confscope/internal/updatecheck"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// appVersion 由构建时 -ldflags 注入，开发环境默认 "dev"。
var appVersion = "dev"

var errUnsupportedProvider = errors.New("unsupported config center provider")
var errDirectWriteRequiresApplyPlan = errors.New("直接配置写入已禁用，请先生成并执行 ApplyPlan")

type AppInfo struct {
	Name          string               `json:"name"`
	Version       string               `json:"version"`
	UpdateSources []updatecheck.Source `json:"updateSources"`
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

	nativeSmokeControl *nativeSmokeControl
}

// NewApp 创建应用服务实例。
func NewApp() *App {
	nacosClient := nacos.NewClient()
	return &App{
		nacos:  nacosClient,
		sshMgr: ssh.NewManager(),
		providers: map[provider.ProviderType]provider.ConfigProvider{
			provider.ProviderNacos:  provider.NewNacosProvider(nacosClient),
			provider.ProviderApollo: provider.NewApolloProvider(nil),
			provider.ProviderConsul: provider.NewConsulProvider(nil),
			provider.ProviderLocal:  provider.NewLocalProvider(),
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
	return errDirectWriteRequiresApplyPlan
}

func (a *App) ConfigCenterPublishConfigFromApplyPlan(profile provider.ConnectionProfile, req provider.PublishConfigRequest) error {
	p, err := a.providerFor(profile.Provider)
	if err != nil {
		return err
	}
	return p.PublishConfig(profile, req)
}

func (a *App) ConfigCenterDeleteConfig(profile provider.ConnectionProfile, ref provider.ConfigRef) error {
	return errDirectWriteRequiresApplyPlan
}

func (a *App) ConfigCenterDeleteConfigFromApplyPlan(profile provider.ConnectionProfile, ref provider.ConfigRef) error {
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

func (a *App) ValidateLocalSnapshotDirectory(path string) provider.LocalSnapshotValidation {
	return provider.ValidateLocalSnapshotDirectory(path)
}

func (a *App) SelectAppDataBackupSaveFile(defaultName string) (string, error) {
	if a.ctx == nil {
		return "", errors.New("wails runtime is not ready")
	}
	name := defaultName
	if name == "" {
		name = "confscope-app-data.csbackup"
	}
	return runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "保存 ConfScope 应用数据备份",
		DefaultFilename: name,
		Filters: []runtime.FileFilter{
			{DisplayName: "ConfScope 应用数据备份 (*.csbackup)", Pattern: "*.csbackup"},
		},
	})
}

func (a *App) SelectAppDataBackupOpenFile() (string, error) {
	if a.ctx == nil {
		return "", errors.New("wails runtime is not ready")
	}
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "选择 ConfScope 应用数据备份",
		Filters: []runtime.FileFilter{
			{DisplayName: "ConfScope 应用数据备份 (*.csbackup)", Pattern: "*.csbackup"},
		},
	})
}

// WriteAppDataBackupFile 加密并写入本地应用数据备份文件。
func (a *App) WriteAppDataBackupFile(path string, plaintextJSON string, password string, meta appbackup.PackageMeta) (appbackup.Summary, error) {
	packageBytes, summary, err := appbackup.EncryptPackage([]byte(plaintextJSON), password, meta)
	if err != nil {
		return appbackup.Summary{}, err
	}
	if err := appbackup.WriteLocalBackup(path, packageBytes); err != nil {
		return appbackup.Summary{}, err
	}
	return summary, nil
}

// ReadAppDataBackupFile 读取并解密本地应用数据备份文件。
func (a *App) ReadAppDataBackupFile(path string, password string) (appbackup.DecryptedPackage, error) {
	packageBytes, err := appbackup.ReadLocalBackup(path)
	if err != nil {
		return appbackup.DecryptedPackage{}, err
	}
	plaintext, summary, err := appbackup.DecryptPackage(packageBytes, password)
	if err != nil {
		return appbackup.DecryptedPackage{}, err
	}
	return appbackup.DecryptedPackage{PlaintextJSON: string(plaintext), Summary: summary}, nil
}

// CreateAppDataRecoveryPoint 在用户数据目录下创建恢复前的自动恢复点。
func (a *App) CreateAppDataRecoveryPoint(plaintextJSON string, password string, meta appbackup.PackageMeta) (appbackup.Summary, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return appbackup.Summary{}, fmt.Errorf("获取用户目录失败: %w", err)
	}
	path := filepath.Join(homeDir, ".confscope", "app-data-recovery-points", appbackup.DefaultBackupFileName(meta))
	return a.WriteAppDataBackupFile(path, plaintextJSON, password, meta)
}

// TestAppDataWebDAV 测试应用数据备份 WebDAV 目标。
func (a *App) TestAppDataWebDAV(target appbackup.WebDAVTarget) error {
	return appbackup.NewWebDAVClient().Test(target)
}

// ListAppDataWebDAVBackups 列出 WebDAV 远端应用数据备份。
func (a *App) ListAppDataWebDAVBackups(target appbackup.WebDAVTarget) ([]appbackup.RemoteBackup, error) {
	return appbackup.NewWebDAVClient().List(target)
}

// UploadAppDataWebDAVBackup 加密并上传应用数据备份到 WebDAV。
func (a *App) UploadAppDataWebDAVBackup(target appbackup.WebDAVTarget, plaintextJSON string, password string, meta appbackup.PackageMeta) (appbackup.RemoteBackup, error) {
	packageBytes, _, err := appbackup.EncryptPackage([]byte(plaintextJSON), password, meta)
	if err != nil {
		return appbackup.RemoteBackup{}, err
	}
	return appbackup.NewWebDAVClient().Upload(target, appbackup.DefaultBackupFileName(meta), packageBytes)
}

// DownloadAppDataWebDAVBackup 下载并解密 WebDAV 应用数据备份。
func (a *App) DownloadAppDataWebDAVBackup(target appbackup.WebDAVTarget, remotePath string, password string) (appbackup.DecryptedPackage, error) {
	packageBytes, err := appbackup.NewWebDAVClient().Download(target, remotePath)
	if err != nil {
		return appbackup.DecryptedPackage{}, err
	}
	plaintext, summary, err := appbackup.DecryptPackage(packageBytes, password)
	if err != nil {
		return appbackup.DecryptedPackage{}, err
	}
	return appbackup.DecryptedPackage{PlaintextJSON: string(plaintext), Summary: summary}, nil
}

// startup 保存 Wails 运行上下文，供后续需要调用运行时能力时使用。
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.startNativeSmokeControl(ctx)
}

// shutdown 停止所有 SSH 隧道。
func (a *App) shutdown(ctx context.Context) {
	a.stopNativeSmokeControl()
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
	return errDirectWriteRequiresApplyPlan
}

// NacosPublishConfigFromApplyPlan 从 ApplyPlan 执行链路发布或更新指定配置。
func (a *App) NacosPublishConfigFromApplyPlan(
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
	return errDirectWriteRequiresApplyPlan
}

// NacosDeleteConfigFromApplyPlan 从 ApplyPlan 执行链路删除指定配置。
func (a *App) NacosDeleteConfigFromApplyPlan(
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

// ── 快照管理 Wails 绑定 ──

// CreateSnapshot 创建本地快照。
func (a *App) CreateSnapshot(source provider.SnapshotSource, configs []provider.ConfigSnapshot) (*provider.Snapshot, error) {
	// 获取快照存储目录
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("获取用户目录失败: %w", err)
	}
	snapshotDir := filepath.Join(homeDir, ".confscope", "backups")
	if err := os.MkdirAll(snapshotDir, 0755); err != nil {
		return nil, fmt.Errorf("创建快照目录失败: %w", err)
	}

	mgr := provider.NewSnapshotManager(snapshotDir)
	return mgr.CreateSnapshot(source, configs)
}

// GetSnapshot 获取快照。
func (a *App) GetSnapshot(id string) (*provider.Snapshot, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("获取用户目录失败: %w", err)
	}
	snapshotDir := filepath.Join(homeDir, ".confscope", "backups")

	mgr := provider.NewSnapshotManager(snapshotDir)
	return mgr.GetSnapshot(id)
}

// ListSnapshots 列出所有快照。
func (a *App) ListSnapshots() ([]provider.Snapshot, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("获取用户目录失败: %w", err)
	}
	snapshotDir := filepath.Join(homeDir, ".confscope", "backups")

	mgr := provider.NewSnapshotManager(snapshotDir)
	return mgr.ListSnapshots()
}

// DeleteSnapshot 删除快照。
func (a *App) DeleteSnapshot(id string) error {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("获取用户目录失败: %w", err)
	}
	snapshotDir := filepath.Join(homeDir, ".confscope", "backups")

	mgr := provider.NewSnapshotManager(snapshotDir)
	return mgr.DeleteSnapshot(id)
}

// TestSnapshotWebDAV 测试配置中心快照 WebDAV 目标。
func (a *App) TestSnapshotWebDAV(target snapshotwebdav.WebDAVTarget) error {
	return snapshotwebdav.NewWebDAVClient().Test(target)
}

// UploadSnapshotWebDAVPackage 加密并上传本地配置中心快照包到 WebDAV。
func (a *App) UploadSnapshotWebDAVPackage(target snapshotwebdav.WebDAVTarget, snapshotID string, password string) (snapshotwebdav.RemoteSnapshot, error) {
	snapshotDir, err := snapshotStorageDir()
	if err != nil {
		return snapshotwebdav.RemoteSnapshot{}, err
	}
	mgr := provider.NewSnapshotManager(snapshotDir)
	snapshot, err := mgr.GetSnapshot(snapshotID)
	if err != nil {
		return snapshotwebdav.RemoteSnapshot{}, err
	}
	packageBytes, _, err := snapshotwebdav.EncryptPackage(*snapshot, password)
	if err != nil {
		return snapshotwebdav.RemoteSnapshot{}, err
	}
	return snapshotwebdav.NewWebDAVClient().Upload(target, snapshotwebdav.DefaultPackageFileName(*snapshot), packageBytes)
}

// ListSnapshotWebDAVPackages 列出 WebDAV 远端配置中心快照包。
func (a *App) ListSnapshotWebDAVPackages(target snapshotwebdav.WebDAVTarget) ([]snapshotwebdav.RemoteSnapshot, error) {
	return snapshotwebdav.NewWebDAVClient().List(target)
}

// ImportSnapshotWebDAVPackage 下载并导入 WebDAV 配置中心快照包为本地快照。
func (a *App) ImportSnapshotWebDAVPackage(target snapshotwebdav.WebDAVTarget, remotePath string, password string) (*provider.Snapshot, error) {
	snapshotDir, err := snapshotStorageDir()
	if err != nil {
		return nil, err
	}
	packageBytes, err := snapshotwebdav.NewWebDAVClient().Download(target, remotePath)
	if err != nil {
		return nil, err
	}
	return snapshotwebdav.ImportPackage(snapshotDir, packageBytes, password, snapshotwebdav.ImportedFrom{RemotePath: remotePath})
}

// ValidateSnapshot 校验快照目录。
func (a *App) ValidateSnapshot(path string) error {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("获取用户目录失败: %w", err)
	}
	snapshotDir := filepath.Join(homeDir, ".confscope", "backups")

	mgr := provider.NewSnapshotManager(snapshotDir)
	return mgr.ValidateSnapshot(path)
}

func snapshotStorageDir() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("获取用户目录失败: %w", err)
	}
	snapshotDir := filepath.Join(homeDir, ".confscope", "backups")
	if err := os.MkdirAll(snapshotDir, 0755); err != nil {
		return "", fmt.Errorf("创建快照目录失败: %w", err)
	}
	return snapshotDir, nil
}
