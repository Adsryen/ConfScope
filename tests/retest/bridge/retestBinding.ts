// 复测 bridge：把 UI 的 Wails 绑定（go.app.App.*）转发到 Node 侧，
// 直接调用持久化 Nacos 容器的 v1 OpenAPI（与 internal/nacos 客户端行为一致），
// 使整条前端 UI 链路（浏览/对比/搜索/编辑/ApplyPlan/历史）真实打到 Docker Nacos。
import { loadRetestState, type RetestNacosEndpoint } from "../state";

interface NacosEndpoint {
  baseUrl: string;
  namespace: string;
}

// ── 主数据文档（[数据根]/app-data/confscope-data.json）的桥内替身（轮50）──────────────
// 为什么放内存而不是落盘：retest 禁止写桌面应用正式数据目录 portable/ConfScopeData（数据纪律第 3 条），
// 而这条链路要验的是「前端到底有没有把文档推给原生绑定、重启后有没有从绑定水合」；
// Go 侧的原子写、读回校验与损坏隔离由 internal/app/app_data_doc_test.go 负责，不在桥里重复。
// 桥每次 install 重置一次，等价于一个干净的数据目录，避免用例之间互相喂数据。
interface RetestAppDataDocState {
  document: Record<string, unknown> | null;
  saves: number;
  gets: number;
}

let appDataDoc: RetestAppDataDocState = { document: null, saves: 0, gets: 0 };

export function resetRetestAppDataDoc(): void {
  appDataDoc = { document: null, saves: 0, gets: 0 };
}

export function retestAppDataDocSnapshot(): RetestAppDataDocState {
  return { ...appDataDoc };
}

/** 对齐 Go 侧 AppDataDocumentStatus 的字段（前端 normalizeStatus 只认这些）。 */
function appDataDocStatus(document: Record<string, unknown> | null) {
  const savedAt = typeof document?.savedAt === "string" ? document.savedAt : "";
  return {
    exists: document !== null,
    valid: document !== null,
    path: "/tmp/confscope-retest/app-data/confscope-data.json（桥内内存替身）",
    schemaVersion: typeof document?.schemaVersion === "number" ? document.schemaVersion : 0,
    savedAt,
    appVersion: "retest",
    sizeBytes: document ? JSON.stringify(document).length : 0,
    corruptFile: "",
    document,
    error: "",
  };
}

// ── 数据根运行形态与换根迁移（轮62）的桥内替身 ─────────────────────────────
// 为什么放内存而不是落盘：同 appDataDoc，retest 禁止写正式数据目录（数据纪律第 3 条）；
// 真实的路径解析五档优先级、逐文件校验复制、指针与 marker 写入由
// internal/portabledata/{runtime_layout,data_root_migration}_test.go 负责，桥里只镜像
// 「前端能不能调通这套绑定 + 迁移确认后 root 是否真的换了 + 是否需要重启」这条 UI 链路。
// 校验判据与 Go 侧 planDataRootMigration 保持最小镜像（空/相对/同根/互相包含）。
export const RETEST_DATA_ROOT_BASE = "/tmp/confscope-retest/data";

interface RetestDataRootState {
  root: string;
  previousRoot: string;
  mode: string;
  source: string;
  migrations: number;
  rollbacks: number;
}

let dataRootState: RetestDataRootState = {
  root: RETEST_DATA_ROOT_BASE,
  previousRoot: "",
  mode: "portable",
  source: "env",
  migrations: 0,
  rollbacks: 0,
};

// 目录选择器在 retest 里没有原生弹层：用例通过 setRetestSelectDataRootTarget 预置「用户会选哪个目录」，
// 未预置时返回一个固定的新根（够跑通「换根 → 需重启 → 回退」这条主链路）。
let pendingDataRootTarget: string | null = null;

export function setRetestSelectDataRootTarget(target: string | null): void {
  pendingDataRootTarget = target;
}

export function resetRetestDataRoot(): void {
  pendingDataRootTarget = null;
  dataRootState = {
    root: RETEST_DATA_ROOT_BASE,
    previousRoot: "",
    mode: "portable",
    source: "env",
    migrations: 0,
    rollbacks: 0,
  };
}

export function retestDataRootSnapshot(): RetestDataRootState {
  return { ...dataRootState };
}

function retestMainDocSummary(root: string) {
  return {
    exists: root !== "",
    path: `${root}/app-data/confscope-data.json`,
    savedAt: root === "" ? "" : new Date().toISOString(),
    sizeBytes: root === "" ? 0 : 2048,
    sha256: root === "" ? "" : `retest-sha-${root}`,
  };
}

function retestRuntimeLayout() {
  return {
    mode: dataRootState.mode,
    dataRoot: dataRootState.root,
    source: dataRootState.source,
    exeDir: "/tmp/confscope-retest/exe",
    exeDirWritable: true,
    pointerPath: `${dataRootState.root}/data-root.json`,
    previousRoot: dataRootState.previousRoot,
    osDataDir: "/tmp/confscope-retest/os-data",
    notes: dataRootState.previousRoot ? [`MIGRATED:${dataRootState.previousRoot}`] : [],
    error: "",
  };
}

/** 与 Go 侧 buildMigrationPlan 同判据的最小镜像（含同样的中文措辞），只拦 UI 最容易踩中的四种。 */
function retestValidateDataRootTarget(target: string): string {
  const trimmed = target.trim().replace(/[\\/]+$/, "");
  if (trimmed === "") return "请先选择目标目录";
  if (!trimmed.startsWith("/")) return `目标必须是绝对路径：${trimmed}`;
  if (trimmed === dataRootState.root) return `目标目录与当前数据根相同：${trimmed}`;
  if (trimmed.startsWith(`${dataRootState.root}/`)) return `目标不能在当前数据根内部，否则会把目录拷进自己的子目录：${trimmed}`;
  if (dataRootState.root.startsWith(`${trimmed}/`)) return `当前数据根在目标目录内部，换根后路径会自我包含：${trimmed}`;
  return "";
}

