// 复测 bridge：把 UI 的 Wails 绑定（go.main.App.*）转发到 Node 侧，
// 直接调用持久化 Nacos 容器的 v1 OpenAPI（与 internal/nacos 客户端行为一致），
// 使整条前端 UI 链路（浏览/对比/搜索/编辑/ApplyPlan/历史）真实打到 Docker Nacos。
import { loadRetestState, type RetestNacosEndpoint } from "../state";

interface NacosEndpoint {
  baseUrl: string;
  namespace: string;
}

function endpointFor(baseUrl: string): NacosEndpoint | null {
  const state = loadRetestState();
  for (const key of ["a", "b"] as const) {
    const ep: RetestNacosEndpoint = state.nacos[key];
    if (ep.baseUrl === baseUrl || baseUrl.includes(`:${ep.clientPort}`)) return { baseUrl: ep.baseUrl, namespace: ep.namespace };
  }
  return null;
}

function v1(ep: NacosEndpoint, path: string, query: Record<string, string>): string {
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return `${ep.baseUrl}/v1${path}${qs ? `?${qs}` : ""}`;
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`Nacos ${res.status}: ${text.slice(0, 200)}`);
  return text;
}

async function getJson<T>(url: string): Promise<T> {
  const text = await getText(url);
  return JSON.parse(text) as T;
}

async function sendForm(method: "POST" | "DELETE", url: string, form: Record<string, string>): Promise<string> {
  const body = new URLSearchParams(form);
  const res = await fetch(url, { method, body: method === "POST" ? body : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`Nacos ${res.status}: ${text.slice(0, 200)}`);
  return text;
}

function isoToMs(iso: string): number {
  const t = Date.parse(iso);
  return isNaN(t) ? 0 : t;
}

function nacosTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  // 秒级时间戳，且向下取整：Nacos v1 的 Last-Modified 头精度为秒级，
  // 若取整方式不一致（如 Date.now() 取整），计划构建与执行之间的 updateTime 会漂移，
  // 导致 ApplyPlan 新鲜度校验误报 stale。
  const t = new Date(Math.floor(ms / 1000) * 1000);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
}

import { createHash } from "node:crypto";

const bridgeListeners: Array<(line: string) => void> = [];

export function onBridgeLog(fn: (line: string) => void): void {
  bridgeListeners.push(fn);
}

const bridgeLog = (...parts: unknown[]) => {
  const line = `[retest-bridge] ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}`;
  console.log(line);
  for (const fn of bridgeListeners) fn(line);
};

/** 进程级共享的发布时间戳（key: `${baseUrl}|${ns}|${group}|${dataId}`，value: 毫秒）。
 *  Nacos v1 的 Last-Modified 头精度为秒级，批量执行中前序写入会刷新后序读取的时间戳，
 *  桥在发布/删除后记录精确毫秒值，读取时优先使用，避免秒级取整造成计划陈旧误判。
 *
 *  持久化到 /tmp 的原因：Playwright 按 spec 文件拆分 worker 进程，模块级 Map 不跨文件共享。
 *  若前一个 spec 在 Nacos 上发布/删除过配置（刷新了 Last-Modified），后一个 spec 的审计/对比
 *  读到旧秒级时间戳，会导致数据被误判为「未变更」或陈旧。用文件兜底跨进程共享。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const STAMP_FILE = "/tmp/confscope-retest-publish-stamps.json";

function loadStampFile(): Map<string, number> {
  try {
    if (!existsSync(STAMP_FILE)) return new Map();
    const raw = JSON.parse(readFileSync(STAMP_FILE, "utf8")) as Record<string, number>;
    return new Map(Object.entries(raw));
  } catch {
    return new Map();
  }
}

const sharedPublishStamps = loadStampFile();

function persistStamps(): void {
  try {
    writeFileSync(STAMP_FILE, JSON.stringify(Object.fromEntries(sharedPublishStamps)));
  } catch {
    /* 忽略持久化失败，退回进程内共享 */
  }
}

