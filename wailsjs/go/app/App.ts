// UpdateProxyConfig 是检查与下载共用的代理口径（对齐 internal/updatecheck.ProxyConfig）。
// 下载必须带上它，否则直连不通的用户查得到版本却下不动包。
export type UpdateProxyConfig = {
  httpProxy: string;
  httpsProxy: string;
  noProxy: string;
};

// 反馈信息能带出的运行环境事实（对齐 internal/app.FeedbackDiagnostics）。
// 只有这 5 项：路径、连接名、命名空间、配置正文都不在这里，前端想塞也得先改这个类型。
export type FeedbackDiagnostics = {
  version: string;
  platform: string;
  runtimeMode: string;
  packageFormat: string;
  assetName: string;
};

type GoApp = {
  GetAppInfo(): Promise<any>;
  CheckForUpdates(request: any): Promise<any>;
  DownloadUpdate(downloadURL: string, sha256: string, proxy: UpdateProxyConfig): Promise<string>;
  GetDownloadProgress(): Promise<any>;
  LaunchUpdateInstaller(downloadedFile: string): Promise<void>;
  RevealDownloadedArtifact(downloadedFile: string): Promise<void>;
  AttachUpdateImage(downloadedFile: string): Promise<void>;
  UpdateInstallCommand(downloadedFile: string): Promise<string>;
  ListActiveSSHTunnels(): Promise<string[]>;
  QuitApplication(): Promise<void>;
  GetCurrentPlatform(): Promise<string>;
  GetFeedbackDiagnostics(): Promise<FeedbackDiagnostics>;
  RunCredentialStorePoC(runID: string): Promise<CredentialStorePoCResult>;
  WriteSecureSecret(ref: SecureSecretRef, value: string): Promise<SecureSecretWriteResult>;
  ReadSecureSecret(ref: SecureSecretRef): Promise<string>;
  DeleteSecureSecret(ref: SecureSecretRef): Promise<void>;
  AppendAuditEvent(raw: string): Promise<void>;
  ClearAuditTrail(): Promise<void>;
  ReadAuditLogLines(limit: number): Promise<string[]>;
  AppendConfigRevision(input: ConfigRevisionInput): Promise<ConfigRevisionAppendResult>;
  ReadConfigRevisions(limit: number): Promise<ConfigRevisionRecord[]>;
  ReadConfigRevisionsForKey(
    connectionID: string,
    namespace: string,
    group: string,
    dataID: string,
    limit: number
  ): Promise<ConfigRevisionRecord[]>;
  PruneConfigRevisions(): Promise<number>;
  ClearConfigRevisions(): Promise<void>;
  GetConfigRevisionFacts(): Promise<ConfigRevisionFacts>;
  GetConfigRevisionPolicy(): Promise<ConfigRevisionPolicyView>;
  SaveConfigRevisionPolicy(keepPerKey: number): Promise<ConfigRevisionPolicyView>;
  SetConfigRevisionPinned(
    connectionID: string,
    namespace: string,
    group: string,
    dataID: string,
    hash: string,
    pinned: boolean
  ): Promise<ConfigRevisionPinResult>;
  SelectLocalSnapshotDirectory(): Promise<string>;
  ValidateLocalSnapshotDirectory(path: string): Promise<any>;
  SelectConfigSourceExportDirectory(): Promise<string>;
  ExportConfigSourceFiles(targetDir: string, source: any, configs: any[]): Promise<any>;
  ConfigCenterListNamespaces(profile: any): Promise<any>;
  ConfigCenterListConfigs(profile: any, request: any): Promise<any>;
  ConfigCenterGetConfig(profile: any, ref: any): Promise<any>;
  ConfigCenterPublishConfig(profile: any, request: any): Promise<void>;
  ConfigCenterDeleteConfig(profile: any, ref: any): Promise<void>;
  ConfigCenterPublishConfigFromApplyPlan(profile: any, request: any): Promise<void>;
  ConfigCenterDeleteConfigFromApplyPlan(profile: any, ref: any): Promise<void>;
  ConfigCenterListHistory(profile: any, ref: any, page: any): Promise<any>;
  ConfigCenterGetHistoryDetail(profile: any, ref: any, id: string): Promise<any>;
  ConfigCenterTestConnection(profile: any): Promise<void>;
  NacosDetectVersion(baseUrl: string): Promise<string>;
  NacosLogin(baseUrl: string, username: string, password: string, apiVersion: string): Promise<any>;
  NacosNamespaces(baseUrl: string, accessToken: string, apiVersion: string): Promise<any>;
  NacosListConfigs(
    baseUrl: string,
    accessToken: string,
    apiVersion: string,
    namespace: string,
    dataId: string,
    group: string,
    pageNo: number,
    pageSize: number
  ): Promise<any>;
  NacosGetConfig(
    baseUrl: string,
    accessToken: string,
    apiVersion: string,
    namespace: string,
    dataId: string,
    group: string
  ): Promise<string>;
  NacosHistoryList(
    baseUrl: string,
    accessToken: string,
    apiVersion: string,
    namespace: string,
    dataId: string,
    group: string,
    pageNo: number,
    pageSize: number
  ): Promise<any>;
  NacosHistoryDetail(
    baseUrl: string,
    accessToken: string,
    apiVersion: string,
    namespace: string,
    dataId: string,
    group: string,
    nid: string
  ): Promise<any>;
  NacosPublishConfig(
    baseUrl: string,
    accessToken: string,
    apiVersion: string,
    namespace: string,
    dataId: string,
    group: string,
    content: string,
    configType: string
  ): Promise<void>;
  NacosDeleteConfig(
    baseUrl: string,
    accessToken: string,
    apiVersion: string,
    namespace: string,
    dataId: string,
    group: string
  ): Promise<void>;
  NacosPublishConfigFromApplyPlan(
    baseUrl: string,
    accessToken: string,
    apiVersion: string,
    namespace: string,
    dataId: string,
    group: string,
    content: string,
    configType: string
  ): Promise<void>;
  NacosDeleteConfigFromApplyPlan(
    baseUrl: string,
    accessToken: string,
    apiVersion: string,
    namespace: string,
    dataId: string,
    group: string
  ): Promise<void>;
  CreateSSHTunnel(connectionId: string, config: any): Promise<number>;
  TestSSHConnection(config: any): Promise<any>;
  StopSSHTunnel(connectionId: string): Promise<void>;
  StopAllSSHTunnels(): Promise<void>;
  GetSSHTunnelLocalPort(connectionId: string): Promise<number>;
  // 快照管理
  CreateSnapshot(source: any, configs: any[]): Promise<any>;
  GetSnapshot(id: string): Promise<any>;
  ListSnapshots(): Promise<any[]>;
  DeleteSnapshot(id: string): Promise<void>;
  ValidateSnapshot(path: string): Promise<void>;
  SelectAppDataBackupSaveFile(defaultName: string): Promise<string>;
  SelectAppDataBackupOpenFile(): Promise<string>;
  WriteAppDataBackupFile(path: string, plaintextJson: string, password: string, meta: any): Promise<any>;
  ReadAppDataBackupFile(path: string, password: string): Promise<any>;
  CreateAppDataRecoveryPoint(plaintextJson: string, password: string, meta: any): Promise<any>;
  ListAppDataSnapshotFiles(): Promise<any[]>;
  RestoreAppDataSnapshotFiles(files: any[]): Promise<void>;
  TestAppDataWebDAV(target: any): Promise<void>;
  ListAppDataWebDAVBackups(target: any): Promise<any[]>;
  UploadAppDataWebDAVBackup(target: any, plaintextJson: string, password: string, meta: any): Promise<any>;
  DownloadAppDataWebDAVBackup(target: any, remotePath: string, password: string): Promise<any>;
  TestSnapshotWebDAV(target: any): Promise<void>;
  ListSnapshotWebDAVPackages(target: any): Promise<any[]>;
  UploadSnapshotWebDAVPackage(target: any, snapshotId: string, password: string): Promise<any>;
  ImportSnapshotWebDAVPackage(target: any, remotePath: string, password: string): Promise<any>;
  // 主数据文档（[数据根]/app-data/confscope-data.json）
  GetAppDataDocument(): Promise<AppDataDocumentStatus>;
  SaveAppDataDocument(document: AppDataDocument): Promise<AppDataDocumentStatus>;
  // 数据位置（设置页展示，可打开文件管理器定位）
  GetDataLocations(): Promise<DataLocations>;
  OpenDataFolder(key: string): Promise<void>;
  // 数据根运行形态与换根迁移（轮62）
  GetRuntimeLayout(): Promise<RuntimeLayoutInfo>;
  SelectDataRootDirectory(): Promise<string>;
  PlanDataRootMigration(target: string): Promise<DataRootMigrationPlan>;
  MigrateDataRoot(target: string): Promise<DataRootMigrationResult>;
  CheckDataRootRollback(): Promise<DataRootRollbackStatus>;
  RollbackDataRoot(): Promise<DataRootMigrationResult>;
};

