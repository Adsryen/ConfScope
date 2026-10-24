// 操作历史的「这条记录能不能回退、以及怎么回退」单一事实源（轮72A）。
//
// 为什么要有这个文件（取证见 .trellis/tasks/10-24-r72a-history-rollback-entry/prd.md）：
// 判据原本有两套。`store/operationHistory.isRollbackableOperation()` 在轮42 禁直写后
// 被改成恒 return false，详情面板于是常年写着「不可回滚」；而真正生效的
// `applyFollowup.canBuildRollbackEntry()` 就在同一块面板下面放着能用的「生成回退计划」按钮。
// 一个说不能、一个让你点，用户只能自己猜哪句是真话。
//
// 现在只许这一处判定，且只讲**回退**（回退=把意图物化成变更计划入口，交给 dry-run/确认/执行）。
// 直写红线不变：`api/nacos.ts` 的 publishConfig/deleteConfig 仍无条件 throw，
// 这里生成的永远是 ApplyEntryPayload，不碰任何写路径。
import type { Connection } from "../store/connections";
import type { OperationRecord } from "../store/operationHistory";
import { translate } from "../locales";
import {
  buildRollbackEntryFromApplyRecord,
  canBuildRollbackEntry,
  type ApplyFollowupDeps,
  type ApplyFollowupResult,
} from "./applyFollowup";
import type { ApplyEntryPayload } from "./applyEntry";
import { buildDirectWriteExitEntry, isWritableConfigTarget } from "./directWriteExit";
import { detectFormat } from "./format";

/** 走「变更计划 + 写前备份快照」回退的记录类型：本次现场由备份快照承载。 */
const APPLY_FAMILY: readonly OperationRecord["type"][] = ["apply", "promote", "restore"];
/** 走「记录里存的写前正文」回退的记录类型：轮42 之前遗留的单条直写记录。 */
const RECORDED_CONTENT_TYPES: readonly OperationRecord["type"][] = ["publish", "delete", "rollback"];

export type HistoryRollbackPath = "apply-backup" | "recorded-content";

export interface HistoryRollbackContext {
  connections: Connection[];
  /**
   * 本机还在的变更计划 id 集合，调用方挂载时一次性读（store/applyPlans.listApplyPlanIds）。
   * 不逐行 getApplyPlan()：那是在渲染期反复解析同一份 localStorage。
   */
  knownPlanIds: ReadonlySet<string>;
}

export interface HistoryRollbackAssessment {
  available: boolean;
  path: HistoryRollbackPath | null;
  /** available=false 时的原因 i18n key；可用时为空串。 */
  reasonKey: string;
  /** available=true 时主按钮的 i18n key；不可用时为空串。 */
  actionLabelKey: string;
}

/** 回退目标连接：执行类记录记的是 targetConnectionId，遗留记录只有 connectionId。 */
function rollbackTargetConnectionId(record: OperationRecord): string {
  return record.targetConnectionId || record.connectionId;
}

function unavailable(reasonKey: string): HistoryRollbackAssessment {
  return { available: false, path: null, reasonKey, actionLabelKey: "" };
}

/**
 * apply/promote/restore：按备份快照回退。
 *
 * 现场齐不齐看 `canBuildRollbackEntry`（R55-A4：**半截写入的失败记录同样放行**，
 * 前面几条已经落到目标上了，只放行成功记录等于把改动留在生产上却没有出口）。
 * 再往下查两件「现场还在不在」的事：计划快照还在本机吗（只留最近 100 份）、目标连接还在列表里吗。
 * 缺任何一样都不放按钮——点了才收到「变更记录 X 没有关联变更计划」是本轮要消灭的体验。
 */
function assessApplyBackup(record: OperationRecord, ctx: HistoryRollbackContext): HistoryRollbackAssessment {
  // 现场齐不齐仍由 applyFollowup 判定（单一出处，含「失败记录也放行」这条 R55-A4 口径）；
  // 这里只负责把「缺了哪一样」翻译成人话。
  if (!canBuildRollbackEntry(record)) {
    return unavailable(record.planId ? "operationHistory.rollbackMissingBackupSnapshot" : "operationHistory.rollbackNoPlanOnRecord");
  }
  // canBuildRollbackEntry 已经保证 planId 在，这里 ?? "" 只为让类型收窄（空串永远不在集合里）。
  if (!ctx.knownPlanIds.has(record.planId ?? "")) return unavailable("operationHistory.rollbackPlanExpired");
  if (!ctx.connections.some((conn) => conn.id === rollbackTargetConnectionId(record))) {
    return unavailable("operationHistory.rollbackTargetConnectionMissing");
  }
  return {
    available: true,
    path: "apply-backup",
    reasonKey: "",
    // 失败记录没说「生成回退计划」那么轻描淡写：它是「把已写入的那几条退回备份」。
    actionLabelKey:
      record.result === "success" ? "operationHistory.generateRollbackPlan" : "operationHistory.rollbackFromBackupPlan",
  };
}

