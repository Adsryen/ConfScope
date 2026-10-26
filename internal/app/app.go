package app

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"confscope/internal/appbackup"
	"confscope/internal/nacos"
	"confscope/internal/portabledata"
	"confscope/internal/provider"
	"confscope/internal/revisions"
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

type AppDataSnapshotFile struct {
	Path          string `json:"path"`
	ContentBase64 string `json:"contentBase64"`
	Mode          uint32 `json:"mode"`
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

	// revisions 是本机配置版本历史的状态句柄（见 app_revisions.go）。
	// 绑定可能并发调用，句柄用 once 建，不给它第二次写指针的机会。
	revisionsOnce sync.Once
	revisions     *revisions.Store
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
//
// req.Mode / req.PackageFormat 在这里被 Go 侧覆盖：前端传什么都不认。
// 「该取哪个产物」只能由程序按运行形态算一次，多一处事实源就多一次
// 「便携版下到安装包 / deb 装的下到 tar.gz」的错配。
func (a *App) CheckForUpdates(req updatecheck.Request) updatecheck.Result {
	if req.CurrentVersion == "" {
		req.CurrentVersion = appVersion
	}
	req.Mode, req.PackageFormat = currentRuntimeShape()
	return updatecheck.Check(context.Background(), req)
}

// currentRuntimeShape 组装更新链路需要的运行形态事实。
// 模式判据复用数据根解析器（唯一事实源）：读不到就按便携态处理，
// 保守出路是「下载 + 人工覆盖」，绝不会误起安装程序。
func currentRuntimeShape() (portabledata.RuntimeMode, string) {
	mode := portabledata.RuntimeModePortable
	if layout, err := currentRuntimeLayout(); err == nil {
		mode = layout.Mode
	}
	return mode, updatecheck.DetectPackageFormat()
}

// FeedbackDiagnostics 是「复制反馈信息」允许带出的全部事实（轮80）。
//
// 为什么只有这五项：这段文本会被用户原样粘进公开 Issue，所以凡是能定位到人或到环境的都不许进来——
// 数据根与日志路径（含 Windows 用户名）、连接名、命名空间与租户名、配置正文、报错原文（常带内网 IP
// 与主机名）一律排除。口径与 tests/ux/publicScreenshotsStaySanitized.test.ts 守的公开面一致。
//
// 为什么由 Go 组装而不是前端拼：运行形态的唯一事实源是 portabledata 解析器 +
// updatecheck.DetectPackageFormat（与 CheckForUpdates 覆盖 req.Mode/PackageFormat 同一条理由），
// 前端猜一套就会和更新链路各猜一次、猜歪一次。
type FeedbackDiagnostics struct {
	Version       string `json:"version"`
	Platform      string `json:"platform"`
	RuntimeMode   string `json:"runtimeMode"`
	PackageFormat string `json:"packageFormat"`
	AssetName     string `json:"assetName"`
}

// GetFeedbackDiagnostics 返回脱敏后的运行环境事实，供 About 页「复制反馈信息」使用。
func (a *App) GetFeedbackDiagnostics() FeedbackDiagnostics {
	mode, format := currentRuntimeShape()
	sel := updatecheck.CurrentSelection(mode, format)
	return FeedbackDiagnostics{
		Version:       appVersion,
		Platform:      sel.Platform,
		RuntimeMode:   string(sel.Mode),
		PackageFormat: sel.PackageFormat,
		AssetName:     sel.ExpectedAssetName(),
	}
}

// GetCurrentPlatform 返回当前平台标识，如 "windows-amd64"。
func (a *App) GetCurrentPlatform() string {
	return updatecheck.CurrentPlatform()
}

// DownloadUpdate 下载更新文件，通过 Wails 事件报告进度。
// 返回下载后的临时文件路径。proxy 必须与检查更新用的一致，
// 否则「查得到版本却下不动包」的直连不通用户还是走不完链路。
func (a *App) DownloadUpdate(downloadURL string, sha256 string, proxy updatecheck.ProxyConfig) (string, error) {
	a.downloadMu.Lock()
	a.downloadProgress = updatecheck.DownloadProgress{}
	a.downloadErr = ""
	a.downloadedFile = ""
	a.downloadMu.Unlock()

	ctx := context.Background()
	if a.ctx != nil {
		ctx = a.ctx
	}

	filePath, err := updatecheck.Download(ctx, downloadURL, sha256, proxy, func(p updatecheck.DownloadProgress) {
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

// LaunchUpdateInstaller 把升级交给 Windows 安装程序（带 /UPDATE 与本次进程 PID），
// 成功后由前端触发优雅退出。程序不碰自己的二进制 —— 「什么时候可以覆盖」
// 是安装程序的责任，不是一个隐藏脚本的责任。
func (a *App) LaunchUpdateInstaller(downloadedFile string) error {
	path, err := a.downloadedArtifactPath(downloadedFile)
	if err != nil {
		return err
	}
	return updatecheck.LaunchUpdateInstaller(path)
}

// RevealDownloadedArtifact 打开下载位置，覆盖动作由人来做（便携版/裸产物）。
func (a *App) RevealDownloadedArtifact(downloadedFile string) error {
	path, err := a.downloadedArtifactPath(downloadedFile)
	if err != nil {
		return err
	}
	return updatecheck.RevealDownloadedArtifact(path)
}

// AttachUpdateImage 挂载 macOS 更新镜像并打开卷窗口，由人拖进 Applications。
func (a *App) AttachUpdateImage(downloadedFile string) error {
	path, err := a.downloadedArtifactPath(downloadedFile)
	if err != nil {
		return err
	}
	return updatecheck.AttachUpdateImage(path)
}

// UpdateInstallCommand 给出 Linux 包管理器的安装命令供复制。
// 只给命令，不提权、不代跑：程序不应该在用户看不见的地方拿到 root。
func (a *App) UpdateInstallCommand(downloadedFile string) string {
	path, err := a.downloadedArtifactPath(downloadedFile)
	if err != nil {
		return ""
	}
	_, packageFormat := currentRuntimeShape()
	return updatecheck.InstallCommandFor(path, packageFormat)
}

// downloadedArtifactPath 允许前端传空串回落到最后一次下载结果，
// 这样"重新打开下载位置"不需要前端自己保存路径。
func (a *App) downloadedArtifactPath(downloadedFile string) (string, error) {
	candidate := strings.TrimSpace(downloadedFile)
	if candidate == "" {
		a.downloadMu.Lock()
		candidate = a.downloadedFile
		a.downloadMu.Unlock()
	}
	if candidate == "" {
		return "", errors.New("还没有下载好的更新包")
	}
	return candidate, nil
}

// ListActiveSSHTunnels 返回当前有隧道的连接标识，供升级交接的忙碌闸门点名。
// 只有隧道表自己知道真有几个隧道：前端另存一份会漂，Go 侧才是事实源。
func (a *App) ListActiveSSHTunnels() []string {
	if a.sshMgr == nil {
		return []string{}
	}
	ids := a.sshMgr.ActiveConnectionIDs()
	if ids == nil {
		return []string{}
	}
	return ids
}

// QuitApplication 优雅退出（升级交接的唯一人工闸门落点）。
// 走到这里之前前端必须已经落盘主数据：强杀一律禁止，
// 主数据是 debounce 写的，被强杀等于吃掉最后一次变更。
func (a *App) QuitApplication() error {
	if a.ctx == nil {
		return errors.New("wails runtime is not ready")
	}
	runtime.Quit(a.ctx)
	return nil
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

func (a *App) SelectConfigSourceExportDirectory() (string, error) {
	if a.ctx == nil {
		return "", errors.New("wails runtime is not ready")
	}
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "选择配置源文件导出目录",
	})
}

// ExportConfigSourceFiles 将配置浏览当前列表导出为可浏览/可对比的源文件目录。
func (a *App) ExportConfigSourceFiles(targetDir string, source provider.SnapshotSource, configs []provider.ConfigSnapshot) (provider.ConfigSourceExportResult, error) {
	return provider.WriteConfigSourceDirectory(targetDir, source, configs)
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
	recoveryDir, err := appDataRecoveryPointStorageDir()
	if err != nil {
		return appbackup.Summary{}, err
	}
	path := filepath.Join(recoveryDir, appbackup.DefaultBackupFileName(meta))
	return a.WriteAppDataBackupFile(path, plaintextJSON, password, meta)
}

// ListAppDataSnapshotFiles 读取便携快照目录文件，供应用数据备份打包。
func (a *App) ListAppDataSnapshotFiles() ([]AppDataSnapshotFile, error) {
	snapshotDir, err := snapshotStorageDir()
	if err != nil {
		return nil, err
	}
	files := []AppDataSnapshotFile{}
	err = filepath.WalkDir(snapshotDir, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(snapshotDir, path)
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		files = append(files, AppDataSnapshotFile{
			Path:          filepath.ToSlash(rel),
			ContentBase64: base64.StdEncoding.EncodeToString(content),
			Mode:          uint32(info.Mode().Perm()),
		})
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("读取快照文件失败: %w", err)
	}
	return files, nil
}

// RestoreAppDataSnapshotFiles 将应用数据备份中的快照文件恢复到便携快照目录。
func (a *App) RestoreAppDataSnapshotFiles(files []AppDataSnapshotFile) error {
	snapshotDir, err := snapshotStorageDir()
	if err != nil {
		return err
	}
	for _, file := range files {
		target, err := safeSnapshotBackupFilePath(snapshotDir, file.Path)
		if err != nil {
			return err
		}
		content, err := base64.StdEncoding.DecodeString(file.ContentBase64)
		if err != nil {
			return fmt.Errorf("解析快照文件失败 %s: %w", file.Path, err)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return fmt.Errorf("创建快照恢复目录失败: %w", err)
		}
		mode := os.FileMode(file.Mode)
		if mode == 0 {
			mode = 0o644
		}
		if err := os.WriteFile(target, content, mode.Perm()); err != nil {
			return fmt.Errorf("写入快照文件失败 %s: %w", file.Path, err)
		}
	}
	return nil
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
func (a *App) Startup(ctx context.Context) {
	a.ctx = ctx
	a.startNativeSmokeControl(ctx)
}

// shutdownTunnelCeiling 是退出收尾给「关掉所有 SSH 隧道」的硬上限。
// 取值只看一件事：Wails 已经销毁窗口，用户此刻看到的是「程序没了但还占着文件」，
// 每多等一秒，Windows 安装程序就多等一秒。2s 足够让正常的 Close 走完。
const shutdownTunnelCeiling = 2 * time.Second

// stopAllTunnelsOnShutdown 是退出收尾里「关掉所有隧道」这一脚的接缝。
// 默认实现只有一条：带硬上限的那一支。存在的意义是让「退出到底走没走上限」
// 能被单测直接钉住——否则这一脚只能在真机上复现，改回无上限版本也没人报警。
var stopAllTunnelsOnShutdown = func(mgr *ssh.Manager, ceiling time.Duration) []string {
	return mgr.StopAllWithCeiling(ceiling)
}

// shutdown 收尾：停本地探针，再停所有 SSH 隧道 —— 并且给后者设硬上限。
//
// 上限是这一轮加的：窗口销毁之后进程必须真的退出去。只要进程还活着，
// 它的 exe 就被系统当作镜像加载着，安装程序覆盖前那道「目标文件能不能写」的
// 探针就永远过不去，用户看到的症状就是「等待 ConfScope 退出」无限打转。
// 一条拨不动的隧道不该拿走整个程序的退出能力：到点点名记一笔日志然后放行。
func (a *App) Shutdown(ctx context.Context) {
	a.stopNativeSmokeControl()
	if a.sshMgr == nil {
		return
	}
	pending := stopAllTunnelsOnShutdown(a.sshMgr, shutdownTunnelCeiling)
	if len(pending) == 0 {
		return
	}
	a.reportPendingTunnelsOnShutdown(pending)
}

// reportPendingTunnelsOnShutdown 把「哪条连接拖住了退出」写进数据根的日志。
// 桌面应用没有控制台，println 在 Windows 上到不了任何地方，所以落点在
// [数据根]/logs/data-root.log（与启动时的数据根解析同一支笔，best-effort）。
func (a *App) reportPendingTunnelsOnShutdown(pending []string) {
	line := fmt.Sprintf("shutdown\t退出时未在 %s 内关闭的 SSH 隧道（已放行退出，请检查这些连接的目标是否可达）: %s",
		shutdownTunnelCeiling, strings.Join(nonNilStrings(pending), ", "))
	println("Shutdown:", line)
	root, err := a.appDataRoot()
	if err != nil {
		return
	}
	shutdownLogf(root, line)
}

// shutdownLogf 是退出诊断的落点，测试里换成内存收集器（不碰真实文件）。
var shutdownLogf = portabledata.AppendRuntimeLogLine

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

// NacosGetConfig 获取指定配置的内容（v1 额外查询列表接口取 md5，仅用于 apply plan 指纹）。
func (a *App) NacosGetConfig(
	baseUrl string,
	accessToken string,
	apiVersion string,
	namespace string,
	dataId string,
	group string,
) (string, error) {
	result, err := a.nacos.GetConfig(baseUrl, accessToken, apiVersion, namespace, dataId, group)
	if err != nil {
		return "", err
	}
	return result.Content, nil
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
	snapshotDir, err := snapshotStorageDir()
	if err != nil {
		return nil, err
	}
	mgr := provider.NewSnapshotManager(snapshotDir)
	return mgr.CreateSnapshot(source, configs)
}

// GetSnapshot 获取快照。
func (a *App) GetSnapshot(id string) (*provider.Snapshot, error) {
	snapshotDir, err := snapshotStorageDir()
	if err != nil {
		return nil, err
	}
	mgr := provider.NewSnapshotManager(snapshotDir)
	return mgr.GetSnapshot(id)
}

// ListSnapshots 列出所有快照。
func (a *App) ListSnapshots() ([]provider.Snapshot, error) {
	snapshotDir, err := snapshotStorageDir()
	if err != nil {
		return nil, err
	}
	mgr := provider.NewSnapshotManager(snapshotDir)
	return mgr.ListSnapshots()
}

// DeleteSnapshot 删除快照。
func (a *App) DeleteSnapshot(id string) error {
	snapshotDir, err := snapshotStorageDir()
	if err != nil {
		return err
	}
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
	snapshotDir, err := snapshotStorageDir()
	if err != nil {
		return err
	}
	mgr := provider.NewSnapshotManager(snapshotDir)
	return mgr.ValidateSnapshot(path)
}

func snapshotStorageDir() (string, error) {
	exePath, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("获取程序路径失败: %w", err)
	}
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("获取用户目录失败: %w", err)
	}
	return snapshotStorageDirFor(exePath, homeDir)
}

func snapshotStorageDirFor(exePath string, homeDir string) (string, error) {
	snapshotDir, err := portabledata.PrepareSnapshotDataFor(exePath, homeDir)
	if err != nil {
		return "", fmt.Errorf("准备快照目录失败: %w", err)
	}
	return snapshotDir, nil
}

func appDataRecoveryPointStorageDir() (string, error) {
	exePath, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("获取程序路径失败: %w", err)
	}
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("获取用户目录失败: %w", err)
	}
	recoveryDir, err := portabledata.PrepareAppDataRecoveryPointDataFor(exePath, homeDir)
	if err != nil {
		return "", fmt.Errorf("准备应用数据恢复点目录失败: %w", err)
	}
	return recoveryDir, nil
}

func safeSnapshotBackupFilePath(root string, relPath string) (string, error) {
	relPath = strings.TrimSpace(relPath)
	if relPath == "" {
		return "", fmt.Errorf("快照文件路径不能为空")
	}
	slashed := filepath.ToSlash(relPath)
	if filepath.IsAbs(relPath) || strings.HasPrefix(slashed, "/") {
		return "", fmt.Errorf("快照文件路径不安全: %s", relPath)
	}
	parts := strings.Split(slashed, "/")
	cleanParts := make([]string, 0, len(parts))
	for _, part := range parts {
		if part == "" || part == "." {
			continue
		}
		if part == ".." {
			return "", fmt.Errorf("快照文件路径不安全: %s", relPath)
		}
		cleanParts = append(cleanParts, part)
	}
	if len(cleanParts) == 0 {
		return "", fmt.Errorf("快照文件路径不能为空")
	}
	target := filepath.Join(append([]string{root}, cleanParts...)...)
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return "", fmt.Errorf("计算快照文件路径失败: %w", err)
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("快照文件路径不安全: %s", relPath)
	}
	return target, nil
}
