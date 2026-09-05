import {
  NacosDeleteConfigFromApplyPlan,
  NacosDetectVersion,
  NacosLogin,
  NacosPublishConfigFromApplyPlan,
  CreateSSHTunnel,
  GetSSHTunnelLocalPort,
  StopSSHTunnel,
} from "../../wailsjs/go/app/App";
import {
  getConfig as configCenterGetConfig,
  getHistoryDetail as configCenterGetHistoryDetail,
  deleteConfigFromApplyPlan as configCenterDeleteConfigFromApplyPlan,
  listConfigs as configCenterListConfigs,
  listHistory as configCenterListHistory,
  listNamespaces as configCenterListNamespaces,
  publishConfigFromApplyPlan as configCenterPublishConfigFromApplyPlan,
  testConnection as configCenterTestConnection,
  type ConfigDocument as ConfigCenterConfigDocument,
  type ConfigPage as ConfigCenterConfigPage,
  type ConfigRef,
  type ConnectionProfile,
  type HistoryDetail as ConfigCenterHistoryDetail,
  type HistoryPage as ConfigCenterHistoryPage,
  type Namespace as ConfigCenterNamespace,
  type ProviderType,
} from "./configCenter";
import { translate } from "../locales";
import type { Connection } from "../store/connections";
import { connectionSSHConfig } from "../store/sshProfiles";
import { hydrateConnectionSecrets } from "../lib/credentialSecrets";

// ── SSH 隧道缓存：按连接 id 缓存隧道的本地 baseUrl ──
const tunnelUrlCache = new Map<string, string>();
const tunnelCreationCache = new Map<string, Promise<string>>();

function normalizeNacosBaseUrl(baseUrl: string): string {
  const value = baseUrl.trim();
  if (!value) return value;
  if (/^https?:\/\//i.test(value)) return value;
  return `http://${value}`;
}

function tunnelUrlFor(originalBaseUrl: string, localPort: number): string {
  const url = new URL(originalBaseUrl);
  return `${url.protocol}//127.0.0.1:${localPort}${url.pathname}`;
}

async function cachedTunnelUrl(conn: Connection, originalBaseUrl: string): Promise<string | null> {
  const cached = tunnelUrlCache.get(conn.id);
  if (!cached) return null;
  try {
    const currentPort = await GetSSHTunnelLocalPort(conn.id);
    if (currentPort > 0) {
      const currentUrl = tunnelUrlFor(originalBaseUrl, currentPort);
      if (currentUrl !== cached) {
        tunnelUrlCache.set(conn.id, currentUrl);
      }
      return currentUrl;
    }
    return cached;
  } catch {
    tunnelUrlCache.delete(conn.id);
    return null;
  }
}

async function createTunnelUrl(conn: Connection, originalBaseUrl: string): Promise<string> {
  const sshConfig = connectionSSHConfig(conn);
  if (!sshConfig) return originalBaseUrl;

  // 解析原始 baseUrl，提取 context-path 和协议
  const url = new URL(originalBaseUrl);
  const remotePort = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;

  // 创建 SSH 隧道
  const localPort = await CreateSSHTunnel(conn.id, {
    host: sshConfig.host,
    port: sshConfig.port,
    username: sshConfig.username,
    authType: sshConfig.authType,
    password: sshConfig.password || "",
    privateKey: sshConfig.privateKey || "",
    passphrase: sshConfig.passphrase || "",
    localPort: sshConfig.localPort || 0,
    remotePort,
    remoteHost: url.hostname,
  });

  // 用本地隧道端口替换原始 URL 的端口；固定使用 IPv4，避免 Windows localhost 解析到 ::1。
  const tunnelUrl = tunnelUrlFor(originalBaseUrl, localPort);
  tunnelUrlCache.set(conn.id, tunnelUrl);
  return tunnelUrl;
}

/** 解析连接的有效 baseUrl：如果有 SSH 隧道配置则通过隧道访问。 */
export async function resolveBaseUrl(conn: Connection): Promise<string> {
  if (conn.sourceType === "local-snapshot") return conn.localPath || conn.baseUrl;
  const originalBaseUrl = normalizeNacosBaseUrl(conn.baseUrl);
  const sshConfig = connectionSSHConfig(conn);
  if (!sshConfig) return originalBaseUrl;

  const cached = await cachedTunnelUrl(conn, originalBaseUrl);
  if (cached) return cached;

  const creating = tunnelCreationCache.get(conn.id);
  if (creating) return creating;

  const next = createTunnelUrl(conn, originalBaseUrl);
  tunnelCreationCache.set(conn.id, next);
  try {
    return await next;
  } finally {
    if (tunnelCreationCache.get(conn.id) === next) {
      tunnelCreationCache.delete(conn.id);
    }
  }
}

/** 清除某连接的 SSH 隧道。 */
export function closeTunnel(connId: string) {
  tunnelUrlCache.delete(connId);
  tunnelCreationCache.delete(connId);
  StopSSHTunnel(connId);
}


function hasSSHConfig(conn: Connection): boolean {
  return !!connectionSSHConfig(conn);
}

function isLocalTunnelTransportError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  const transportMarkers = [
    "wsarecv",
    "forcibly closed",
    "actively refused",
    "connection refused",
    "connectex",
    "dial tcp",
    "read tcp",
    "unexpected eof",
    "eof",
    "reset by peer",
    "broken pipe",
    "no connection could be made",
  ];
  const hasTransportMarker = transportMarkers.some((marker) => message.includes(marker));
  if (!hasTransportMarker) return false;

  const targetsLocalTunnel =
    message.includes("localhost") || message.includes("127.0.0.1") || message.includes("[::1]") || message.includes("::1");
  const lostLoginResponse = message.includes("读取登录响应失败") || message.includes("login response") || message.includes("登录请求失败");
  return targetsLocalTunnel || lostLoginResponse;
}

