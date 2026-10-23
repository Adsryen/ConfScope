import type { Connection } from "../store/connections";
import type { ConfigDocument } from "../api/nacos";
import type { OperationRecord } from "../store/operationHistory";
import type { TaskManager } from "./taskmanager";
import {
  fingerprintApplyPlanValue,
  validateApplyPlanFreshness,
  type ApplyPlan,
  type ApplyPlanEndpoint,
  type ApplyPlanFreshnessIssue,
  type ApplyPlanFreshnessSide,
  type ApplyPlanFreshnessSnapshot,
  type ApplyPlanItem,
  type ApplyPlanRef,
  type ApplyPlanValueInput,
} from "./applyPlan";
import {
  buildApplyOperationHistoryInput,
  operationTypeForApplyPlan,
  prepareApplyExecutionSafety,
  type ApplyBackupConfig,
  type ApplyBackupSummary,
  type ApplyTargetBeforeSnapshot,
} from "./applyExecutionSafety";
import { detectFormat, nacosType, type Format } from "./format";
import { BATCH_READ_CONCURRENCY, mapWithConcurrency } from "./concurrency";
import { normalizeConfig } from "./normalize";
import { translate } from "../locales";
import { errorText } from "./errorText";
import { recordConfirmedWrite } from "./configRevisions";
import { normalizeNamespace, type ConfigChangeNotice, type ConfigChangeRef } from "./configChangeBus";

const PROTECTED_TARGET_MARKERS = ["uat", "prod", "production", "生产", "真实", "线上"] as const;
const DOCUMENT_KEY = "__document";

export interface ExecuteApplyPlanDeps {
  connections: Connection[];
  getConfigDocument: (conn: Connection, namespace: string, dataId: string, group: string) => Promise<ConfigDocument>;
  publishConfig: (conn: Connection, namespace: string, dataId: string, group: string, content: string, configType: string) => Promise<void>;
  deleteConfig: (conn: Connection, namespace: string, dataId: string, group: string) => Promise<void>;
  publishConfigRef?: (conn: Connection, ref: ApplyPlanWriteRef, content: string, configType: string) => Promise<void>;
  deleteConfigRef?: (conn: Connection, ref: ApplyPlanWriteRef) => Promise<void>;
  createBackupSnapshot: (configs: ApplyBackupConfig[]) => Promise<{ id: string; name: string }>;
  recordOperation: (record: Omit<OperationRecord, "id" | "timestamp">) => OperationRecord;
  taskManager: TaskManager;
  /**
   * 真实写入（非 dry-run）结束后的失效广播：只要有一条 item 落成功就发，
   * 全部成功与逐项失败两条出口都发（部分写入同样是「服务端数据变了」）。
   * 由调用方接到 configChangeBus —— 保活视图（配置浏览 / 配置对比）靠它感知真值已变，
   * 否则界面刚提示「变更执行完成」，切回去看到的还是执行前那一份。
   */
  onConfigsChanged?: (notice: ConfigChangeNotice) => void;
}

export interface ApplyItemWriteResult {
  item: ApplyPlanItem;
  kind: PlannedWrite["kind"];
  result: "success" | "failure";
  error?: string;
  /** 写入前目标完整内容（delete 时为删除前内容）。 */
  beforeContent?: string;
  /** 写入后完整内容（delete 后为空串）。 */
  afterContent?: string;
}

export interface ExecuteApplyPlanOptions {
  selectedItemIds?: string[];
  dryRun?: boolean;
  onTaskCreated?: (taskId: string) => void;
  /** 逐项写入完成回调（成功或失败即回调；供变更会话记录落盘完整现场）。 */
  onItemResult?: (result: ApplyItemWriteResult) => void;
  /**
   * 写后回读的重试节奏（毫秒），默认 WRITE_VERIFY_DELAYS_MS。
   * 留给测试注入 `[0]` —— 否则每条未确认项要真的等满 1.1 秒退避。
   */
  verifyDelaysMs?: number[];
}

export type ExecuteApplyPlanResult =
  | { ok: true; taskId: string; historyId: string; verification?: ApplyWriteVerification }
  | { ok: true; dryRun: true; taskId: string; plannedWrites: number }
  | {
      ok: false;
      taskId?: string;
      historyId?: string;
      error: string;
      progress?: ApplyExecutionProgress;
      /** 半截写入时同样回读（B1）：失败前落成功的那几条到底生效没有，必须能报出来。 */
      verification?: ApplyWriteVerification;
    };