function md5Of(text: string): string {
  return createHash("md5").update(text, "utf8").digest("hex");
}

interface RawNamespace {
  namespace: string;
  namespaceShowName: string | null;
  quota: number;
  configCount: number;
  type: number;
}

interface RawConfigItem {
  id?: string;
  dataId: string;
  group: string;
  content: string;
  type: string;
  md5: string | null;
  appName?: string;
}

interface RawHistory {
  id: string;
  // v1 历史行 dataId/group 可能缺失（旧 row-mapper 行为），用 optional 避免 TS 假象；
  // 调用方用 `if (!h.dataId) h.dataId = ...` 显式回填。
  dataId?: string;
  group?: string;
  opType: string;
  lastModifiedTime: string;
}

interface RawHistoryDetail extends RawConfigItem {
  nid: string;
  opType: string;
  createTime: number;
  lastModifiedTime: number;
}

function normalizeRefLike(input: unknown): {
  provider: string;
  connectionId: string;
  namespace: string;
  group: string;
  dataId: string;
  key: string;
} {
  const r = (input ?? {}) as Record<string, unknown>;
  return {
    provider: String(r.provider ?? "nacos"),
    connectionId: String(r.connectionId ?? ""),
    namespace: String(r.namespace ?? ""),
    group: String(r.group ?? "DEFAULT_GROUP"),
    dataId: String(r.dataId ?? ""),
    key: String(r.key ?? ""),
  };
}

function detectVersionFor(baseUrl: string): Promise<"v1" | "v3"> {
  return fetch(`${baseUrl}/v3/console/core/namespace/list`)
    .then((res) => (res.status === 404 ? "v1" : "v3"))
    .catch(() => "v1");
}

export interface RetestInvoke {
  (method: string, args: unknown[]): Promise<unknown>;
}

