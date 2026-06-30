import {
  NacosDeleteConfig,
  NacosDetectVersion,
  NacosLogin,
  NacosPublishConfig,
  CreateSSHTunnel,
  StopSSHTunnel,
} from "../../wailsjs/go/main/App";
import {
  getConfig as configCenterGetConfig,
  getHistoryDetail as configCenterGetHistoryDetail,
  listConfigs as configCenterListConfigs,
  listHistory as configCenterListHistory,
  listNamespaces as configCenterListNamespaces,
  testConnection as configCenterTestConnection,
  type ConfigPage as ConfigCenterConfigPage,
  type ConfigRef,
  type ConnectionProfile,
  type HistoryDetail as ConfigCenterHistoryDetail,
  type HistoryPage as ConfigCenterHistoryPage,
  type Namespace as ConfigCenterNamespace,
} from "./configCenter";
import type { Connection } from "../store/connections";
import { connectionSSHConfig } from "../store/sshProfiles";

// ── SSH 隧道缓存：按连接 id 缓存隧道的本地 baseUrl ──
const tunnelUrlCache = new Map<string, string>();

function normalizeNacosBaseUrl(baseUrl: string): string {
  const value = baseUrl.trim();
  if (!value) return value;
  if (/^https?:\/\//i.test(value)) return value;
  return `http://${value}`;
}

/** 解析连接的有效 baseUrl：如果有 SSH 隧道配置则通过隧道访问。 */
export async function resolveBaseUrl(conn: Connection): Promise<string> {
  if (conn.sourceType === "local-snapshot") return conn.localPath || conn.baseUrl;
  const originalBaseUrl = normalizeNacosBaseUrl(conn.baseUrl);
  const sshConfig = connectionSSHConfig(conn);
  if (!sshConfig) return originalBaseUrl;

  const cached = tunnelUrlCache.get(conn.id);
  if (cached) return cached;

  // 解析原始 baseUrl，提取 context-path 和协议
  const url = new URL(originalBaseUrl);
  const contextPath = url.pathname;
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

  // 用本地隧道端口替换原始 URL 的端口
  const tunnelUrl = `${url.protocol}//localhost:${localPort}${contextPath}`;
  tunnelUrlCache.set(conn.id, tunnelUrl);
  return tunnelUrl;
}

/** 清除某连接的 SSH 隧道。 */
export function closeTunnel(connId: string) {
  tunnelUrlCache.delete(connId);
  StopSSHTunnel(connId);
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
}

export interface ConfigPage {
  totalCount: number;
  pageNumber: number;
  pagesAvailable: number;
  pageItems: ConfigItem[];
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
  const res = await NacosLogin(baseUrl, conn.username, conn.password, apiVersion);
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
async function withAuth<T>(
  conn: Connection,
  call: (token: string, apiVersion: ApiVersion) => Promise<T>
): Promise<T> {
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
}

async function withProfile<T>(
  conn: Connection,
  call: (profile: ConnectionProfile) => Promise<T>
): Promise<T> {
  if (conn.sourceType === "local-snapshot") {
    const baseUrl = await resolveBaseUrl(conn);
    return call(toConnectionProfile(conn, baseUrl, "", "v1"));
  }
  const apiVersion = await getVersion(conn);
  const accessToken = await getToken(conn);
  const baseUrl = await resolveBaseUrl(conn);
  try {
    return await call(toConnectionProfile(conn, baseUrl, accessToken, apiVersion));
  } catch (e) {
    const msg = String(e);
    if (conn.username && (msg.includes("403") || msg.includes("token") || msg.includes("code=403"))) {
      const fresh = await getToken(conn, true);
      return await call(toConnectionProfile(conn, baseUrl, fresh, apiVersion));
    }
    throw e;
  }
}

function toConnectionProfile(
  conn: Connection,
  baseUrl: string,
  accessToken: string,
  apiVersion: ApiVersion
): ConnectionProfile {
  const optional = conn as Connection & { environment?: string; safetyLevel?: string };
  return {
    id: conn.id,
    name: conn.name,
    provider: conn.sourceType === "local-snapshot" ? "local" : "nacos",
    distribution: conn.distribution ?? "opensource",
    authType: conn.sourceType === "local-snapshot" ? "none" : conn.authType ?? (conn.username ? "nacos-password" : "none"),
    baseUrl,
    accessToken,
    apiVersion,
    accessKeyId: conn.accessKeyId ?? "",
    accessKeySecret: conn.accessKeySecret ?? "",
    securityToken: conn.securityToken ?? "",
    environment: optional.environment ?? "",
    safetyLevel: optional.safetyLevel ?? "",
  };
}

function toConfigRef(conn: Connection, namespace: string, dataId: string, group: string): ConfigRef {
  return {
    provider: conn.sourceType === "local-snapshot" ? "local" : "nacos",
    connectionId: conn.id,
    namespace,
    group,
    dataId,
    key: "",
  };
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
    })),
  };
}