/**
 * 写后回读的三态（R55-B1）。
 *
 * `confirmed` 是「回读到了我们写进去的那一份」；`drifted` 是「回读到了，但不是那一份」；
 * `unreadable` 是「回读这条路本身断了」（非 404 的读取错误），现值未知，
 * 既不能替用户说「写成功了」，也不能说「写坏了」。
 */
export type ApplyWriteVerdict = "confirmed" | "drifted" | "unreadable";

export interface ApplyWriteVerificationItem {
  /** 人读标签：`命名空间/分组/dataId (+ key)`，不是 itemId 的 `|` 拼接串。 */
  ref: string;
  verdict: ApplyWriteVerdict;
}

export interface ApplyWriteVerification {
  /** 参与验证的项数 = 真正落笔成功的写入数。 */
  total: number;
  confirmedCount: number;
  /** 回读到了、但不是写进去的那一份。 */
  drifted: string[];
  /** 回读这条路本身断了（非 404 的读取错误），现值未知。 */
  unreadable: string[];
  /** `drifted + unreadable`，界面用它决定这轮结论该报成功还是报警告。 */
  unconfirmedCount: number;
  /** 逐项三态，供会话事件留完整现场（界面只用上面三个汇总）。 */
  items: ApplyWriteVerificationItem[];
}

/**
 * 失败时外露的执行进度（R55-A2，轮54 复检）。
 *
 * 逐项写入是「一失败就停」，前面落成功的项已经改了服务端。以前结果里只有一句错误串，
 * 用户既不知道写了几条、也不知道断在哪一条，没法判断要不要立刻回退。
 */
export interface ApplyExecutionProgress {
  /** 失败前真正写成功的项数。 */
  completedWrites: number;
  /** 本次要执行的总项数。 */
  totalWrites: number;
  /** 失败项在本次写入序列里的序号（1 起）。 */
  failedIndex?: number;
  /** 失败项的人读标签（命名空间/分组/dataId (+ key)）。 */
  failedRef?: string;
}