export function createRetestInvoke(): RetestInvoke {
  const versionCache = new Map<string, "v1" | "v3">();
  const snapshotCache = new Map<string, unknown>();
  const snapshotsList: unknown[] = [];

  const getEndpoint = (args: unknown[]): NacosEndpoint => {
    const profile = args[0] as Record<string, unknown>;
    const baseUrl = String(profile?.baseUrl ?? "");
    const ep = endpointFor(baseUrl);
    if (!ep) throw new Error(`retest bridge: 未知 Nacos 端点 ${baseUrl}（只允许持久化复测环境）`);
    return ep;
  };

  const publishStamps = new Map<string, number>();
  const stampKey = (ep: NacosEndpoint, namespace: string, group: string, dataId: string) =>
    `${ep.baseUrl}|${namespace}|${group}|${dataId}`;
  const readStamp = (ep: NacosEndpoint, namespace: string, group: string, dataId: string) =>
    sharedPublishStamps.get(stampKey(ep, namespace, group, dataId))
      ?? publishStamps.get(`${namespace}/${group}/${dataId}`)
      ?? null;
  const writeStamp = (ep: NacosEndpoint, namespace: string, group: string, dataId: string) => {
    const now = Date.now();
    sharedPublishStamps.set(stampKey(ep, namespace, group, dataId), now);
    publishStamps.set(`${namespace}/${group}/${dataId}`, now);
    persistStamps();
  };
  // Nacos v1 历史列表（/v1/cs/history?search=accurate...）
  /** Nacos v1 的 /cs/history?search=accurate 在 dataId 为空串（列表拉取场景）时不返回任何行
   * （Nacos 2.x/3.x 行为：空 dataId 被当作精确匹配空串）。中心历史列表因此走 v3
   * `searchConfigHistory`（console/admin，返回全部命名空间历史）；具体 dataId 的历史
   * 仍用 v1 accurate（返回该 dataId 全部行，nid 必填参数传 1 不过滤）。 */
  // Nacos v1 历史接口 /cs/history?search=accurate 只返回 {id, nid, lastId, tenant, group, appName,
  // md5, srcIp, opType, publishType, lastModifiedTime}（无 dataId 字段）。
  // dataId 由本次查询的 dataId 参数决定（accurate 语义）；列表模式（空 dataId）
  // 必须先枚举配置再逐 dataId 查询，每行回填对应 dataId 才能被中心历史列表/筛选使用。
  const rawHistory = async (ep: NacosEndpoint, namespace: string, dataId: string, group: string, pageSize = 100) => {
    const list = dataId
      ? await getJson<RawHistory[]>(
          v1(ep, "/cs/history", { search: "accurate", dataId, group, tenant: namespace, nid: "1", pageNo: "1", pageSize: String(pageSize) })
        )
      : await listAllHistory(ep, namespace, pageSize);
    const rawList: RawHistory[] = Array.isArray(list)
      ? list
      : ((list as unknown as { pageItems?: RawHistory[] }).pageItems ?? []);
    // Nacos v1 历史行实际带 dataId/group 字段（accurate 语义：行就是请求的 dataId）；
    // 早期版本 row-mapper 曾不填 dataId，这里兜底用请求参数补齐。
    // 单 dataId 查询：行 dataId 缺失时用请求参数 dataId 回填；
    // 列表模式（dataId=""）：用 listAllHistory 已按配置回填的行内 dataId。
    for (const h of rawList) {
      if (!h.dataId && dataId) h.dataId = dataId;
      if (!h.group && group) h.group = group;
    }
    const items = rawList
      .map((h) => ({
        id: String(h.id),
        ref: { provider: "nacos", connectionId: "", namespace, group: h.group || group, dataId: h.dataId || dataId, key: "" },
        opType: h.opType,
        lastModifiedTime: nacosTime(isoToMs(h.lastModifiedTime)),
      }))
      .sort((x, y) => y.lastModifiedTime.localeCompare(x.lastModifiedTime));
    return items;
  };
  /** 命名空间全部历史（中心历史列表用）。Nacos v1 的 /cs/history?search=accurate 要求
   * dataId 非空（空串精确匹配 → 0 行），且本容器无 v3 历史接口；因此先枚举该命名空间的
   * 配置（v1 configs blur），再逐 dataId 拉历史并合并。 */
  const listAllHistory = async (ep: NacosEndpoint, namespace: string, pageSize = 100): Promise<RawHistory[]> => {
    const configs = await getJson<{ pageItems?: RawConfigItem[] }>(
      v1(ep, "/cs/configs", { search: "blur", dataId: "", group: "", tenant: namespace, pageNo: "1", pageSize: "500" })
    );
    const merged: RawHistory[] = [];
    for (const c of configs.pageItems ?? []) {
      const res = await getJson<RawHistory[]>(
        v1(ep, "/cs/history", { search: "accurate", dataId: c.dataId, group: c.group, tenant: namespace, nid: "1", pageNo: "1", pageSize: String(pageSize) })
      );
      const items = Array.isArray(res) ? res : ((res as unknown as { pageItems?: RawHistory[] }).pageItems ?? []);
      // v1 历史行不带 dataId 字段：按本次查询的 dataId 回填
      for (const item of items) item.dataId = c.dataId;
      merged.push(...items);
    }
    merged.sort((x, y) => isoToMs(y.lastModifiedTime) - isoToMs(x.lastModifiedTime));
    return merged;
  };
  const rawHistoryDetail = async (ep: NacosEndpoint, namespace: string, dataId: string, group: string, nid: string) => {
    const detail = await getJson<RawHistoryDetail>(
      v1(ep, "/cs/history", { dataId, group, tenant: namespace, nid })
    );
    return {
      id: String(detail.nid ?? nid),
      ref: { provider: "nacos", connectionId: "", namespace, group: detail.group ?? group, dataId: detail.dataId ?? dataId, key: "" },
      content: detail.content ?? "",
      opType: detail.opType ?? "",
      createdTime: nacosTime(isoToMs(detail.createTime)),
      lastModifiedTime: nacosTime(isoToMs(detail.lastModifiedTime)),
    };
  };

  const rawNamespaces = async (ep: NacosEndpoint) => {
    // Nacos v1 OpenAPI 对 /console/namespaces 使用 {code,message,data} 包裹（internal/nacos/namespace.go 会解包）
    const data = await getJson<unknown>(v1(ep, "/console/namespaces", {}));
    const items = Array.isArray(data) ? data : ((data as { data?: RawNamespace[] }).data ?? []);
    return items;
  };

  // ConfigCenter* 的 page/pageItems 形态与 Go 序列化一致，但经 JSON 往返后
  // pageItems 可能变成非数组（例如 Nacos 端点返回错误对象）。这里统一兜底，
  // 避免 UI 侧 list.filter is not a function 直接崩溃（50-history 实测发现）。
  const normalizePage = (result: unknown): unknown => {
    if (result && typeof result === "object" && !Array.isArray(result)) {
      const page = result as Record<string, unknown>;
      if ("pageItems" in page && !Array.isArray(page.pageItems)) {
        page.pageItems = [];
      } else if (Array.isArray(page.pageItems)) {
        page.pageItems = (page.pageItems as unknown[]).filter(
          (it) => it && typeof it === "object"
        );
      }
    }
    return result;
  };

  const invokeInner = async (method: string, args: unknown[]) => {
    switch (method) {
      case "GetAppInfo":
        // 与存储播种的 startup.lastShown* 版本一致 → 不触发欢迎弹窗
        return { name: "ConfScope", version: "1.8.0", updateSources: [] };
      case "GetCurrentPlatform":
        return "linux";
      case "CheckForUpdates":
        return { hasUpdate: false, latestVersion: "1.8.0", currentVersion: "1.8.0", sourceName: "", releaseNotes: "", mandatory: false, error: "" };
      case "GetDownloadProgress":
        // 复测环境无真实下载任务；返回 done 状态，供 About 页轮询使用
        return { downloaded: 0, total: 0, percent: 0, done: true, error: "" };
      case "DownloadUpdate":
        return "no-op";
      case "InstallAndRestart":
        return undefined;
      case "NacosDetectVersion": {
        const baseUrl = String(args[0]);
        const hit = versionCache.get(baseUrl);
        if (hit) return hit;
        const version = await detectVersionFor(baseUrl);
        versionCache.set(baseUrl, version);
        return version;
      }
      case "NacosLogin": {
        // 复测 Nacos 关闭鉴权：真实登录必然失败，模拟"未配置账号"的免鉴权成功
        return { accessToken: "", tokenTtl: 18000, globalAdmin: false };
      }

      // ── 新版 ConfigCenter 门面（profile + ref/req 结构体） ──
      case "ConfigCenterTestConnection": {
        const ep = getEndpoint(args);
        await getText(v1(ep, "/console/health/readiness", {}));
        return null;
      }
      case "ConfigCenterListNamespaces": {
        const ep = getEndpoint(args);
        const items = await rawNamespaces(ep);
        return items.map((item) => ({
          id: item.namespace,
          name: item.namespaceShowName || (item.namespace ? item.namespace : "public"),
          configCount: item.configCount ?? 0,
          kind: item.type ?? 0,
        }));
      }
      case "ConfigCenterListConfigs": {
        const ep = getEndpoint(args);
        const req = args[1] as Record<string, unknown>;
        const listReq = {
          search: "blur",
          dataId: String(req.dataId ?? ""),
          group: String(req.group ?? ""),
          tenant: String(req.namespace ?? ""),
          pageNo: String(req.pageNo ?? 1),
          pageSize: String(req.pageSize ?? 20),
        };
        const page = await getJson<{ totalCount: number; pageNumber: number; pagesAvailable: number; pageItems: RawConfigItem[] }>(
          v1(ep, "/cs/configs", listReq)
        );
        return {
          totalCount: page.totalCount,
          pageNumber: page.pageNumber,
          pagesAvailable: page.pagesAvailable,
          pageItems: (page.pageItems ?? []).map((item) => ({
            ref: {
              provider: "nacos",
              connectionId: String((args[0] as Record<string, unknown>).id ?? ""),
              namespace: String(req.namespace ?? ""),
              group: item.group,
              dataId: item.dataId,
              key: "",
            },
            content: item.content,
            format: item.type,
            updateTime: nacosTime(Number((item as Record<string, unknown>).lastModifiedTime ?? 0)),
          })),
        };
      }
      case "ConfigCenterGetConfig": {
        const ep = getEndpoint(args);
        const ref = normalizeRefLike(args[1]);
        // 注意：GET /cs/configs 会命中 Chromium/Node 默认 HTTP 缓存（同 URL 同缓存键，
        // 无 cache-control 头）。审计等场景两侧命名空间不同但 dataId/group 相同时
        // （URL 仅 tenant 参数不同…tenant 在 query 里，仍可能因代理/预取混淆），
        // 一律加 no-store 强制回源，保证每次读取拿到真实当前内容。
        const res = await fetch(v1(ep, "/cs/configs", { dataId: ref.dataId, group: ref.group, tenant: ref.namespace }), { cache: "no-store" });
        if (res.status === 404) throw new Error(`404 config not found: ${ref.namespace}/${ref.group}/${ref.dataId}`);
        const content = await res.text();
        if (!res.ok) throw new Error(`Nacos ${res.status}: ${content.slice(0, 200)}`);
        const type = (ref.dataId.split(".").pop() ?? "").toLowerCase();
        const rawHeader = res.headers.get("last-modified") ?? "";
        let lastModified = Number(rawHeader ? new Date(rawHeader).getTime() : 0) || Date.now();
        const localStamp = readStamp(ep, ref.namespace, ref.group, ref.dataId);
        if (localStamp) {
          // 本桥刚发布过该配置：用记录的毫秒时间替代秒级的 Last-Modified，
          // 保证同一桥会话内构建计划与执行时的 updateTime 一致。
          if (localStamp >= lastModified) lastModified = localStamp;
        }
        const updateTime = nacosTime(lastModified);
        bridgeLog("GetConfig", ref.namespace, ref.group, ref.dataId, "raw", rawHeader, "ms", lastModified, "stamp", localStamp ?? "-", "updateTime", updateTime);
        return {
          ref: { ...ref, provider: "nacos" },
          content,
          format: ["yaml", "yml", "json", "properties", "txt"].includes(type) ? type : "txt",
          version: md5Of(content),
          source: "nacos",
          updateTime,
        };
      }
      case "ConfigCenterPublishConfig":
        throw new Error("直接发布被阻断：必须通过 ApplyPlan");
      case "ConfigCenterDeleteConfig":
        throw new Error("直接删除被阻断：必须通过 ApplyPlan");
      case "ConfigCenterPublishConfigRefFromApplyPlan":
      case "ConfigCenterPublishConfigFromApplyPlan": {
        const ep = getEndpoint(args);
        const req = args[1] as { ref: unknown; content: string; format: string };
        const ref = normalizeRefLike(req.ref);
        if (ref.key && ref.key !== "__document") throw new Error(`Nacos 不支持键级发布: ${ref.dataId}/${ref.key}`);
        const text = await sendForm("POST", v1(ep, "/cs/configs", {}), {
          dataId: ref.dataId,
          group: ref.group,
          tenant: ref.namespace,
          content: req.content,
          type: req.format || "txt",
        });
        if (text !== "true") throw new Error(`发布失败: ${text}`);
        writeStamp(ep, ref.namespace, ref.group, ref.dataId);
        bridgeLog("publish", ref.namespace, ref.group, ref.dataId, "type=ref");
        return null;
      }
      case "ConfigCenterDeleteConfigRefFromApplyPlan":
      case "ConfigCenterDeleteConfigFromApplyPlan": {
        const ep = getEndpoint(args);
        const req = args[1] as { ref: unknown };
        const ref = normalizeRefLike(req.ref);
        const text = await sendForm("DELETE", v1(ep, "/cs/configs", { dataId: ref.dataId, group: ref.group, tenant: ref.namespace }), {});
        if (text !== "true") throw new Error(`删除失败: ${text}`);
        writeStamp(ep, ref.namespace, ref.group, ref.dataId);
        bridgeLog("delete", ref.namespace, ref.group, ref.dataId, "type=ref");
        return null;
      }
      case "ConfigCenterListHistory": {
        const ep = getEndpoint(args);
        const ref = normalizeRefLike(args[1]);
        bridgeLog("ListHistory in", ref.namespace, ref.dataId || "(all)", ref.group || "(all)");
        const items = await rawHistory(ep, ref.namespace, ref.dataId, ref.group);
        bridgeLog("ListHistory out", items.length, items[0]?.ref?.dataId ?? "-", items[0]?.lastModifiedTime ?? "-");
        // ConfigCenterHistoryItem 用 ref 结构（含 namespace），与 nacos.ts HistoryItem（平铺）不同。
        // Wails 侧 Go 结构体把零值字符串字段直接省略（JSON 无 key），所以行 ref.dataId
        // 在「列表模式」（请求 ref.dataId 为空）下是 undefined 而不是 ""：
        //   - 单 dataId 历史：行无 dataId → 回落到请求 ref.dataId（accurate 语义，正确）
        //   - 全量列表：逐行用 listAllHistory 已回填的行内 dataId
        // 同时输出两种形态（与 internal/nacos 原生 HistoryItem 平铺 + provider 包 ref 一致），
        // 真实 Wails runtime 序列化 Go 结构体时零值字段会被省略，
        // 前端 fromConfigCenterHistoryPage 对两种形态都做兜底解析。
        const pageItems = items.map((h) => {
          const rowDataId = (h as unknown as { dataId?: string }).dataId || h.ref.dataId || ref.dataId;
          const rowGroup = (h as unknown as { group?: string }).group || h.ref.group || ref.group;
          return {
            id: h.id,
            ref: {
              provider: "nacos",
              connectionId: ref.connectionId,
              namespace: ref.namespace,
              group: rowGroup,
              dataId: rowDataId,
              key: "",
            },
            dataId: rowDataId,
            group: rowGroup,
            opType: h.opType,
            lastModifiedTime: h.lastModifiedTime,
          };
        });
        return normalizePage({ totalCount: pageItems.length, pageNumber: 1, pagesAvailable: 1, pageItems });
      }
      case "ConfigCenterGetHistoryDetail": {
        const ep = getEndpoint(args);
        const ref = normalizeRefLike(args[1]);
        const d = await rawHistoryDetail(ep, ref.namespace, ref.dataId, ref.group, String(args[2]));
        return {
          id: d.id,
          ref: { provider: "nacos", connectionId: ref.connectionId, namespace: ref.namespace, group: ref.group, dataId: ref.dataId, key: "" },
          content: d.content,
          opType: d.opType,
          createdTime: d.createdTime,
          lastModifiedTime: d.lastModifiedTime,
        };
      }

      // ── 旧版 Nacos* 方法（参数布局见 app.go：baseUrl, accessToken, apiVersion, ...） ──
      case "NacosNamespaces": {
        const ep = endpointFor(String(args[0]));
        if (!ep) throw new Error(`retest bridge: 未知端点 ${args[0]}`);
        const items = await rawNamespaces(ep);
        return items.map((item) => ({
          namespace: item.namespace,
          namespaceShowName: item.namespaceShowName || (item.namespace ? item.namespace : "public"),
          configCount: item.configCount ?? 0,
          kind: item.type ?? 0,
        }));
      }
      case "NacosListConfigs": {
        const ep = endpointFor(String(args[0]));
        if (!ep) throw new Error(`retest bridge: 未知端点 ${args[0]}`);
        const [, , , namespace, dataId, group, pageNo, pageSize] = args as unknown[];
        const page = await getJson<{ totalCount: number; pageNumber: number; pagesAvailable: number; pageItems: RawConfigItem[] }>(
          v1(ep, "/cs/configs", {
            search: "blur",
            dataId: String(dataId ?? ""),
            group: String(group ?? ""),
            tenant: String(namespace ?? ""),
            pageNo: String(pageNo ?? 1),
            pageSize: String(pageSize ?? 20),
          })
        );
        return {
          totalCount: page.totalCount ?? 0,
          pageNumber: page.pageNumber ?? 1,
          pagesAvailable: page.pagesAvailable ?? 1,
          pageItems: (page.pageItems ?? []).map((item) => ({ dataId: item.dataId, group: item.group, content: item.content, configType: item.type })),
        };
      }
      case "NacosGetConfig": {
        const ep = endpointFor(String(args[0]));
        if (!ep) throw new Error(`retest bridge: 未知端点 ${args[0]}`);
        const [, , , namespace, dataId, group] = args as unknown[];
        return getText(v1(ep, "/cs/configs", { dataId: String(dataId ?? ""), group: String(group ?? ""), tenant: String(namespace ?? "") }));
      }
      case "NacosHistoryList": {
        const ep = endpointFor(String(args[0]));
        if (!ep) throw new Error(`retest bridge: 未知端点 ${args[0]}`);
        const [, , , namespace, dataId, group] = args as unknown[];
        // v3 的 NacosHistoryList 走 v3 历史接口（pageItems 直接是数组），这里走 v1 兼容
        // 持久化容器的历史 nid 会在重启后重置，按会话基线过滤会误杀真实历史；
        // 与 ConfigCenterListHistory 保持一致：返回全部（降序），由 UI 侧自行筛选
        const items = await rawHistory(
          ep,
          String(namespace ?? ""),
          String(dataId ?? ""),
          String(group ?? ""),
          100
        );
        return normalizePage({ totalCount: items.length, pageNumber: 1, pagesAvailable: 1, pageItems: items });
      }
      case "NacosHistoryDetail": {
        const ep = endpointFor(String(args[0]));
        if (!ep) throw new Error(`retest bridge: 未知端点 ${args[0]}`);
        const [, , , namespace, dataId, group, , nid] = args as unknown[];
        const detail = await rawHistoryDetail(ep, String(namespace ?? ""), String(dataId ?? ""), String(group ?? ""), String(nid ?? ""));
        return { id: detail.id, dataId: detail.ref.dataId, group: detail.ref.group, content: detail.content, opType: detail.opType, createdTime: detail.createdTime, lastModifiedTime: detail.lastModifiedTime };
      }
      case "NacosPublishConfig":
        throw new Error("直接发布被阻断：必须通过 ApplyPlan");
      case "NacosDeleteConfig":
        throw new Error("直接删除被阻断：必须通过 ApplyPlan");
      case "NacosPublishConfigFromApplyPlan": {
        const ep = endpointFor(String(args[0]));
        if (!ep) throw new Error(`retest bridge: 未知端点 ${args[0]}`);
        const [, , , namespace, dataId, group, content, configType] = args as unknown[];
        const text = await sendForm("POST", v1(ep, "/cs/configs", {}), {
          dataId: String(dataId ?? ""),
          group: String(group ?? ""),
          tenant: String(namespace ?? ""),
          content: String(content ?? ""),
          type: String(configType || "txt"),
        });
        if (text !== "true") throw new Error(`发布失败: ${text}`);
        writeStamp(ep, String(namespace ?? ""), String(group ?? ""), String(dataId ?? ""));
        bridgeLog("publish", namespace, group, dataId, "type=nacos");
        return null;
      }
      case "NacosDeleteConfigFromApplyPlan": {
        const ep = endpointFor(String(args[0]));
        if (!ep) throw new Error(`retest bridge: 未知端点 ${args[0]}`);
        const [, , , namespace, dataId, group] = args as unknown[];
        const text = await sendForm("DELETE", v1(ep, "/cs/configs", { dataId: String(dataId ?? ""), group: String(group ?? ""), tenant: String(namespace ?? "") }), {});
        if (text !== "true") throw new Error(`删除失败: ${text}`);
        writeStamp(ep, String(namespace ?? ""), String(group ?? ""), String(dataId ?? ""));
        bridgeLog("delete", namespace, group, dataId, "type=nacos");
        return null;
      }

      // ── 未纳入本次复测范围的能力（SSH/快照/WebDAV/备份）：返回安全默认值 ──
      case "CreateSSHTunnel":
        throw new Error("retest bridge: SSH 隧道未启用");
      case "TestSSHConnection":
        throw new Error("retest bridge: SSH 隧道未启用");
      case "StopSSHTunnel":
      case "StopAllSSHTunnels":
        return null;
      case "GetSSHTunnelLocalPort":
        return 0;
      case "CreateSnapshot": {
        // 备份快照落盘到 Node 侧目录（模拟 wails CreateSnapshot），返回可查询的 Snapshot
        const source = args[0] as Record<string, unknown>;
        const configs = args[1] as unknown[];
        const id = `retest-snap-${Date.now()}`;
        const name = `retest-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        const snapshot = {
          schemaVersion: 1,
          toolVersion: "1.8.0",
          id,
          path: `/tmp/confscope-retest-snapshots/${id}`,
          name,
          description: `retest auto backup`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          source,
          configs,
        };
        snapshotCache.set(id, snapshot);
        snapshotsList.push(snapshot);
        return snapshot;
      }
      case "GetSnapshot": {
        const snap = snapshotCache.get(String(args[0]));
        if (!snap) throw new Error(`snapshot not found: ${args[0]}`);
        return snap;
      }
      case "ListSnapshots":
        return snapshotsList;
      case "DeleteSnapshot":
        snapshotCache.delete(String(args[0]));
        return null;
      case "ValidateSnapshot":
        return true;
      case "SelectLocalSnapshotDirectory":
      case "ValidateLocalSnapshotDirectory":
      case "SelectAppDataBackupSaveFile":
      case "SelectAppDataBackupOpenFile":
      case "WriteAppDataBackupFile":
      case "ReadAppDataBackupFile":
      case "CreateAppDataRecoveryPoint":
      case "TestAppDataWebDAV":
      case "ListAppDataWebDAVBackups":
      case "UploadAppDataWebDAVBackup":
      case "DownloadAppDataWebDAVBackup":
      case "TestSnapshotWebDAV":
      case "ListSnapshotWebDAVPackages":
      case "UploadSnapshotWebDAVPackage":
      case "ImportSnapshotWebDAVPackage":
        return null;
      default:
        throw new Error(`retest bridge: 未实现绑定 ${method}`);
    }
  };
  return async (method: string, args: unknown[]) => {
    if (method === "ConfigCenterListHistory" || method === "ConfigCenterGetHistoryDetail" || method === "NacosHistoryList" || method === "NacosHistoryDetail") {
      const start = Date.now();
      try {
        const res = await invokeInner(method, args);
        return normalizePage(res);
      } catch (e) {
        console.log(`[retest-bridge] ${method} FAILED: ${e}`);
        throw e;
      }
    }
    if (method === "ConfigCenterPublishConfigFromApplyPlan" || method === "ConfigCenterPublishConfigRefFromApplyPlan" || method === "ConfigCenterDeleteConfigFromApplyPlan" || method === "ConfigCenterDeleteConfigRefFromApplyPlan" || method === "CreateSnapshot") {
      const start = Date.now();
      try {
        const res = await invokeInner(method, args);
        console.log(`[retest-bridge] ${method} took ${Date.now() - start}ms`);
        return normalizePage(res);
      } catch (e) {
        console.log(`[retest-bridge] ${method} FAILED after ${Date.now() - start}ms:`, e);
        throw e;
      }
    }
    const start = Date.now();
    const profile = args[0] as Record<string, unknown>;
    const label = `${method} [${profile?.id ?? "?"} ${String(profile?.baseUrl ?? "")}]`;
    try {
      const res = await invokeInner(method, args);
      bridgeLog("ok", label, `${Date.now() - start}ms`);
      return normalizePage(res);
    } catch (e) {
      bridgeLog("FAIL", label, `${Date.now() - start}ms`, String(e));
      throw e;
    }
  };
}

