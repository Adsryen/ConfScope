// 操作历史页面：展示配置中心的操作记录和本地执行的操作。
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "../i18n";
import { Connection } from "../store/connections";
import { reportError } from "../lib/errorCenter";
import { toast } from "../lib/toast";
import type { ApplyEntryPayload } from "../lib/applyEntry";
import { buildPromotionEntryFromVerification, buildRollbackEntryFromApplyRecord, fingerprintsForCurrentPlanTargets } from "../lib/applyFollowup";
import {
  loadOperationHistory,
  filterOperationHistory,
  isRollbackableOperation,
  rollbackUnavailableReason,
  type OperationRecord,
  type OperationType,
} from "../store/operationHistory";
import { getApplyPlan } from "../store/applyPlans";
import {
  loadApplyVerifications,
  saveApplyVerification,
  type ApplyVerification,
} from "../store/applyVerifications";
import { getConfigDocument, listHistory } from "../api/nacos";
import { getSnapshot } from "../api/snapshot";
import CopyButton from "./CopyButton";

interface Props {
  connections: Connection[];
  onStartApply?: (payload: ApplyEntryPayload) => void;
}

const OPERATION_LABELS: Record<OperationType, string> = {
  publish: "operationHistory.opPublish",
  delete: "operationHistory.opDelete",
  rollback: "operationHistory.opRollback",
  snapshot: "operationHistory.opSnapshot",
  snapshot_delete: "operationHistory.opSnapshotDelete",
  snapshot_compare: "operationHistory.opSnapshotCompare",
  export: "operationHistory.opExport",
  apply: "operationHistory.opApply",
  promote: "operationHistory.opPromote",
  restore: "operationHistory.opRestore",
};

const RESULT_LABELS: Record<string, string> = {
  success: "operationHistory.resultSuccess",
  failure: "operationHistory.resultFailure",
};

interface FollowupError {
  recordId: string;
  detail: string;
}

function isApplyFollowupRecord(record: OperationRecord): boolean {
  return record.result === "success" && (record.type === "apply" || record.type === "promote" || record.type === "restore");
}

function findVerification(verifications: ApplyVerification[], record: OperationRecord): ApplyVerification | null {
  if (!record.planId) return null;
  return verifications.find((verification) => verification.planId === record.planId && verification.applyHistoryId === record.id) ?? null;
}

