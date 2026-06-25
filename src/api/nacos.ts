import {
  NacosDeleteConfig,
  NacosDetectVersion,
  NacosGetConfig,
  NacosHistoryDetail,
  NacosHistoryList,
  NacosListConfigs,
  NacosLogin,
  NacosNamespaces,
  NacosPublishConfig,
} from "../../wailsjs/go/main/App";
import type { Connection } from "../store/connections";

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
  const hit = versionCache.get(conn.baseUrl);
  if (hit) return hit;
  const v = (await NacosDetectVersion(conn.baseUrl)) as ApiVersion;
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
  if (!conn.username) return "";
  const cached = tokenCache.get(conn.id);
  if (!force && cached && Date.now() < cached.expireAt) return cached.token;

  const apiVersion = await getVersion(conn);
  const res = await NacosLogin(conn.baseUrl, conn.username, conn.password, apiVersion);
  const ttl = res.tokenTtl > 0 ? res.tokenTtl : 18000;
  tokenCache.set(conn.id, {
    token: res.accessToken,
    expireAt: Date.now() + (ttl - 30) * 1000,
  });
  return res.accessToken;
}

/** 清掉某连接的 token 与版本缓存（凭据/地址改动或删除时调用）。 */
export function clearToken(connId: string, baseUrl?: string) {
  tokenCache.delete(connId);
  if (baseUrl) versionCache.delete(baseUrl);
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

// ── 业务接口封装 ──
export async function testConnection(conn: Connection): Promise<LoginResult> {
  const apiVersion = await getVersion(conn);
  return NacosLogin(conn.baseUrl, conn.username, conn.password, apiVersion);
}

export function listNamespaces(conn: Connection): Promise<Namespace[]> {
  return withAuth(conn, (accessToken, apiVersion) =>
    NacosNamespaces(conn.baseUrl, accessToken, apiVersion)
  );
}

export function listConfigs(
  conn: Connection,
  namespace: string,
  dataId: string,
  group: string,
  pageNo: number,
  pageSize: number
): Promise<ConfigPage> {
  return withAuth(conn, (accessToken, apiVersion) =>
    NacosListConfigs(conn.baseUrl, accessToken, apiVersion, namespace, dataId, group, pageNo, pageSize)
  );
}

export function getConfig(
  conn: Connection,
  namespace: string,
  dataId: string,
  group: string
): Promise<string> {
  return withAuth(conn, (accessToken, apiVersion) =>
    NacosGetConfig(conn.baseUrl, accessToken, apiVersion, namespace, dataId, group)
  );
}

export function listHistory(
  conn: Connection,
  namespace: string,
  dataId: string,
  group: string,
  pageNo: number,
  pageSize: number
): Promise<HistoryPage> {
  return withAuth(conn, (accessToken, apiVersion) =>
    NacosHistoryList(conn.baseUrl, accessToken, apiVersion, namespace, dataId, group, pageNo, pageSize)
  );
}

export function publishConfig(
  conn: Connection,
  namespace: string,
  dataId: string,
  group: string,
  content: string,
  configType: string
): Promise<void> {
  return withAuth(conn, (accessToken, apiVersion) =>
    NacosPublishConfig(conn.baseUrl, accessToken, apiVersion, namespace, dataId, group, content, configType)
  );
}

export function deleteConfig(
  conn: Connection,
  namespace: string,
  dataId: string,
  group: string
): Promise<void> {
  return withAuth(conn, (accessToken, apiVersion) =>
    NacosDeleteConfig(conn.baseUrl, accessToken, apiVersion, namespace, dataId, group)
  );
}

export function getHistoryDetail(
  conn: Connection,
  namespace: string,
  dataId: string,
  group: string,
  nid: string
): Promise<HistoryDetail> {
  return withAuth(conn, (accessToken, apiVersion) =>
    NacosHistoryDetail(conn.baseUrl, accessToken, apiVersion, namespace, dataId, group, nid)
  );
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
