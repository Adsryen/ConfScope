import { useEffect, useRef, useState } from "react";
import {
  deleteConfigFromApplyPlan,
  deleteConfigRefFromApplyPlan,
  getConfigDocument,
  publishConfigFromApplyPlan,
  publishConfigRefFromApplyPlan,
} from "../api/nacos";
import { createSnapshot, getSnapshot } from "../api/snapshot";
import { useTranslation } from "../i18n";
import type { ApplyPlan, ApplyPlanAction, ApplyPlanItem, ApplyPlanSummary, ApplyPlanValueSnapshot } from "../lib/applyPlan";
import type { ApplyEntryPayload } from "../lib/applyEntry";
import { buildApplyPlanFromEntry } from "../lib/applyPlanDraft";
import { applyConfirmationText, executeApplyPlan, isProtectedApplyTarget } from "../lib/applyPlanExecution";
import { getTaskManager, type Task, type TaskStatus } from "../lib/taskmanager";
import { recordOperation } from "../store/operationHistory";
import { createAuditSession, auditSessionEvent, endAuditSession } from "../lib/auditSessionLog";
import { saveApplyPlan } from "../store/applyPlans";
import type { Connection } from "../store/connections";
import CopyButton from "./CopyButton";
import DiffPanel from "./DiffPanel";
import DiffWorkflowCard, { type WorkflowStepId } from "./DiffWorkflowCard";

interface Props {
  entry: ApplyEntryPayload | null;
  connections: Connection[];
  onBack: () => void;
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
    sourceRef: item.sourceRef ? { namespace: item.sourceRef.namespace, group: item.sourceRef.group, dataId: item.sourceRef.dataId, key: item.sourceRef.key } : null,
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
      <strong>{plan.source.label}</strong>
      <span>{t("apply.ledger.dryRun")}</span>
      <strong>{plan.id}</strong>
      <span>{t("apply.ledger.target")}</span>
      <strong>{plan.target.label}</strong>
    </div>
  );
}

function PlanItemList({
  plan,
  selectedId,
  selectedIds,
  onSelect,
  onToggleSelected,
  onSelectAll,
  onSelectNone,
}: {
  plan: ApplyPlan;
  selectedId: string;
  selectedIds: Set<string>;
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
        const selectable = isSelectableApplyItem(item);
        const checked = selectedIds.has(item.id);
        return (
          <label
            key={item.id}
            className={`apply-item-row${item.id === selectedId ? " selected" : ""}${item.blocked ? " blocked" : ""}${checked ? " checked" : ""}`}
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
              <span className="mono">{item.ref.dataId}</span>
              <span className="apply-item-key mono">{item.ref.key}</span>
            </span>
            <span className={`apply-action apply-action-${item.action}`}>{actionLabel(t, item.action)}</span>
            {item.blocked && <span className="apply-blocked">{t("apply.blocked")}</span>}
          </label>
        );
      })}
    </div>
  );
}

function ItemDetail({ item }: { item: ApplyPlanItem }) {
  const { t } = useTranslation();
  const missingLabel = t("apply.valueMissing");
  const diffFormat = item.afterValue.format ?? item.sourceValue.format ?? item.targetValue.format ?? "TEXT";
  const hasFatalParseError =
    item.sourceValue.parseStatus === "error" || item.targetValue.parseStatus === "error";
  // parseError 现在兼作 warning（如 YAML duplicate key）：fatal 解析失败红色展示；
  // 非 fatal 的 warning（后值覆盖类）用黄色提示，不再完全隐藏。
  const parseErrors = hasFatalParseError
    ? [item.sourceValue.parseError, item.targetValue.parseError, item.afterValue.parseError].filter(
        (error): error is string => Boolean(error)
      )
    : [];
  const parseWarnings = hasFatalParseError
    ? []
    : [item.sourceValue.parseError, item.targetValue.parseError, item.afterValue.parseError].filter(
        (error): error is string => Boolean(error)
      );
  return (
    <div className="apply-detail">
      <div className="apply-detail-head">
        <div>
          <div className="apply-detail-title mono">{item.ref.dataId}</div>
          <div className="apply-detail-sub mono">
            {item.ref.group} / {item.ref.key}
          </div>
        </div>
        <span className={`apply-action apply-action-${item.action}`}>{actionLabel(t, item.action)}</span>
      </div>
      <div className="apply-detail-meta">
        <span>{t("apply.actionLine", { action: item.action })}</span>
        {item.blockReason && <span>{t("apply.blockReasonLine", { reason: item.blockReason })}</span>}
      </div>
      <div className="apply-diff-preview">
        <DiffPanel
          leftLabel={t("apply.targetValue")}
          rightLabel={t("apply.afterValue")}
          leftText={valueText(item.targetValue, missingLabel)}
          rightText={valueText(item.afterValue, missingLabel)}
          format={diffFormat}
          hideOnlyChangesToggle
        />
      </div>
      {parseErrors.map((error, index) => (
        <div className="apply-parse-error" key={`${item.id}-parse-error-${index}`}>
          {error}
        </div>
      ))}
      {parseWarnings.map((warning, index) => (
        <div className="apply-parse-warning" key={`${item.id}-parse-warning-${index}`}>
          {"\u26A0"} {warning}
        </div>
      ))}
    </div>
  );
}

