import {
  CheckForUpdates,
  DownloadUpdate,
  GetAppInfo,
  GetCurrentPlatform,
  GetFeedbackDiagnostics,
  GetDownloadProgress,
  LaunchUpdateInstaller,
  RevealDownloadedArtifact,
  AttachUpdateImage,
  UpdateInstallCommand,
  ListActiveSSHTunnels,
  QuitApplication,
  type UpdateProxyConfig,
  ExportConfigSourceFiles,
  SelectConfigSourceExportDirectory,
  SelectLocalSnapshotDirectory,
  ValidateLocalSnapshotDirectory,
} from "../../wailsjs/go/app/App";
import type { ProxySettings } from "../store/settings";
import type { ConfigItem } from "./nacos";

export interface UpdateSource {
  name: string;
  url: string;
}

// 反馈通道能带出的运行环境事实。字段口径与 Go 侧 FeedbackDiagnostics 一一对应，
// 改字段要同时改 internal/app/app.go 旁边那条「必须只有 5 项」的用例。
export interface FeedbackDiagnostics {
  version: string;
  platform: string;
  runtimeMode: string;
  packageFormat: string;
  assetName: string;
}

export interface AppInfo {
  name: string;
  version: string;
  updateSources: UpdateSource[];
}

export interface CheckUpdatesRequest {
  currentVersion: string;
  sources: UpdateSource[];
  proxy: ProxySettings;
}

// 升级出路由 Go 侧选定，前端只认这五个值，不许按文件后缀自己猜形态。
// installer 起安装程序 / reveal 打开下载位置人工覆盖 / command 复制包管理器命令 /
// image 挂载 dmg / page 兜底打开下载页。
export type UpdateHandoff = "installer" | "reveal" | "command" | "image" | "page";

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  sourceName: string;
  sourceUrl: string;
  downloadUrl: string;
  releaseNotes: string;
  publishedAt: string;
  sha256: string;
  mandatory: boolean;
  checkedAt: string;
  error: string;
  platformKey: string;
  fileName: string;
  handoff: UpdateHandoff | "";
  downgraded: boolean;
  reason: string;
}

export interface DownloadProgress {
  downloaded: number;
  total: number;
  percent: number;
  done: boolean;
  error: string;
}

export interface LocalSnapshotValidation {
  valid: boolean;
  path: string;
  code: string;
  message: string;
  configCount: number;
  hasManifest: boolean;
  matchedMarkers: string[];
  schemaVersion: number;
  layout: string;
  legacy: boolean;
  checkedAt: string;
}

export interface ConfigSourceExportSource {
  provider?: string;
  connectionId: string;
  connectionName: string;
  namespace: string;
  namespaceId: string;
}

export interface ConfigSourceExportItem extends ConfigItem {
  namespace?: string;
  contentType?: string;
  updateTime?: string;
}

export interface ConfigSourceExportResult {
  path: string;
  configCount: number;
  manifest: string;
}

export function getAppInfo(): Promise<AppInfo> {
  return GetAppInfo();
}

export function checkForUpdates(request: CheckUpdatesRequest): Promise<UpdateCheckResult> {
  return CheckForUpdates(request);
}

// downloadUpdate 必须带代理：检查走代理而下载直连，是"查得到版本却下不动包"的根因。
export function downloadUpdate(downloadURL: string, sha256: string, proxy: ProxySettings): Promise<string> {
  return DownloadUpdate(downloadURL, sha256, proxy as UpdateProxyConfig);
}

export function getDownloadProgress(): Promise<DownloadProgress> {
  return GetDownloadProgress();
}

// 以下四个是"下载完成后"的分流动作，对应 UpdateCheckResult.handoff。
// 传空串表示让 Go 用它记住的最后一次下载结果。
export function launchUpdateInstaller(downloadedFile: string): Promise<void> {
  return LaunchUpdateInstaller(downloadedFile);
}

export function revealDownloadedArtifact(downloadedFile: string): Promise<void> {
  return RevealDownloadedArtifact(downloadedFile);
}

export function attachUpdateImage(downloadedFile: string): Promise<void> {
  return AttachUpdateImage(downloadedFile);
}

// 只拿命令文本供复制，程序既不提权也不代跑。
export function getUpdateInstallCommand(downloadedFile: string): Promise<string> {
  return UpdateInstallCommand(downloadedFile);
}

// 交接前的忙碌闸门：隧道表只住在 Go 侧，前端不再另存一份。
export function listActiveSSHTunnels(): Promise<string[]> {
  return ListActiveSSHTunnels();
}

// 唯一的人工闸门落点：前端确认数据已落盘后才允许调用。
export function quitApplication(): Promise<void> {
  return QuitApplication();
}

export function getCurrentPlatform(): Promise<string> {
  return GetCurrentPlatform();
}

// 反馈信息的唯一事实来源：形态判据住在 Go（portabledata 解析器 + DetectPackageFormat），
// 前端只负责排版，不再自己猜「我这是安装版还是便携版」。
export function getFeedbackDiagnostics(): Promise<FeedbackDiagnostics> {
  return GetFeedbackDiagnostics();
}

export function selectLocalSnapshotDirectory(): Promise<string> {
  return SelectLocalSnapshotDirectory();
}

export function validateLocalSnapshotDirectory(path: string): Promise<LocalSnapshotValidation> {
  return ValidateLocalSnapshotDirectory(path);
}

export function selectConfigSourceExportDirectory(): Promise<string> {
  return SelectConfigSourceExportDirectory();
}

export function exportConfigSourceFiles(
  targetDir: string,
  source: ConfigSourceExportSource,
  configs: ConfigSourceExportItem[]
): Promise<ConfigSourceExportResult> {
  return ExportConfigSourceFiles(targetDir, source, configs) as Promise<ConfigSourceExportResult>;
}
