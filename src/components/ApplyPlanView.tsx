import { useEffect, useState } from "react";
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
import { getTaskManager } from "../lib/taskmanager";
import { recordOperation } from "../store/operationHistory";
import { saveApplyPlan } from "../store/applyPlans";
import type { Connection } from "../store/connections";
import CopyButton from "./CopyButton";
import DiffPanel from "./DiffPanel";

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

function ValueBlock({ title, value }: { title: string; value: ApplyPlanValueSnapshot }) {
  const { t } = useTranslation();
  return (
    <div className="apply-value-block">
      <div className="apply-value-title">{title}</div>
      <pre>{valueText(value, t("apply.valueMissing"))}</pre>
      {value.parseError && <div className="apply-parse-error">{value.parseError}</div>}
    </div>
  );
}

function ItemDetail({ item }: { item: ApplyPlanItem }) {
  const { t } = useTranslation();
  const missingLabel = t("apply.valueMissing");
  const diffFormat = item.afterValue.format ?? item.sourceValue.format ?? item.targetValue.format ?? "TEXT";
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
      <div className="apply-value-grid">
        <ValueBlock title={t("apply.sourceValue")} value={item.sourceValue} />
        <ValueBlock title={t("apply.targetValue")} value={item.targetValue} />
        <ValueBlock title={t("apply.afterValue")} value={item.afterValue} />
      </div>
    </div>
  );
}

function ConfirmationPanel({
  plan,
  selectedCount,
  protectedTarget,
  confirmed,
  confirmationText,
  executionMode,
  executeError,
  executeNotice,
  onConfirmedChange,
  onConfirmationTextChange,
  onExecute,
  onDryRun,
}: {
  plan: ApplyPlan;
  selectedCount: number;
  protectedTarget: boolean;
  confirmed: boolean;
  confirmationText: string;
  executionMode: ExecutionMode | null;
  executeError: string | null;
  executeNotice: string | null;
  onConfirmedChange: (value: boolean) => void;
  onConfirmationTextChange: (value: string) => void;
  onExecute: () => void;
  onDryRun: () => void;
}) {
  const { t } = useTranslation();
  const requiredText = applyConfirmationText(plan);
  const ready = protectedTarget ? confirmationText === requiredText : confirmed;
  const anyRunning = executionMode !== null;
  const dryRunDisabled = anyRunning || selectedCount === 0;
  const executeDisabled = !ready || anyRunning || plan.summary.blocked > 0 || selectedCount === 0;
  const executeLabel = executionMode === "apply"
    ? t("apply.executing")
    : selectedCount === plan.items.length
      ? t("apply.execute")
      : t("apply.executeSelected", { count: selectedCount });
  const dryRunLabel = executionMode === "dry-run"
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
  const [executeError, setExecuteError] = useState<string | null>(null);
  const [executeNotice, setExecuteNotice] = useState<string | null>(null);

  useEffect(() => {
    setConfirmed(false);
    setConfirmationText("");
    setExecutionMode(null);
    setExecuteError(null);
    setExecuteNotice(null);
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
        setDraftState({ status: "ready", plan: savedPlan, sourceConnection: result.sourceConnection, targetConnection: result.targetConnection });
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

  const plan = draftState.status === "ready" ? draftState.plan : null;
  const sourceConnection = draftState.status === "ready" ? draftState.sourceConnection : null;
  const targetConnection = draftState.status === "ready" ? draftState.targetConnection : null;
  const selectedItem = plan?.items.find((item) => item.id === selectedId) ?? plan?.items[0] ?? null;
  const protectedTarget = plan ? isProtectedApplyTarget(targetConnection, plan.target) : false;
  const selectedCount = selectedIds.size;

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
    const selectedItemIds = Array.from(selectedIds);
    if (selectedItemIds.length === 0) {
      setExecuteNotice(null);
      setExecuteError(t("apply.noSelectedItems"));
      return;
    }
    setExecutionMode(dryRun ? "dry-run" : "apply");
    setExecuteError(null);
    setExecuteNotice(null);
    try {
      const result = await executeApplyPlan(
        plan,
        {
          connections:
            sourceConnection && targetConnection
              ? applyExecutionConnections(connections, sourceConnection, targetConnection)
              : connections,
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
          taskManager: getTaskManager(),
        },
        {
          selectedItemIds,
          ...(dryRun ? { dryRun: true } : {}),
        }
      );
      if (!result.ok) {
        setExecuteError(result.error);
        return;
      }
      if ("dryRun" in result && result.dryRun) {
        setExecuteNotice(t("apply.dryRunCompleted", { count: result.plannedWrites }));
      } else {
        setExecuteNotice(t("apply.executionSucceeded", { count: selectedItemIds.length }));
      }
    } catch (error) {
      setExecuteError(error instanceof Error ? error.message : String(error));
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

      {entry && draftState.status === "loading" && <div className="pad-msg big">{t("apply.generating")}</div>}

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
        <>
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
            {selectedItem ? <ItemDetail item={selectedItem} /> : <div className="data-empty-state detail-empty">{t("apply.noItems")}</div>}
          </div>
          <ConfirmationPanel
            plan={plan}
            selectedCount={selectedCount}
            protectedTarget={protectedTarget}
            confirmed={confirmed}
            confirmationText={confirmationText}
            executionMode={executionMode}
            executeError={executeError}
            executeNotice={executeNotice}
            onConfirmedChange={setConfirmed}
            onConfirmationTextChange={setConfirmationText}
            onExecute={() => runPlan(false)}
            onDryRun={() => runPlan(true)}
          />
        </>
      )}
    </div>
  );
}