export interface DataLocationEntry {
  key: string;
  path: string;
  isFile: boolean;
  exists: boolean;
}

export interface DataLocations {
  dataRoot: string;
  entries: DataLocationEntry[];
  mode: string;
  source: string;
  notes: string[];
}

export interface RuntimeLayoutInfo {
  mode: string;
  dataRoot: string;
  source: string;
  exeDir: string;
  exeDirWritable: boolean;
  pointerPath: string;
  previousRoot: string;
  osDataDir: string;
  notes: string[];
  error: string;
}

export interface DataRootMigrationPlan {
  source: string;
  target: string;
  mode: string;
  itemCount: number;
  totalBytes: number;
  hasSourceData: boolean;
  resumable: boolean;
  reusedItems: number;
  warnings: string[];
  requiresRestart: boolean;
  valid: boolean;
  error: string;
}

export interface DataRootMigrationResult {
  source: string;
  target: string;
  itemsCopied: number;
  itemsReused: number;
  pointerPath: string;
  migratedMarker: string;
  requiresRestart: boolean;
  restartReason: string;
  notes: string[];
  error: string;
}

export interface MainDataDocSummary {
  exists: boolean;
  path: string;
  savedAt: string;
  sizeBytes: number;
  sha256: string;
}

export interface DataRootRollbackStatus {
  available: boolean;
  currentRoot: string;
  previousRoot: string;
  currentDoc: MainDataDocSummary;
  previousDoc: MainDataDocSummary;
  reason: string;
}