function fromConfigCenterHistoryPage(page: ConfigCenterHistoryPage): HistoryPage {
  return {
    totalCount: page.totalCount,
    pageNumber: page.pageNumber,
    pagesAvailable: page.pagesAvailable,
    pageItems: page.pageItems.map((item) => ({
      id: item.id,
      dataId: item.ref.dataId,
      group: item.ref.group,
      opType: item.opType,
      lastModifiedTime: item.lastModifiedTime,
    })),
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
  if (conn.sourceType === "local-snapshot") {
    const baseUrl = await resolveBaseUrl(conn);
    await configCenterTestConnection(toConnectionProfile(conn, baseUrl, "", "v1"));
    return { accessToken: "", tokenTtl: 0, globalAdmin: false };
  }
  if (conn.authType === "aliyun-aksk") {
    const apiVersion = await getVersion(conn);
    const baseUrl = await resolveBaseUrl(conn);
    await configCenterTestConnection(toConnectionProfile(conn, baseUrl, "", apiVersion));
    return { accessToken: "", tokenTtl: 0, globalAdmin: false };
  }
  const apiVersion = await getVersion(conn);
  const baseUrl = await resolveBaseUrl(conn);
  return NacosLogin(baseUrl, conn.username, conn.password, apiVersion);
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
    const normalizedGroup = conn.distribution === "aliyun-mse" && conn.authType === "aliyun-aksk" && !group
      ? "DEFAULT_GROUP"
      : group;
    const page = await configCenterListConfigs(profile, { namespace, dataId, group: normalizedGroup, pageNo, pageSize });
    return fromConfigCenterConfigPage(page);
  });
}

export async function getConfig(
  conn: Connection,
  namespace: string,
  dataId: string,
  group: string
): Promise<string> {
  return withProfile(conn, async (profile) => {
    const document = await configCenterGetConfig(profile, toConfigRef(conn, namespace, dataId, group));
    return document.content;
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
    const page = await configCenterListHistory(
      profile,
      toConfigRef(conn, namespace, dataId, group),
      { pageNo, pageSize }
    );
    return fromConfigCenterHistoryPage(page);
  });
}

export async function publishConfig(
  conn: Connection,
  namespace: string,
  dataId: string,
  group: string,
  content: string,
  configType: string
): Promise<void> {
  if (conn.sourceType === "local-snapshot") {
    throw new Error("本地快照来源只读，不能发布配置");
  }
  const baseUrl = await resolveBaseUrl(conn);
  return withAuth(conn, (accessToken, apiVersion) =>
    NacosPublishConfig(baseUrl, accessToken, apiVersion, namespace, dataId, group, content, configType)
  );
}

export async function deleteConfig(
  conn: Connection,
  namespace: string,
  dataId: string,
  group: string
): Promise<void> {
  if (conn.sourceType === "local-snapshot") {
    throw new Error("本地快照来源只读，不能删除配置");
  }
  const baseUrl = await resolveBaseUrl(conn);
  return withAuth(conn, (accessToken, apiVersion) =>
    NacosDeleteConfig(baseUrl, accessToken, apiVersion, namespace, dataId, group)
  );
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
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
        d.getHours()
      )}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }
  }
  return raw;
}