function ConfirmationPanel({
  plan,
  selectedCount,
  selectedIds,
  protectedTarget,
  confirmed,
  confirmationText,
  executionMode,
  executeError,
  executeNotice,
  executionTask,
  executionSucceeded,
  onConfirmedChange,
  onConfirmationTextChange,
  onExecute,
  onDryRun,
}: {
  plan: ApplyPlan;
  selectedCount: number;
  selectedIds: Set<string>;
  protectedTarget: boolean;
  confirmed: boolean;
  confirmationText: string;
  executionMode: ExecutionMode | null;
  executeError: string | null;
  executeNotice: string | null;
  executionTask: Task | null;
  executionSucceeded: boolean;
  onConfirmedChange: (value: boolean) => void;
  onConfirmationTextChange: (value: string) => void;
  onExecute: () => void;
  onDryRun: () => void;
}) {
  const { t } = useTranslation();
  const requiredText = applyConfirmationText(plan);
  const ready = protectedTarget ? confirmationText === requiredText : confirmed;
  const anyRunning = executionMode !== null;
  const dryRunDisabled = anyRunning || executionSucceeded || selectedCount === 0;
  // 执行守卫基于「已勾选且可执行」的项：存在 blocked 项本身不再全局禁用按钮，
  // 用户可取消勾选阻断项后执行其余项（执行层 runPlan 仍会兜底过滤 blocked/parse_error/skip）。
  const selectedHasBlocked = plan.items.some((item) => selectedIds.has(item.id) && !isSelectableApplyItem(item));
  const executeDisabled = !ready || anyRunning || executionSucceeded || selectedCount === 0 || selectedHasBlocked;
  const executeLabel =
    executionMode === "apply"
      ? t("apply.executing")
      : selectedCount === plan.items.length
        ? t("apply.execute")
        : t("apply.executeSelected", { count: selectedCount });
  const dryRunLabel =
    executionMode === "dry-run"
      ? t("apply.dryRunExecuting")
      : selectedCount === plan.items.length
        ? t("apply.dryRun")
        : t("apply.dryRunSelected", { count: selectedCount });

  return (
    <div className="apply-confirmation" aria-label={t("apply.confirmationLabel")}>
      <div className="apply-confirmation-head">
        <h4>{t("apply.confirmationTitle")}</h4>
        <span>{protectedTarget ? t("apply.protectedNotice") : t("apply.normalNotice")}</span>
      </div>
      <div className="apply-selection-note">{t("apply.selectionCount", { count: selectedCount })}</div>
      {protectedTarget ? (
        <div className="field">
          <label className="field-label" htmlFor="apply-confirmation-text">
            {t("apply.confirmationTextLabel")}
          </label>
          <div className="field-hint">{t("apply.protectedInstruction")}</div>
          <code className="apply-confirmation-code">{requiredText}</code>
          <input
            id="apply-confirmation-text"
            className="search-input wide mono"
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
        <button className="btn btn-ghost" type="button" disabled={dryRunDisabled} onClick={onDryRun}>
          {dryRunLabel}
        </button>
        <button className="btn btn-primary" type="button" disabled={executeDisabled} onClick={onExecute}>
          {executeLabel}
        </button>
      </div>
      {executeNotice && <div className="apply-execution-notice">{executeNotice}</div>}
      {executionTask && (
        <div className="apply-task-progress" aria-label={t("apply.taskProgressLabel")}>
          <div className="apply-task-progress-head">
            <strong>{t("apply.taskProgressTitle")}</strong>
            <span className={`task-status task-status-${executionTask.status}`}>
              {taskStatusLabel(t, executionTask.status)}
            </span>
          </div>
          <div className="progress-bar large">
            <div className="progress-fill" style={{ width: `${executionTask.progress}%` }} />
          </div>
          <div className="apply-task-progress-meta">
            <span>{t("apply.taskProgressStats", { completed: executionTask.completed, total: executionTask.total })}</span>
            <span>{t("apply.taskProgressPercent", { progress: executionTask.progress })}</span>
          </div>
          <div className="apply-task-progress-id">
            <span>{t("tasks.taskId")}: <span className="mono">{executionTask.id}</span></span>
            <CopyButton text={executionTask.id} label={t("apply.copyTaskId")} />
          </div>
          {executionTask.error && <pre className="apply-task-progress-error">{executionTask.error}</pre>}
        </div>
      )}
      {executeError && (
        <div className="inline-error" role="alert">
          <div className="inline-error-head">
            <span className="inline-error-title">{t("apply.executionFailed")}</span>
            <div className="inline-error-actions">
              <CopyButton text={executeError} label={t("apply.copyError")} />
            </div>
          </div>
          <pre className="inline-error-body">{executeError}</pre>
        </div>
      )}
    </div>
  );
}

export default function ApplyPlanView({ entry, connections, onBack }: Props) {
  const { t } = useTranslation();
  const [draftState, setDraftState] = useState<DraftState>({ status: "idle" });
  const [selectedId, setSelectedId] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmed, setConfirmed] = useState(false);
  const [confirmationText, setConfirmationText] = useState("");
  const [executionMode, setExecutionMode] = useState<ExecutionMode | null>(null);
  const [lastExecutionMode, setLastExecutionMode] = useState<ExecutionMode | null>(null);
  const [executionCompleted, setExecutionCompleted] = useState(false);
  const [executionSucceeded, setExecutionSucceeded] = useState(false);
  const [executionTask, setExecutionTask] = useState<Task | null>(null);
  const [executeError, setExecuteError] = useState<string | null>(null);
  const [executeNotice, setExecuteNotice] = useState<string | null>(null);
  const [workflowDetailStep, setWorkflowDetailStep] = useState<WorkflowStepId | null>(null);
  const taskManager = getTaskManager();
  const trackedTaskIdRef = useRef<string | null>(null);
  // 变更会话 id：进入计划时创建，整个组件生命周期内五步事件共用
  const applySessionRef = useRef<string | null>(null);
  // 进入计划时的 apply_session_start 事件会话 id（runPlan 复用；
  // 不用 createAuditSession 的返回值是因为事件需写入会话列表供审计日志页展示）
  const applyEntrySessionRef = useRef<string | null>(null);

  useEffect(() => {
    const unsubscribe = taskManager.onTaskUpdate((task) => {
      if (task.id === trackedTaskIdRef.current) setExecutionTask(task);
    });
    return () => unsubscribe?.();
  }, [taskManager]);

  useEffect(() => {
    setConfirmed(false);
    setConfirmationText("");
    setExecutionMode(null);
    setLastExecutionMode(null);
    setExecutionCompleted(false);
    setExecutionSucceeded(false);
    setExecutionTask(null);
    trackedTaskIdRef.current = null;
    setExecuteError(null);
    setExecuteNotice(null);
    setWorkflowDetailStep(null);
    if (!entry) {
      setDraftState({ status: "idle" });
      setSelectedId("");
      setSelectedIds(new Set());
      return;
    }

    let alive = true;
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
        if (!alive) return;
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
            source: { label: result.plan.source?.label, connectionId: result.plan.source?.connectionId, namespace: result.plan.source?.namespace },
            target: { label: result.plan.target?.label, connectionId: result.plan.target?.connectionId, namespace: result.plan.target?.namespace },
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
        if (!alive) return;
        setDraftState({ status: "error", detail: error instanceof Error ? error.message : String(error) });
      });

    return () => {
      alive = false;
    };
  }, [connections, entry]);

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
  const sandboxTarget = plan ? isSandboxTarget(targetConnection, plan) : false;
  const selectedCount = selectedIds.size;
  const workflowCurrentStep: WorkflowStepId = lastExecutionMode === "apply" ? "verify" : "execute";

  const selectAllItems = () => {
    if (!plan) return;
    setSelectedIds(defaultSelectedItemIds(plan));
  };

  const selectNoItems = () => setSelectedIds(new Set());

  const toggleSelectedItem = (id: string) => {
    if (!plan) return;
    const item = plan.items.find((candidate) => candidate.id === id);
    if (!item || !isSelectableApplyItem(item)) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runPlan = async (dryRun: boolean) => {
    if (!plan || executionMode) return;
    // 始终过滤 blocked/parse_error/skip 项：勾选框禁用只是 UI 层守卫，
    // 这里是执行层兜底，避免任何来源（含旧计划数据）把阻断项写入目标。
    const selectedItemIds = Array.from(selectedIds).filter((id) => {
      const item = plan.items.find((candidate) => candidate.id === id);
      return item ? isSelectableApplyItem(item) : false;
    });
    if (selectedItemIds.length === 0) {
      setExecuteNotice(null);
      setExecuteError(t("apply.noSelectedItems"));
      return;
    }
    // 计划里被阻断（parse_error 等）的项数，用于执行完成提示里告知用户
    const skippedBlocked = plan.items.filter((item) => !isSelectableApplyItem(item)).length;
    setExecutionMode(dryRun ? "dry-run" : "apply");
    setLastExecutionMode(dryRun ? "dry-run" : "apply");
    if (!dryRun) {
      setExecutionCompleted(false);
      setExecutionSucceeded(false);
    }
    setExecutionTask(null);
    trackedTaskIdRef.current = null;
    setExecuteError(null);
    setExecuteNotice(null);
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
                provider: "nacos",
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
        },
        {
          selectedItemIds,
          onTaskCreated: (taskId) => {
            trackedTaskIdRef.current = taskId;
            setExecutionTask(taskManager.getTask(taskId) ?? null);
          },
          ...(dryRun ? { dryRun: true } : {}),
          onItemResult: (r) => {
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
      const resultHistoryId = "historyId" in result ? result.historyId : undefined;
      if (result.taskId) {
        trackedTaskIdRef.current = result.taskId;
        setExecutionTask(taskManager.getTask(result.taskId) ?? null);
      }
      if (!result.ok) {
        setExecuteError(result.error);
        auditSessionEvent(session, { kind: "apply_error", result: "failure", taskId: result.taskId, historyId: resultHistoryId, error: result.error });
        endAuditSession(session, "failure", result.error);
        return;
      }
      if ("dryRun" in result && result.dryRun) {
        setExecuteNotice(t("apply.dryRunCompleted", { count: result.plannedWrites }));
      } else {
        setExecutionCompleted(!sandboxTarget);
        setExecutionSucceeded(true);
        if (skippedBlocked > 0) {
          setExecuteNotice(`${t("apply.executionSucceeded", { count: selectedItemIds.length })}（另有 ${skippedBlocked} 项已阻断，未执行）`);
        } else {
          setExecuteNotice(t("apply.executionSucceeded", { count: selectedItemIds.length }));
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
      setExecuteError(error instanceof Error ? error.message : String(error));
      auditSessionEvent(session, {
        kind: "apply_error",
        result: "failure",
        step: dryRun ? "execute" : "verify",
        dryRun,
        error: error instanceof Error ? error.message : String(error),
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
      endAuditSession(session, "failure", error instanceof Error ? error.message : String(error));
    } finally {
      setExecutionMode(null);
    }
  };

  return (
    <div className="page-surface data-page apply-view">
      <div className="page-header">
        <div>
          <h3>{t("apply.title")}</h3>
          <div className="page-subtitle">{entry ? t("apply.subtitle") : t("apply.missingEntry")}</div>
        </div>
        <div className="page-actions">
          <button className="btn btn-ghost" type="button" onClick={onBack}>
            {t("apply.back")}
          </button>
        </div>
      </div>

      {!entry && <div className="data-empty-state page-empty">{t("apply.missingEntry")}</div>}

      {entry && draftState.status === "loading" && <div className="pad-msg big apply-draft-loading" role="status">{t("apply.generating")}</div>}

      {entry && draftState.status === "error" && (
        <div className="inline-error" role="alert">
          <div className="inline-error-head">
            <span className="inline-error-title">{t("apply.generationFailed")}</span>
            <div className="inline-error-actions">
              <CopyButton text={draftState.detail} label={t("apply.copyError")} />
            </div>
          </div>
          <pre className="inline-error-body">{draftState.detail}</pre>
        </div>
      )}

      {plan && (
        <div className="apply-workspace">
          <DiffWorkflowCard
            currentStep={workflowCurrentStep}
            completed={executionCompleted}
            detailStep={workflowDetailStep}
            onDetailStepChange={setWorkflowDetailStep}
          />
          <div className="apply-main-column">
            <div className="apply-plan-summary">
              <div className="data-info-grid">
                <div className="info-row">
                  <span className="info-label">{t("apply.planId")}:</span>
                  <span className="info-value mono">{plan.id}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">{t("apply.createdAt")}:</span>
                  <span className="info-value">{plan.createdAt}</span>
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
                onSelect={setSelectedId}
                onToggleSelected={toggleSelectedItem}
                onSelectAll={selectAllItems}
                onSelectNone={selectNoItems}
              />
              {selectedItem ? (
                <ItemDetail item={selectedItem} />
              ) : (
                <div className="data-empty-state detail-empty">{t("apply.noItems")}</div>
              )}
            </div>
            <ConfirmationPanel
              plan={plan}
              selectedCount={selectedCount}
              selectedIds={selectedIds}
              protectedTarget={protectedTarget}
              confirmed={confirmed}
              confirmationText={confirmationText}
              executionMode={executionMode}
              executeError={executeError}
              executeNotice={executeNotice}
              executionTask={executionTask}
              executionSucceeded={executionSucceeded}
              onConfirmedChange={setConfirmed}
              onConfirmationTextChange={setConfirmationText}
              onExecute={() => runPlan(false)}
              onDryRun={() => runPlan(true)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