export interface CredentialStorePoCResult {
  ok: boolean;
  targetName: string;
  readBackOk: boolean;
  deleted: boolean;
  valueSize: number;
}

export interface SecureSecretRef {
  namespace: string;
  ownerId: string;
  field: string;
}

export interface SecureSecretWriteResult {
  ref: SecureSecretRef;
  targetName: string;
  valueSize: number;
  verified: boolean;
}

export interface AppDataDocument {
  schemaVersion: number;
  savedAt: string;
  appVersion: string;
  data: any;
}

export interface AppDataDocumentStatus {
  exists: boolean;
  valid: boolean;
  path: string;
  schemaVersion: number;
  savedAt: string;
  appVersion: string;
  sizeBytes: number;
  corruptFile: string;
  document: AppDataDocument;
  error: string;
}

// ── 本机配置版本历史（internal/revisions，R57）──
// 手维护的绑定声明：字段名与 Go 侧 Record/Input 的 json tag 逐字对齐，
// 加字段必须同时改 internal/revisions/trail.go 与它的字段清单测试。

/** 前端提交的一条观测/写入事实：摘要、大小、超限裁剪、时间戳由 Go 决定，前端只说实话。 */
export interface ConfigRevisionInput {
  kind: string;
  connectionId: string;
  connectionName: string;
  provider: string;
  namespace: string;
  group: string;
  dataId: string;
  content: string;
  format: string;
  serverMd5: string;
  planId: string;
  appVersion: string;
}