async function resetTunnelState(conn: Connection) {
  tokenCache.delete(conn.id);
  versionCache.delete(conn.baseUrl);
  tunnelUrlCache.delete(conn.id);
  tunnelCreationCache.delete(conn.id);
  try {
    await StopSSHTunnel(conn.id);
  } catch {
    // Ignore stop failures: the tunnel is already unhealthy; the retry should attempt a fresh tunnel.
  }
}

async function withTunnelReconnect<T>(conn: Connection, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!hasSSHConfig(conn) || !isLocalTunnelTransportError(error)) throw error;
    await resetTunnelState(conn);
    return operation();
  }
}

// ── 与 Go 端对应的返回类型 ──
export interface LoginResult {
  accessToken: string;
  tokenTtl: number;
  globalAdmin: boolean;
}

export interface Namespace {
  namespace: string;
  namespaceShowName: string;
  configCount: number;
  kind: number;
}

export interface ConfigItem {
  dataId: string;
  group: string;
  content: string;
  configType: string;
  updateTime?: string;
}

export interface ConfigPage {
  totalCount: number;
  pageNumber: number;
  pagesAvailable: number;
  pageItems: ConfigItem[];
}

export interface ConfigDocument {
  content: string;
  format: string;
  version: string;
  source: string;
  updateTime: string;
  /** 内容摘要（Nacos v1 列表接口 md5），供 apply plan 内容级指纹。 */
  md5?: string;
}

export interface HistoryItem {
  id: string;
  dataId: string;
  group: string;
  opType: string;
  lastModifiedTime: string;
}

export interface HistoryPage {
  totalCount: number;
  pageNumber: number;
  pagesAvailable: number;
  pageItems: HistoryItem[];
}

export interface HistoryDetail {
  id: string;
  dataId: string;
  group: string;
  content: string;
  opType: string;
  createdTime: string;
  lastModifiedTime: string;
}

export type ApiVersion = "v1" | "v3";

// ── API 版本探测缓存：每个连接（按 baseUrl）探测一次 ──
const versionCache = new Map<string, ApiVersion>();

/** 探测并缓存连接的 Nacos API 版本（v1=1.x/2.x，v3=3.x）。 */
export async function getVersion(conn: Connection): Promise<ApiVersion> {
  if (conn.sourceType === "local-snapshot") return "v1";
  if (conn.authType === "aliyun-aksk") return "v1";
  const hit = versionCache.get(conn.baseUrl);
  if (hit) return hit;
  const baseUrl = await resolveBaseUrl(conn);
  const v = (await NacosDetectVersion(baseUrl)) as ApiVersion;
  const ver: ApiVersion = v === "v3" ? "v3" : "v1";
  versionCache.set(conn.baseUrl, ver);
  return ver;
}

// ── accessToken 缓存：按连接 id 缓存，带过期时间 ──
interface CachedToken {
  token: string;
  expireAt: number;
}
const tokenCache = new Map<string, CachedToken>();

