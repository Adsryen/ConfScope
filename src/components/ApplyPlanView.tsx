import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteConfigFromApplyPlan,
  deleteConfigRefFromApplyPlan,
  getConfigDocument,
  publishConfigFromApplyPlan,
  publishConfigRefFromApplyPlan,
} from "../api/nacos";
import { createSnapshot, getSnapshot } from "../api/snapshot";
import { useTranslation } from "../i18n";
import {
  DOCUMENT_KEY,
  withEditedAfterValue,
  type ApplyPlan,
  type ApplyPlanAction,
  type ApplyPlanItem,
  type ApplyPlanSummary,
  type ApplyPlanValueSnapshot,
} from "../lib/applyPlan";
import { busyProps } from "../lib/busyRegion";
import { formatDateTime } from "../lib/formatDateTime";
import CodeEditor from "./CodeEditor";
import { validateConfig } from "../lib/validate";
import { describeParseError } from "../lib/parseErrorCopy";
import { applyEntryStepsAreNavigable, type ApplyEntryPayload } from "../lib/applyEntry";
import { buildApplyPlanFromEntry } from "../lib/applyPlanDraft";
import {
  applyConfirmationText,
  executeApplyPlan,
  isProtectedApplyTarget,
  requiresManualApplyConfirm,
  type ApplyExecutionProgress,
  type ApplyWriteVerification,
} from "../lib/applyPlanExecution";
import { getTaskManager, type Task, type TaskStatus } from "../lib/taskmanager";
import { loadOperationHistory, recordOperation, type OperationRecord } from "../store/operationHistory";
import { publishConfigChange } from "../lib/configChangeBus";
import { createAuditSession, auditSessionEvent, endAuditSession } from "../lib/auditSessionLog";
import { saveApplyPlan } from "../store/applyPlans";
import type { Connection } from "../store/connections";
import ConfirmModal from "./ConfirmModal";
import CopyButton from "./CopyButton";
import InlineError from "./InlineError";
import DiffPanel from "./DiffPanel";
import DiffWorkflowCard, { WORKFLOW_STEP_IDS, type WorkflowStepId } from "./DiffWorkflowCard";
import { errorText } from "../lib/errorText";
import { statusMessageProps } from "../lib/statusSemantics";

interface Props {
  entry: ApplyEntryPayload | null;
  connections: Connection[];
  onBack: (focusStep?: WorkflowStepId) => void;
  /**
   * 跳到操作历史并定位本次执行留下的记录（轮66 WP-2）。
   * 失败文案承诺「可在操作历史用本次备份快照回退」，这个回调就是把承诺接上的那只手；
   * 不传（比如脱离 App 单独渲染）就不摆按钮，不放一个点了没反应的空入口。
   */
  onOpenHistory?: (recordId: string) => void;
  /**
   * 换一份入口负载回到第1步。
   * 第5步的晋级入口本批已撤、「以本次范围新建变更计划」尚未排期，组件内暂时没有页面在用它；
   * App 仍会传入，这里保留为预留接口。它不写任何东西，产出的仍是变更计划入口，五步 + dry-run 一道不少。
   */
  onStartApply?: (payload: ApplyEntryPayload) => void;
}

type DraftState =
  | { status: "idle" | "loading" }
  | { status: "ready"; plan: ApplyPlan; sourceConnection: Connection; targetConnection: Connection }
  | { status: "error"; detail: string };

type ExecutionMode = "apply" | "dry-run";

function firstSelectableItem(plan: ApplyPlan): string {
  return plan.items[0]?.id ?? "";
}

function isSelectableApplyItem(item: ApplyPlanItem): boolean {
  return !item.blocked && item.action !== "skip" && item.action !== "parse_error";
}

function defaultSelectedItemIds(plan: ApplyPlan): Set<string> {
  return new Set(plan.items.filter(isSelectableApplyItem).map((item) => item.id));
}