export interface ConfigRevisionRecord {
  schema: number;
  ts: string;
  kind: string;
  connectionId: string;
  connectionName: string;
  provider: string;
  namespace: string;
  group: string;
  dataId: string;
  hash: string;
  serverMd5: string;
  bytes: number;
  format: string;
  content: string;
  contentOmittedReason: string;
  /** 仅在本版由 observed 升级为 confirmed-write 时出现：首见时刻不许被写入时刻盖掉。 */
  firstSeenTs: string;
  planId: string;
  appVersion: string;
}

export interface ConfigRevisionAppendResult {
  appended: boolean;
  /** duplicate = 同一版已记过（常态）；promoted = 同一版的来历就地升级为写入确认。 */
  reason: string;
  record: ConfigRevisionRecord;
}

export interface ConfigRevisionFacts {
  path: string;
  exists: boolean;
  records: number;
  sizeBytes: number;
  keys: number;
  /** 生效配额（磁盘策略钳制后的值），不是构建常量。 */
  keepPerKey: number;
  /** 生效配额的来源档：policy / default-missing / default-unreadable / default-out-of-range。 */
  keepSource: string;
  /** 钉住条目数（指向磁盘策略，不数日志行）。 */
  pinnedCount: number;
}

/** 一条钉住的身份：配置键四元组 + 正文摘要（不是时间戳，见 internal/revisions/policy.go）。 */
export interface ConfigRevisionPinnedRef {
  connectionId: string;
  namespace: string;
  group: string;
  dataId: string;
  hash: string;
}

/** 生效的保留策略：配额、来源档、合法区间与钉住清单（区间由这里给，前端不抄常量）。 */
export interface ConfigRevisionPolicyView {
  path: string;
  keepPerKey: number;
  keepSource: string;
  minKeepPerKey: number;
  maxKeepPerKey: number;
  defaultKeepPerKey: number;
  pinned: ConfigRevisionPinnedRef[];
  pinnedCount: number;
  /** 按当前上限已经多出来、下一次裁剪会被删掉的未钉住条数（「按新上限清理」据此说话）。 */
  unpinnedOverQuota: number;
}

/** 一次钉住/取消钉住的真实结局：hits 是命中的行数，钉不住时如实回 0。 */
export interface ConfigRevisionPinResult {
  pinned: boolean;
  hits: number;
  pinnedCount: number;
}

declare global {
  interface Window {
    go: {
      app: {
        App: GoApp;
      };
    };
  }
}

/**
 * 原生绑定缺失时抛这个，而不是留一句 `app().X is not a function`：
 * 报错必须说得出**是哪一个方法**没了。轮94 的白屏根因就是这个名字没人报出来 ——
 * 「关于」页挂载时取反馈事实，桥的方法表里少一个名字，整棵 React 树被卸载，
 * 探针读到的只是「提示没弹」，谁也没想到缺的是一颗方法表里的键。
 */
export class MissingNativeBindingError extends Error {
  readonly binding: string;

  constructor(binding: string) {
    super(`原生绑定 window.go.app.App.${binding} 不可用：` + `请确认 Go 侧方法名与本文件一致（复测环境需要由复测桥补上同名替身）`);
    this.name = "MissingNativeBindingError";
    this.binding = binding;
  }
}

/**
 * 唯一的原生调用出口（轮95）。两条不变式，缺一不可：
 *  ① **返回值永远是 Promise**。绑定缺失、`window.go` 还没注入、Go 侧同步抛错，
 *     一律退化成 rejection —— 调用点的 `.catch()` 与 errorCenter 抓得到。
 *     同步抛错会绕过这两层，在 render/effect 阶段炸穿，React 卸载整个 root。
 *  ② **报错里必须带方法名**。`x is not a function` 定位不到是哪颗绑定。
 *
 * 静态守卫 `tests/ux/nativeBindingsUseSingleAsyncExit.test.ts` 钉住这两条：
 * 本文件里除本函数外不得再出现 `window.go` 或 `app()` 形态的直接调用。
 */