/** 拿到一个可用的 accessToken：缓存命中且未过期直接返回，否则登录刷新。
 *  未填账号（未开启鉴权）的连接返回空串。 */
export async function getToken(conn: Connection, force = false): Promise<string> {
  if (conn.sourceType === "local-snapshot") return "";
  if (!conn.username) return "";
  const cached = tokenCache.get(conn.id);
  if (!force && cached && Date.now() < cached.expireAt) return cached.token;

  const apiVersion = await getVersion(conn);
  const baseUrl = await resolveBaseUrl(conn);
  const credentialConn = await hydrateConnectionSecrets(conn);
  const res = await NacosLogin(baseUrl, credentialConn.username, credentialConn.password, apiVersion);
  const ttl = res.tokenTtl > 0 ? res.tokenTtl : 18000;
  tokenCache.set(conn.id, {
    token: res.accessToken,
    expireAt: Date.now() + (ttl - 30) * 1000,
  });
  return res.accessToken;
}

/** 清掉某连接的 token、版本与隧道缓存（凭据/地址改动或删除时调用）。 */
export function clearToken(connId: string, baseUrl?: string) {
  tokenCache.delete(connId);
  if (baseUrl) versionCache.delete(baseUrl);
  closeTunnel(connId);
}

/** 包一层「403 自动重登重试」+ 自动注入 apiVersion。 */
async function withAuth<T>(conn: Connection, call: (token: string, apiVersion: ApiVersion) => Promise<T>): Promise<T> {
  return withTunnelReconnect(conn, async () => {
    const apiVersion = await getVersion(conn);
    const token = await getToken(conn);
    try {
      return await call(token, apiVersion);
    } catch (e) {
      const msg = String(e);
      if (conn.username && (msg.includes("403") || msg.includes("token") || msg.includes("code=403"))) {
        const fresh = await getToken(conn, true);
        return await call(fresh, apiVersion);
      }
      throw e;
    }
  });
}


async function withProfile<T>(conn: Connection, call: (profile: ConnectionProfile) => Promise<T>): Promise<T> {
  return withTunnelReconnect(conn, async () => {
    const credentialConn = await hydrateConnectionSecrets(conn);
    if (conn.sourceType === "local-snapshot") {
      const baseUrl = await resolveBaseUrl(conn);
      return call(toConnectionProfile(credentialConn, baseUrl, "", "v1"));
    }
    if ((conn.provider ?? "nacos") === "apollo") {
      const baseUrl = await resolveBaseUrl(conn);
      return call(toConnectionProfile(credentialConn, baseUrl, credentialConn.apolloToken ?? "", ""));
    }
    if ((conn.provider ?? "nacos") === "consul") {
      const baseUrl = await resolveBaseUrl(conn);
      return call(toConnectionProfile(credentialConn, baseUrl, credentialConn.consulToken ?? "", ""));
    }
    const apiVersion = await getVersion(conn);
    const accessToken = await getToken(conn);
    const baseUrl = await resolveBaseUrl(conn);
    try {
      return await call(toConnectionProfile(credentialConn, baseUrl, accessToken, apiVersion));
    } catch (e) {
      const msg = String(e);
      if (conn.username && (msg.includes("403") || msg.includes("token") || msg.includes("code=403"))) {
        const fresh = await getToken(conn, true);
        return await call(toConnectionProfile(credentialConn, baseUrl, fresh, apiVersion));
      }
      throw e;
    }
  });
}

function providerForConnection(conn: Connection): ProviderType {
  if (conn.sourceType === "local-snapshot") return "local";
  return conn.provider ?? "nacos";
}