/**
 * 遗留单条记录：按记录里的写前正文生成回退计划。
 *
 * 这类记录没有 planId、也没有备份快照（轮42 之前那条链还没建起来），
 * 但 `beforeContent` 就是这个 dataId 在被改/被删之前的完整正文，
 * 足够把「这个位置应该变回什么」物化成计划来源值——与浏览页编辑保存、本机版本历史同一套机制。
 * 目标不可写（本地快照/只读连接/非 Nacos）时不放入口：放出去就是必然失败。
 */
function assessRecordedContent(record: OperationRecord, ctx: HistoryRollbackContext): HistoryRollbackAssessment {
  if (record.result !== "success") return unavailable("operationHistory.rollbackOnlySuccess");
  if (typeof record.beforeContent !== "string" || !record.dataId.trim()) {
    return unavailable("operationHistory.rollbackMissingContent");
  }
  const conn = ctx.connections.find((item) => item.id === rollbackTargetConnectionId(record));
  if (!conn) return unavailable("operationHistory.rollbackTargetConnectionMissing");
  if (!isWritableConfigTarget(conn)) return unavailable("operationHistory.rollbackTargetNotWritable");
  return { available: true, path: "recorded-content", reasonKey: "", actionLabelKey: "operationHistory.rollbackFromRecordedContent" };
}

/** 这条记录能不能回退、走哪条路、按钮叫什么。判定只此一份，组件不许自己算。 */
export function assessHistoryRollback(record: OperationRecord, ctx: HistoryRollbackContext): HistoryRollbackAssessment {
  if (APPLY_FAMILY.includes(record.type)) {
    // apply 家族**不**降级到「按记录正文回退」：批量记录里的 beforeContent 只是第一条配置的写前正文，
    // 放出去会把「只回退一条」演成「整批都退回去了」。计划/快照不在了就讲清缺哪一环。
    return assessApplyBackup(record, ctx);
  }
  if (RECORDED_CONTENT_TYPES.includes(record.type)) {
    return assessRecordedContent(record, ctx);
  }
  // 快照/导出这类不写配置中心的记录：本来就没有「回退」这回事，沿用调用方写在记录里的原因。
  return unavailable(record.rollbackReason || "operationHistory.rollbackUnsupportedType");
}

/** 返回口只在这里定一次，两条路径共用（见下面 buildHistoryRollbackEntry）。 */
function withHistoryReturnMode(entry: ApplyEntryPayload): ApplyEntryPayload {
  return { ...entry, origin: { ...entry.origin, returnMode: "history" } };
}

/**
 * 按上面的判定生成回退入口；不可回退时返回带原因的申请失败结果（调用方就地展示，不发写入）。
 *
 * 两条路径都只产出 `ApplyEntryPayload`：
 * - `apply-backup` → 备份快照里的写前内容（含本次新建项 → 计划里判成删除）；
 * - `recorded-content` → 记录里的写前正文，物化成 `sourceValueOverride`。
 * 回退入口的 `origin.returnMode` 统一为 "history"：用户是从操作历史点进来的，
 * 计划页「返回」就该落回那一页，而不是被扔到配置浏览。这一句靠 `withHistoryReturnMode`
 * 落实，两条路径都必须过它——两个构造器各自的 origin 不作数：`directWriteExit` 那套恒给
 * "browse"（它是配置浏览页内 tab 的口径），`applyFollowup` 那套恰好是 "history"，
 * 靠巧合对齐的口径，下一次改动就会分叉（轮72A 复跑探针实测：只改其中一处时，
 * 真机用例照样绿，因为 apply 家族走的是另一条返回口）。
 */

export async function buildHistoryRollbackEntry(
  record: OperationRecord,
  ctx: HistoryRollbackContext,
  deps: ApplyFollowupDeps
): Promise<ApplyFollowupResult> {
  const assessment = assessHistoryRollback(record, ctx);
  if (!assessment.available || !assessment.path) {
    return {
      ok: false,
      error: "history_rollback_unavailable",
      detail: assessment.reasonKey ? translate(assessment.reasonKey) : translate("operationHistory.rollbackUnsupportedType"),
    };
  }

  if (assessment.path === "apply-backup") {
    const result = await buildRollbackEntryFromApplyRecord(record, deps);
    return result.ok ? { ok: true, entry: withHistoryReturnMode(result.entry) } : result;
  }

  const conn = ctx.connections.find((item) => item.id === rollbackTargetConnectionId(record));
  const desiredContent = record.beforeContent;
  if (!conn || typeof desiredContent !== "string") {
    // 判定刚过又取不到，只可能是状态在两次读之间变了（连接被删/记录被清理）：讲清原因，不放空计划。
    return { ok: false, error: "history_rollback_unavailable", detail: translate("operationHistory.rollbackTargetConnectionMissing") };
  }
  const entry = buildDirectWriteExitEntry({
    conn,
    t: (key) => translate(key),
    namespace: record.namespace,
    group: record.group,
    dataId: record.dataId,
    format: detectFormat(record.dataId, record.configType ?? "", desiredContent),
    desiredContent,
    intent: "rollback",
  });
  if (!entry) return { ok: false, error: "history_rollback_unavailable", detail: translate("operationHistory.rollbackTargetNotWritable") };
  return { ok: true, entry: withHistoryReturnMode(entry) };
}