function call<K extends keyof GoApp>(name: K, ...args: Parameters<GoApp[K]>): ReturnType<GoApp[K]> {
  const invoke = () => {
    const api = window.go?.app?.App;
    const candidate = api ? (api[name] as unknown) : undefined;
    if (typeof candidate !== "function") throw new MissingNativeBindingError(String(name));
    const method = candidate as (...a: Parameters<GoApp[K]>) => ReturnType<GoApp[K]>;
    return method(...args);
  };
  // 走 Promise.resolve().then 而不是 async 包装：GoApp 的方法一律声明成 Promise<...>，
  // 这样每个包装的对外签名与改造前**逐字一致**（调用点零漂移），而 invoke 里的同步抛错
  // 已经被 .then 的边界吃成 rejection —— 这正是这一层要买的唯一东西。
  return Promise.resolve().then(invoke) as ReturnType<GoApp[K]>;
}

export const GetAppInfo = () => call("GetAppInfo");

export const CheckForUpdates = (request: any) => call("CheckForUpdates", request);

export const DownloadUpdate = (downloadURL: string, sha256: string, proxy: UpdateProxyConfig) =>
  call("DownloadUpdate", downloadURL, sha256, proxy);

export const GetDownloadProgress = () => call("GetDownloadProgress");

// 升级的出路只有交给别人这几条，程序从不覆盖自己的二进制。
// 传空串表示回落到 Go 侧记住的最后一次下载结果（见 internal/app/app.go）。
export const LaunchUpdateInstaller = (downloadedFile: string) => call("LaunchUpdateInstaller", downloadedFile);

export const RevealDownloadedArtifact = (downloadedFile: string) => call("RevealDownloadedArtifact", downloadedFile);

export const AttachUpdateImage = (downloadedFile: string) => call("AttachUpdateImage", downloadedFile);

export const UpdateInstallCommand = (downloadedFile: string) => call("UpdateInstallCommand", downloadedFile);

export const ListActiveSSHTunnels = () => call("ListActiveSSHTunnels");

export const QuitApplication = () => call("QuitApplication");

export const GetCurrentPlatform = () => call("GetCurrentPlatform");

export const GetFeedbackDiagnostics = () => call("GetFeedbackDiagnostics");

export const RunCredentialStorePoC = (runID: string) => call("RunCredentialStorePoC", runID);

export const WriteSecureSecret = (ref: SecureSecretRef, value: string) => call("WriteSecureSecret", ref, value);

export const ReadSecureSecret = (ref: SecureSecretRef) => call("ReadSecureSecret", ref);

export const DeleteSecureSecret = (ref: SecureSecretRef) => call("DeleteSecureSecret", ref);

export const AppendAuditEvent = (raw: string) => call("AppendAuditEvent", raw);
export const ClearAuditTrail = () => call("ClearAuditTrail");

export const ReadAuditLogLines = (limit: number) => call("ReadAuditLogLines", limit);

export const AppendConfigRevision = (input: ConfigRevisionInput) => call("AppendConfigRevision", input);
export const ReadConfigRevisions = (limit: number) => call("ReadConfigRevisions", limit);
export const ReadConfigRevisionsForKey = (connectionID: string, namespace: string, group: string, dataID: string, limit: number) =>
  call("ReadConfigRevisionsForKey", connectionID, namespace, group, dataID, limit);
export const PruneConfigRevisions = () => call("PruneConfigRevisions");
export const ClearConfigRevisions = () => call("ClearConfigRevisions");
export const GetConfigRevisionFacts = () => call("GetConfigRevisionFacts");
export const GetConfigRevisionPolicy = () => call("GetConfigRevisionPolicy");
export const SaveConfigRevisionPolicy = (keepPerKey: number) => call("SaveConfigRevisionPolicy", keepPerKey);
export const SetConfigRevisionPinned = (
  connectionID: string,
  namespace: string,
  group: string,
  dataID: string,
  hash: string,
  pinned: boolean
) => call("SetConfigRevisionPinned", connectionID, namespace, group, dataID, hash, pinned);

export const SelectLocalSnapshotDirectory = () => call("SelectLocalSnapshotDirectory");

export const ValidateLocalSnapshotDirectory = (path: string) => call("ValidateLocalSnapshotDirectory", path);

export const SelectConfigSourceExportDirectory = () => call("SelectConfigSourceExportDirectory");