function toConnectionProfile(conn: Connection, baseUrl: string, accessToken: string, apiVersion: string): ConnectionProfile {
  const optional = conn as Connection & { environment?: string; safetyLevel?: string };
  const provider = providerForConnection(conn);
  const isApollo = provider === "apollo";
  const isConsul = provider === "consul";
  return {
    id: conn.id,
    name: conn.name,
    provider,
    distribution: conn.distribution ?? "opensource",
    authType:
      conn.sourceType === "local-snapshot" || provider === "apollo" || provider === "consul"
        ? "none"
        : (conn.authType ?? (conn.username ? "nacos-password" : "none")),
    baseUrl,
    accessToken,
    apiVersion,
    accessKeyId: conn.accessKeyId ?? "",
    accessKeySecret: conn.accessKeySecret ?? "",
    securityToken: conn.securityToken ?? "",
    environment: optional.environment ?? "",
    safetyLevel: optional.safetyLevel ?? "",
    useProxy: !!conn.useProxy,
    apolloEnv: isApollo ? (conn.apolloEnv ?? "") : "",
    apolloAppId: isApollo ? (conn.apolloAppId ?? conn.defaultNamespace ?? "") : "",
    apolloCluster: isApollo ? (conn.apolloCluster ?? "") : "",
    apolloNamespaceName: isApollo ? (conn.apolloNamespaceName ?? "") : "",
    consulDatacenter: isConsul ? (conn.consulDatacenter ?? conn.defaultNamespace ?? "") : "",
    consulKeyPrefix: isConsul ? (conn.consulKeyPrefix ?? "") : "",
  };
}

function toConfigRef(conn: Connection, namespace: string, dataId: string, group: string, key = ""): ConfigRef {
  return {
    provider: providerForConnection(conn),
    connectionId: conn.id,
    namespace,
    group: providerGroupForConnection(conn, group),
    dataId,
    key,
  };
}

function providerGroupForConnection(conn: Connection, group: string): string {
  const provider = providerForConnection(conn);
  if (provider === "apollo") return apolloGroupForConnection(conn, group);
  if (provider === "consul") return consulGroupForConnection(conn, group);
  return group;
}

function apolloGroupForConnection(conn: Connection, group: string): string {
  if (providerForConnection(conn) !== "apollo") return group;
  const value = group.trim();
  if (value && value !== "DEFAULT_GROUP") return value;
  return conn.apolloCluster?.trim() || "default";
}

function consulGroupForConnection(conn: Connection, group: string): string {
  if (providerForConnection(conn) !== "consul") return group;
  const value = group.trim();
  if (value && value !== "DEFAULT_GROUP") return value;
  return conn.consulKeyPrefix?.trim() || "";
}

function fromConfigCenterNamespace(item: ConfigCenterNamespace): Namespace {
  return {
    namespace: item.id,
    namespaceShowName: item.name,
    configCount: item.configCount,
    kind: item.kind,
  };
}

function fromConfigCenterConfigPage(page: ConfigCenterConfigPage): ConfigPage {
  return {
    totalCount: page.totalCount,
    pageNumber: page.pageNumber,
    pagesAvailable: page.pagesAvailable,
    pageItems: page.pageItems.map((item) => ({
      dataId: item.ref.dataId,
      group: item.ref.group,
      content: item.content,
      configType: item.format,
      updateTime: item.updateTime ?? "",
    })),
  };
}

function fromConfigCenterDocument(document: ConfigCenterConfigDocument): ConfigDocument {
  return {
    content: document.content,
    format: document.format,
    version: document.version ?? "",
    source: document.source ?? "",
    updateTime: document.updateTime ?? "",
    ...(document.md5 ? { md5: document.md5 } : {}),
  };
}

function fromConfigCenterHistoryPage(page: ConfigCenterHistoryPage): HistoryPage {
  // 兼容真实 Wails runtime：Go 结构体 JSON 序列化会省略零值字符串字段
  // （provider.ConfigRef 的 dataId 在历史列表行可能缺 key → undefined），
  // 且 nacos 原生历史行用平铺 dataId/group（无 ref）。这里统一取
  // 「ref.dataId 优先，其次平铺 dataId」，避免「中心历史」整列 dataId 空。
  const toItem = (raw: unknown): HistoryItem | null => {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const ref = (r.ref ?? null) as Record<string, unknown> | null;
    const dataId = String((ref?.dataId as string | undefined) ?? r.dataId ?? "");
    const group = String((ref?.group as string | undefined) ?? r.group ?? "");
    return {
      id: String(r.id ?? ""),
      dataId,
      group,
      opType: String(r.opType ?? ""),
      lastModifiedTime: String(r.lastModifiedTime ?? ""),
    };
  };
  const items: HistoryItem[] = [];
  const rawItems = Array.isArray(page.pageItems) ? page.pageItems : [];
  for (const raw of rawItems) {
    const item = toItem(raw);
    if (item) items.push(item);
  }
  return {
    totalCount: page.totalCount,
    pageNumber: page.pageNumber,
    pagesAvailable: page.pagesAvailable,
    pageItems: items,
  };
}