/** 变更会话 id（组件级，跨 runPlan 调用复用同一 session，五步事件串成一条时间线）。 */
function genApplySessionId(): string {
  return `apply-${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 单条 item 的完整现场（源/目标/写后 完整内容 + 指纹 + 阻断原因），供会话记录 payload。 */
function planItemFullRecord(item: ApplyPlanItem): Record<string, unknown> {
  const pick = (v: ApplyPlanItem["sourceValue"]) => ({
    exists: v.exists,
    value: v.value ?? null,
    format: v.format ?? null,
    parseStatus: v.parseStatus ?? null,
    parseError: v.parseError ?? null,
    content: v.content ?? null,
    version: v.version ?? null,
    md5: v.md5 ?? null,
    fingerprint: v.fingerprint,
  });
  return {
    id: item.id,
    action: item.action,
    blocked: item.blocked,
    blockReason: item.blockReason ?? null,
    ref: { provider: item.ref.provider, namespace: item.ref.namespace, group: item.ref.group, dataId: item.ref.dataId, key: item.ref.key },
    sourceRef: item.sourceRef
      ? { namespace: item.sourceRef.namespace, group: item.sourceRef.group, dataId: item.sourceRef.dataId, key: item.sourceRef.key }
      : null,
    sourceValue: pick(item.sourceValue),
    targetValue: pick(item.targetValue),
    afterValue: pick(item.afterValue),
  };
}

function planItemsFullRecord(plan: ApplyPlan): Array<Record<string, unknown>> {
  return plan.items.map(planItemFullRecord);
}

/** 会话记录辅助：把事件写入 audit session（静默失败，不阻断主流程）。 */
function sessionEventSafe(sessionId: string | null, event: Parameters<typeof auditSessionEvent>[1]): void {
  if (!sessionId) return;
  try {
    auditSessionEvent(sessionId, event);
  } catch {
    // 审计失败不影响主流程
  }
}

function appendConnection(connections: Connection[], connection: Connection): Connection[] {
  return connections.some((item) => item.id === connection.id) ? connections : [...connections, connection];
}

function applyExecutionConnections(connections: Connection[], sourceConnection: Connection, targetConnection: Connection): Connection[] {
  return appendConnection(appendConnection(connections, sourceConnection), targetConnection);
}

function valueText(value: ApplyPlanValueSnapshot, missingLabel: string): string {
  if (!value.exists) return missingLabel;
  return value.value ?? value.content ?? "";
}

function countLabel(
  t: (key: string, params?: Record<string, string | number>) => string,
  key: keyof ApplyPlanSummary,
  count: number
): string {
  return t(`apply.summary.${key}`, { count });
}

function actionLabel(t: (key: string, params?: Record<string, string | number>) => string, action: ApplyPlanAction): string {
  return t(`apply.actions.${action}`);
}

function isSandboxTarget(connection: Connection | null, plan: ApplyPlan): boolean {
  const values = [
    connection?.name,
    connection?.environmentName,
    connection?.sourceName,
    ...(connection?.tags ?? []),
    plan.target.label,
    plan.target.connectionName,
  ];
  return values.some((value) => /sandbox|沙箱/i.test(value ?? ""));
}

function taskStatusLabel(t: (key: string, params?: Record<string, string | number>) => string, status: TaskStatus): string {
  return t(`tasks.status${status[0].toUpperCase()}${status.slice(1)}`);
}

function PlanCountStrip({ plan }: { plan: ApplyPlan }) {
  const { t } = useTranslation();
  return (
    <div className="apply-count-strip" aria-label={t("apply.summaryLabel")}>
      <span>{countLabel(t, "total", plan.summary.total)}</span>
      <span>{countLabel(t, "create", plan.summary.create)}</span>
      <span>{countLabel(t, "overwrite", plan.summary.overwrite)}</span>
      <span>{countLabel(t, "delete", plan.summary.delete)}</span>
      <span>{countLabel(t, "skip", plan.summary.skip)}</span>
      <span>{countLabel(t, "parse_error", plan.summary.parse_error)}</span>
      <span>{countLabel(t, "blocked", plan.summary.blocked)}</span>
    </div>
  );
}

function PlanLedger({ plan }: { plan: ApplyPlan }) {
  const { t } = useTranslation();
  return (
    <div className="apply-ledger" aria-label={t("apply.ledgerLabel")}>
      <span>{t("apply.ledger.source")}</span>
      <strong title={plan.source.label}>{plan.source.label}</strong>
      <span>{t("apply.ledger.dryRun")}</span>
      <strong title={plan.id}>{plan.id}</strong>
      <span>{t("apply.ledger.target")}</span>
      <strong title={plan.target.label}>{plan.target.label}</strong>
    </div>
  );
}

function PlanItemList({
  plan,
  selectedId,
  selectedIds,
  appliedIds,
  onSelect,
  onToggleSelected,
  onSelectAll,
  onSelectNone,
}: {
  plan: ApplyPlan;
  selectedId: string;
  selectedIds: Set<string>;
  /** 本计划里已经真写进目标的项（轮134）：勾不回来，也再不许被写第二遍。 */
  appliedIds: Set<string>;
  onSelect: (id: string) => void;
  onToggleSelected: (id: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="apply-item-list">
      <div className="apply-item-toolbar">
        <span>{t("apply.selectionCount", { count: selectedIds.size })}</span>
        <div className="apply-item-toolbar-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onSelectAll}>
            {t("apply.selectAll")}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onSelectNone}>
            {t("apply.selectNone")}
          </button>
        </div>
      </div>
      {plan.items.map((item) => {
        const applied = appliedIds.has(item.id);
        const selectable = isSelectableApplyItem(item) && !applied;
        const checked = selectedIds.has(item.id);
        return (
          <label
            key={item.id}
            className={`apply-item-row${item.id === selectedId ? " selected" : ""}${item.blocked ? " blocked" : ""}${checked ? " checked" : ""}${applied ? " applied" : ""}`}
            onClick={() => onSelect(item.id)}
          >
            <input
              className="apply-item-check"
              type="checkbox"
              checked={checked}
              disabled={!selectable}
              onChange={() => onToggleSelected(item.id)}
            />
            <span className="apply-item-main">
              <span className="mono" title={item.ref.dataId}>
                {item.ref.dataId}
              </span>
              {/* 整篇文档级条目不露内部哨兵 key，真值留在 title 里供排查（R55-B4） */}
              <span className="apply-item-key mono" title={item.ref.key}>
                {item.ref.key === DOCUMENT_KEY ? t("apply.documentKey") : item.ref.key}
              </span>
            </span>
            <span className={`apply-action apply-action-${item.action}`}>{actionLabel(t, item.action)}</span>
            {item.blocked && <span className="apply-blocked">{t("apply.blocked")}</span>}
            {item.manualTuned && (
              <span className="tune-badge" title={t("apply.manualTunedHint")}>
                {t("apply.manualTuned")}
              </span>
            )}
            {applied && (
              <span className="tune-badge is-applied" title={t("apply.itemAppliedHint")}>
                {t("apply.itemApplied")}
              </span>
            )}
          </label>
        );
      })}
    </div>
  );
}

/**
 * 内联「编辑目标内容」面板里还没保存的东西。
 *
 * 这份状态以前挂在 ItemDetail 自己的 useState 上：切换选中的配置项时组件不会重置，
 * 于是 A 项写了一半的内容会带着面板一起显示在 B 项上，点「保存」就把 A 的正文
 * 塞进了 B 的 afterValue 并落进计划（轮7 R60，真会写坏要发布的内容）。
 * 提到父层按 itemId 存放后：串行不可能发生，切走再回来草稿还在，
 * 「返回」有未保存草稿时也能拦一道（R58）。
 */
interface TargetEdit {
  content: string;
  errors: string[];
}

function ItemDetail({
  item,
  edit,
  onEditChange,
  onCommitEdit,
}: {
  item: ApplyPlanItem;
  edit?: TargetEdit;
  onEditChange: (itemId: string, next: TargetEdit | null) => void;
  onCommitEdit: (itemId: string, content: string) => void;
}) {
  const { t } = useTranslation();
  const missingLabel = t("apply.valueMissing");
  const diffFormat = item.afterValue.format ?? item.sourceValue.format ?? item.targetValue.format ?? "TEXT";
  const currentAfter = valueText(item.afterValue, missingLabel);
  const canEdit = item.action !== "delete";

  const startEdit = () => onEditChange(item.id, { content: currentAfter, errors: [] });
  const cancelEdit = () => onEditChange(item.id, null);
  const commitEdit = () => {
    if (!edit) return;
    const problems = validateConfig(edit.content, diffFormat);
    if (problems.length > 0) {
      onEditChange(item.id, { content: edit.content, errors: problems });
      return;
    }
    onCommitEdit(item.id, edit.content);
  };
  const hasFatalParseError = item.sourceValue.parseStatus === "error" || item.targetValue.parseStatus === "error";
  // parseError 现在兼作 warning（如 YAML duplicate key）：fatal 解析失败红色展示；
  // 非 fatal 的 warning（后值覆盖类）用黄色提示，不再完全隐藏。
  // create / overwrite 时 afterValue 与 sourceValue 是同一份快照（applyPlan.ts 的 afterValueFor），
  // 三个槽位里会拿到两条一模一样的串——按内容去重，不同来源各自的提示仍然逐条保留。
  const parseIssues = [
    ...new Set(
      [item.sourceValue.parseError, item.targetValue.parseError, item.afterValue.parseError].filter((error): error is string =>
        Boolean(error)
      )
    ),
  ];
  const parseErrors = hasFatalParseError ? parseIssues : [];
  const parseWarnings = hasFatalParseError ? [] : parseIssues;
  return (
    <div className="apply-detail">
      <div className="apply-detail-head">
        <div>
          <div className="apply-detail-title mono">{item.ref.dataId}</div>
          <div className="apply-detail-sub mono" title={item.ref.key}>
            {item.ref.group} / {item.ref.key === DOCUMENT_KEY ? t("apply.documentKey") : item.ref.key}
          </div>
        </div>
        <span className={`apply-action apply-action-${item.action}`}>{actionLabel(t, item.action)}</span>
      </div>
      <div className="apply-detail-meta">
        <span>{t("apply.actionLine", { action: actionLabel(t, item.action) })}</span>
        {/* 人工干预可追溯（轮60 R4）：第三步手写的微调、第四步改过目标内容，都算人工干预。 */}
        {item.manualTuned && (
          <span className="tune-badge" title={t("apply.manualTunedHint")}>
            {t("apply.manualTuned")}
          </span>
        )}
        {item.blockReason && <span>{t("apply.blockReasonLine", { reason: blockReasonLabel(t, item.blockReason) })}</span>}
        {canEdit && !edit && (
          <button className="btn btn-ghost btn-sm" type="button" onClick={startEdit}>
            {t("apply.editTarget")}
          </button>
        )}
      </div>
      {edit && (
        <div className="apply-edit-panel">
          <div className="apply-edit-head">
            <span className="apply-edit-hint">{t("apply.editTargetHint")}</span>
            <div className="apply-edit-actions">
              <button className="btn btn-ghost btn-sm" type="button" onClick={cancelEdit}>
                {t("common.cancel")}
              </button>
              <button className="btn btn-primary btn-sm" type="button" onClick={commitEdit}>
                {t("apply.editTargetSave")}
              </button>
            </div>
          </div>
          {edit.errors.length > 0 && (
            <div className="apply-edit-errors" {...statusMessageProps("error")}>
              {edit.errors.map((err, i) => (
                <div key={i}>{err}</div>
              ))}
            </div>
          )}
          <div className="apply-edit-editor">
            <CodeEditor
              value={edit.content}
              onChange={(content) => onEditChange(item.id, { content, errors: [] })}
              format={diffFormat}
              ariaLabel={t("apply.editTarget")}
            />
          </div>
        </div>
      )}
      <div className="apply-diff-preview">
        <div className="apply-dryrun-note">{t("apply.dryRunPreviewNote")}</div>
        <DiffPanel
          leftLabel={t("apply.targetValue")}
          rightLabel={t("apply.afterValue")}
          leftText={valueText(item.targetValue, missingLabel)}
          rightText={valueText(item.afterValue, missingLabel)}
          format={diffFormat}
          hideOnlyChangesToggle
          enableFind={false}
        />
      </div>
      {parseErrors.map((error, index) => (
        <div className="apply-parse-error" key={`${item.id}-parse-error-${index}`}>
          {describeParseError(error)}
        </div>
      ))}
      {parseWarnings.map((warning, index) => (
        <div className="apply-parse-warning" key={`${item.id}-parse-warning-${index}`}>
          {"\u26A0"} {describeParseError(warning)}
        </div>
      ))}
    </div>
  );
}

/**
 * blockReason 存的是机器码——审计事件与计划文件要能按码 grep，所以不动它；
 * 但界面上一句「阻塞原因：source_parse_error」等于没解释（R55-B4）。
 * 认得的码翻成人话，认不出的（旧计划里的自由文本）原样留着，不做静默吞掉。
 */
const BLOCK_REASON_KEYS: Record<string, string> = {
  source_parse_error: "apply.blockReasonSourceParse",
  target_parse_error: "apply.blockReasonTargetParse",
  edited_parse_error: "apply.blockReasonEditedParse",
  blank_content: "apply.blockReasonBlankContent",
};

function blockReasonLabel(t: (key: string) => string, reason: string): string {
  const key = BLOCK_REASON_KEYS[reason];
  return key ? t(key) : reason;
}

/**
 * 写后回读面板（R55-B2，轮55 B线）。
 *
 * 「服务端返回成功」和「目标上真的是这份值」是两件事：真机取证单节点 loopback 也有
 * 54–145ms 的可见窗口，多节点更宽。这一版把回读结论摆在执行结果旁边，
 * 没确认的项点名到人读标签，用户不至于拿着半生效的目标去标记验证通过。
 */
function PostWriteVerificationPanel({ verification }: { verification: ApplyWriteVerification }) {
  const { t } = useTranslation();
  const warning = verification.unconfirmedCount > 0;
  return (
    <div className={`apply-post-write-verification${warning ? " is-warning" : ""}`} {...statusMessageProps(warning ? "info" : "success")}>
      <div className="apply-post-write-verification-head">
        <strong>{t("apply.postWriteVerificationTitle")}</strong>
        <span>{t("apply.postWriteVerificationHeadline", { confirmed: verification.confirmedCount, total: verification.total })}</span>
      </div>
      {verification.drifted.length > 0 && (
        <div className="apply-post-write-verification-group">
          <span className="apply-post-write-verification-label">
            {t("apply.postWriteVerificationDrifted", { count: verification.drifted.length })}
          </span>
          <ul className="apply-post-write-verification-refs">
            {verification.drifted.map((ref) => (
              <li key={`drifted-${ref}`} className="mono">
                {ref}
              </li>
            ))}
          </ul>
        </div>
      )}
      {verification.unreadable.length > 0 && (
        <div className="apply-post-write-verification-group">
          <span className="apply-post-write-verification-label">
            {t("apply.postWriteVerificationUnreadable", { count: verification.unreadable.length })}
          </span>
          <ul className="apply-post-write-verification-refs">
            {verification.unreadable.map((ref) => (
              <li key={`unreadable-${ref}`} className="mono">
                {ref}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="apply-post-write-verification-hint">
        {t(warning ? "apply.postWriteVerificationHintWarning" : "apply.postWriteVerificationHintConfirmed")}
      </p>
    </div>
  );
}

/**
 * 只读预演这一轮到底覆盖哪几项（轮134）。
 * 勾选出来的可执行项优先；勾选被「写完自动摘掉」清空、而整版又都写过了，回落到刚写过的那批——
 * 写完再干跑一次核对目标现状是执行后最自然的下一步，把预演一起灰掉等于逼用户重新生成计划（R55-D3）。
 * 用户自己点「全不选」不触发回落：那时还剩没写的项，清空是有意为之，预演确实没有对象。
 */
function resolveDryRunItemIds(plan: ApplyPlan, selectedIds: Set<string>, appliedItemIds: Set<string>): string[] {
  const previewable = plan.items.filter((item) => isSelectableApplyItem(item)).map((item) => item.id);
  const chosen = previewable.filter((id) => selectedIds.has(id));
  if (chosen.length > 0) return chosen;
  if (previewable.length === 0) return [];
  return previewable.every((id) => appliedItemIds.has(id)) ? previewable : [];
}

function ConfirmationPanel({
  plan,
  selectedCount,
  selectedIds,
  protectedTarget,
  manualConfirmRequired,
  confirmed,
  confirmationText,
  executionMode,
  executeError,
  executeProgress,
  executeNotice,
  executionTask,
  remainingWork,
  appliedCount,
  dryRunCount,
  writeVerification,
  executeHistoryId,
  alreadyAppliedRefs,
  nothingToWrite,
  onOpenHistory,
  onConfirmedChange,
  onConfirmationTextChange,
  onExecute,
  onDryRun,
  onSkipFailedItem,
}: {
  plan: ApplyPlan;
  selectedCount: number;
  selectedIds: Set<string>;
  /** 目标是否受保护（决定头部通知：受保护目标 / 普通目标）。 */
  protectedTarget: boolean;
  /** 第 5 步要不要手敲确认文本（r114：连接显式写入确认策略优先，未声明落到受保护判定）。 */
  manualConfirmRequired: boolean;
  confirmed: boolean;
  confirmationText: string;
  executionMode: ExecutionMode | null;
  executeError: string | null;
  /** 部分写入的进度（R55-A2）：失败时由执行器算出来，拿不到就不显示这一行。 */
  executeProgress: ApplyExecutionProgress | null;
  executeNotice: string | null;
  executionTask: Task | null;
  /** 本计划里还没真写进目标的可执行项数（轮134）。 */
  remainingWork: number;
  /** 本计划已经真写进目标的项数。 */
  appliedCount: number;
  /** 这一轮只读预演实际覆盖到的项数（轮134）：勾选为空但整版已写完时回落到刚写过的那批。 */
  dryRunCount: number;
  /** 写后回读结论（R55-B2）：dry-run 与没落笔的失败都是 null——没验证过就别装作验证过。 */
  writeVerification: ApplyWriteVerification | null;
  /** 本次执行写进操作历史的记录 id；拿不到就没有回退入口可指。 */
  executeHistoryId: string | null;
  /** 本次执行留下的那条记录（成功分支才有）：成功分支一次性解析好；晋级入口本批已撤，当前页面无消费者，作预留字段。 */
  executeRecord: OperationRecord | null;
  /** 本轮判定「目标已经是这一版」而没有落笔的项（人读标签，轮98）。 */
  alreadyAppliedRefs: string[];
  /** 勾选项全部已达成：这一轮一个字节都没写，屏上不许出现「变更执行完成」。 */
  nothingToWrite: boolean;
  /** 预留：晋级入口本批已撤，生产目标候选的读取随面板走了；替代入口排期后恢复消费。 */
  connections: Connection[];
  onOpenHistory?: (recordId: string) => void;
  /** 预留：晋级入口本批已撤，「以本次范围新建变更计划」未排期，组件内暂无调用方（App 仍传入）。 */
  onStartApply?: (payload: ApplyEntryPayload) => void;
  onConfirmedChange: (value: boolean) => void;
  onConfirmationTextChange: (value: string) => void;
  onExecute: () => void;
  onDryRun: () => void;
  /** 摘掉失败项执行剩下的（轮98 第二条出口）；itemId 由执行进度给出。 */
  onSkipFailedItem: (itemId: string) => void;
}) {
  const { t } = useTranslation();
  const requiredText = applyConfirmationText(plan);
  // 手敲 26 个字符很容易带进一个尾空格，而空格看不见——差一个字符就永远灰着，
  // 用户只会以为「这按钮坏了」。比较前 trim，多敲的空格不算错（轮67 / R67-WP10）。
  const typedText = confirmationText.trim();
  const ready = manualConfirmRequired ? typedText === requiredText : confirmed;
  const anyRunning = executionMode !== null;
  // 只读预演不受「这一批已经写过了」的限制：写完想再干跑一次核对目标现状，
  // 是执行之后最自然的下一步，把它灰掉等于逼用户重新生成一份计划（R55-D3）。
  // 判据看 dryRunCount（预演实际覆盖到的项数）而不是勾选数——写过的项会自动退出勾选，
  // 这时预演对象回落到刚写过的那批，按钮不能跟着一起灭（轮134）。
  const dryRunDisabled = anyRunning || dryRunCount === 0;
  // 执行守卫基于「已勾选且可执行」的项：存在 blocked 项本身不再全局禁用按钮，
  // 用户可取消勾选阻断项后执行其余项（执行层 runPlan 仍会兜底过滤 blocked/parse_error/skip）。
  const selectedHasBlocked = plan.items.some((item) => selectedIds.has(item.id) && !isSelectableApplyItem(item));
  const executeDisabled = !ready || anyRunning || remainingWork === 0 || selectedCount === 0 || selectedHasBlocked;
  // 半截失败的第二条出口（轮98）：摘掉失败项后还有得写才给这颗按钮，
  // 「跳过最后一项」变成空跑没有意义。守卫沿用执行按钮那一份（确认文本/执行中/已成功一次），
  // 只是把"勾选项里含失败项"这条摘掉——少选一项不可能是新的风险动作。
  const skipCandidateId =
    executeError && executeProgress?.failedItemId && selectedIds.has(executeProgress.failedItemId) ? executeProgress.failedItemId : "";
  const remainingAfterSkip = skipCandidateId
    ? plan.items.filter((item) => selectedIds.has(item.id) && item.id !== skipCandidateId && isSelectableApplyItem(item))
    : [];
  const canSkipFailedItem = Boolean(skipCandidateId) && remainingAfterSkip.length > 0;
  const skipDisabled = !ready || anyRunning || remainingWork === 0;
  // 灰按钮必须自己说清缺哪一步（R19）：五个原因并成一个 disabled，用户只能一个个开关去试。
  // title 挂在包裹按钮的 .btn-guard 上而不是按钮本身——disabled 的元素收不到 pointer 事件，
  // 浏览器根本不出 tooltip（与 ConnectionManager 的端口守卫同一写法）。
  const blockers: Array<{ id: string; label: string; alsoDryRun: boolean }> = [];
  if (anyRunning) blockers.push({ id: "running", label: t("apply.blockRunning"), alsoDryRun: true });
  // 「这一版没有剩下要写的项」与「一项都没勾」是两条独立原因，必须分开说：
  // 前者该重新生成计划，后者只需要勾上（轮134 之前它们被同一颗整计划锁混成了一条）。
  if (remainingWork === 0 && appliedCount > 0) blockers.push({ id: "allApplied", label: t("apply.blockAllApplied"), alsoDryRun: false });
  // 「整版都写完了」自己就给出了出口（重新生成计划），别再补一句「请勾选至少一项」——
  // 这时勾选框是灭的，让人去勾选等于指错路（轮134）。
  if (selectedCount === 0 && !(remainingWork === 0 && appliedCount > 0)) {
    blockers.push({ id: "noSelection", label: t("apply.blockNoSelection"), alsoDryRun: true });
  }
  if (selectedHasBlocked) blockers.push({ id: "hasBlocked", label: t("apply.blockHasBlocked"), alsoDryRun: false });
  if (!ready) {
    blockers.push({
      id: "notReady",
      // 「一个字都没敲」与「敲了但差一个字符」必须分开说（轮67 / R67-WP10）：
      // 真机量过，敲错时旧文案仍然回「还没输入上方要求的确认文本。」，
      // 用户对着已经填满的输入框看不出哪里错，只能整串重来。
      label: !manualConfirmRequired
        ? t("apply.blockNotConfirmed")
        : typedText
          ? t("apply.blockConfirmMismatch")
          : t("apply.blockConfirmText"),
      alsoDryRun: false,
    });
  }
  const dryRunBlockers = blockers.filter((blocker) => blocker.alsoDryRun);
  const skipBlockers = blockers.filter((blocker) => blocker.id !== "noSelection");
  const blockerTitle = (list: typeof blockers) => (list.length ? list.map((blocker) => blocker.label).join("\n") : undefined);
  const executeLabel =
    executionMode === "apply"
      ? t("apply.executing")
      : selectedCount === plan.items.length
        ? t("apply.execute")
        : t("apply.executeSelected", { count: selectedCount });
  const dryRunLabel =
    executionMode === "dry-run"
      ? t("apply.dryRunExecuting")
      : dryRunCount === plan.items.length
        ? t("apply.dryRun")
        : t("apply.dryRunSelected", { count: dryRunCount });

  return (
    <div className="apply-confirmation" aria-label={t("apply.confirmationLabel")}>
      <div className="apply-confirmation-head">
        <h4>{t("apply.confirmationTitle")}</h4>
        <span>{protectedTarget ? t("apply.protectedNotice") : t("apply.normalNotice")}</span>
      </div>
      <div className="apply-selection-note">{t("apply.selectionCount", { count: selectedCount })}</div>
      {manualConfirmRequired ? (
        <div className="field">
          <label className="field-label" htmlFor="apply-confirmation-text">
            {t("apply.confirmationTextLabel")}
          </label>
          <div className="field-hint">{t("apply.protectedInstruction")}</div>
          {/* 确认文本要能抄（轮67 / R67-WP10）：`body` 关了全选，这一串原本拖选/三击都是 0 字符，
              于是「抄不走 + 敲不完」两头堵。放开选中再补一颗复制键，粘过去即可；
              但不做「一键填入」——填进去就等于跳过手敲那层防呆，复制出口留给真的敲不动的人。 */}
          <div className="apply-confirmation-code-row">
            <code className="apply-confirmation-code">{requiredText}</code>
            <CopyButton text={requiredText} label={t("apply.copyConfirmationText")} />
          </div>
          <input
            type="text"
            id="apply-confirmation-text"
            className="search-input wide mono"
            spellCheck={false}
            value={confirmationText}
            onChange={(event) => onConfirmationTextChange(event.target.value)}
          />
        </div>
      ) : (
        <label className="apply-confirm-check">
          <input type="checkbox" checked={confirmed} onChange={(event) => onConfirmedChange(event.target.checked)} />
          <span>{t("apply.confirmNormal")}</span>
        </label>
      )}
      <div className="apply-confirmation-actions">
        <span className="btn-guard" title={blockerTitle(dryRunBlockers)}>
          <button className="btn btn-ghost" type="button" disabled={dryRunDisabled} aria-disabled={dryRunDisabled} onClick={onDryRun}>
            {dryRunLabel}
          </button>
        </span>
        <span className="btn-guard" title={blockerTitle(blockers)}>
          <button className="btn btn-primary" type="button" disabled={executeDisabled} aria-disabled={executeDisabled} onClick={onExecute}>
            {executeLabel}
          </button>
        </span>
      </div>
      {/* 任务在跑时进度面板自己会说话，这里不再重复播报「已有任务在执行」；
          读屏拿的是这条行内清单，不依赖悬停 tooltip。 */}
      {!anyRunning && blockers.length > 0 && (
        <ul className="apply-blocker-hint" aria-label={t("apply.blockerHintLabel")}>
          {blockers.map((blocker) => (
            <li key={blocker.id}>{blocker.label}</li>
          ))}
        </ul>
      )}
      {/*
       * 全部已达成（轮98 A5）：这不是一次"变更执行完成"，而是一轮什么都没做。
       * 绿色那条成功横幅留给真的写过的场合，这里用信息色块并把项清单摊开——
       * 用户下一步要判断的是"那我到底还要不要改这份计划"，看不见是哪几项就判断不了。
       */}
      {nothingToWrite && (
        <div className="apply-already-applied" {...statusMessageProps("info")}>
          <span>{executeNotice}</span>
          {alreadyAppliedRefs.length > 0 && (
            <span className="apply-already-applied-refs">
              {t("apply.alreadyAppliedItems", { count: alreadyAppliedRefs.length, refs: alreadyAppliedRefs.join(" / ") })}
            </span>
          )}
        </div>
      )}
      {!nothingToWrite && executeNotice && <div className="apply-execution-notice">{executeNotice}</div>}
      {!nothingToWrite && alreadyAppliedRefs.length > 0 && (
        <div className="apply-already-applied" {...statusMessageProps("info")}>
          {t("apply.alreadyAppliedNote", { count: alreadyAppliedRefs.length })}
        </div>
      )}
      {writeVerification && <PostWriteVerificationPanel verification={writeVerification} />}
      {executionTask && (
        <div className="apply-task-progress" aria-label={t("apply.taskProgressLabel")}>
          <div className="apply-task-progress-head">
            <strong>{t("apply.taskProgressTitle")}</strong>
            <span className={`task-status task-status-${executionTask.status}`}>{taskStatusLabel(t, executionTask.status)}</span>
          </div>
          <div
            className="progress-bar large"
            role="progressbar"
            aria-label={t("apply.taskProgressLabel")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={executionTask.progress}
          >
            <div className="progress-fill" style={{ width: `${executionTask.progress}%` }} />
          </div>
          <div className="apply-task-progress-meta">
            <span>{t("apply.taskProgressStats", { completed: executionTask.completed, total: executionTask.total })}</span>
            <span>{t("apply.taskProgressPercent", { progress: executionTask.progress })}</span>
          </div>
          <div className="apply-task-progress-id">
            <span>
              {t("tasks.taskId")}: <span className="mono">{executionTask.id}</span>
            </span>
            <CopyButton text={executionTask.id} label={t("apply.copyTaskId")} />
          </div>
          {/*
           * 任务失败时这句错误与下面 InlineError 的 message 是同一个字符串——
           * applyPlanExecution.recordFailure() 把 error 同时喂给 completeTask(taskId,false,error)
           * 和返回值的 error 字段，两处各渲染各的，谁都没写错。真机第五步实测（/tmp/cs/wp11-readings.txt）：
           * 「配置在计划生成后又变了…」在 .apply-task-progress-error 与 .inline-error-body 里各出现一份，
           * 同屏两遍长文本，用户以为发生了两次失败。失败详情归 InlineError 那一份（复制与重试都挂在它身上），
           * 进度面板只留它自己该说的事实：状态、进度、任务号。
           * 仍然保留兜底：任务带错误而 executeError 没跟上（或两者文字不同）时照旧显示，不吞信息。
           */}
          {executionTask.error && executionTask.error.trim() !== (executeError ?? "").trim() && (
            <pre className="apply-task-progress-error">{executionTask.error}</pre>
          )}
        </div>
      )}
      {executeError && (
        <InlineError
          title={t("apply.executionFailed")}
          message={executeError}
          copyLabel={t("apply.copyError")}
          /* 重试直接走同一个 onExecute，守卫复用按钮那套判定（executeDisabled）：
             确认勾选 / 确认文本 / blocked 项 / 成功一次后禁再执行，一个都绕不过去（R55-A6）。 */
          onRetry={executeDisabled ? undefined : onExecute}
        />
      )}
      {executeError && executeProgress && (
        <div className="apply-partial-write" {...statusMessageProps("info")}>
          {executeProgress.completedWrites > 0
            ? t("apply.progressPartial", {
                completed: executeProgress.completedWrites,
                total: executeProgress.totalWrites,
                failedIndex: executeProgress.failedIndex ?? "?",
                ref: executeProgress.failedRef ?? "",
              })
            : /* 一项都没写成功时不能暗示「已有内容生效/可回退」（轮60 真机 403 的第一次失败就是这个形态） */
              t("apply.progressNothingWritten", {
                failedIndex: executeProgress.failedIndex ?? "?",
                ref: executeProgress.failedRef ?? "",
              })}
        </div>
      )}
      {/* 轮66 WP-2：上面那句「可在操作历史用本次备份快照回退」是页面上唯一的线索，
          而侧边栏那一格「操作历史」并不属于这段提示，用户读完得自己猜去哪条记录里找现场。
          半截写入 = 改动已经在目标上生效，出口必须比文案更显眼，所以直接给一颗跳转按钮。
          只在真拿到本次记录 id 时出现；也不塞进上面那块——它带 aria-live，
          交互节点放进去会让读屏把按钮连文案重播一遍。 */}
      {executeError && canSkipFailedItem && (
        <div className="apply-skip-exit">
          <span className="btn-guard" title={blockerTitle(skipBlockers)}>
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              disabled={skipDisabled}
              aria-disabled={skipDisabled}
              onClick={() => onSkipFailedItem(skipCandidateId)}
            >
              {t("apply.skipFailedItem")}
            </button>
          </span>
          <span className="apply-skip-exit-hint">{t("apply.skipFailedItemHint", { count: remainingAfterSkip.length })}</span>
        </div>
      )}
      {/* 两条出口并存（轮98）：想留着已写成的部分继续 → 跳过这一项；想把已写成的撤回去 → 回退。
          回退那条仍只认真正写成过的项（completedWrites > 0）：一项都没落笔时它指向一份不存在的现场。 */}
      {executeError && executeProgress && executeProgress.completedWrites > 0 && executeHistoryId && onOpenHistory && (
        <div className="apply-rollback-entry">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenHistory(executeHistoryId)}>
            {t("apply.openHistoryToRollback")}
          </button>
          <span className="apply-rollback-entry-hint">{t("apply.openHistoryToRollbackHint")}</span>
        </div>
      )}
    </div>
  );
}

export default function ApplyPlanView({ entry, connections, onBack, onOpenHistory, onStartApply }: Props) {
  const { t } = useTranslation();
  const [draftState, setDraftState] = useState<DraftState>({ status: "idle" });
  const [selectedId, setSelectedId] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // 未保存的「编辑目标内容」：itemId -> 草稿。只有本页会写，切选中项不丢，离开前拦一道。
  const [targetEdits, setTargetEdits] = useState<Record<string, TargetEdit>>({});
  const [askDiscardEdits, setAskDiscardEdits] = useState(false);
  // 写入进行中点「返回」/stepper 回退：先确认一次再走（R55-A5）
  const [askLeaveDuringRun, setAskLeaveDuringRun] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmationText, setConfirmationText] = useState("");
  const [executionMode, setExecutionMode] = useState<ExecutionMode | null>(null);
  const [lastExecutionMode, setLastExecutionMode] = useState<ExecutionMode | null>(null);
  const [executionCompleted, setExecutionCompleted] = useState(false);
  /**
   * 本计划已经真写进目标的项（轮134）。
   *
   * 为什么按项而不是一个「已成功执行过一次」的总闸：一份计划里多条变更是分次执行是常态
   * （第 1 条写完想接着写第 2 条），旧口径把整颗执行按钮永久灰到「重新生成计划」，
   * 用户看到的是按钮坏了。清单来源只有一个——执行器逐项回调里 result==="success" 的那些项，
   * 与「已应用 N 项」用的是同一份落笔事实，不许拿勾选数重算。
   */
  const [appliedItemIds, setAppliedItemIds] = useState<Set<string>>(new Set());
  const [executionTask, setExecutionTask] = useState<Task | null>(null);
  const [executeError, setExecuteError] = useState<string | null>(null);
  // 失败时的「已写入几项 / 第几项断的」（R55-A2）：跟着 executeError 一起清，避免留旧数
  const [executeProgress, setExecuteProgress] = useState<ApplyExecutionProgress | null>(null);
  // 本次执行落到操作历史的记录 id（轮66 WP-2）：回退入口要指着这条记录，同样跟着 executeError 一起清
  const [executeHistoryId, setExecuteHistoryId] = useState<string | null>(null);
  // 本次执行那条记录本身：晋级入口本批已撤，当前页面无消费者，作预留字段；
  // 仍在成功分支一次性解析好，不在渲染期读 localStorage（判据见 tests/ux/renderTimeStorageReads.test.ts）。
  const [executeRecord, setExecuteRecord] = useState<OperationRecord | null>(null);
  const [executeNotice, setExecuteNotice] = useState<string | null>(null);
  // 写后回读结论（R55-B2）：跟着执行态一起重置，换一次执行不能留着上一轮的结论
  const [writeVerification, setWriteVerification] = useState<ApplyWriteVerification | null>(null);
  // 轮98：本轮判定「目标已经是这一版」而没有落笔的项，以及"这一轮什么都没要写"这条独立结论。
  // 两者都跟着执行态一起清，换一次执行不能留着上一轮的结论。
  const [alreadyAppliedRefs, setAlreadyAppliedRefs] = useState<string[]>([]);
  const [nothingToWrite, setNothingToWrite] = useState(false);
  const taskManager = getTaskManager();
  const trackedTaskIdRef = useRef<string | null>(null);
  // 变更会话 id：进入计划时创建，整个组件生命周期内五步事件共用
  const applySessionRef = useRef<string | null>(null);
  // 进入计划时的 apply_session_start 事件会话 id（runPlan 复用；
  // 不用 createAuditSession 的返回值是因为事件需写入会话列表供审计日志页展示）
  const applyEntrySessionRef = useRef<string | null>(null);

  // 写入进行中关掉整个应用会掐断在途请求，已落库的配置也不会自动回退，
  // 所以这一层用 beforeunload 拦一次（R55-A5）。dry-run 什么都不写，不挂。
  // 挂在 executionMode 上：离开执行态（finally）自动摘除，不给后续操作留隐形拦截。
  useEffect(() => {
    if (executionMode !== "apply") return;
    const blockLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", blockLeave);
    return () => window.removeEventListener("beforeunload", blockLeave);
  }, [executionMode]);

  useEffect(() => {
    const unsubscribe = taskManager.onTaskUpdate((task) => {
      if (task.id === trackedTaskIdRef.current) setExecutionTask(task);
    });
    return () => unsubscribe?.();
  }, [taskManager]);

  // 计划构建从「进入本页」的 useEffect 里提出来（R55-A6）：以前构建逻辑长在 effect 内部，
  // 生成失败后界面上除了退出再进来没有第二条路，行内错误也就无从挂「重试」。
  // attempt 计数 + mounted 双保险：重试或换 entry 时，上一趟 promise 的回调不许再落状态。
  const buildAttemptRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const buildDraft = useCallback(() => {
    if (!entry) {
      setDraftState({ status: "idle" });
      setSelectedId("");
      setSelectedIds(new Set());
      return;
    }
    buildAttemptRef.current += 1;
    const attempt = buildAttemptRef.current;
    setDraftState({ status: "loading" });
    setSelectedId("");
    setSelectedIds(new Set());
    applySessionRef.current = null;
    applyEntrySessionRef.current = null;
    buildApplyPlanFromEntry(entry, {
      connections,
      getSnapshot,
      getConfigDocument,
    })
      .then((result) => {
        if (!mountedRef.current || attempt !== buildAttemptRef.current) return;
        if (!result.ok) {
          setDraftState({ status: "error", detail: result.detail });
          return;
        }
        const savedPlan = saveApplyPlan(result.plan);
        // 变更会话开始（第 1 步 choose）：记录完整现场——两端端点 + 全部 items 完整内容
        if (!applySessionRef.current) {
          applySessionRef.current = genApplySessionId();
        }
        const planSession = createAuditSession("apply");
        applyEntrySessionRef.current = planSession;
        auditSessionEvent(planSession, {
          kind: "apply_session_start",
          scope: "apply",
          step: "choose",
          planId: savedPlan.id,
          sourceType: result.plan.inputSummary?.sourceType,
          direction: "left->right",
          left: result.plan.source?.label,
          right: result.plan.target?.label,
          summary: {
            total: result.plan.summary?.total ?? 0,
            create: result.plan.summary?.create ?? 0,
            overwrite: result.plan.summary?.overwrite ?? 0,
            delete: result.plan.summary?.delete ?? 0,
            skip: result.plan.summary?.skip ?? 0,
            parseError: result.plan.summary?.parse_error ?? 0,
            blocked: result.plan.summary?.blocked ?? 0,
          },
          payload: JSON.stringify({
            source: {
              label: result.plan.source?.label,
              connectionId: result.plan.source?.connectionId,
              namespace: result.plan.source?.namespace,
            },
            target: {
              label: result.plan.target?.label,
              connectionId: result.plan.target?.connectionId,
              namespace: result.plan.target?.namespace,
            },
            scope: result.plan.scope,
            items: planItemsFullRecord(result.plan),
          }),
        });
        setDraftState({
          status: "ready",
          plan: savedPlan,
          sourceConnection: result.sourceConnection,
          targetConnection: result.targetConnection,
        });
        setSelectedId(firstSelectableItem(savedPlan));
        setSelectedIds(defaultSelectedItemIds(savedPlan));
      })
      .catch((error) => {
        if (!mountedRef.current || attempt !== buildAttemptRef.current) return;
        setDraftState({ status: "error", detail: errorText(error) });
      });
  }, [connections, entry]);

  // 换来源 / 换连接：执行态与确认态一律重置，然后重建计划草稿。
  useEffect(() => {
    setConfirmed(false);
    setConfirmationText("");
    setExecutionMode(null);
    setLastExecutionMode(null);
    setExecutionCompleted(false);
    setExecutionTask(null);
    trackedTaskIdRef.current = null;
    setExecuteError(null);
    setExecuteProgress(null);
    setExecuteHistoryId(null);
    setExecuteRecord(null);
    setExecuteNotice(null);
    setWriteVerification(null);
    setAlreadyAppliedRefs([]);
    setNothingToWrite(false);
    setAppliedItemIds(new Set());
    buildDraft();
  }, [buildDraft]);

  // 第 3 步「选择变更」：每次勾选变化记录选中集 + 每项完整内容（变化才记，避免刷屏）
  const selectionJson = JSON.stringify(Array.from(selectedIds).sort());
  const lastSelectionRef = useRef<string>("");
  const planForSelection = draftState.status === "ready" ? draftState.plan : null;
  useEffect(() => {
    if (!planForSelection) return;
    if (selectionJson === lastSelectionRef.current) return;
    lastSelectionRef.current = selectionJson;
    const ids = new Set(selectedIds);
    const selected = planForSelection.items.filter((item) => ids.has(item.id));
    sessionEventSafe(applyEntrySessionRef.current, {
      kind: "apply_selection",
      scope: "apply",
      step: "plan",
      planId: planForSelection.id,
      selectedCount: selected.length,
      payload: JSON.stringify({
        selectedIds: Array.from(ids),
        summary: planForSelection.summary,
        items: selected.map(planItemFullRecord),
      }),
    });
  }, [selectionJson, planForSelection, selectedIds]);

  const plan = draftState.status === "ready" ? draftState.plan : null;
  const sourceConnection = draftState.status === "ready" ? draftState.sourceConnection : null;
  const targetConnection = draftState.status === "ready" ? draftState.targetConnection : null;
  const selectedItem = plan?.items.find((item) => item.id === selectedId) ?? plan?.items[0] ?? null;
  const protectedTarget = plan ? isProtectedApplyTarget(targetConnection, plan.target) : false;
  // 手敲与否是连接上显式写入确认策略与受保护判定的合成结论（r114）：
  // 策略声明 always/never 直接定档，protected-only 与未声明落到受保护判定。
  const manualConfirmRequired = plan ? requiresManualApplyConfirm(targetConnection, plan.target) : false;
  const sandboxTarget = plan ? isSandboxTarget(targetConnection, plan) : false;
  const selectedCount = selectedIds.size;
  // 还没真写进目标的可执行项：执行按钮的唯一「还有活儿」判据（轮134，替掉整计划一次性锁死）
  const remainingWork = plan ? plan.items.filter((item) => isSelectableApplyItem(item) && !appliedItemIds.has(item.id)).length : 0;
  // 只读预演这一轮实际覆盖哪几项（轮134），按钮文案/守卫与 runPlan 共用这一份结论。
  const dryRunItemIds = plan ? resolveDryRunItemIds(plan, selectedIds, appliedItemIds) : [];
  const workflowCurrentStep: WorkflowStepId = lastExecutionMode === "apply" ? "verify" : "execute";

  const updateTargetEdit = useCallback((itemId: string, next: TargetEdit | null) => {
    setTargetEdits((prev) => {
      const copy = { ...prev };
      if (next) copy[itemId] = next;
      else delete copy[itemId];
      return copy;
    });
  }, []);

  const unsavedEditCount = Object.keys(targetEdits).length;
  // 「返回」和 stepper 回退都会卸载本页，未保存的目标内容随之消失——有草稿时先问一句。
  // 记下来时的目标步骤，确认后才带着它走，避免「放弃草稿」把用户丢到别的步骤。
  const pendingBackStepRef = useRef<WorkflowStepId | undefined>(undefined);
  const attemptBack = (focusStep?: WorkflowStepId) => {
    // 执行中优先拦这一条：任务中心是全局的，返回不丢进度，但这一页的结果面板会消失，
    // 而且中途关窗会掐断在途请求（R55-A5）。确认后才带着目标步骤走，逻辑同「放弃草稿」。
    if (executionMode === "apply") {
      pendingBackStepRef.current = focusStep;
      setAskLeaveDuringRun(true);
      return;
    }
    if (unsavedEditCount === 0) {
      onBack(focusStep);
      return;
    }
    pendingBackStepRef.current = focusStep;
    setAskDiscardEdits(true);
  };

  // ── 工作流 stepper 导航（仅回退：任意回退到 DiffView 并聚焦目标步骤，进度保留；前进走页面内操作按钮） ──
  const onWorkflowStepClick = (step: WorkflowStepId) => {
    const curIdx = executionCompleted ? WORKFLOW_STEP_IDS.length : WORKFLOW_STEP_IDS.indexOf(workflowCurrentStep);
    const idx = WORKFLOW_STEP_IDS.indexOf(step);
    if (idx >= curIdx) return; // 防御：stepper 只暴露更早的步骤
    attemptBack(step);
  };

  const selectAllItems = () => {
    if (!plan) return;
    // 只增减可执行项，不取消已勾选项：
    // 编辑面板打开时点"全选"可能误触面板（面板盖住按钮区域），
    // 若"全选"同时把已勾选项清空，会意外取消用户刚勾的项。
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const candidate of plan.items) {
        if (isSelectableApplyItem(candidate) && !appliedItemIds.has(candidate.id)) next.add(candidate.id);
      }
      return next;
    });
  };

  const selectNoItems = () => setSelectedIds(new Set());

  // 人工编辑目标内容：更新选中 item 的 afterValue（执行层真正写库的内容），
  // 重算解析/动作后持久化计划，并写入变更会话（含完整编辑后内容，供排查）。
  const handleEditAfterValue = useCallback(
    (itemId: string, content: string) => {
      if (draftState.status !== "ready") return;
      const plan = draftState.plan;
      const item = plan.items.find((candidate) => candidate.id === itemId);
      if (!item) return;
      const edited = withEditedAfterValue(item, content);
      const nextPlan = { ...plan, items: plan.items.map((candidate) => (candidate.id === itemId ? edited : candidate)) };
      const savedPlan = saveApplyPlan(nextPlan);
      setDraftState({ ...draftState, plan: savedPlan });
      sessionEventSafe(applyEntrySessionRef.current, {
        kind: "apply_edit_target",
        scope: "apply",
        step: "plan",
        planId: savedPlan.id,
        selectedCount: selectedIds.size,
        payload: JSON.stringify({
          itemId: edited.id,
          dataId: edited.ref.dataId,
          group: edited.ref.group,
          action: edited.action,
          blocked: edited.blocked,
          afterContent: content,
        }),
      });
    },
    [draftState, selectedIds]
  );

  // 保存并重新校验：沿用上面写计划的逻辑，成功后收起这一项的草稿。
  const commitTargetEdit = useCallback(
    (itemId: string, content: string) => {
      handleEditAfterValue(itemId, content);
      updateTargetEdit(itemId, null);
    },
    [handleEditAfterValue, updateTargetEdit]
  );

  const toggleSelectedItem = (id: string) => {
    if (!plan) return;
    const item = plan.items.find((candidate) => candidate.id === id);
    if (!item || !isSelectableApplyItem(item) || appliedItemIds.has(item.id)) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /**
   * @param selectedOverride 明确指定本次执行的项 id —— 「跳过这一项，继续剩下的」走这条。
   *   必须走参数而不是先 setSelectedIds 再调用：setState 之后这一趟 runPlan 读到的还是旧勾选，
   *   失败项会被再写一遍，而那颗按钮承诺的恰恰是"不写它"。
   */
  /** 摘掉失败项、把剩下的继续写完（轮98 的第二条出口）。 */
  const skipFailedItemAndContinue = (itemId: string) => {
    if (!plan) return;
    const remaining = plan.items
      .filter((item) => selectedIds.has(item.id) && item.id !== itemId && isSelectableApplyItem(item) && !appliedItemIds.has(item.id))
      .map((item) => item.id);
    // 勾选与执行用同一份清单：界面上那颗复选框必须跟着灭掉，否则用户看到的还是"这几项待写"
    setSelectedIds(new Set(remaining));
    void runPlan(false, remaining);
  };

  const runPlan = async (dryRun: boolean, selectedOverride?: string[]) => {
    if (!plan || executionMode) return;
    // 始终过滤 blocked/parse_error/skip 项：勾选框禁用只是 UI 层守卫，
    // 这里是执行层兜底，避免任何来源（含旧计划数据）把阻断项写入目标。
    // 落笔的对象与只读预演的对象不是同一份（轮134）：预演走 resolveDryRunItemIds 的回落口径。
    const requestedIds = selectedOverride ?? (dryRun ? dryRunItemIds : Array.from(selectedIds));
    const selectedItemIds = requestedIds.filter((id) => {
      const item = plan.items.find((candidate) => candidate.id === id);
      if (!item || !isSelectableApplyItem(item)) return false;
      // 执行层兜底第二条：已经真写进目标的项不再进第二趟（重试/跳过都只写没写过的那几条）。
      // 这一条只挡真正要落笔的执行——预演什么都不写，不该被它挡住。
      return dryRun || !appliedItemIds.has(item.id);
    });
    if (selectedItemIds.length === 0) {
      setExecuteNotice(null);
      setExecuteHistoryId(null);
      setExecuteRecord(null);
      setExecuteError(t("apply.noSelectedItems"));
      return;
    }
    // 计划里被阻断（parse_error 等）的项数，用于执行完成提示里告知用户
    const skippedBlocked = plan.items.filter((item) => !isSelectableApplyItem(item)).length;
    setExecutionMode(dryRun ? "dry-run" : "apply");
    setLastExecutionMode(dryRun ? "dry-run" : "apply");
    if (!dryRun) {
      setExecutionCompleted(false);
    }
    setExecutionTask(null);
    trackedTaskIdRef.current = null;
    setExecuteError(null);
    setExecuteProgress(null);
    // dry-run 什么都不写，不该把上一次真实执行留下的记录引用一起抹掉：
    // 写完再干跑一次核对现状是最自然的动作，抹掉就等于把回退入口藏起来。
    if (!dryRun) {
      setExecuteHistoryId(null);
      setExecuteRecord(null);
    }
    setExecuteNotice(null);
    setWriteVerification(null);
    setAlreadyAppliedRefs([]);
    setNothingToWrite(false);
    // 复用组件级变更会话（进入计划时已 apply_session_start），后续步骤续写同一 sessionId
    const session = applyEntrySessionRef.current ?? createAuditSession("apply");
    auditSessionEvent(session, {
      kind: dryRun ? "apply_dryrun" : "apply_execute",
      scope: "apply",
      step: dryRun ? "execute" : "verify",
      planId: plan.id,
      sourceType: plan.inputSummary?.sourceType,
      direction: "left->right",
      left: plan.source?.label,
      right: plan.target?.label,
      selectedCount: selectedItemIds.length,
      dryRun,
      summary: {
        total: plan.summary?.total ?? 0,
        create: plan.summary?.create ?? 0,
        overwrite: plan.summary?.overwrite ?? 0,
        delete: plan.summary?.delete ?? 0,
        skip: plan.summary?.skip ?? 0,
        parseError: plan.summary?.parse_error ?? 0,
        blocked: plan.summary?.blocked ?? 0,
      },
    });
    try {
      // 这一批真正落笔成功的项（执行器逐项回调给的事实，成功与半截失败两条出口都要吃它）
      const writtenItemIds: string[] = [];
      const result = await executeApplyPlan(
        plan,
        {
          connections:
            sourceConnection && targetConnection ? applyExecutionConnections(connections, sourceConnection, targetConnection) : connections,
          getConfigDocument,
          publishConfig: publishConfigFromApplyPlan,
          deleteConfig: deleteConfigFromApplyPlan,
          publishConfigRef: publishConfigRefFromApplyPlan,
          deleteConfigRef: deleteConfigRefFromApplyPlan,
          createBackupSnapshot: async (configs) => {
            const snapshot = await createSnapshot(
              {
                // 备份元数据的 provider 必须跟着计划目标端走：写 Apollo/Consul 的这趟，
                // 快照被标成 nacos 之后，从快照页根本认不出它是哪个中心的备份（R55-D2）。
                provider: plan.target.provider,
                connectionId: plan.target.connectionId,
                connectionName: targetConnection?.name ?? plan.target.connectionName,
                namespace: plan.target.namespace || "public",
                namespaceId: plan.target.namespace || "public",
              },
              configs
            );
            return { id: snapshot.id, name: snapshot.name };
          },
          recordOperation,
          taskManager,
          // 写后失效广播（轮43）：执行器是唯一 sanctioned 写入者，发布点收敛在这里，
          // 保活的配置浏览 / 配置对比页各自订阅重取，不再让用户看到执行前的旧正文。
          onConfigsChanged: publishConfigChange,
        },
        {
          selectedItemIds,
          onTaskCreated: (taskId) => {
            trackedTaskIdRef.current = taskId;
            setExecutionTask(taskManager.getTask(taskId) ?? null);
          },
          ...(dryRun ? { dryRun: true } : {}),
          onItemResult: (r) => {
            if (!dryRun && r.result === "success") writtenItemIds.push(r.item.id);
            sessionEventSafe(session, {
              kind: "apply_item_result",
              scope: "apply",
              step: "verify",
              planId: plan.id,
              dryRun,
              dataId: r.item.ref.dataId,
              group: r.item.ref.group,
              direction: "left->right",
              result: r.result,
              error: r.error,
              payload: JSON.stringify({
                itemId: r.item.id,
                action: r.item.action,
                kind: r.kind,
                ref: { namespace: r.item.ref.namespace, group: r.item.ref.group, dataId: r.item.ref.dataId, key: r.item.ref.key },
                beforeContent: r.beforeContent ?? null,
                afterContent: r.afterContent ?? null,
              }),
            });
          },
        }
      );
      // 落笔即记账（轮134）：半截失败也一样——前面真写成的那几条已经改了目标，
      // 不记进已应用清单，下一趟会把它们再写一遍，而「跳过这一项」承诺的恰恰是不重复写。
      if (writtenItemIds.length > 0) {
        const justApplied = new Set(writtenItemIds);
        setAppliedItemIds((prev) => new Set([...prev, ...justApplied]));
        setSelectedIds((prev) => new Set(Array.from(prev).filter((id) => !justApplied.has(id))));
      }
      const resultHistoryId = "historyId" in result ? result.historyId : undefined;
      // 写后回读结论：成功与「半截写入」两条出口都可能有（dry-run 恒无，没写就不验）
      const writeVerificationResult = "verification" in result ? result.verification : undefined;
      setWriteVerification(writeVerificationResult ?? null);
      if (result.taskId) {
        trackedTaskIdRef.current = result.taskId;
        setExecutionTask(taskManager.getTask(result.taskId) ?? null);
      }
      // 成功也要记住本次记录（F4）：轮66 只在失败分支设过，成功屏因此指不回自己的现场。
      // 记录由执行器同步写进本地历史，这里当场读回来一次，不放进渲染期。
      setExecuteHistoryId(resultHistoryId ?? null);
      setExecuteRecord(resultHistoryId ? (loadOperationHistory().find((item) => item.id === resultHistoryId) ?? null) : null);
      // 已达成的项在成功与失败两条出口里都要如实报出来（轮98）：失败屏上那句
      // 「另有 N 项已经是这一版」正是用户判断"这一次重试到底有没有意义"的依据。
      setAlreadyAppliedRefs(result.alreadyApplied ?? []);
      if (!result.ok) {
        setExecuteError(result.error);
        setExecuteProgress(result.progress ?? null);
        auditSessionEvent(session, {
          kind: "apply_error",
          result: "failure",
          taskId: result.taskId,
          historyId: resultHistoryId,
          error: result.error,
          // 部分写入时这份结论才是真正要紧的：哪几条落成功且回读一致，才谈得上回退
          payload: writeVerificationResult ? JSON.stringify({ verification: writeVerificationResult }) : undefined,
        });
        endAuditSession(session, "failure", result.error);
        return;
      }
      if ("dryRun" in result && result.dryRun) {
        setExecuteNotice(t("apply.dryRunCompleted", { count: result.plannedWrites }));
      } else if ("alreadyAppliedOnly" in result && result.alreadyAppliedOnly) {
        // 没写就不许记成功：executionCompleted 留在原值、这一轮也不进「已应用」账本——
        // 工作流「已完成」那条线与执行按钮都靠它们点亮，这里点亮了就是假话。
        setNothingToWrite(true);
        setExecuteNotice(t("apply.alreadyAppliedOnly"));
      } else {
        setExecutionCompleted(!sandboxTarget);
        // 「已应用 N 项」的 N 取执行器那份落笔清单：verification.total 与操作历史的 appliedLocations
        // 是写入循环里同一个 `if (!itemError)` 攒出来的两份视图，天生同源。
        // 界面不许拿勾选数重算——轮98 的跳过出口让「勾了 2 条、只写 1 条」成为常态，
        // 那时报「已应用 2 项」就和同一轮历史里的「本次写入 1 项」对不上（审计数字只许一个来源）。
        const appliedCount = writeVerificationResult?.total ?? selectedItemIds.length;
        if (skippedBlocked > 0) {
          // 整句走 i18n：以前这里是「t() 结果 + 写死的中文尾巴」，英文界面会漏出「（另有 N 项已阻断，未执行）」（轮6 R54）
          setExecuteNotice(t("apply.executionSucceededWithBlocked", { count: appliedCount, blocked: skippedBlocked }));
        } else {
          setExecuteNotice(t("apply.executionSucceeded", { count: appliedCount }));
        }
      }
      auditSessionEvent(session, {
        kind: "apply_result",
        result: "success",
        step: dryRun ? "execute" : "verify",
        dryRun,
        taskId: result.taskId,
        historyId: resultHistoryId,
        payload: JSON.stringify({
          dryRun,
          verification: writeVerificationResult ?? null,
          plannedWrites: "dryRun" in result ? result.plannedWrites : undefined,
          selectedCount: selectedItemIds.length,
          items: plan.items
            .filter((item) => selectedItemIds.includes(item.id))
            .map((item) => ({
              id: item.id,
              action: item.action,
              dataId: item.ref.dataId,
              group: item.ref.group,
              afterContent: item.afterValue.content ?? null,
              fingerprint: item.afterValue.fingerprint,
            })),
        }),
      });
      endAuditSession(session, "success");
    } catch (error) {
      setExecuteError(errorText(error));
      setExecuteProgress(null);
      setExecuteHistoryId(null);
      setExecuteRecord(null);
      auditSessionEvent(session, {
        kind: "apply_error",
        result: "failure",
        step: dryRun ? "execute" : "verify",
        dryRun,
        error: errorText(error),
        payload: JSON.stringify({
          selectedCount: selectedItemIds.length,
          items: plan.items
            .filter((item) => selectedItemIds.includes(item.id))
            .map((item) => ({
              id: item.id,
              action: item.action,
              dataId: item.ref.dataId,
              group: item.ref.group,
              afterContent: item.afterValue.content ?? null,
            })),
        }),
      });
      endAuditSession(session, "failure", errorText(error));
    } finally {
      setExecutionMode(null);
    }
  };

  return (
    <div className="page-surface data-page apply-view" {...busyProps(draftState.status === "loading")}>
      <div className="page-header">
        <div>
          <h3>{t("apply.title")}</h3>
          <div className="page-subtitle">{entry ? t("apply.subtitle") : t("apply.missingEntry")}</div>
        </div>
        {plan && (
          /* 回退点击只在「返回落点确实是对比页」时给出（轮76）：晋级/回退/审计/备份进来的计划
             没有对比现场可回，按钮点下去落在别的页面，气泡那句「回到「确认方向」（进度保留）」就成了假话。 */
          <DiffWorkflowCard
            currentStep={workflowCurrentStep}
            completed={executionCompleted}
            onStepClick={applyEntryStepsAreNavigable(entry) ? onWorkflowStepClick : undefined}
          />
        )}
        <div className="page-actions">
          <button className="btn btn-ghost" type="button" onClick={() => attemptBack()}>
            {t("apply.back")}
          </button>
        </div>
      </div>

      {!entry && <div className="data-empty-state page-empty">{t("apply.missingEntry")}</div>}

      {entry && draftState.status === "loading" && (
        <div className="pad-msg big apply-draft-loading" role="status">
          {t("apply.generating")}
        </div>
      )}

      {entry && draftState.status === "error" && (
        /* 构建逻辑从 effect 提到 buildDraft 后，「生成失败」也有了第二条出路：
           原地重试，不用退出再进来（R55-A6）。 */
        <InlineError
          title={t("apply.generationFailed")}
          message={draftState.detail}
          copyLabel={t("apply.copyError")}
          onRetry={buildDraft}
        />
      )}

      {plan && (
        <div className="apply-workspace">
          <div className="apply-main-column">
            <div className="apply-plan-summary">
              <div className="data-info-grid">
                <div className="info-row">
                  <span className="info-label">{t("apply.planId")}:</span>
                  <span className="info-value mono">{plan.id}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">{t("apply.createdAt")}:</span>
                  <span className="info-value">{formatDateTime(plan.createdAt)}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">{t("apply.source")}:</span>
                  <span className="info-value">{plan.source.label}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">{t("apply.target")}:</span>
                  <span className="info-value">{plan.target.label}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">{t("apply.scope")}:</span>
                  <span className="info-value">{t(`apply.scopes.${plan.scope}`)}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">{t("apply.selected")}:</span>
                  <span className="info-value">{t("apply.selectedCount", { count: plan.inputSummary.selectedCount })}</span>
                </div>
              </div>
              <PlanLedger plan={plan} />
              <PlanCountStrip plan={plan} />
            </div>

            <div className="apply-workbench">
              <PlanItemList
                plan={plan}
                selectedId={selectedItem?.id ?? ""}
                selectedIds={selectedIds}
                appliedIds={appliedItemIds}
                onSelect={setSelectedId}
                onToggleSelected={toggleSelectedItem}
                onSelectAll={selectAllItems}
                onSelectNone={selectNoItems}
              />
              {selectedItem ? (
                <ItemDetail
                  item={selectedItem}
                  edit={targetEdits[selectedItem.id]}
                  onEditChange={updateTargetEdit}
                  onCommitEdit={commitTargetEdit}
                />
              ) : (
                <div className="data-empty-state detail-empty">{t("apply.noItems")}</div>
              )}
            </div>
            <ConfirmationPanel
              plan={plan}
              selectedCount={selectedCount}
              selectedIds={selectedIds}
              protectedTarget={protectedTarget}
              manualConfirmRequired={manualConfirmRequired}
              confirmed={confirmed}
              confirmationText={confirmationText}
              executionMode={executionMode}
              executeError={executeError}
              executeProgress={executeProgress}
              executeNotice={executeNotice}
              executionTask={executionTask}
              remainingWork={remainingWork}
              appliedCount={appliedItemIds.size}
              dryRunCount={dryRunItemIds.length}
              writeVerification={writeVerification}
              executeHistoryId={executeHistoryId}
              executeRecord={executeRecord}
              alreadyAppliedRefs={alreadyAppliedRefs}
              nothingToWrite={nothingToWrite}
              connections={connections}
              onOpenHistory={onOpenHistory}
              onStartApply={onStartApply}
              onConfirmedChange={setConfirmed}
              onConfirmationTextChange={setConfirmationText}
              onExecute={() => runPlan(false)}
              onDryRun={() => runPlan(true)}
              onSkipFailedItem={skipFailedItemAndContinue}
            />
          </div>
        </div>
      )}
      {askLeaveDuringRun && (
        <ConfirmModal
          danger
          title={t("apply.leaveDuringRunTitle")}
          message={t("apply.leaveDuringRunMessage")}
          confirmLabel={t("apply.leaveDuringRunConfirm")}
          onConfirm={() => {
            setAskLeaveDuringRun(false);
            onBack(pendingBackStepRef.current);
          }}
          onCancel={() => setAskLeaveDuringRun(false)}
        />
      )}
      {askDiscardEdits && (
        <ConfirmModal
          danger
          title={t("apply.discardEditsTitle")}
          message={t("apply.discardEditsMessage", { count: unsavedEditCount })}
          confirmLabel={t("apply.discardEditsConfirm")}
          onConfirm={() => {
            setAskDiscardEdits(false);
            setTargetEdits({});
            onBack(pendingBackStepRef.current);
          }}
          onCancel={() => setAskDiscardEdits(false)}
        />
      )}
    </div>
  );
}