export const ExportConfigSourceFiles = (targetDir: string, source: any, configs: any[]) =>
  call("ExportConfigSourceFiles", targetDir, source, configs);

export const ConfigCenterListNamespaces = (profile: any) => call("ConfigCenterListNamespaces", profile);

export const ConfigCenterListConfigs = (profile: any, request: any) => call("ConfigCenterListConfigs", profile, request);

export const ConfigCenterGetConfig = (profile: any, ref: any) => call("ConfigCenterGetConfig", profile, ref);

export const ConfigCenterPublishConfig = (profile: any, request: any) => call("ConfigCenterPublishConfig", profile, request);

export const ConfigCenterDeleteConfig = (profile: any, ref: any) => call("ConfigCenterDeleteConfig", profile, ref);

export const ConfigCenterPublishConfigFromApplyPlan = (profile: any, request: any) =>
  call("ConfigCenterPublishConfigFromApplyPlan", profile, request);

export const ConfigCenterDeleteConfigFromApplyPlan = (profile: any, ref: any) =>
  call("ConfigCenterDeleteConfigFromApplyPlan", profile, ref);

export const ConfigCenterListHistory = (profile: any, ref: any, page: any) => call("ConfigCenterListHistory", profile, ref, page);

export const ConfigCenterGetHistoryDetail = (profile: any, ref: any, id: string) => call("ConfigCenterGetHistoryDetail", profile, ref, id);

export const ConfigCenterTestConnection = (profile: any) => call("ConfigCenterTestConnection", profile);

export const NacosDetectVersion = (baseUrl: string) => call("NacosDetectVersion", baseUrl);

export const NacosLogin = (baseUrl: string, username: string, password: string, apiVersion: string) =>
  call("NacosLogin", baseUrl, username, password, apiVersion);

export const NacosNamespaces = (baseUrl: string, accessToken: string, apiVersion: string) =>
  call("NacosNamespaces", baseUrl, accessToken, apiVersion);

export const NacosListConfigs = (
  baseUrl: string,
  accessToken: string,
  apiVersion: string,
  namespace: string,
  dataId: string,
  group: string,
  pageNo: number,
  pageSize: number
) => call("NacosListConfigs", baseUrl, accessToken, apiVersion, namespace, dataId, group, pageNo, pageSize);

export const NacosGetConfig = (
  baseUrl: string,
  accessToken: string,
  apiVersion: string,
  namespace: string,
  dataId: string,
  group: string
) => call("NacosGetConfig", baseUrl, accessToken, apiVersion, namespace, dataId, group);

export const NacosHistoryList = (
  baseUrl: string,
  accessToken: string,
  apiVersion: string,
  namespace: string,
  dataId: string,
  group: string,
  pageNo: number,
  pageSize: number
) => call("NacosHistoryList", baseUrl, accessToken, apiVersion, namespace, dataId, group, pageNo, pageSize);

export const NacosHistoryDetail = (
  baseUrl: string,
  accessToken: string,
  apiVersion: string,
  namespace: string,
  dataId: string,
  group: string,
  nid: string
) => call("NacosHistoryDetail", baseUrl, accessToken, apiVersion, namespace, dataId, group, nid);

export const NacosPublishConfig = (
  baseUrl: string,
  accessToken: string,
  apiVersion: string,
  namespace: string,
  dataId: string,
  group: string,
  content: string,
  configType: string
) => call("NacosPublishConfig", baseUrl, accessToken, apiVersion, namespace, dataId, group, content, configType);

export const NacosDeleteConfig = (
  baseUrl: string,
  accessToken: string,
  apiVersion: string,
  namespace: string,
  dataId: string,
  group: string
) => call("NacosDeleteConfig", baseUrl, accessToken, apiVersion, namespace, dataId, group);

export const NacosPublishConfigFromApplyPlan = (
  baseUrl: string,
  accessToken: string,
  apiVersion: string,
  namespace: string,
  dataId: string,
  group: string,
  content: string,
  configType: string
) => call("NacosPublishConfigFromApplyPlan", baseUrl, accessToken, apiVersion, namespace, dataId, group, content, configType);