function retestPlanDataRootMigration(target: string) {
  const trimmed = target.trim().replace(/[\\/]+$/, "");
  const err = retestValidateDataRootTarget(trimmed);
  return {
    source: dataRootState.root,
    target: trimmed,
    mode: dataRootState.mode,
    itemCount: err ? 0 : 5,
    totalBytes: err ? 0 : 20480,
    hasSourceData: err ? false : true,
    resumable: false,
    reusedItems: 0,
    warnings: ["复测桥为内存替身，不会真实复制文件"],
    requiresRestart: true,
    valid: err === "",
    error: err,
  };
}

function retestMigrateDataRoot(target: string) {
  const plan = retestPlanDataRootMigration(target);
  if (!plan.valid) {
    return {
      source: plan.source,
      target: plan.target,
      itemsCopied: 0,
      itemsReused: 0,
      pointerPath: "",
      migratedMarker: "",
      requiresRestart: false,
      restartReason: "",
      notes: [],
      error: plan.error,
    };
  }
  dataRootState.previousRoot = plan.source;
  dataRootState.root = plan.target;
  dataRootState.source = "user-choice";
  dataRootState.migrations += 1;
  return {
    source: plan.source,
    target: plan.target,
    itemsCopied: plan.itemCount,
    itemsReused: 0,
    pointerPath: `${plan.target}/data-root.json`,
    migratedMarker: `${plan.source}/MIGRATED-retest.marker`,
    requiresRestart: true,
    restartReason: "数据位置已切换，需重启应用后新位置才会生效",
    notes: [`已在旧位置留下迁移标记：${plan.source}`],
    error: "",
  };
}

function retestCheckDataRootRollback() {
  const available = dataRootState.previousRoot !== "";
  return {
    available,
    currentRoot: dataRootState.root,
    previousRoot: dataRootState.previousRoot,
    currentDoc: retestMainDocSummary(dataRootState.root),
    previousDoc: retestMainDocSummary(available ? dataRootState.previousRoot : ""),
    reason: available ? "" : "没有可回退的旧数据位置",
  };
}

function retestRollbackDataRoot() {
  if (dataRootState.previousRoot === "") {
    return {
      source: dataRootState.root,
      target: "",
      itemsCopied: 0,
      itemsReused: 0,
      pointerPath: "",
      migratedMarker: "",
      requiresRestart: false,
      restartReason: "",
      notes: [],
      error: "没有可回退的旧数据位置",
    };
  }
  const from = dataRootState.root;
  dataRootState.root = dataRootState.previousRoot;
  dataRootState.previousRoot = "";
  dataRootState.source = "user-choice";
  dataRootState.rollbacks += 1;
  return {
    source: from,
    target: dataRootState.root,
    itemsCopied: 0,
    itemsReused: 0,
    pointerPath: `${dataRootState.root}/data-root.json`,
    migratedMarker: "",
    requiresRestart: true,
    restartReason: "已回退到旧数据位置，需重启应用后生效",
    notes: [],
    error: "",
  };
}

function endpointFor(baseUrl: string): NacosEndpoint | null {
  const state = loadRetestState();
  for (const key of ["a", "b"] as const) {
    const ep: RetestNacosEndpoint = state.nacos[key];
    if (ep.baseUrl === baseUrl || baseUrl.includes(`:${ep.clientPort}`)) return { baseUrl: ep.baseUrl, namespace: ep.namespace };
  }
  return null;
}

function normalizeSSHConfigLike(input: unknown): Record<string, unknown> {
  const c = (input ?? {}) as Record<string, unknown>;
  return c;
}