function fromConfigCenterHistoryDetail(detail: ConfigCenterHistoryDetail): HistoryDetail {
  return {
    id: detail.id,
    dataId: detail.ref.dataId,
    group: detail.ref.group,
    content: detail.content,
    opType: detail.opType,
    createdTime: detail.createdTime,
    lastModifiedTime: detail.lastModifiedTime,
  };
}

// ── 业务接口封装 ──
export async function testConnection(conn: Connection): Promise<LoginResult> {
  return withTunnelReconnect(conn, async () => {
    const credentialConn = await hydrateConnectionSecrets(conn);
    if (conn.sourceType === "local-snapshot") {
      const baseUrl = await resolveBaseUrl(conn);
      await configCenterTestConnection(toConnectionProfile(credentialConn, baseUrl, "", "v1"));
      return { accessToken: "", tokenTtl: 0, globalAdmin: false };
    }
    if ((conn.provider ?? "nacos") === "apollo") {
      const baseUrl = await resolveBaseUrl(conn);
      await configCenterTestConnection(toConnectionProfile(credentialConn, baseUrl, credentialConn.apolloToken ?? "", ""));
      return { accessToken: "", tokenTtl: 0, globalAdmin: false };
    }
    if ((conn.provider ?? "nacos") === "consul") {
      const baseUrl = await resolveBaseUrl(conn);
      await configCenterTestConnection(toConnectionProfile(credentialConn, baseUrl, credentialConn.consulToken ?? "", ""));
      return { accessToken: "", tokenTtl: 0, globalAdmin: false };
    }
    if (conn.authType === "aliyun-aksk") {
      const apiVersion = await getVersion(conn);
      const baseUrl = await resolveBaseUrl(conn);
      await configCenterTestConnection(toConnectionProfile(credentialConn, baseUrl, "", apiVersion));
      return { accessToken: "", tokenTtl: 0, globalAdmin: false };
    }
    const apiVersion = await getVersion(conn);
    const baseUrl = await resolveBaseUrl(conn);
    return NacosLogin(baseUrl, credentialConn.username, credentialConn.password, apiVersion);
  });
}


export async function listNamespaces(conn: Connection): Promise<Namespace[]> {
  return withProfile(conn, async (profile) => {
    const items = await configCenterListNamespaces(profile);
    return items.map(fromConfigCenterNamespace);
  });
}

export async function listConfigs(
  conn: Connection,
  namespace: string,
  dataId: string,
  group: string,
  pageNo: number,
  pageSize: number
): Promise<ConfigPage> {
  return withProfile(conn, async (profile) => {
    const normalizedGroup =
      providerForConnection(conn) === "apollo" || providerForConnection(conn) === "consul"
        ? providerGroupForConnection(conn, group)
        : conn.distribution === "aliyun-mse" && conn.authType === "aliyun-aksk" && !group
          ? "DEFAULT_GROUP"
          : group;
    const page = await configCenterListConfigs(profile, { namespace, dataId, group: normalizedGroup, pageNo, pageSize });
    const items = fromConfigCenterConfigPage(page).pageItems;
    // Nacos v1 的 group 过滤存在大小写不精确的问题（过滤后结果可能混入
    // 大小写不同/前缀相近的其他 group），前端必须按请求的 group 再做一次
    // 精确过滤兜底（空 group = 不过滤）。
    if (group) {
      const expected = group.toLowerCase();
      const kept = items.filter((item) => item.group.toLowerCase() === expected);
      return { ...page, pageItems: kept, totalCount: kept.length };
    }
    return { ...page, pageItems: items };
  });
}

export async function getConfig(conn: Connection, namespace: string, dataId: string, group: string): Promise<string> {
  const document = await getConfigDocument(conn, namespace, dataId, group);
  return document.content;
}

export async function getConfigDocument(conn: Connection, namespace: string, dataId: string, group: string): Promise<ConfigDocument> {
  return withProfile(conn, async (profile) => {
    const document = await configCenterGetConfig(profile, toConfigRef(conn, namespace, dataId, group));
    return fromConfigCenterDocument(document);
  });
}

export async function listHistory(
  conn: Connection,
  namespace: string,
  dataId: string,
  group: string,
  pageNo: number,
  pageSize: number
): Promise<HistoryPage> {
  return withProfile(conn, async (profile) => {
    const page = await configCenterListHistory(profile, toConfigRef(conn, namespace, dataId, group), { pageNo, pageSize });
    return fromConfigCenterHistoryPage(page);
  });
}