export const NacosDeleteConfigFromApplyPlan = (
  baseUrl: string,
  accessToken: string,
  apiVersion: string,
  namespace: string,
  dataId: string,
  group: string
) => call("NacosDeleteConfigFromApplyPlan", baseUrl, accessToken, apiVersion, namespace, dataId, group);

export const CreateSSHTunnel = (connectionId: string, config: any) => call("CreateSSHTunnel", connectionId, config);

export const TestSSHConnection = (config: any) => call("TestSSHConnection", config);

export const StopSSHTunnel = (connectionId: string) => call("StopSSHTunnel", connectionId);

export const StopAllSSHTunnels = () => call("StopAllSSHTunnels");

export const GetSSHTunnelLocalPort = (connectionId: string) => call("GetSSHTunnelLocalPort", connectionId);

// 快照管理
export const CreateSnapshot = (source: any, configs: any[]) => call("CreateSnapshot", source, configs);

export const GetSnapshot = (id: string) => call("GetSnapshot", id);

export const ListSnapshots = () => call("ListSnapshots");

export const DeleteSnapshot = (id: string) => call("DeleteSnapshot", id);

export const ValidateSnapshot = (path: string) => call("ValidateSnapshot", path);

export const SelectAppDataBackupSaveFile = (defaultName: string) => call("SelectAppDataBackupSaveFile", defaultName);

export const SelectAppDataBackupOpenFile = () => call("SelectAppDataBackupOpenFile");

export const WriteAppDataBackupFile = (path: string, plaintextJson: string, password: string, meta: any) =>
  call("WriteAppDataBackupFile", path, plaintextJson, password, meta);

export const ReadAppDataBackupFile = (path: string, password: string) => call("ReadAppDataBackupFile", path, password);

export const CreateAppDataRecoveryPoint = (plaintextJson: string, password: string, meta: any) =>
  call("CreateAppDataRecoveryPoint", plaintextJson, password, meta);

export const ListAppDataSnapshotFiles = () => call("ListAppDataSnapshotFiles");

export const RestoreAppDataSnapshotFiles = (files: any[]) => call("RestoreAppDataSnapshotFiles", files);

export const TestAppDataWebDAV = (target: any) => call("TestAppDataWebDAV", target);

export const ListAppDataWebDAVBackups = (target: any) => call("ListAppDataWebDAVBackups", target);

export const UploadAppDataWebDAVBackup = (target: any, plaintextJson: string, password: string, meta: any) =>
  call("UploadAppDataWebDAVBackup", target, plaintextJson, password, meta);

export const DownloadAppDataWebDAVBackup = (target: any, remotePath: string, password: string) =>
  call("DownloadAppDataWebDAVBackup", target, remotePath, password);

export const GetAppDataDocument = () => call("GetAppDataDocument");

export const SaveAppDataDocument = (document: AppDataDocument) => call("SaveAppDataDocument", document);

// 数据位置
export const GetDataLocations = () => call("GetDataLocations");
export const OpenDataFolder = (key: string) => call("OpenDataFolder", key);

// 数据根运行形态与换根迁移
export const GetRuntimeLayout = () => call("GetRuntimeLayout");
export const SelectDataRootDirectory = () => call("SelectDataRootDirectory");
export const PlanDataRootMigration = (target: string) => call("PlanDataRootMigration", target);
export const MigrateDataRoot = (target: string) => call("MigrateDataRoot", target);
export const CheckDataRootRollback = () => call("CheckDataRootRollback");
export const RollbackDataRoot = () => call("RollbackDataRoot");

export const TestSnapshotWebDAV = (target: any) => call("TestSnapshotWebDAV", target);

export const ListSnapshotWebDAVPackages = (target: any) => call("ListSnapshotWebDAVPackages", target);

export const UploadSnapshotWebDAVPackage = (target: any, snapshotId: string, password: string) =>
  call("UploadSnapshotWebDAVPackage", target, snapshotId, password);

export const ImportSnapshotWebDAVPackage = (target: any, remotePath: string, password: string) =>
  call("ImportSnapshotWebDAVPackage", target, remotePath, password);

export {};