function v1(ep: NacosEndpoint, path: string, query: Record<string, string>): string {
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return `${ep.baseUrl}/v1${path}${qs ? `?${qs}` : ""}`;
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
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


const bridgeListeners: Array<(line: string) => void> = [];

export function onBridgeLog(fn: (line: string) => void): void {
  bridgeListeners.push(fn);
}

const bridgeLog = (...parts: unknown[]) => {
  const line = `[retest-bridge] ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}`;
  console.log(line);
  for (const fn of bridgeListeners) fn(line);
};

// ── 本机配置版本历史（config-revisions.jsonl）的桥内替身（轮67 R57）──────────────
// 为什么放内存而不是落盘：retest 禁止写桌面应用正式数据目录 portable/ConfScopeData（数据纪律第 3 条），
// 这条链路要验的是前端可见结果——读到正文后「本机历史」攒出几版、同一版重复读不涨、服务端改一版再读才涨、
// 分段切了在看的内容跟着切、设置页清掉之后回到诚实空态且清完还能重新攒起来（前端那份 md5 记忆确实跟着清了）。
// 真实的 JSONL 追加、坏行跳过、超限裁剪、保留策略重写，以及「读不出来 ≠ 本机没记过」的返回值拆分由
// internal/revisions/trail_test.go 负责，桥里只镜像它的前端可见判据：
//   摘要 = 规范化换行后的内容指纹；同键同摘要的 observed 不新起一版；
//   confirmed-write 命中同一版时就地升级并保留首见时刻；已挂写入确认的同一版再执行只判重。
export const RETEST_REVISIONS_PATH = "/tmp/confscope-retest/app-data/config-revisions.jsonl（桥内内存替身）";

// 与 Go 侧 revisions 包同名常量同值。桥只做镜像，不参与产品构建，产品里那一份的唯一出口是 src/lib/configRevisions.ts。
const REVISION_KIND_OBSERVED = "observed";
const REVISION_KIND_CONFIRMED_WRITE = "confirmed-write";
const REVISION_CONTENT_OMITTED_TOO_LARGE = "too-large";
const REVISION_REASON_APPENDED = "appended";
const REVISION_REASON_DUPLICATE = "duplicate";
const REVISION_REASON_PROMOTED = "promoted";
const REVISION_KEEP_PER_KEY = 50;
const REVISION_MAX_CONTENT_BYTES = 512 * 1024;
// 分组键分隔符同 Go 侧 keySeparator（NUL）。用 fromCharCode 造而不在源码里写字面量：
// 源文件里塞一个真实的 NUL 会让各种工具链抽搐（与 src/lib/configRevisions.ts 同一处理）。
const REVISION_KEY_SEPARATOR = String.fromCharCode(0);

/** 字段名与 Go 侧 Record 的 json tag 逐字对齐（界面按这些名字取，改一处就得三处一起改）。 */
interface RetestRevisionRecord {
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
  firstSeenTs: string;
  planId: string;
  appVersion: string;
}

/** 单个配置键在桥内替身里发生过的三种结局（断言只按自己的键取，别被同页其他配置的读取噪声串台）。 */
interface RetestRevisionKeyCounters {
  appended: number;
  duplicate: number;
  promoted: number;
}

interface RetestRevisionsState {
  /** 追加序 = 时间序（与 jsonl 一行一条同构），读取时才倒过来变成「最新在前」。 */
  records: RetestRevisionRecord[];
  appended: number;
  duplicate: number;
  promoted: number;
  reads: number;
  clears: number;
  /** 按配置键分开的结局计数（整页会顺带读别的配置正文，全局计数没法证明「这一次重复读被判重了」）。 */
  byKey: Record<string, RetestRevisionKeyCounters>;
}

function emptyRevisionsState(): RetestRevisionsState {
  return { records: [], appended: 0, duplicate: 0, promoted: 0, reads: 0, clears: 0, byKey: {} };
}

let revisionsState: RetestRevisionsState = emptyRevisionsState();

export function resetRetestRevisions(): void {
  revisionsState = emptyRevisionsState();
}

/** 只给复测断言用（前端不调它）：桥内到底攒了几版、三种结局各发生几次。 */
export function retestRevisionsSnapshot(): RetestRevisionsState {
  return {
    ...revisionsState,
    records: revisionsState.records.map((rec) => ({ ...rec })),
    byKey: Object.fromEntries(Object.entries(revisionsState.byKey).map(([k, v]) => [k, { ...v }])),
  };
}

function revisionKeyOf(rec: { connectionId: string; namespace: string; group: string; dataId: string }): string {
  return [rec.connectionId, rec.namespace, rec.group, rec.dataId].join(REVISION_KEY_SEPARATOR);
}

/**
 * 只给复测断言用：某个配置键在桥内攒下的版本与三种结局各发生几次。
 *
 * 为什么按键而不是看全局：配置浏览页挂载时会顺带读到别的配置的正文（对比页的自动恢复也会各读一次），
 * 那些都算「本机见过」。断言「这个配置重复读不涨版」「判重真的发生了」必须只看自己那一把键。
 */
export function retestRevisionKeyStats(connectionId: string, namespace: string, group: string, dataId: string) {
  const key = [connectionId, namespace, group, dataId].join(REVISION_KEY_SEPARATOR);
  const counters = revisionsState.byKey[key] ?? { appended: 0, duplicate: 0, promoted: 0 };
  return {
    key,
    records: revisionsState.records.filter((rec) => revisionKeyOf(rec) === key).map((rec) => ({ ...rec })),
    appended: counters.appended,
    duplicate: counters.duplicate,
    promoted: counters.promoted,
    attempts: counters.appended + counters.duplicate + counters.promoted,
  };
}

function bumpRevisionKeyCounter(key: string, field: keyof RetestRevisionKeyCounters): void {
  const current = revisionsState.byKey[key] ?? { appended: 0, duplicate: 0, promoted: 0 };
  current[field] += 1;
  revisionsState.byKey[key] = current;
}

/** 该键在本机记录的最后一版下标（-1 = 这个键还没记过）。 */
function lastRevisionIndexForKey(key: string): number {
  for (let i = revisionsState.records.length - 1; i >= 0; i -= 1) {
    if (revisionKeyOf(revisionsState.records[i]) === key) return i;
  }
  return -1;
}

/** 摘要前的规范化口径同 Go 侧 NormalizeContent：只统一换行（CRLF/CR → LF），别的一律不动。 */
function normalizeRevisionContent(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * 内容指纹。
 *
 * Go 侧是 sha256: + 十六进制；桥里优先用 WebCrypto 拿真 sha256（node 22 与 localhost 安全上下文都有），
 * 取不到时退回一个「同内容必同值」的稳定短指纹——判重只要求稳定，界面也只截前 12 位显示，
 * 真实摘要口径由 internal/revisions/trail_test.go 钉住。前缀照抄，保证 hashShort 的显示形状一致。
 */
async function revisionHashOf(normalized: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalized);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest("SHA-256", bytes);
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `sha256:${hex}`;
  }
  let h = 5381;
  for (const b of bytes) h = ((h << 5) + h + b) >>> 0;
  return `sha256:${h.toString(16).padStart(8, "0")}`;
}

/** 与 Go 侧 buildRecord 同判据：非法输入直接报错（悄悄记一条没归属的版本比失败更坏）。 */
async function buildRevisionRecord(input: Record<string, unknown>): Promise<RetestRevisionRecord> {
  const kind = String(input?.kind ?? "").trim();
  const connectionId = String(input?.connectionId ?? "").trim();
  const dataId = String(input?.dataId ?? "").trim();
  const planId = String(input?.planId ?? "").trim();
  if (kind !== REVISION_KIND_OBSERVED && kind !== REVISION_KIND_CONFIRMED_WRITE) {
    throw new Error(`未知的版本记录类型: ${String(input?.kind ?? "")}`);
  }
  if (!connectionId || !dataId) throw new Error("版本记录缺少连接或 dataId，无法归属");
  if (kind === REVISION_KIND_CONFIRMED_WRITE && !planId) {
    throw new Error("写入确认记录缺少 planId，无法回链操作历史与备份快照");
  }
  const normalized = normalizeRevisionContent(String(input?.content ?? ""));
  const size = new TextEncoder().encode(normalized).length;
  const omitted = size > REVISION_MAX_CONTENT_BYTES;
  return {
    schema: 1,
    ts: new Date().toISOString(),
    kind,
    connectionId,
    connectionName: String(input?.connectionName ?? "").trim(),
    provider: String(input?.provider ?? "").trim(),
    // 命名空间与分组按原样留着（Go 侧也不 trim：空串就是 public，改成 " " 会变成另一个键）
    namespace: String(input?.namespace ?? ""),
    group: String(input?.group ?? ""),
    dataId,
    hash: await revisionHashOf(normalized),
    serverMd5: String(input?.serverMd5 ?? "").trim(),
    bytes: size,
    format: String(input?.format ?? "").trim(),
    // 超限只存摘要：显示半截正文比不显示更坏（用户会以为那一版就是半截）
    content: omitted ? "" : normalized,
    contentOmittedReason: omitted ? REVISION_CONTENT_OMITTED_TOO_LARGE : "",
    firstSeenTs: "",
    planId,
    // Go 侧缺失时补构建版本；桥里补一个固定值，界面这一列只用来核对「记上了」
    appVersion: String(input?.appVersion ?? "").trim() || "retest",
  };
}