function targetSearchText(connection: Connection | null | undefined, endpoint: ApplyPlanEndpoint): string {
  return [
    connection?.name,
    connection?.environmentName,
    connection?.sourceName,
    endpoint.label,
    endpoint.connectionName,
    endpoint.envId,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
}

export function isProtectedApplyTarget(connection: Connection | null | undefined, endpoint: ApplyPlanEndpoint): boolean {
  const text = targetSearchText(connection, endpoint);
  return PROTECTED_TARGET_MARKERS.some((marker) => text.includes(marker));
}

/**
 * 受保护目标的确认文本（轮67 / R67-WP10）。
 *
 * 旧格式 `APPLY <planId> TO <目标标签>` 是复测真机量出来的：
 * 复测环境 80 字符，真实 MSE（命名空间是 36 位 UUID）约 110 字符，而承载它的
 * `<code>` 被 body 的 `user-select:none` 禁选（拖选/三击实测都是 0 字符）——
 * 抄不走又敲不完，第五步成了打字考试。
 * 现在只留 `APPLY <planId>`（实测 26 字符）：planId 每个计划新生成、不复用，
 * 「必须看清屏幕才能提交」这层防呆一分没少；目标身份由上方「目标」行与每条计划项的
 * ref 承担，不必在确认串里再抄一遍。
 */
export function applyConfirmationText(plan: Pick<ApplyPlan, "id">): string {
  return `APPLY ${plan.id}`;
}

function isMissingConfigError(error: unknown): boolean {
  const message = errorText(error).toLowerCase();
  return message.includes("404") || message.includes("not found") || message.includes("not exist") || message.includes("notexists");
}

function findConnection(deps: ExecuteApplyPlanDeps, connectionId: string): Connection | string {
  return deps.connections.find((conn) => conn.id === connectionId) ?? translate("apply.missingConnection", { id: connectionId });
}

function summarizeItems(items: ApplyPlanItem[]): ApplyPlan["summary"] {
  const summary: ApplyPlan["summary"] = {
    total: items.length,
    create: 0,
    overwrite: 0,
    delete: 0,
    skip: 0,
    parse_error: 0,
    blocked: 0,
  };
  for (const item of items) {
    summary[item.action] += 1;
    if (item.blocked) summary.blocked += 1;
  }
  return summary;
}

function selectPlanItems(plan: ApplyPlan, selectedItemIds?: string[]): ApplyPlan {
  if (!selectedItemIds) return plan;
  const selected = new Set(selectedItemIds);
  const items = plan.items.filter((item) => selected.has(item.id));
  return {
    ...plan,
    items,
    inputSummary: {
      ...plan.inputSummary,
      selectedCount: items.length,
    },
    summary: summarizeItems(items),
  };
}

function sourceRef(item: ApplyPlanItem) {
  return item.sourceRef ?? item.ref;
}

function targetRef(item: ApplyPlanItem) {
  return item.targetRef ?? item.ref;
}

function formatFromDocument(item: ApplyPlanItem, document: ConfigDocument, ref = targetRef(item)): Format {
  return detectFormat(ref.dataId, document.format, document.content);
}

function missingValue(item: ApplyPlanItem, ref = targetRef(item)): ApplyPlanValueInput {
  return { exists: false, fingerprint: fingerprintApplyPlanValue(ref, { exists: false }) };
}

function documentValue(item: ApplyPlanItem, document: ConfigDocument, ref = targetRef(item)): ApplyPlanValueInput {
  const format = formatFromDocument(item, document, ref);
  const normalized = normalizeConfig(document.content, format);
  const value: ApplyPlanValueInput = {
    exists: true,
    value: document.content,
    valueType: "text",
    format,
    parseStatus: normalized.parseStatus,
    ...(normalized.parseError ? { parseError: normalized.parseError } : {}),
    content: document.content,
    version: document.version,
    updateTime: document.updateTime,
    ...(document.md5 ? { md5: document.md5 } : {}),
  };
  return { ...value, fingerprint: fingerprintApplyPlanValue(ref, value) };
}

function keyValueFromLine(item: ApplyPlanItem, document: ConfigDocument, format: Format, ref = targetRef(item)): ApplyPlanValueInput | null {
  const escapedKey = ref.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*${escapedKey}\\s*[:=]\\s*(.*)$`, "m");
  const match = document.content.match(pattern);
  if (!match) return null;
  const value: ApplyPlanValueInput = {
    exists: true,
    value: match[1],
    valueType: "string",
    format,
    parseStatus: "ok",
  };
  return { ...value, fingerprint: fingerprintApplyPlanValue(ref, value) };
}

function keyValue(item: ApplyPlanItem, document: ConfigDocument, ref = targetRef(item)): ApplyPlanValueInput {
  const format = formatFromDocument(item, document, ref);
  const normalized = normalizeConfig(document.content, format);
  const entry = normalized.entries.find((candidate) => candidate.key === ref.key);
  if (entry) {
    const value: ApplyPlanValueInput = {
      exists: true,
      value: entry.value,
      valueType: entry.valueType,
      format,
      parseStatus: entry.parseStatus,
      ...(entry.parseError ? { parseError: entry.parseError } : {}),
    };
    return { ...value, fingerprint: fingerprintApplyPlanValue(ref, value) };
  }
  const fallback = keyValueFromLine(item, document, format, ref);
  if (fallback) return fallback;
  const value: ApplyPlanValueInput = {
    exists: false,
    format,
    parseStatus: normalized.parseStatus,
    ...(normalized.parseError ? { parseError: normalized.parseError } : {}),
  };
  return { ...value, fingerprint: fingerprintApplyPlanValue(ref, value) };
}

function valueFromDocument(item: ApplyPlanItem, document: ConfigDocument, ref = targetRef(item)): ApplyPlanValueInput {
  return ref.key === DOCUMENT_KEY ? documentValue(item, document, ref) : keyValue(item, document, ref);
}

/**
 * 现值 + 读回的那份正文。
 *
 * 为什么要把 document 一起交出去：写后回读确认（R55-B1）拿到的整篇正文，正是本机版本历史
 * 要记的那一版（R57）。只回传派生出来的 value 的话，key 级写入那条路只能拿到单个 key 的值，
 * 记不进「这一版的完整正文」。读取失败与 404 的语义仍由 readCurrentValue 统一收口。
 */
async function readCurrentValueWithDocument(
  item: ApplyPlanItem,
  conn: Connection,
  role: "source" | "target",
  deps: ExecuteApplyPlanDeps
): Promise<{ value: ApplyPlanValueInput; document?: ConfigDocument }> {
  const ref = role === "source" ? sourceRef(item) : targetRef(item);
  try {
    const document = await deps.getConfigDocument(conn, ref.namespace, ref.dataId, ref.group);
    return { value: valueFromDocument(item, document, ref), document };
  } catch (error) {
    // 404 归成「不存在」：这时手里没有正文，本机历史也就没有可记的一版（不是漏记，是确实没读到）。
    if (isMissingConfigError(error)) return { value: missingValue(item, ref) };
    throw new Error(
      translate("apply.readConfigFailed", {
        role: translate(role === "source" ? "apply.source" : "apply.target"),
        ref: `${ref.namespace}/${ref.group}/${ref.dataId}`,
        detail: errorText(error),
      })
    );
  }
}

/** 只要派生值的地方走这颗薄封装，语义与改动前完全一致。 */
async function readCurrentValue(
  item: ApplyPlanItem,
  conn: Connection,
  role: "source" | "target",
  deps: ExecuteApplyPlanDeps
): Promise<ApplyPlanValueInput> {
  return (await readCurrentValueWithDocument(item, conn, role, deps)).value;
}

async function readBeforeSnapshot(
  item: ApplyPlanItem,
  targetConnection: Connection,
  deps: ExecuteApplyPlanDeps
): Promise<ApplyTargetBeforeSnapshot> {
  const ref = targetRef(item);
  try {
    const document = await deps.getConfigDocument(targetConnection, ref.namespace, ref.dataId, ref.group);
    return {
      itemId: item.id,
      namespace: ref.namespace,
      group: ref.group,
      dataId: ref.dataId,
      exists: true,
      content: document.content,
      configType: document.format || "text",
      updateTime: document.updateTime,
    };
  } catch (error) {
    if (isMissingConfigError(error)) {
      return {
        itemId: item.id,
        namespace: ref.namespace,
        group: ref.group,
        dataId: ref.dataId,
        exists: false,
      };
    }
    throw new Error(
      translate("apply.readBeforeSnapshotFailed", {
        ref: `${ref.namespace}/${ref.group}/${ref.dataId}`,
        detail: errorText(error),
      })
    );
  }
}

function executableItems(plan: ApplyPlan): ApplyPlanItem[] {
  return plan.items.filter((item) => item.action !== "skip" && item.action !== "parse_error");
}

/**
 * 新鲜度快照：每项两端各读一次现值（R55-D1 起按 BATCH_READ_CONCURRENCY 并发）。
 *
 * 顺序不能乱——快照数组要按项配对写进审计与比对，mapWithConcurrency 按下标回填，
 * 与入参同序，所以展开成两项一组再 flat 一次即可。
 */
async function freshnessSnapshots(
  plan: ApplyPlan,
  sourceConnection: Connection,
  targetConnection: Connection,
  deps: ExecuteApplyPlanDeps
): Promise<ApplyPlanFreshnessSnapshot[]> {
  const perItem = await mapWithConcurrency(plan.items, BATCH_READ_CONCURRENCY, async (item) => {
    const [sourceValue, targetValue] = await Promise.all([
      readCurrentValue(item, sourceConnection, "source", deps),
      readCurrentValue(item, targetConnection, "target", deps),
    ]);
    return [
      {
        itemId: item.id,
        side: "source" as const,
        fingerprint: sourceValue.fingerprint ?? fingerprintApplyPlanValue(sourceRef(item), sourceValue),
      },
      {
        itemId: item.id,
        side: "target" as const,
        fingerprint: targetValue.fingerprint ?? fingerprintApplyPlanValue(targetRef(item), targetValue),
      },
    ];
  });
  return perItem.flat();
}

/** 写前快照：只给真正会落笔的项建（skip / parse_error 不参与），同样按并发口径拉取。 */
async function beforeSnapshots(plan: ApplyPlan, targetConnection: Connection, deps: ExecuteApplyPlanDeps): Promise<ApplyTargetBeforeSnapshot[]> {
  return mapWithConcurrency(executableItems(plan), BATCH_READ_CONCURRENCY, (item) => readBeforeSnapshot(item, targetConnection, deps));
}

interface PlannedWrite {
  item: ApplyPlanItem;
  kind: "publish" | "delete" | "publish_ref" | "delete_ref";
  content?: string;
  configType?: string;
}

type ApplyPlanWriteRef = ApplyPlanItem["ref"] & { expectedVersion?: string };

function contentForDocumentWrite(item: ApplyPlanItem): string {
  return item.afterValue.content ?? item.afterValue.value ?? "";
}

function formatForWrite(item: ApplyPlanItem): Format {
  return item.afterValue.format ?? item.sourceValue.format ?? item.targetValue.format ?? "TEXT";
}

function valueForKeyWrite(item: ApplyPlanItem): string {
  return item.afterValue.value ?? item.afterValue.content ?? "";
}

function isProviderKeyWriteSupported(item: ApplyPlanItem): boolean {
  const ref = targetRef(item);
  return ref.provider === "apollo" && formatForWrite(item) === "Properties";
}

function consulExpectedVersion(item: ApplyPlanItem): string | null {
  if (item.action === "create") return "0";
  return item.targetValue.version ?? null;
}

function providerWriteRef(item: ApplyPlanItem): ApplyPlanWriteRef | string {
  const ref = targetRef(item);
  if (ref.provider !== "consul") return ref;
  const expectedVersion = consulExpectedVersion(item);
  if (!expectedVersion) return translate("apply.consulModifyIndexRequired", { dataId: ref.dataId });
  return { ...ref, expectedVersion };
}

function planWrites(plan: ApplyPlan): PlannedWrite[] | string {
  const writes: PlannedWrite[] = [];
  for (const item of plan.items) {
    const ref = targetRef(item);
    // 阻断项本来就被界面过滤掉了，这条是兜底出路；文案里吐 itemId 的 `|` 拼接串等于没说（R55-B4）
    if (item.blocked || item.action === "parse_error") return translate("apply.blockedItem", { id: itemRefLabel(ref) });
    if (item.action === "skip") continue;
    if (ref.key !== DOCUMENT_KEY) {
      if (!isProviderKeyWriteSupported(item)) {
        return translate("apply.keyLevelWriteUnsupported", { ref: `${ref.dataId}/${ref.key}`, format: formatForWrite(item) });
      }
      if (item.action === "delete") {
        writes.push({ item, kind: "delete_ref" });
        continue;
      }
      if (item.action === "create" || item.action === "overwrite") {
        writes.push({ item, kind: "publish_ref", content: valueForKeyWrite(item), configType: nacosType(formatForWrite(item)) });
        continue;
      }
    }
    if (ref.provider === "consul") {
      const writeRef = providerWriteRef(item);
      if (typeof writeRef === "string") return writeRef;
      if (item.action === "delete") {
        writes.push({ item, kind: "delete_ref" });
        continue;
      }
      if (item.action === "create" || item.action === "overwrite") {
        writes.push({ item, kind: "publish_ref", content: contentForDocumentWrite(item), configType: nacosType(formatForWrite(item)) });
        continue;
      }
    }
    if (item.action === "delete") {
      writes.push({ item, kind: "delete" });
      continue;
    }
    if (item.action === "create" || item.action === "overwrite") {
      writes.push({ item, kind: "publish", content: contentForDocumentWrite(item), configType: nacosType(formatForWrite(item)) });
    }
  }
  return writes;
}

/** 写后可见窗口（真机取证，轮55 B线）：单节点 loopback 也要 54–145ms 才读得到新值。 */
export const WRITE_VERIFY_DELAYS_MS = [0, 150, 350, 600] as const;

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** 落成功、需要回读确认的写入，连同它的人读标签（回读时 ref 已不会再变，先算好）。 */
interface WrittenWrite {
  write: PlannedWrite;
  refLabel: string;
}

/**
 * 写入值与回读值是不是同一份（R55-B1）。
 *
 * 口径刻意不用 fingerprint：`fingerprintApplyPlanValue` 把 md5 / format / parseStatus
 * 一起卷了进去，而 `afterValue` 是计划阶段造的、回读值是现读现算的，两边不同源，
 * 比出来的差异绝大多数是噪声（真机 detail 接口的 md5 在 showAll 下还恒为 null）。
 * 取证结论是 provider 原样保留正文——CRLF、尾随空格、无尾换行都不改写——所以直接比字符串：
 * 整篇写入比整篇正文，key 级写入比这一项读回来的值，删除比「读不到了」。
 */
function writeMatchesReadBack(write: PlannedWrite, current: ApplyPlanValueInput): boolean {
  if (write.kind === "delete" || write.kind === "delete_ref") return !current.exists;
  if (!current.exists) return false;
  const actual = current.content ?? current.value;
  if (actual === undefined) return false;
  return actual === (write.content ?? "");
}

async function verifyWrittenWrite(
  item: ApplyPlanItem,
  write: PlannedWrite,
  targetConnection: Connection,
  deps: ExecuteApplyPlanDeps
): Promise<{ verdict: ApplyWriteVerdict; document?: ConfigDocument }> {
  let current: ApplyPlanValueInput;
  let document: ConfigDocument | undefined;
  try {
    const readBack = await readCurrentValueWithDocument(item, targetConnection, "target", deps);
    current = readBack.value;
    document = readBack.document;
  } catch {
    // readCurrentValue 已经把 404 归成「不存在」，走到这儿只剩读取本身失败
    return { verdict: "unreadable" };
  }
  return { verdict: writeMatchesReadBack(write, current) ? "confirmed" : "drifted", document };
}

/**
 * 写后回读验证（R55-B1）。
 *
 * 放在整轮写入之后而不是逐条夹在循环里，有两个原因：
 * 一是「一失败就停」的循环要保持写入语义干净，回读不能把失败项的序号搅乱；
 * 二是回读天然适合并发——项与项之间没有依赖，按 BATCH_READ_CONCURRENCY 收口后
 * 多项的最坏总耗时和单项一样是 1.1 秒，而不是项数的倍数。
 */
export async function verifyWrittenWrites(
  written: WrittenWrite[],
  targetConnection: Connection,
  deps: ExecuteApplyPlanDeps,
  options: ExecuteApplyPlanOptions,
  planId = ""
): Promise<ApplyWriteVerification | undefined> {
  if (!written.length) return undefined;
  const delays = options.verifyDelaysMs?.length ? options.verifyDelaysMs : [...WRITE_VERIFY_DELAYS_MS];
  const items = await mapWithConcurrency(written, BATCH_READ_CONCURRENCY, async ({ write, refLabel }) => {
    let verdict: ApplyWriteVerdict = "unreadable";
    let document: ConfigDocument | undefined;
    for (const delay of delays) {
      await sleep(delay);
      const checked = await verifyWrittenWrite(write.item, write, targetConnection, deps);
      verdict = checked.verdict;
      document = checked.document;
      if (verdict === "confirmed") break;
    }
    if (verdict === "confirmed" && document) {
      // R57：回读确认过的那一版才是「本程序写的」。这里挂上 planId，
      // Go 侧会把刚才回读时以 observed 落下的同一版就地升级（promote），不会攒出重复版本。
      const ref = targetRef(write.item);
      recordConfirmedWrite(targetConnection, { namespace: ref.namespace, group: ref.group, dataId: ref.dataId }, document, planId);
    }
    return { ref: refLabel, verdict };
  });
  const drifted = items.filter((item) => item.verdict === "drifted").map((item) => item.ref);
  const unreadable = items.filter((item) => item.verdict === "unreadable").map((item) => item.ref);
  return {
    total: items.length,
    confirmedCount: items.filter((item) => item.verdict === "confirmed").length,
    drifted,
    unreadable,
    // 界面判定「这条结论能不能直接往下走」只看这一个数，别再各自把两个数组加一遍
    unconfirmedCount: drifted.length + unreadable.length,
    items,
  };
}

function emptyBackup(): ApplyBackupSummary {
  return { backedUpCount: 0, missingBeforeCount: 0 };
}

function createTask(plan: ApplyPlan, deps: ExecuteApplyPlanDeps, onTaskCreated?: (taskId: string) => void): string {
  const taskType = operationTypeForApplyPlan(plan) === "restore" ? "restore" : "apply";
  const task = deps.taskManager.createTask(translate("apply.planTaskName", { id: plan.id }), taskType, {
    scope: plan.target.label,
    cancellable: false,
  });
  onTaskCreated?.(task.id);
  deps.taskManager.startTask(task.id);
  return task.id;
}

/** 人读的项标签：`命名空间/分组/dataId`，key 级再补 `(key)`（R55-A3）。 */
function itemRefLabel(ref: ApplyPlanRef): string {
  const base = `${ref.namespace}/${ref.group}/${ref.dataId}`;
  return ref.key && ref.key !== DOCUMENT_KEY ? `${base} (${ref.key})` : base;
}

function sideLabel(side: ApplyPlanFreshnessSide): string {
  return translate(side === "source" ? "apply.source" : "apply.target");
}

/**
 * 过期项的可读清单（R55-A3）。
 *
 * 以前这里塞的是 `${itemId}/${side}`，而 itemId 本身是
 * `provider|connectionId|namespace|group|dataId|key` 的拼接串——界面上一长串管道符，
 * 用户读不出「哪一份配置、哪一侧」变了。
 */
function staleIssueLabel(plan: ApplyPlan, issue: ApplyPlanFreshnessIssue): string {
  const item = plan.items.find((candidate) => candidate.id === issue.itemId);
  if (!item) {
    // 理论上到不了这儿：过期项是从 plan.items 算出来的。兜底也只还原成 `/` 路径，
    // 不把 `|` 拼接串再吐给用户。
    return `${issue.itemId.replace(/\|/g, "/")} · ${sideLabel(issue.side)}`;
  }
  const ref = issue.side === "source" ? sourceRef(item) : targetRef(item);
  return `${itemRefLabel(ref)} · ${sideLabel(issue.side)}`;
}

function recordFailure(
  plan: ApplyPlan,
  deps: ExecuteApplyPlanDeps,
  taskId: string,
  error: string,
  backup: ApplyBackupSummary = emptyBackup(),
  recordHistory = true,
  progress?: ApplyExecutionProgress,
  verification?: ApplyWriteVerification
): ExecuteApplyPlanResult {
  let historyId = "";
  if (recordHistory) {
    const history = deps.recordOperation(
      buildApplyOperationHistoryInput(plan, {
        result: "failure",
        backup,
        taskId,
        error,
      })
    );
    historyId = history.id;
  }
  deps.taskManager.completeTask(taskId, false, error);
  return recordHistory
    ? { ok: false, taskId, historyId, error, progress, verification }
    : { ok: false, taskId, error, progress, verification };
}

export async function executeApplyPlan(
  plan: ApplyPlan,
  deps: ExecuteApplyPlanDeps,
  options: ExecuteApplyPlanOptions = {}
): Promise<ExecuteApplyPlanResult> {
  const workingPlan = selectPlanItems(plan, options.selectedItemIds);
  if (options.selectedItemIds && workingPlan.items.length === 0) {
    return { ok: false, error: translate("apply.noSelectedItems") };
  }

  const taskId = createTask(workingPlan, deps, options.onTaskCreated);
  // 本轮真正落成功的写入位置（按命名空间分组成多条 notice 广播）；dry-run 恒空。
  const writtenRefs: { namespace: string; dataId: string; group: string }[] = [];
  const notifyConfigsChanged = () => {
    if (!deps.onConfigsChanged || !writtenRefs.length) return;
    const grouped = new Map<string, ConfigChangeRef[]>();
    for (const ref of writtenRefs) {
      const namespace = normalizeNamespace(ref.namespace);
      const bucket = grouped.get(namespace);
      if (bucket) bucket.push({ dataId: ref.dataId, group: ref.group });
      else grouped.set(namespace, [{ dataId: ref.dataId, group: ref.group }]);
    }
    writtenRefs.length = 0;
    for (const [namespace, refs] of grouped) {
      deps.onConfigsChanged({ connectionId: workingPlan.target.connectionId, namespace, refs });
    }
  };
  const sourceConnection = findConnection(deps, workingPlan.source.connectionId);
  if (typeof sourceConnection === "string") return recordFailure(workingPlan, deps, taskId, sourceConnection, emptyBackup(), !options.dryRun);
  const targetConnection = findConnection(deps, workingPlan.target.connectionId);
  if (typeof targetConnection === "string") return recordFailure(workingPlan, deps, taskId, targetConnection, emptyBackup(), !options.dryRun);

  try {
    const currentSnapshots = await freshnessSnapshots(workingPlan, sourceConnection, targetConnection, deps);
    const freshness = validateApplyPlanFreshness(workingPlan, currentSnapshots);
    if (!freshness.ok) {
      const error = translate("apply.planStale", {
        items: freshness.staleItems.map((issue) => staleIssueLabel(workingPlan, issue)).join(", "),
      });
      return recordFailure(workingPlan, deps, taskId, error, emptyBackup(), !options.dryRun);
    }

    const writes = planWrites(workingPlan);
    if (typeof writes === "string") return recordFailure(workingPlan, deps, taskId, writes, emptyBackup(), !options.dryRun);

    if (options.dryRun) {
      deps.taskManager.updateProgress(taskId, writes.length, writes.length, writes.length);
      deps.taskManager.completeTask(taskId, true);
      return { ok: true, dryRun: true, taskId, plannedWrites: writes.length };
    }

    const before = await beforeSnapshots(workingPlan, targetConnection, deps);
    const safety = await prepareApplyExecutionSafety(workingPlan, before, {
      createBackupSnapshot: deps.createBackupSnapshot,
      taskId,
    });
    if (!safety.ok) {
      const history = deps.recordOperation(safety.historyInput);
      deps.taskManager.completeTask(taskId, false, safety.error);
      return { ok: false, taskId, historyId: history.id, error: safety.error };
    }

    // 失败项在本次写入序列里的位置与人读标签（R55-A2）：一失败就停，但
    // 「停在哪一条、前面写了几条」必须能报给界面，所以计数声明在 try 外面。
    let processed = 0;
    // 落成功的写入：整轮跑完后按 BATCH_READ_CONCURRENCY 并发回读确认（R55-B1）
    const writtenWrites: WrittenWrite[] = [];
    let attemptedIndex = 0;
    let attemptedRefLabel = "";
    let completedWrites = 0;
    try {
      for (const write of writes) {
        const ref = targetRef(write.item);
        attemptedIndex += 1;
        attemptedRefLabel = itemRefLabel(ref);
        // 完整现场：写入前目标当前内容（best-effort；读失败不阻断执行）
        let beforeContent: string | undefined;
        let currentFingerprint: string | undefined;
        try {
          const current = await readCurrentValue(write.item, targetConnection, "target", deps);
          beforeContent = current.content ?? current.value;
          currentFingerprint = current.fingerprint;
        } catch {
          beforeContent = undefined;
        }
        let itemError: string | undefined;
        // 最后一刻指纹复检（R55-A1，轮54 复检）。批量新鲜度校验在这轮循环之前一次读完，
        // 从那次读到此刻落库之间被别人改过的值，靠这一次「本来就要读」的现值兜住——
        // Nacos/Apollo 的 key 级写入没有 CAS，覆盖一旦发出去就收不回。
        // 读取失败时手上没有可比对的现值，维持原有 best-effort 语义，不新增阻断。
        const plannedFingerprint = write.item.targetFingerprint || write.item.targetValue?.fingerprint;
        if (currentFingerprint && plannedFingerprint && currentFingerprint !== plannedFingerprint) {
          itemError = translate("apply.writeConflictDetected", { ref: attemptedRefLabel });
        } else {
          try {
            if (write.kind === "publish") {
              await deps.publishConfig(
                targetConnection,
                ref.namespace,
                ref.dataId,
                ref.group,
                write.content ?? "",
                write.configType ?? "text"
              );
            } else if (write.kind === "delete") {
              await deps.deleteConfig(targetConnection, ref.namespace, ref.dataId, ref.group);
            } else if (write.kind === "publish_ref") {
              if (!deps.publishConfigRef) throw new Error(translate("apply.publishRefBindingMissing"));
              const writeRef = providerWriteRef(write.item);
              if (typeof writeRef === "string") throw new Error(writeRef);
              await deps.publishConfigRef(targetConnection, writeRef, write.content ?? "", write.configType ?? "text");
            } else {
              if (!deps.deleteConfigRef) throw new Error(translate("apply.deleteRefBindingMissing"));
              const writeRef = providerWriteRef(write.item);
              if (typeof writeRef === "string") throw new Error(writeRef);
              await deps.deleteConfigRef(targetConnection, writeRef);
            }
          } catch (e) {
            itemError = errorText(e);
          }
        }
        processed += 1;
        if (!itemError) completedWrites += 1;
        deps.taskManager.updateProgress(taskId, processed, 0, writes.length);
        if (options.onItemResult) {
          try {
            options.onItemResult({
              item: write.item,
              kind: write.kind,
              result: itemError ? "failure" : "success",
              error: itemError,
              beforeContent,
              afterContent: itemError ? undefined : write.kind === "delete" || write.kind === "delete_ref" ? "" : write.content ?? "",
            });
          } catch {
            // 会话记录失败不阻断执行
          }
        }
        if (!itemError) {
          writtenRefs.push({ namespace: ref.namespace, dataId: ref.dataId, group: ref.group });
          writtenWrites.push({ write, refLabel: itemRefLabel(ref) });
        }
        if (itemError) throw new Error(itemError);
      }
    } catch (error) {
      // 部分写入：失败项之前落成功的那些已经改过服务端了，先回读确认它们到底生效没有，
      // 再广播失效——回读排在广播之前，免得保活视图在可见窗口里重取到旧值。
      const verification = await verifyWrittenWrites(writtenWrites, targetConnection, deps, options, workingPlan.id);
      notifyConfigsChanged();
      return recordFailure(workingPlan, deps, taskId, errorText(error), safety.backup, true, {
        completedWrites,
        totalWrites: writes.length,
        failedIndex: attemptedIndex,
        failedRef: attemptedRefLabel,
      }, verification);
    }

    const verification = await verifyWrittenWrites(writtenWrites, targetConnection, deps, options, workingPlan.id);
    const history = deps.recordOperation(safety.historyInput);
    deps.taskManager.completeTask(taskId, true);
    notifyConfigsChanged();
    return { ok: true, taskId, historyId: history.id, verification };
  } catch (error) {
    notifyConfigsChanged();
    return recordFailure(workingPlan, deps, taskId, errorText(error), emptyBackup(), !options.dryRun);
  }
}