export default function OperationHistoryView({ connections, onStartApply }: Props) {
  const { t } = useTranslation();

  // 本地操作记录
  const [localRecords, setLocalRecords] = useState<OperationRecord[]>([]);
  // 配置中心历史
  const [centerRecords, setCenterRecords] = useState<OperationRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 筛选条件
  const [filterConnection, setFilterConnection] = useState<string>("");
  const [filterType, setFilterType] = useState<OperationType | "">("");
  const [filterDataId, setFilterDataId] = useState("");
  const [selectedRecord, setSelectedRecord] = useState<OperationRecord | null>(null);
  const [verifications, setVerifications] = useState<ApplyVerification[]>(() => loadApplyVerifications());
  const [followupBusy, setFollowupBusy] = useState<string | null>(null);
  const [followupError, setFollowupError] = useState<FollowupError | null>(null);
  const [promotionTargets, setPromotionTargets] = useState<Record<string, string>>({});

  // 加载本地记录
  useEffect(() => {
    setLocalRecords(loadOperationHistory());
  }, []);

  // 从配置中心拉取历史（选择连接时触发）
  const fetchCenterHistory = useCallback(
    async (connId: string) => {
      const conn = connections.find((c) => c.id === connId);
      if (!conn) return;

      setLoading(true);
      setError(null);
      try {
        const records: OperationRecord[] = [];
        const namespaces = [conn.defaultNamespace || ""];
        for (const ns of namespaces) {
          try {
            const history = await listHistory(conn, ns, "", "", 1, 50);
            for (const item of history.pageItems || []) {
              records.push({
                id: item.id?.toString() || `${Date.now()}`,
                type: "publish",
                result: "success",
                timestamp: item.lastModifiedTime || new Date().toISOString(),
                connectionId: conn.id,
                connectionName: conn.name,
                namespace: ns || "public",
                group: item.group || "DEFAULT_GROUP",
                dataId: item.dataId || "",
              });
            }
          } catch {
            // 单个命名空间失败不影响整体
          }
        }
        setCenterRecords((prev) => [...prev, ...records]);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [connections]
  );

  // 合并并筛选记录
  const allRecords = useMemo(() => {
    const combined = [...localRecords, ...centerRecords];
    combined.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return filterOperationHistory(combined, {
      connectionId: filterConnection || undefined,
      type: filterType || undefined,
      dataId: filterDataId || undefined,
    });
  }, [localRecords, centerRecords, filterConnection, filterType, filterDataId]);

  const selectedVisibleRecord = selectedRecord && allRecords.some((record) => record.id === selectedRecord.id) ? selectedRecord : null;
  const failedCount = allRecords.filter((record) => record.result === "failure").length;
  const sourceCount = new Set(allRecords.map((record) => record.connectionId)).size;

  // 格式化时间
  const setRecordFollowupError = (record: OperationRecord, detail: string) => {
    setFollowupError({ recordId: record.id, detail });
  };

  const startRollbackDryRun = async (record: OperationRecord) => {
    if (!onStartApply) return;
    const busyKey = `rollback:${record.id}`;
    setFollowupBusy(busyKey);
    setFollowupError(null);
    try {
      const result = await buildRollbackEntryFromApplyRecord(record, {
        connections,
        getApplyPlan,
        getSnapshot,
        getConfigDocument,
      });
      if (!result.ok) {
        setRecordFollowupError(record, result.detail);
        return;
      }
      onStartApply(result.entry);
    } catch (e) {
      const message = String(e);
      setRecordFollowupError(record, message);
      reportError({ title: t("operationHistory.followupFailed"), source: record.dataId, message, detail: message });
    } finally {
      setFollowupBusy(null);
    }
  };

  const markSandboxVerified = async (record: OperationRecord) => {
    const busyKey = `verify:${record.id}`;
    setFollowupBusy(busyKey);
    setFollowupError(null);
    try {
      if (!record.planId) {
        setRecordFollowupError(record, `Apply record ${record.id} is missing planId.`);
        return;
      }
      const plan = getApplyPlan(record.planId);
      if (!plan) {
        setRecordFollowupError(record, `Apply plan ${record.planId} is missing.`);
        return;
      }
      const sandboxConnectionId = record.targetConnectionId || plan.target.connectionId || record.connectionId;
      const sandboxConnection = connections.find((conn) => conn.id === sandboxConnectionId);
      if (!sandboxConnection) {
        setRecordFollowupError(record, `Sandbox connection ${sandboxConnectionId} is missing.`);
        return;
      }
      const verification = saveApplyVerification({
        planId: plan.id,
        applyHistoryId: record.id,
        sandboxConnectionId: sandboxConnection.id,
        sandboxConnectionName: sandboxConnection.name,
        sandboxNamespace: record.targetNamespace ?? plan.target.namespace ?? record.namespace,
        verifiedTargetFingerprints: await fingerprintsForCurrentPlanTargets(plan, sandboxConnection, { getConfigDocument }),
      });
      setVerifications(loadApplyVerifications());
      toast(t("operationHistory.sandboxVerified"), "success");
      setPromotionTargets((current) => {
        const candidates = connections.filter((conn) => conn.id !== verification.sandboxConnectionId);
        return current[record.id] || candidates.length === 0 ? current : { ...current, [record.id]: candidates[0].id };
      });
    } catch (e) {
      const message = String(e);
      setRecordFollowupError(record, message);
      reportError({ title: t("operationHistory.followupFailed"), source: record.dataId, message, detail: message });
    } finally {
      setFollowupBusy(null);
    }
  };

  const productionTargetsFor = (record: OperationRecord, verification: ApplyVerification | null): Connection[] => {
    const sandboxConnectionId = verification?.sandboxConnectionId || record.targetConnectionId || record.connectionId;
    return connections.filter((conn) => conn.id !== sandboxConnectionId);
  };

  const selectedPromotionTargetId = (record: OperationRecord, verification: ApplyVerification | null): string => {
    const candidates = productionTargetsFor(record, verification);
    const selected = promotionTargets[record.id];
    return selected && candidates.some((conn) => conn.id === selected) ? selected : candidates[0]?.id ?? "";
  };

  const startPromotionDryRun = async (record: OperationRecord) => {
    if (!onStartApply) return;
    const verification = findVerification(verifications, record);
    if (!verification) {
      setRecordFollowupError(record, `Apply record ${record.id} has no sandbox verification.`);
      return;
    }
    const targetId = selectedPromotionTargetId(record, verification);
    const productionTarget = connections.find((conn) => conn.id === targetId);
    if (!productionTarget) {
      setRecordFollowupError(record, t("operationHistory.noProductionTarget"));
      return;
    }

    const busyKey = `promote:${record.id}`;
    setFollowupBusy(busyKey);
    setFollowupError(null);
    try {
      const result = await buildPromotionEntryFromVerification(record, verification, productionTarget, {
        connections,
        getApplyPlan,
        getSnapshot,
        getConfigDocument,
      });
      if (!result.ok) {
        setRecordFollowupError(record, result.detail);
        return;
      }
      onStartApply(result.entry);
    } catch (e) {
      const message = String(e);
      setRecordFollowupError(record, message);
      reportError({ title: t("operationHistory.followupFailed"), source: record.dataId, message, detail: message });
    } finally {
      setFollowupBusy(null);
    }
  };

  const formatTime = (timestamp: string) => {
    try {
      return new Date(timestamp).toLocaleString();
    } catch {
      return timestamp;
    }
  };

  const formatPlanSummary = (record: OperationRecord) => {
    const summary = record.planSummary;
    if (!summary) return "";
    return t("operationHistory.planSummaryText", {
      total: summary.total,
      create: summary.create,
      overwrite: summary.overwrite,
      delete: summary.delete,
      skip: summary.skip,
      blocked: summary.blocked,
    });
  };

  const formatBackupSnapshot = (record: OperationRecord) => {
    if (record.backupSnapshotName && record.backupSnapshotId) return `${record.backupSnapshotName} (${record.backupSnapshotId})`;
    return record.backupSnapshotName || record.backupSnapshotId || "";
  };

  const formatApplyDirection = (record: OperationRecord) => {
    const source = record.sourceConnectionName || record.planSummary?.sourceLabel || record.sourceConnectionId || "";
    const target = record.targetConnectionName || record.planSummary?.targetLabel || record.targetConnectionId || "";
    return source && target ? `${source} -> ${target}` : "";
  };

  return (
    <div className="page-surface data-page history-page">
      <div className="page-header">
        <div>
          <h3>{t("app.history")}</h3>
          <div className="page-subtitle">
            {allRecords.length > 0 ? t("operationHistory.recordCount", { count: allRecords.length }) : t("operationHistory.noRecords")}
          </div>
        </div>
        <div className="page-actions data-summary">
          <span className="data-pill">{t("operationHistory.sourceCount", { count: sourceCount })}</span>
          <span className={`data-pill${failedCount > 0 ? " danger" : ""}`}>
            {t("operationHistory.failedCount", { count: failedCount })}
          </span>
        </div>
      </div>

      {/* 筛选条件（一行内） */}
      <div className="data-toolbar history-filters">
        <select
          className="history-filter-select"
          value={filterConnection}
          onChange={(e) => {
            const connId = e.target.value;
            setFilterConnection(connId);
            if (connId) fetchCenterHistory(connId);
          }}
        >
          <option value="">{t("operationHistory.allConnections")}</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select className="history-filter-select" value={filterType} onChange={(e) => setFilterType(e.target.value as OperationType | "")}>
          <option value="">{t("operationHistory.allTypes")}</option>
          <option value="publish">{t("operationHistory.opPublish")}</option>
          <option value="delete">{t("operationHistory.opDelete")}</option>
          <option value="rollback">{t("operationHistory.opRollback")}</option>
          <option value="snapshot">{t("operationHistory.opSnapshot")}</option>
          <option value="snapshot_delete">{t("operationHistory.opSnapshotDelete")}</option>
          <option value="snapshot_compare">{t("operationHistory.opSnapshotCompare")}</option>
          <option value="export">{t("operationHistory.opExport")}</option>
          <option value="apply">{t("operationHistory.opApply")}</option>
          <option value="promote">{t("operationHistory.opPromote")}</option>
          <option value="restore">{t("operationHistory.opRestore")}</option>
        </select>
        <input
          className="history-filter-input"
          placeholder={t("operationHistory.dataIdPlaceholder")}
          value={filterDataId}
          onChange={(e) => setFilterDataId(e.target.value)}
        />
      </div>

      {error && (
        <div className="inline-error" role="alert">
          <div className="inline-error-head">
            <span className="inline-error-title">{t("operationHistory.loadFailed")}</span>
            <CopyButton text={error} label={t("common.copyError")} />
          </div>
          <pre className="inline-error-body">{error}</pre>
        </div>
      )}
      {loading && <div className="history-loading">{t("common.loading")}</div>}

      {/* 操作列表 */}
      <div className="data-split history-content">
        <div className="data-list history-list">
          {allRecords.length === 0 ? (
            <div className="data-empty-state">
              <div>{t("operationHistory.noRecords")}</div>
              <span>{t("operationHistory.emptyHint")}</span>
            </div>
          ) : (
            allRecords.map((record) => (
              <button
                key={record.id}
                className={`data-list-item history-item ${selectedVisibleRecord?.id === record.id ? "active" : ""}`}
                onClick={() => setSelectedRecord(selectedVisibleRecord?.id === record.id ? null : record)}
              >
                <span className={`data-item-accent ${record.result === "failure" ? "danger" : record.type}`} />
                <div className="history-item-head">
                  <span className={`history-type ${record.type}`}>{t(OPERATION_LABELS[record.type])}</span>
                  <span className={`history-result ${record.result}`}>{t(RESULT_LABELS[record.result])}</span>
                  <span className="history-time">{formatTime(record.timestamp)}</span>
                </div>
                <div className="history-dataid">{record.dataId}</div>
                <div className="history-item-meta">
                  <span>{record.connectionName}</span>
                  <span>
                    {record.namespace}/{record.group}
                  </span>
                </div>
              </button>
            ))
          )}
        </div>

        <div className="data-detail history-detail-panel">
          {selectedVisibleRecord ? (
            <>
              {(() => {
                const rollbackable = isRollbackableOperation(selectedVisibleRecord);
                const rollbackReason = rollbackUnavailableReason(selectedVisibleRecord);
                const followupRecord = isApplyFollowupRecord(selectedVisibleRecord);
                const verification = findVerification(verifications, selectedVisibleRecord);
                const productionTargets = productionTargetsFor(selectedVisibleRecord, verification);
                const promotionTargetId = selectedPromotionTargetId(selectedVisibleRecord, verification);
                const rollbackBusy = followupBusy === `rollback:${selectedVisibleRecord.id}`;
                const verifyBusy = followupBusy === `verify:${selectedVisibleRecord.id}`;
                const promoteBusy = followupBusy === `promote:${selectedVisibleRecord.id}`;
                const visibleFollowupError = followupError?.recordId === selectedVisibleRecord.id ? followupError.detail : "";

                return (
                  <>
              <div className="data-detail-header">
                <div>
                  <h3 className="data-detail-title">{selectedVisibleRecord.dataId}</h3>
                  <div className="data-detail-subtitle">
                    {selectedVisibleRecord.connectionName} · {selectedVisibleRecord.namespace}/{selectedVisibleRecord.group}
                  </div>
                </div>
                <CopyButton text={JSON.stringify(selectedVisibleRecord, null, 2)} label={t("operationHistory.copyRecord")} />
              </div>
              <div className="data-info-grid">
                <div className="info-row">
                  <span className="info-label">{t("operationHistory.operationType")}:</span>
                  <span className="info-value">{t(OPERATION_LABELS[selectedVisibleRecord.type])}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">{t("operationHistory.result")}:</span>
                  <span className={`info-value ${selectedVisibleRecord.result === "failure" ? "error" : ""}`}>
                    {t(RESULT_LABELS[selectedVisibleRecord.result])}
                  </span>
                </div>
                <div className="info-row">
                  <span className="info-label">{t("operationHistory.time")}:</span>
                  <span className="info-value">{formatTime(selectedVisibleRecord.timestamp)}</span>
                </div>
                {selectedVisibleRecord.planId && (
                  <div className="info-row">
                    <span className="info-label">{t("operationHistory.planId")}:</span>
                    <span className="info-value">{selectedVisibleRecord.planId}</span>
                  </div>
                )}
                {selectedVisibleRecord.planSummary && (
                  <div className="info-row">
                    <span className="info-label">{t("operationHistory.planSummary")}:</span>
                    <span className="info-value">{formatPlanSummary(selectedVisibleRecord)}</span>
                  </div>
                )}
                {formatBackupSnapshot(selectedVisibleRecord) && (
                  <div className="info-row">
                    <span className="info-label">{t("operationHistory.backupSnapshot")}:</span>
                    <span className="info-value">{formatBackupSnapshot(selectedVisibleRecord)}</span>
                  </div>
                )}
                {selectedVisibleRecord.taskId && (
                  <div className="info-row">
                    <span className="info-label">{t("operationHistory.taskId")}:</span>
                    <span className="info-value">{selectedVisibleRecord.taskId}</span>
                  </div>
                )}
                {formatApplyDirection(selectedVisibleRecord) && (
                  <div className="info-row">
                    <span className="info-label">{t("operationHistory.applyDirection")}:</span>
                    <span className="info-value">{formatApplyDirection(selectedVisibleRecord)}</span>
                  </div>
                )}
                <div className="info-row">
                  <span className="info-label">{t("operationHistory.rollbackState")}:</span>
                  <span className={`info-value history-rollback-state ${rollbackable ? "available" : "unavailable"}`}>
                    {rollbackable ? t("operationHistory.rollbackable") : t("operationHistory.notRollbackable")}
                  </span>
                </div>
                {!rollbackable && rollbackReason && (
                  <div className="info-row">
                    <span className="info-label">{t("operationHistory.rollbackReason")}:</span>
                    <span className="info-value">{t(rollbackReason)}</span>
                  </div>
                )}
              </div>
              {followupRecord && onStartApply && (
                <div className="history-followup-panel">
                  <div className="history-detail-actions">
                    <button
                      className="btn btn-primary btn-sm"
                      type="button"
                      onClick={() => startRollbackDryRun(selectedVisibleRecord)}
                      disabled={rollbackBusy}
                    >
                      {rollbackBusy ? t("operationHistory.generatingFollowup") : t("operationHistory.generateRollbackPlan")}
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      type="button"
                      onClick={() => void markSandboxVerified(selectedVisibleRecord)}
                      disabled={verifyBusy}
                    >
                      {verifyBusy
                        ? t("operationHistory.generatingFollowup")
                        : verification
                          ? t("operationHistory.sandboxVerifiedState")
                          : t("operationHistory.markSandboxVerified")}
                    </button>
                  </div>
                  <div className="history-promote-row">
                    <label className="field-label" htmlFor={`promotion-target-${selectedVisibleRecord.id}`}>
                      {t("operationHistory.productionTarget")}
                    </label>
                    <select
                      id={`promotion-target-${selectedVisibleRecord.id}`}
                      className="history-filter-select"
                      value={promotionTargetId}
                      onChange={(event) =>
                        setPromotionTargets((current) => ({ ...current, [selectedVisibleRecord.id]: event.target.value }))
                      }
                    >
                      {productionTargets.length === 0 ? (
                        <option value="">{t("operationHistory.noProductionTarget")}</option>
                      ) : (
                        productionTargets.map((conn) => (
                          <option key={conn.id} value={conn.id}>
                            {conn.name}
                          </option>
                        ))
                      )}
                    </select>
                    <button
                      className="btn btn-primary btn-sm"
                      type="button"
                      onClick={() => startPromotionDryRun(selectedVisibleRecord)}
                      disabled={!verification || !promotionTargetId || promoteBusy}
                    >
                      {promoteBusy ? t("operationHistory.generatingFollowup") : t("operationHistory.promoteToTarget")}
                    </button>
                  </div>
                  {!verification && (
                    <div className="field-hint">{t("operationHistory.promoteRequiresVerification")}</div>
                  )}
                  {visibleFollowupError && (
                    <div className="inline-error" role="alert">
                      <div className="inline-error-head">
                        <span className="inline-error-title">{t("operationHistory.followupFailed")}</span>
                        <div className="inline-error-actions">
                          <CopyButton text={visibleFollowupError} label={t("common.copyError")} />
                        </div>
                      </div>
                      <pre className="inline-error-body">{visibleFollowupError}</pre>
                    </div>
                  )}
                </div>
              )}
              {selectedVisibleRecord.content && (
                <div className="history-detail-field">
                  <label>{t("operationHistory.content")}</label>
                  <pre className="history-detail-content">{selectedVisibleRecord.content}</pre>
                </div>
              )}
              {selectedVisibleRecord.error && (
                <div className="history-detail-field">
                  <div className="data-section-head">
                    <label>{t("operationHistory.error")}</label>
                    <CopyButton text={selectedVisibleRecord.error} label={t("common.copyError")} />
                  </div>
                  <pre className="history-detail-error">{selectedVisibleRecord.error}</pre>
                </div>
              )}
                  </>
                );
              })()}
            </>
          ) : (
            <div className="data-empty-state detail-empty">
              <div>{t("operationHistory.selectHint")}</div>
              <span>{t("operationHistory.selectHintDetail")}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