/** 与 Go 侧 Store.Append 同判据的最小镜像（三种结局都要回给调用方）。 */
async function retestAppendRevision(input: Record<string, unknown>) {
  const record = await buildRevisionRecord(input);
  const key = revisionKeyOf(record);
  const lastIndex = lastRevisionIndexForKey(key);
  if (lastIndex >= 0 && revisionsState.records[lastIndex].hash === record.hash) {
    if (record.kind === REVISION_KIND_OBSERVED) {
      revisionsState.duplicate += 1;
      bumpRevisionKeyCounter(key, "duplicate");
      return { appended: false, reason: REVISION_REASON_DUPLICATE, record };
    }
    const last = revisionsState.records[lastIndex];
    if (last.kind === REVISION_KIND_CONFIRMED_WRITE) {
      // 这一版已经挂着写入确认与 planId：重复执行同一份内容不再改写来历，也不新起一版
      revisionsState.duplicate += 1;
      bumpRevisionKeyCounter(key, "duplicate");
      return { appended: false, reason: REVISION_REASON_DUPLICATE, record };
    }
    record.firstSeenTs = last.ts;
    revisionsState.records[lastIndex] = record;
    revisionsState.promoted += 1;
    bumpRevisionKeyCounter(key, "promoted");
    return { appended: false, reason: REVISION_REASON_PROMOTED, record };
  }
  revisionsState.records.push(record);
  revisionsState.appended += 1;
  bumpRevisionKeyCounter(key, "appended");
  return { appended: true, reason: REVISION_REASON_APPENDED, record };
}

/** 跨键最近 limit 条，最新在前（limit<=0 时取 Go 侧那个 5000 上限）。 */
function retestReadRevisions(limit: number): RetestRevisionRecord[] {
  revisionsState.reads += 1;
  const newestFirst = [...revisionsState.records].reverse();
  return limit > 0 ? newestFirst.slice(0, limit) : newestFirst.slice(0, 5000);
}

/** 某个配置键的版本历史，最新在前（limit<=0 = 全部，界面就是不分页地一次读完）。 */
function retestReadRevisionsForKey(
  connectionId: string,
  namespace: string,
  group: string,
  dataId: string,
  limit: number
): RetestRevisionRecord[] {
  revisionsState.reads += 1;
  const key = [connectionId, namespace, group, dataId].join(REVISION_KEY_SEPARATOR);
  const newestFirst = revisionsState.records.filter((rec) => revisionKeyOf(rec) === key).reverse();
  return limit > 0 ? newestFirst.slice(0, limit) : newestFirst;
}

