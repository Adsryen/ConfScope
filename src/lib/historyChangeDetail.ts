// 操作历史的「本次改动」：把执行记录还原成可读的逐项 before/after，只读，不产生任何写入口。
//
// 为什么要单独一层（轮75）：批量 apply/promote/restore 的执行记录里 **没有正文**
// （`applyExecutionSafety.buildApplyOperationHistoryInput` 不写 content，`beforeContent`
// 只在单条时才带），所以详情面板整块正文区不出现——用户想知道「这次到底改了什么」，
// 唯一出路是先生成回退计划跳到变更计划页去看，等于把审计需求绕到写操作入口上解决。
//
// 数据其实早在本机：计划项 `ApplyPlanItem` 带着 `targetValue`（写前现场）与
// `afterValue`（本次真正写进去的内容），`store/applyPlans` 落盘/回读都不丢 content；
// 而执行前 `applyPlanExecution` 会做新鲜度校验（任一项现值与计划指纹不符 ⇒ 整批 stale 中止），
// 所以计划里的写前正文就是真正的写前正文，不需要再去备份快照里兜第二层。
import { applyPlanItemLabel, DOCUMENT_KEY, type ApplyPlan, type ApplyPlanAction, type ApplyPlanItem } from "./applyPlan";
import { executableItemsForRecord } from "./applyFollowup";
import type { Format } from "./format";
import type { OperationRecord } from "../store/operationHistory";

/** ready = 有正文可看；unavailable = 取不到，必须给出 reasonKey 而不是假装空 diff。 */
export type HistoryChangeDetailStatus = "ready" | "unavailable";

/** changed = 目标确实变了；unchanged = 写后与写前逐字相同；unknown = 正文取不到，不下结论。 */
export type HistoryChangeState = "changed" | "unchanged" | "unknown";

export interface HistoryChangeDetailItem {
  itemId: string;
  /** 人读位置标签，口径见 `applyPlanItemLabel`。 */
  label: string;
  action: ApplyPlanAction;
  /** 人工微调过的目标内容（第三步手写 / 第四步编辑），审计时要能认出来。 */
  manualTuned: boolean;
  beforeText: string;
  afterText: string;
  /**
   * 这一项相对写前现场的变化结论。
   *
   * 三态而不是布尔：正文没随计划存下来时只能是 `unknown`，拿空串去比会编出
   * 「无变化」或「删掉了空内容」这类假结论（`contentKnown` 就是为这一刻留的）。
   * `changed` 还包含「本次是新建 / 删除」这类结构变化，与写前后文本是否逐字相同是两回事。
   */
  changeState: HistoryChangeState;
  /**
   * 两侧正文都随计划存下来了。
   *
   * false 时 `beforeText`/`afterText` 里至少有一侧是空的**未知**空——界面必须说「正文未随计划存档」，
   * 不能拿空串去比出「无变化」或「删除了空内容」这种假结论。
   */
  contentKnown: boolean;
  /** 目标在写前是否存在这份配置：false ⇒ 本次是新建，写前那侧应当读作「不存在」。 */
  targetExisted: boolean;
  /** key 级项只比 key 值，文档级项比整篇正文，两者不能混在一句话里说。 */
  documentLevel: boolean;
  format?: Format;
}

export interface HistoryChangeDetail {
  status: HistoryChangeDetailStatus;
  /** unavailable 时的 i18n key；ready 时为空串。 */
  reasonKey: string;
  /** 记录里没有本次执行范围清单（轮66 之前的老记录）时为 true：列表按完整计划的可执行项列。 */
  scopeUnverified: boolean;
  items: HistoryChangeDetailItem[];
  changedCount: number;
}

/**
 * 这条记录能不能挂「本次改动」（轮79 E4 放开半截失败的口子）。
 *
 * - 成功记录：写成功即等于清单里的项都落了笔，照常给（轮66 之前的老记录虽然按「全部勾选项」记，
 *   但成功记录里全部勾选项确实都写了，那份清单在成功语境下不撒谎）。
 * - 失败记录：只有新链路的 `scopeIsWritten` 才能证明这份清单是**真正落笔的那几条**；
 *   老记录那份是全部勾选项，拿它当「本次改动」会把没写过的配置说成写了，继续不给。
 * - 空清单（一条都没写成，prepare 阶段就失败）：没有改动可看，不给。
 */
export function canShowChangeDetail(record: OperationRecord): boolean {
  if (record.result === "success") return true;
  return record.scopeIsWritten === true && (record.appliedLocations?.length ?? 0) > 0;
}

function textOf(value: { exists: boolean; content?: string; value?: string }): { text: string; known: boolean } {
  if (!value.exists) return { text: "", known: true };
  if (typeof value.content === "string") return { text: value.content, known: true };
  if (typeof value.value === "string") return { text: value.value, known: true };
  return { text: "", known: false };
}

function isDocumentLevel(item: ApplyPlanItem): boolean {
  const ref = item.targetRef ?? item.ref;
  return !ref.key || ref.key === DOCUMENT_KEY;
}

function changeStateOf(
  item: ApplyPlanItem,
  before: { text: string; known: boolean },
  after: { text: string; known: boolean }
): HistoryChangeState {
  if (!before.known || !after.known) return "unknown";
  // 结构变化先于文本比对：新建（写前目标上没有）与删除（写后目标上不该有）无论正文如何都是「变了」。
  if (!item.targetValue.exists || item.action === "delete") return "changed";
  return before.text === after.text ? "unchanged" : "changed";
}

/**
 * 从计划 + 执行记录构造「本次改动」。
 *
 * 范围必须走 `executableItemsForRecord`：planId 指向的是**完整计划**，用户执行时可能只勾了一部分，
 * 没勾选项既没被写也不该出现在这份审计清单里（轮66 R66-WP9 对回退定下的同一条边界）。
 */
export function buildHistoryChangeDetail(plan: ApplyPlan | null, record: OperationRecord): HistoryChangeDetail {
  if (!record.planId) return { status: "unavailable", reasonKey: "operationHistory.changeDetailNoPlan", scopeUnverified: false, items: [], changedCount: 0 };
  if (!plan) return { status: "unavailable", reasonKey: "operationHistory.changeDetailPlanExpired", scopeUnverified: false, items: [], changedCount: 0 };

  const items = executableItemsForRecord(plan, record);
  const views = items.map((item) => {
    const before = textOf(item.targetValue);
    // delete 之后目标上没有这份配置：after 读作「空」，而不是「正文为空串」。
    const after = item.action === "delete" ? { text: "", known: true } : textOf(item.afterValue);
    return {
      itemId: item.id,
      label: applyPlanItemLabel(item.targetRef ?? item.ref),
      action: item.action,
      manualTuned: item.manualTuned === true,
      beforeText: before.text,
      afterText: after.text,
      changeState: changeStateOf(item, before, after),
      contentKnown: before.known && after.known,
      targetExisted: item.targetValue.exists,
      documentLevel: isDocumentLevel(item),
      ...(item.afterValue.format ? { format: item.afterValue.format } : {}),
    } satisfies HistoryChangeDetailItem;
  });

  return {
    status: "ready",
    reasonKey: "",
    scopeUnverified: record.appliedLocations === undefined,
    items: views,
    changedCount: views.filter((item) => item.changeState === "changed").length,
  };
}