export async function publishConfig(
  _conn: Connection,
  _namespace: string,
  _dataId: string,
  _group: string,
  _content: string,
  _configType: string
): Promise<void> {
  throw new Error(translate("api.directWriteRequiresApplyPlan"));
}

export async function publishConfigFromApplyPlan(
  conn: Connection,
  namespace: string,
  dataId: string,
  group: string,
  content: string,
  configType: string
): Promise<void> {
  if (conn.sourceType === "local-snapshot") {
    throw new Error(translate("api.localSnapshotPublishReadonly"));
  }
  if ((conn.provider ?? "nacos") !== "nacos") {
    return withProfile(conn, (profile) =>
      configCenterPublishConfigFromApplyPlan(profile, {
        ref: toConfigRef(conn, namespace, dataId, group),
        content,
        format: configType,
      })
    );
  }
  return withAuth(conn, async (accessToken, apiVersion) => {
    const baseUrl = await resolveBaseUrl(conn);
    return NacosPublishConfigFromApplyPlan(baseUrl, accessToken, apiVersion, namespace, dataId, group, content, configType);
  });
}

export async function publishConfigRefFromApplyPlan(
  conn: Connection,
  ref: ConfigRef,
  content: string,
  configType: string
): Promise<void> {
  if (conn.sourceType === "local-snapshot") {
    throw new Error(translate("api.localSnapshotPublishReadonly"));
  }
  if ((conn.provider ?? "nacos") !== "nacos") {
    return withProfile(conn, (profile) =>
      configCenterPublishConfigFromApplyPlan(profile, {
        ref: {
          ...ref,
          provider: providerForConnection(conn),
          connectionId: conn.id,
          group: providerGroupForConnection(conn, ref.group),
        },
        content,
        format: configType,
      })
    );
  }
  return publishConfigFromApplyPlan(conn, ref.namespace, ref.dataId, ref.group, content, configType);
}

export async function deleteConfig(_conn: Connection, _namespace: string, _dataId: string, _group: string): Promise<void> {
  throw new Error(translate("api.directWriteRequiresApplyPlan"));
}

export async function deleteConfigFromApplyPlan(conn: Connection, namespace: string, dataId: string, group: string): Promise<void> {
  if (conn.sourceType === "local-snapshot") {
    throw new Error(translate("api.localSnapshotDeleteReadonly"));
  }
  if ((conn.provider ?? "nacos") !== "nacos") {
    return withProfile(conn, (profile) => configCenterDeleteConfigFromApplyPlan(profile, toConfigRef(conn, namespace, dataId, group)));
  }
  return withAuth(conn, async (accessToken, apiVersion) => {
    const baseUrl = await resolveBaseUrl(conn);
    return NacosDeleteConfigFromApplyPlan(baseUrl, accessToken, apiVersion, namespace, dataId, group);
  });
}

export async function deleteConfigRefFromApplyPlan(conn: Connection, ref: ConfigRef): Promise<void> {
  if (conn.sourceType === "local-snapshot") {
    throw new Error(translate("api.localSnapshotDeleteReadonly"));
  }
  if ((conn.provider ?? "nacos") !== "nacos") {
    return withProfile(conn, (profile) =>
      configCenterDeleteConfigFromApplyPlan(profile, {
        ...ref,
        provider: providerForConnection(conn),
        connectionId: conn.id,
        group: providerGroupForConnection(conn, ref.group),
      })
    );
  }
  return deleteConfigFromApplyPlan(conn, ref.namespace, ref.dataId, ref.group);
}

export async function getHistoryDetail(
  conn: Connection,
  namespace: string,
  dataId: string,
  group: string,
  nid: string
): Promise<HistoryDetail> {
  return withProfile(conn, async (profile) => {
    const detail = await configCenterGetHistoryDetail(profile, toConfigRef(conn, namespace, dataId, group), nid);
    return fromConfigCenterHistoryDetail(detail);
  });
}

/** 统一格式化 Nacos 时间：v3 是 epoch 毫秒，v1 是字符串，纯数字按时间戳格式化。 */
export function formatTime(raw: string): string {
  if (!raw) return "—";
  if (/^\d{10,}$/.test(raw)) {
    const ms = raw.length <= 10 ? Number(raw) * 1000 : Number(raw);
    const d = new Date(ms);
    if (!isNaN(d.getTime())) {
      const p = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }
  }
  return raw;
}