/** 保留策略同 Go 侧 pruneLocked：每键最早一版留作锚点，其余只留最近 keepPerKey 条。 */
function retestPruneRevisions(keepPerKeyRaw: number): number {
  const keepPerKey = keepPerKeyRaw > 0 ? keepPerKeyRaw : REVISION_KEEP_PER_KEY;
  const total = new Map<string, number>();
  for (const rec of revisionsState.records) {
    const key = revisionKeyOf(rec);
    total.set(key, (total.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const kept: RetestRevisionRecord[] = [];
  let removed = 0;
  for (const rec of revisionsState.records) {
    const key = revisionKeyOf(rec);
    const nth = (seen.get(key) ?? 0) + 1;
    seen.set(key, nth);
    const fromEnd = (total.get(key) ?? 0) - nth + 1;
    if (nth === 1 || fromEnd <= keepPerKey) kept.push(rec);
    else removed += 1;
  }
  revisionsState.records = kept;
  return removed;
}

function retestClearRevisions(): void {
  // Go 侧 truncate 为 0 字节并重建索引；桥里等价于把记录清空（全局计数留着给断言看「清过几次」，
  // 按键的结局计数属于「这份历史的内容」，跟着一起清，否则清完后断言读不到真实起点）
  revisionsState.records = [];
  revisionsState.byKey = {};
  revisionsState.clears += 1;
}

/**
 * 体量事实同 Go 侧 GetFacts 的字段；sizeBytes 按等价 jsonl 的行长估算（一字节不差没必要）。
 * 也导给复测断言直接调：设置页那行念的数必须和界面读到的是同一份口径，不然断言就成了猜数字。
 */
export function retestRevisionFacts() {
  const keys = new Set(revisionsState.records.map((rec) => revisionKeyOf(rec)));
  const sizeBytes = revisionsState.records.reduce((acc, rec) => acc + JSON.stringify(rec).length + 1, 0);
  return {
    path: RETEST_REVISIONS_PATH,
    exists: revisionsState.records.length > 0,
    records: revisionsState.records.length,
    sizeBytes,
    keys: keys.size,
    keepPerKey: REVISION_KEEP_PER_KEY,
  };
}

// 审计事件持久化（模拟 Go 侧 AppendAuditEvent → <dataDir>/audit-trail.jsonl）：
// 容器跨 run 持久化，jsonl 只追加，供 60-audit spec 校验完整操作过程。
export const RETEST_AUDIT_DIR = "/tmp/confscope-retest/audit";
export const RETEST_AUDIT_FILE = `${RETEST_AUDIT_DIR}/audit-trail.jsonl`;
const auditSessions = new Map<string, { kind: string; status: string }>();
const auditLines: string[] = [];
let auditLineSink: ((line: string) => void) | null = null;
let auditReadSource: (() => string[]) | null = null;
let auditClearSink: (() => void) | null = null;

/** node 侧落盘回调（由 installRetestBridge 注入）；
 * 浏览器内联桥环境无 node:fs（见 e12e4f7 的浏览器兼容改造），审计仅日志。 */
export function setRetestAuditLineSink(sink: ((line: string) => void) | null): void {
  auditLineSink = sink;
}

/** node 侧审计文件读取/清空钩子（由 installRetestBridge 注入，e12e4f7 浏览器兼容改造
 * 移除了 node:fs 后 ReadAuditLogLines/ClearAuditTrail 依赖的落盘能力由此恢复）；
 * 纯浏览器环境无注入时：读取回退进程内行、清空 no-op。 */
export function setRetestAuditFsHooks(read: () => string[], clear: () => void): void {
  auditReadSource = read;
  auditClearSink = clear;
}

function auditRead(): string[] {
  if (auditReadSource) return auditReadSource();
  return auditLines;
}
function auditWrite(lines: string[]): void {
  if (lines.length === 0) {
    auditClearSink?.();
    auditLines.length = 0;
    return;
  }
  for (const line of lines) appendAuditEventNode(line);
}
function appendAuditEventNode(raw: string): void {
  auditLines.push(raw);
  bridgeLog("audit", raw.slice(0, 400));
  auditLineSink?.(raw);
}

/** 进程级共享的发布时间戳（key: `${baseUrl}|${ns}|${group}|${dataId}`，value: 毫秒）。
 *  Nacos v1 的 Last-Modified 头精度为秒级，批量执行中前序写入会刷新后序读取的时间戳，
 *  桥在发布/删除后记录精确毫秒值，读取时优先使用，避免秒级取整造成计划陈旧误判。
 *
 *  持久化到 /tmp 的原因：Playwright 按 spec 文件拆分 worker 进程，模块级 Map 不跨文件共享。
 *  若前一个 spec 在 Nacos 上发布/删除过配置（刷新了 Last-Modified），后一个 spec 的审计/对比
 *  读到旧秒级时间戳，会导致数据被误判为「未变更」或陈旧。用文件兜底跨进程共享。
 */

function md5Of(text: string): string {
  // 浏览器侧无 node:crypto：djb2 十六进制指纹，仅用于缓存键/去重，非密码学用途
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
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

/*
 * 升级交接闸门的桥内替身（默认全关：别的用例照旧读到「已是最新 + 没有隧道」）。
 *
 * 为什么要有：这条链路以前只有真人在实机才走得到——桥里 CheckForUpdates 恒回无更新、
 * 隧道表恒空，「退出并安装」的忙碌闸门从没被真机测过一次，所以 1.9.8 才会在实机上
 * 把内部连接 ID 直接甩给用户、还不给任何出口。setter 由用例显式调用，
 * installRetestBridge 每用例重置一次，不会把「有新版本」泄漏给同 worker 的下一条用例。
 */
let retestUpdateCheck: Record<string, unknown> | null = null;
let retestDownloadedArtifact = "no-op";
const retestActiveTunnels: string[] = [];

/** 覆盖 CheckForUpdates 的返回（null = 恢复「已是最新」基线）；顺带指定下载完落地的产物路径。 */
export function setRetestUpdateCheck(result: Record<string, unknown> | null, artifactPath = "/tmp/confscope-retest-installer.exe") {
  retestUpdateCheck = result;
  retestDownloadedArtifact = result ? artifactPath : "no-op";
}

/** 让 Go 侧隧道表替身里有这几条隧道（元素是连接 ID，与产品侧 CreateSSHTunnel 的键同源）。 */
export function setRetestActiveTunnels(ids: string[]) {
  retestActiveTunnels.length = 0;
  retestActiveTunnels.push(...ids);
}

/** 用例侧读桥内隧道表：断言「产品真的把这条隧道关掉了」，不看界面文案自己说满意。 */
export function getRetestActiveTunnels(): string[] {
  return [...retestActiveTunnels];
}

export function resetRetestUpdateHandoff() {
  retestUpdateCheck = null;
  retestDownloadedArtifact = "no-op";
  retestActiveTunnels.length = 0;
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

  // 发布 stamp 只记录本 Playwright 进程内的发布。
  // 注意：复测容器是持久化的，跨 run 残留 stamp（旧版曾落盘 /tmp）会让
  // GetConfig 误判"内容未变"（stamp >= Nacos Last-Modified），审计/历史场景因此失真。
  const publishStamps = new Map<string, number>();
  const stampKey = (ep: NacosEndpoint, namespace: string, group: string, dataId: string) =>
    `${ep.baseUrl}|${namespace}|${group}|${dataId}`;
  const readStamp = (ep: NacosEndpoint, namespace: string, group: string, dataId: string) =>
    publishStamps.get(stampKey(ep, namespace, group, dataId)) ?? null;
  const writeStamp = (ep: NacosEndpoint, namespace: string, group: string, dataId: string) => {
    publishStamps.set(stampKey(ep, namespace, group, dataId), Date.now());
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

  // ConfigCenter 门面走 /v1/console/namespaces（{code,message,data} 包裹，需解包）；
  // 旧版 Nacos* 方法走同一接口的数组形态。两者共用本解析。
  const rawNamespacesV1 = async (ep: NacosEndpoint): Promise<RawNamespace[]> => {
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
    const state = loadRetestState();
    switch (method) {
      case "GetAppInfo":
        // 与存储播种的 startup.lastShown* 版本一致 → 不触发欢迎弹窗
        return { name: "ConfScope", version: "1.9.2", updateSources: [] };
      case "GetCurrentPlatform":
        return "linux";
      case "CheckForUpdates":
        if (retestUpdateCheck) return retestUpdateCheck;
        return {
          hasUpdate: false,
          latestVersion: "1.9.2",
          currentVersion: "1.9.2",
          sourceName: "",
          releaseNotes: "",
          mandatory: false,
          error: "",
          platformKey: "linux-amd64",
          fileName: "confscope-linux-amd64.tar.gz",
          handoff: "reveal",
          downgraded: false,
          reason: "",
        };
      case "GetDownloadProgress":
        // 复测环境无真实下载任务；返回 done 状态，供 About 页轮询使用
        return { downloaded: 0, total: 0, percent: 0, done: true, error: "" };
      case "DownloadUpdate":
        return retestDownloadedArtifact;
      // 升级出路四条（与 internal/updatecheck/handoff.go 同名同义）：
      // 复测环境没有真实产物，一律按"还没有下载好的更新包"这条 Go 侧判据回绝，
      // 这样任何误起安装程序的调用都会在复测里暴露而不是静默成功。
      case "LaunchUpdateInstaller":
        return undefined;
      case "RevealDownloadedArtifact":
        return undefined;
      case "AttachUpdateImage":
        return undefined;
      case "UpdateInstallCommand":
        return "";
      case "ListActiveSSHTunnels":
        // 复测桥不建真实隧道：默认交接闸门读到空表（用例可用 setRetestActiveTunnels 播种）。
        return [...retestActiveTunnels];
      case "QuitApplication":
        // 浏览器里没有可退出的进程，交接链路在此止步（断言看事件，不看真退出）。
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
        // 复测 Nacos 关闭鉴权：auth.enabled=false 时 /v1/auth/login 会长时间挂起
        // （等 auth-server），真实链路此处挂死；免鉴权直接返回空 token。
        return { accessToken: "", tokenTtl: 18000, globalAdmin: false };
      }

      // ── 新版 ConfigCenter 门面（profile + ref/req 结构体） ──
      case "ConfigCenterTestConnection": {
        // 快照来源连接（baseUrl=/tmp/...）不走 Nacos 端点探测，直接成功（与 Go 侧 local provider 行为一致）。
        const profileConn = (args[0] ?? {}) as Record<string, unknown>;
        if (String(profileConn?.id ?? "").startsWith("snapshot:") || String(profileConn?.baseUrl ?? "").startsWith("/tmp/confscope-retest-snapshots")) {
          return null;
        }
        const ep = getEndpoint(args);
        // 与 Go 侧 NacosProvider.TestConnection 行为一致：探测命名空间接口。
        // 注意：v2.5.2 容器没有 /console/health/readiness（那是 2.4+ 的 8080 端口），
        // 走该路径会 404 导致连接测试误报失败。
        await rawNamespaces(ep);
        return null;
      }
      case "ConfigCenterListNamespaces": {
        const ep = getEndpoint(args);
        // 与 Go 侧一致：v1 命名空间接口是 /v1/console/namespaces（非 v3 路径）。
        const items = await rawNamespacesV1(ep);
        // 必须镜像 src/api/nacos.ts 的 fromConfigCenterNamespace：
        //   { id: item.namespace, name: item.namespaceShowName || fallback, configCount, kind }
        // 桥输出经 exposeFunction JSON 序列化给 UI，字段名必须与前端映射读取的 {id,name} 一致，
        // 否则 UI 静默丢弃（曾发生：桥输出 {namespace,...} → ns 下拉只剩 public 默认项）。
        const out = items.map((item) => ({
          id: item.namespace,
          name: item.namespaceShowName || (item.namespace ? item.namespace : "public"),
          configCount: item.configCount ?? 0,
          kind: item.type ?? 0,
        }));
        // 复测扩展：B 连接追加哨兵命名空间 "B 侧 (prod)" → namespace "retest:envB"，
        // 浏览/编辑/历史 UI 切到它即读到 B 侧(19849/retest-qa)同 dataId 的 prod 版内容
        // （Nacos v2 发布时不自动建命名空间, 无法用真实 ns; 生产程序不经此桥, 不受影响）。
        if (ep.baseUrl === state.nacos.b.baseUrl) {
          out.push({ id: "retest:envB", name: "B 侧 (prod)", configCount: 16, kind: 0 });
        }
        return out;
      }
      case "ConfigCenterListConfigs": {
        const ep = getEndpoint(args);
        const req = args[1] as Record<string, unknown>;
        const listReq = {
          search: "blur",
          dataId: String(req.dataId ?? ""),
          group: String(req.group ?? ""),
          tenant: String(req.namespace ?? "") === "retest:envB" ? ep.namespace : String(req.namespace ?? ""),
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
        const ref = normalizeRefLike(args[1]);
        // 快照来源（local-snapshot）：连接 baseUrl 是 /tmp 快照路径，不命中任何 Nacos 端点。
        // 回退计划执行链路（S8b）的 freshness/before 快照读取会走这里，从内存快照缓存取内容。
        const profile0 = (args[0] ?? {}) as Record<string, unknown>;
        if (ref.provider === "local" || String(profile0?.id ?? "").startsWith("snapshot:") || String(profile0?.baseUrl ?? "").startsWith("/tmp/confscope-retest-snapshots")) {
          const snapshotId = String(profile0?.id ?? "").replace(/^snapshot:/, "");
          const snap = snapshotCache.get(snapshotId) as { configs?: Array<Record<string, unknown>> } | undefined;
          const match = (snap?.configs ?? []).find(
            (c) =>
              String(c.dataId) === ref.dataId &&
              (String(c.group) === ref.group || (ref.group === "" && !c.group))
          );
          if (!match) throw new Error(`404 config not found in snapshot ${snapshotId}: ${ref.dataId}`);
          const content = String(match.content ?? "");
          const type = (ref.dataId.split(".").pop() ?? "").toLowerCase();
          bridgeLog("GetConfig(snapshot)", snapshotId, ref.namespace, ref.dataId, "ok", content.length);
          return {
            ref: { ...ref, provider: "local" },
            content,
            format: ["yaml", "yml", "json", "properties", "txt"].includes(type) ? type : "txt",
            version: md5Of(content),
            source: "local-snapshot",
            updateTime: String(match.updateTime ?? ""),
          };
        }
        const ep = getEndpoint(args);
        // 复测扩展：tenant 参数 "retest:envB" 让浏览/编辑/历史 UI 可切换同一 dataId
        // 的 B 侧(prod 版)内容 —— 用于大文件(330 行)编辑器回归等测试。
        // 生产程序不经过本桥, 不受影响; 普通 tenant(retest-dev/retest-qa)行为不变。
        const nacosTenant =
          ref.namespace === "retest:envB" ? ep.namespace : ref.namespace;
        // 注意：GET /cs/configs 会命中 Chromium/Node 默认 HTTP 缓存（同 URL 同缓存键，
        // 无 cache-control 头）。审计等场景两侧命名空间不同但 dataId/group 相同时
        // （URL 仅 tenant 参数不同…tenant 在 query 里，仍可能因代理/预取混淆），
        // 一律加 no-store 强制回源，保证每次读取拿到真实当前内容。
        const res = await fetch(v1(ep, "/cs/configs", { dataId: ref.dataId, group: ref.group, tenant: nacosTenant }), { cache: "no-store" });
        if (res.status === 404) throw new Error(`404 config not found: ${nacosTenant}/${ref.group}/${ref.dataId}`);
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
      case "ConfigCenterPublishConfigFromApplyPlan": {
        const ep = getEndpoint(args);
        // 形状契约（按 frontend/wailsjs/go/app/App.d.ts 的签名，不是按猜）：
        // 发布类 arg2 = provider.PublishConfigRequest = { ref, content, format } 信封。
        // 删除类 arg2 = provider.ConfigRef 本体——两类不同形，见下方 delete 分支。
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
      case "ConfigCenterDeleteConfigFromApplyPlan": {
        const ep = getEndpoint(args);
        // arg2 就是 ConfigRef 本体（App.d.ts: ConfigCenterDeleteConfigFromApplyPlan(
        // arg1 ConnectionProfile, arg2 ConfigRef)；native/smoke 用例同形状）。
        // 这里曾照搬发布分支去解包 req.ref，拿到 undefined → dataId 空串发给 Nacos →
        // 服务端回 "invalid dataId"，于是「计划删除」在复测里永远红、还查不到产品头上
        // （轮72C ST-03 定位）。形状错就让它当场响，不要静默降级成空参数。
        const ref = normalizeRefLike(args[1]);
        if (!ref.dataId) throw new Error("retest bridge: 删除请求的 dataId 为空，arg2 形状与绑定契约不符（应为 ConfigRef 本体）");
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
        const histTenant = ref.namespace === "retest:envB" ? ep.namespace : ref.namespace;
        const items = await rawHistory(ep, histTenant, ref.dataId, ref.group);
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
        const histDetailTenant = ref.namespace === "retest:envB" ? ep.namespace : ref.namespace;
        const d = await rawHistoryDetail(ep, histDetailTenant, ref.dataId, ref.group, String(args[2]));
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
      case "TestSSHConnection": {
        // S5：模拟真实 SSH 测试。UI 侧（SSHManagerView.testSSHProfile）只消费
        // latencyText(result)，不检查 ok 字段：host 命中本地容器 sshd → 成功；
        // 否则 throw（UI catch → 「SSH 连接失败：…（…ms）」红色反馈）。
        const cfg = normalizeSSHConfigLike(args[0]);
        const host = String(cfg?.host ?? "");
        const state = loadRetestState();
        if (state.ssh && host === state.ssh.host) {
          bridgeLog("ssh-test", host, "ok");
          return { latencyMs: 12 };
        }
        bridgeLog("ssh-test", host || "(empty)", "fail");
        throw new Error(`ssh: no route to host ${host || "(空)"}`);
      }
      case "StopSSHTunnel": {
        // 与 Go 侧 Manager.StopTunnel 同语义：同步从隧道表里摘掉这条，
        // 所以前端「等确认再重读」的闸门才能在复测里复现（产品侧不等就会二次读到它）。
        const target = String(args[0] ?? "");
        const at = retestActiveTunnels.indexOf(target);
        if (at >= 0) retestActiveTunnels.splice(at, 1);
        return null;
      }
      case "StopAllSSHTunnels":
        retestActiveTunnels.length = 0;
        return null;
      case "GetSSHTunnelLocalPort":
        return 0;
      case "CreateSnapshot": {
        // 备份快照落盘到 Node 侧目录（模拟 wails CreateSnapshot），返回可查询的 Snapshot
        const source = args[0] as Record<string, unknown>;
        const configs = args[1] as unknown[];
        const id = `retest-snap-${Date.now()}`;
        const name = `retest-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        // 字段兼容：BackupView 读 cfg.configType，ConfigBrowser 写入的快照项为
        // {configType, ...}；两者都给一份，避免渲染空白类型列。
        const normalizedConfigs = (configs as Array<Record<string, unknown>>).map((c) => ({
          ...c,
          configType: c.configType ?? c.contentType ?? "text",
        }));
        const snapshot = {
          schemaVersion: 1,
          toolVersion: "1.9.2",
          id,
          path: `/tmp/confscope-retest-snapshots/${id}`,
          name,
          description: `retest auto backup`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          source,
          configs: normalizedConfigs,
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
        // 按 createdAt 倒序（新→旧），与 Go 侧 ListSnapshots 排序语义一致；
        // UI 首项即最新快照，测试/人工操作都依赖这个顺序。
        return [...snapshotsList].sort((a, b) =>
          String((b as { createdAt?: string })?.createdAt ?? "").localeCompare(
            String((a as { createdAt?: string })?.createdAt ?? "")
          )
        );
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
      case "TestSnapshotWebDAV": {
        // S7：target {url, username, password}。url 非空 → 通过；空 → 抛错（UI 展示 inline-error）。
        const target = (args[0] ?? {}) as Record<string, unknown>;
        const url = String(target?.url ?? "").trim();
        if (!url) throw new Error("retest bridge: WebDAV 地址不能为空");
        if (url.includes("unreachable")) {
          throw new Error(`WebDAV 连接失败: ${url}（连接超时）`);
        }
        return null;
      }
      case "ListSnapshotWebDAVPackages": {
        // S7：返回一个 mock 远端快照包，供「刷新远端快照」列表渲染断言。
        return [
          {
            name: "retest-remote-snap.cssnapshot",
            path: "/snapshots/retest-remote-snap.cssnapshot",
            size: 20480,
            modifiedAt: "2026-08-30T10:00:00+08:00",
            snapshotId: "retest-remote-snap",
            snapshotName: "retest-remote-backup",
            provider: "nacos",
            connectionId: "retest-b",
            connectionName: "Retest Nacos B",
            configCount: 13,
            createdAt: "2026-08-30T09:00:00+08:00",
          },
        ];
      }
      case "UploadSnapshotWebDAVPackage": {
        // S7：返回上传后的远端快照包（UI 用 remote.path/name 渲染列表 + 「快照包已上传」toast）。
        return {
          name: "retest-uploaded.cssnapshot",
          path: "/snapshots/retest-uploaded.cssnapshot",
          size: 20480,
          modifiedAt: new Date().toISOString(),
          snapshotId: String(args[1] ?? ""),
          snapshotName: "retest-uploaded",
          provider: "nacos",
          connectionId: "retest-b",
          connectionName: "Retest Nacos B",
          configCount: 13,
          createdAt: new Date().toISOString(),
        };
      }
      case "ImportSnapshotWebDAVPackage": {
        // S7：导入一个最小本地快照（含 1 条配置），UI 展示「快照已导入」toast 并刷新列表。
        const id = "retest-imported-snap";
        const snapshot = {
          schemaVersion: 1,
          toolVersion: "1.9.2",
          id,
          path: `/tmp/confscope-retest-snapshots/${id}`,
          name: "retest-imported",
          description: "retest imported from mock WebDAV",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          source: {
            provider: "nacos",
            connectionId: "retest-b",
            connectionName: "Retest Nacos B",
            namespace: "retest-qa",
            namespaceId: "retest-qa",
          },
          configs: [
            {
              namespace: "retest-qa",
              dataId: "svc-billing.yaml",
              group: "RETEST-PROD",
              configType: "yaml",
              contentType: "yaml",
              content: "billing:\n  cycle: daily\n",
              updateTime: new Date().toISOString(),
            },
          ],
          importedFrom: { type: "webdav", remotePath: "/snapshots/retest-remote-snap.cssnapshot", importedAt: new Date().toISOString() },
        };
        snapshotCache.set(id, snapshot);
        snapshotsList.push(snapshot);
        // UI 用返回值渲染 toast/刷新列表：必须返回完整 Snapshot（与 CreateSnapshot 契约一致）
        return snapshot;
      }
      case "AppendAuditEvent": {
        // raw 为单行 JSON（JSONL）
        const line = String(args[0] ?? "");
        appendAuditEventNode(line);
        try {
          const ev = JSON.parse(line) as { kind?: string; sessionId?: string; result?: string; status?: string };
          if (ev.kind && ev.sessionId) {
            if (ev.kind === "session_start") auditSessions.set(ev.sessionId, { kind: String(ev.kind), status: "running" });
            else if (ev.kind === "session_end") auditSessions.set(ev.sessionId, { kind: String(ev.kind), status: String(ev.status ?? "unknown") });
          }
        } catch {
          // 非 JSON 行也照写
        }
        return null;
      }
      case "ReadAuditLogLines": {
        const limit = Number(args[0] ?? 5000);
        return auditRead().slice(-Math.max(1, limit));
      }
      case "ClearAuditTrail": {
        // 模拟 Go ClearAuditTrail：清空（幂等）
        auditWrite([]);
        return null;
      }
      case "GetDataLocations": {
        // 模拟 Go GetDataLocations：数据根来自桥内替身（迁移后会变，见 dataRootState）
        const root = dataRootState.root;
        const entry = (key: string, path: string, isFile: boolean) => ({ key, path, isFile, exists: true });
        return {
          dataRoot: root,
          mode: dataRootState.mode,
          source: dataRootState.source,
          notes: dataRootState.previousRoot ? [`MIGRATED:${dataRootState.previousRoot}`] : [],
          entries: [
            entry("dataRoot", root, false),
            entry("appDataFile", `${root}/app-data/confscope-data.json`, true),
            entry("webview", `${root}/webview`, false),
            entry("snapshots", `${root}/snapshots`, false),
            entry("recoveryPoints", `${root}/app-data-recovery-points`, false),
            entry("logs", `${root}/logs`, false),
            entry("audit", `${root}/audit-trail.jsonl`, true),
          ],
        };
      }
      case "OpenDataFolder":
        // retest 无文件管理器：仅校验白名单 key，模拟成功
        if (!["dataRoot", "appDataFile", "webview", "snapshots", "recoveryPoints", "logs", "audit"].includes(String(args[0]))) {
          throw new Error(`unknown data location key: ${args[0]}`);
        }
        return null;
      case "GetRuntimeLayout":
        // 模拟 Go GetRuntimeLayout：运行形态/命中档位/当前数据根
        return retestRuntimeLayout();
      case "SelectDataRootDirectory":
        // retest 无原生目录选择器：返回用例预置的目录，没预置就给一个固定的新根
        return pendingDataRootTarget ?? `${RETEST_DATA_ROOT_BASE}-moved`;
      case "PlanDataRootMigration":
        return retestPlanDataRootMigration(String(args[0] ?? ""));
      case "MigrateDataRoot":
        return retestMigrateDataRoot(String(args[0] ?? ""));
      case "CheckDataRootRollback":
        return retestCheckDataRootRollback();
      case "RollbackDataRoot":
        return retestRollbackDataRoot();
      case "GetAppDataDocument":
        appDataDoc.gets += 1;
        return appDataDocStatus(appDataDoc.document);
      case "SaveAppDataDocument": {
        const doc = (args[0] ?? null) as Record<string, unknown> | null;
        appDataDoc.document = doc;
        appDataDoc.saves += 1;
        return appDataDocStatus(doc);
      }
      case "RetestAppDataDocSnapshot":
        // 只给复测断言用（前端不调它）：读桥内替身的调用计数与最后一份文档。
        return { ...appDataDoc };
      // 本机配置版本历史（轮67 R57）：桥内内存替身，判据镜像 internal/revisions（见文件顶部的替身说明）
      case "AppendConfigRevision":
        return retestAppendRevision((args[0] ?? {}) as Record<string, unknown>);
      case "ReadConfigRevisions":
        return retestReadRevisions(Number(args[0] ?? 0));
      case "ReadConfigRevisionsForKey":
        return retestReadRevisionsForKey(
          String(args[0] ?? ""),
          String(args[1] ?? ""),
          String(args[2] ?? ""),
          String(args[3] ?? ""),
          Number(args[4] ?? 0)
        );
      case "PruneConfigRevisions":
        return retestPruneRevisions(Number(args[0] ?? 0));
      case "ClearConfigRevisions":
        return retestClearRevisions();
      case "GetConfigRevisionFacts":
        return retestRevisionFacts();
      case "RetestRevisionsSnapshot":
        // 只给复测断言用（前端不调它）：读桥内替身攒到的版本条数与各结局计数。
        return retestRevisionsSnapshot();
      default:
        throw new Error(`retest bridge: 未实现绑定 ${method}`);
    }
  };
  return async (method: string, args: unknown[]) => {
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

