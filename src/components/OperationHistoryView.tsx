// 操作历史页面：展示配置中心的操作记录和本地执行的操作。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../i18n";
import { Connection } from "../store/connections";
import { reportError } from "../lib/errorCenter";
import { busyProps } from "../lib/busyRegion";
import { formatDateTime } from "../lib/formatDateTime";
import { toast } from "../lib/toast";
import type { ApplyEntryPayload } from "../lib/applyEntry";
import {
  buildPromotionEntryFromVerification,
  buildRollbackEntryFromApplyRecord,
  canBuildRollbackEntry,
  executableItemsForRecord,
  fingerprintsForCurrentTargets,
} from "../lib/applyFollowup";
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
import { supportsCenterHistory } from "../lib/configCapabilities";
import { useRememberedState, useScrollMemory } from "../lib/viewState";
import { getSnapshot } from "../api/snapshot";
import CopyButton from "./CopyButton";
import InlineError from "./InlineError";
import { errorText } from "../lib/errorText";
import { useScrollResetOnContentChange } from "../lib/useScrollResetOnContentChange";

interface Props {
  connections: Connection[];
  onStartApply?: (payload: ApplyEntryPayload) => void;
  /**
   * 要定位的操作记录 id（轮66 WP-2）：变更计划页半截写入后跳过来时带上。
   * 只做「解筛 + 选中 + 滚到可见」，不改任何存档数据；用完由 onFocusConsumed 清掉，
   * 免得用户之后自己进这页又被拽回那条记录。
   */
  focusRecordId?: string | null;
  onFocusConsumed?: () => void;
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

/**
 * 后续动作面板要不要出现（R55-A4）。
 *
 * 成功记录照旧；**部分写入的失败记录**也进面板——它带着 planId + 写前备份快照，
 * 前面几条已经落到目标上了，不给出口就只能看着。沙箱验证 / 晋级只对成功记录有意义，
 * 由渲染层单独收口；回退按钮则按 `canBuildRollbackEntry` 放，现场不齐的记录不再「点了才报错」。
 */
function isApplyFollowupRecord(record: OperationRecord): boolean {
  if (record.result === "success") return record.type === "apply" || record.type === "promote" || record.type === "restore";
  return canBuildRollbackEntry(record);
}

function findVerification(verifications: ApplyVerification[], record: OperationRecord): ApplyVerification | null {
  if (!record.planId) return null;
  return verifications.find((verification) => verification.planId === record.planId && verification.applyHistoryId === record.id) ?? null;
}

export default function OperationHistoryView({ connections, onStartApply, focusRecordId, onFocusConsumed }: Props) {
  const { t } = useTranslation();

  // 本地操作记录
  const [localRecords, setLocalRecords] = useState<OperationRecord[]>([]);
  // 配置中心历史
  const [centerRecords, setCenterRecords] = useState<OperationRecord[]>([]);
  // R55-E3：能力支持但拉到 0 行时给出的说明（不支持的情形在渲染层直接讲，不走请求）。
  const [centerEmptyNote, setCenterEmptyNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 筛选条件（切 Tab 不再丢：记在 lib/viewState，R27）
  const [filterConnection, setFilterConnection] = useRememberedState<string>("history.filterConnection", "");
  const [filterType, setFilterType] = useRememberedState<OperationType | "">("history.filterType", "");
  const [filterDataId, setFilterDataId] = useRememberedState<string>("history.filterDataId", "");
  const [selectedRecord, setSelectedRecord] = useRememberedState<OperationRecord | null>("history.selectedRecord", null);
  const [verifications, setVerifications] = useState<ApplyVerification[]>(() => loadApplyVerifications());
  const [followupBusy, setFollowupBusy] = useState<string | null>(null);
  const [followupError, setFollowupError] = useState<FollowupError | null>(null);
  const [promotionTargets, setPromotionTargets] = useState<Record<string, string>>({});
  // 带记录 id 跳过来、但本地历史里已经找不到那条（被清理过 / 记录本来在中心侧）时的说明。
  const [focusMissingId, setFocusMissingId] = useState<string | null>(null);

  // 加载本地记录。loaded 标记是给跨页定位用的：本地历史空不空得等读完了才算数，
  // 只看「数组为空」会把「刚挂载还没读」和「真的被清理过」混成一种情况（轮66 WP-2）。
  const [localRecordsLoaded, setLocalRecordsLoaded] = useState(false);
  useEffect(() => {
    setLocalRecords(loadOperationHistory());
    setLocalRecordsLoaded(true);
  }, []);

  // 从配置中心拉取历史（选择连接时触发）。
  //
  // R55-E3（真机取证驱动）：命名空间级「中心历史」在现有 provider 上都是拿不到的——
  // Nacos v1 空查询恒 0 行且不报错（静默假空，用户以为记录丢了），Apollo/Consul 在
  // Go 侧返回「当前为只读模式」错误又被逐 ns 的 catch 吞掉。所以按能力闸门收口：
  // 不支持的连接不发请求，界面直接讲清楚去哪看历史（lib/configCapabilities 是口径源）。
  const fetchCenterHistory = useCallback(
    async (connId: string) => {
      const conn = connections.find((c) => c.id === connId);
      if (!conn) return;
      setCenterEmptyNote(null);
      if (!supportsCenterHistory(conn)) return;

      setLoading(true);
      setError(null);
      try {
        const records: OperationRecord[] = [];
        const namespaces = [conn.defaultNamespace || ""];
        let lastError: unknown = null;
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
          } catch (e) {
            // 单个命名空间失败不影响其余，但总得留个证据：整体 0 行时报告它，
            // 不能再让失败伪装成「没有记录」。
            lastError = e;
          }
        }
        setCenterRecords((prev) => [...prev, ...records]);
        if (records.length === 0) {
          if (lastError) setError(errorText(lastError));
          else setCenterEmptyNote(t("history.empty"));
        }
      } catch (e) {
        setError(errorText(e));
      } finally {
        setLoading(false);
      }
    },
    [connections, t]
  );

  // 记住的连接筛选要在重新挂载时补拉一次中心历史：否则「筛选还在、列表只剩本地记录」，
  // 看起来像数据丢了。只补这一次（onChange 里原有的一次不动），不碰在途请求取消那条 backlog。
  const centerRefetchDone = useRef(false);
  useEffect(() => {
    if (centerRefetchDone.current || !filterConnection) return;
    centerRefetchDone.current = true;
    void fetchCenterHistory(filterConnection);
  }, [filterConnection, fetchCenterHistory]);

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

  // 列表滚动位置：本地记录要挂载后才同步进来，条数作为列表版本，内容变多时再恢复一次
  const listScroll = useScrollMemory("history.scroll.list", allRecords.length);

  const selectedVisibleRecord = selectedRecord && allRecords.some((record) => record.id === selectedRecord.id) ? selectedRecord : null;

  /**
   * 跨页定位（轮66 WP-2）。分两步是不得已：本地历史在挂载 effect 里才读进来，
   * 第一轮渲染时 allRecords 还是空的，直接判「找不到」会把正常跳转误报成记录丢失。
   *
   * 第一步：记录到手后，只解**挡住它**的那几项筛选（连接/类型/dataId），其余筛选原样留着——
   * 用户自己选的口径不该被一次跳转清空。然后选中它。
   * 第二步：等它真的出现在筛选后的列表里，再把行滚进可见区并通知调用方消费掉。
   * 列表项靠 data-record-id 认领，用 dataset 比对而不是属性选择器拼 id：记录 id 含
   * `_`、数字都无所谓，但把外部值直接塞进选择器迟早撞转义问题。
   */
  useEffect(() => {
    if (!focusRecordId || !localRecordsLoaded) return;
    const record = localRecords.find((item) => item.id === focusRecordId);
    if (!record) {
      setFocusMissingId(focusRecordId);
      onFocusConsumed?.();
      return;
    }
    if (filterConnection && filterConnection !== record.connectionId) setFilterConnection("");
    if (filterType && filterType !== record.type) setFilterType("");
    if (filterDataId && !record.dataId.includes(filterDataId)) setFilterDataId("");
    setFocusMissingId(null);
    setSelectedRecord(record);
  }, [focusRecordId, localRecords, localRecordsLoaded, filterConnection, filterType, filterDataId, setFilterConnection, setFilterType, setFilterDataId, setSelectedRecord, onFocusConsumed]);

  const focusRowVisible = focusRecordId ? allRecords.some((record) => record.id === focusRecordId) : false;
  const listRef = listScroll.ref;
  useEffect(() => {
    if (!focusRecordId || !focusRowVisible) return;
    const container = listRef.current;
    const row = container
      ? Array.from(container.querySelectorAll<HTMLElement>("[data-record-id]")).find((element) => element.dataset.recordId === focusRecordId)
      : null;
    // 先判可用性再滚：jsdom 没有 scrollIntoView（与 DiffView 定位命中行同一口径），
    // 不加这道判空会在测试里直接抛错，把「定位」这件事从断言里挤掉。
    if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
    onFocusConsumed?.();
  }, [focusRecordId, focusRowVisible, listRef, onFocusConsumed]);
  const failedCount = allRecords.filter((record) => record.result === "failure").length;
  const sourceCount = new Set(allRecords.map((record) => record.connectionId)).size;
  // 详情正文与错误两块 <pre> 在切换记录时复用同一节点，不归零就停在上一份记录的偏移处（轮13 波29 / R49）。
  const contentRef = useRef<HTMLPreElement>(null);
  useScrollResetOnContentChange(contentRef, [selectedVisibleRecord?.id ?? "", selectedVisibleRecord?.content ?? ""]);
  const errorRef = useRef<HTMLPreElement>(null);
  useScrollResetOnContentChange(errorRef, [selectedVisibleRecord?.id ?? "", selectedVisibleRecord?.error ?? ""]);

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
      const message = errorText(e);
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
        setRecordFollowupError(record, t("apply.followupMissingPlanId", { id: record.id }));
        return;
      }
      const plan = getApplyPlan(record.planId);
      if (!plan) {
        setRecordFollowupError(record, t("apply.followupPlanMissing", { id: record.planId }));
        return;
      }
      const sandboxConnectionId = record.targetConnectionId || plan.target.connectionId || record.connectionId;
      const sandboxConnection = connections.find((conn) => conn.id === sandboxConnectionId);
      if (!sandboxConnection) {
        setRecordFollowupError(record, t("apply.followupSandboxConnectionMissing", { id: sandboxConnectionId }));
        return;
      }
      const verification = saveApplyVerification({
        planId: plan.id,
        applyHistoryId: record.id,
        sandboxConnectionId: sandboxConnection.id,
        sandboxConnectionName: sandboxConnection.name,
        sandboxNamespace: record.targetNamespace ?? plan.target.namespace ?? record.namespace,
        verifiedTargetFingerprints: await fingerprintsForCurrentTargets(executableItemsForRecord(plan, record), sandboxConnection, {
          getConfigDocument,
        }),
      });
      setVerifications(loadApplyVerifications());
      toast(t("operationHistory.sandboxVerified"), "success");
      setPromotionTargets((current) => {
        const candidates = connections.filter((conn) => conn.id !== verification.sandboxConnectionId);
        return current[record.id] || candidates.length === 0 ? current : { ...current, [record.id]: candidates[0].id };
      });
    } catch (e) {
      const message = errorText(e);
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
      setRecordFollowupError(record, t("apply.followupNoVerification", { id: record.id }));
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
      const message = errorText(e);
      setRecordFollowupError(record, message);
      reportError({ title: t("operationHistory.followupFailed"), source: record.dataId, message, detail: message });
    } finally {
      setFollowupBusy(null);
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

  // 渲染期推导（不占状态，切连接自动跟随）：能力不支持 → 讲清楚去哪看；
  // 能力支持但拉到 0 行 → 用请求回调里写好的 centerEmptyNote。
  const selectedCenterConn = filterConnection ? connections.find((c) => c.id === filterConnection) : undefined;
  const centerNoteText =
    selectedCenterConn && !supportsCenterHistory(selectedCenterConn)
      ? t("history.centerHistoryUnsupported")
      : centerEmptyNote;

  return (
    <div className="page-surface data-page history-page" {...busyProps(loading)}>
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
          aria-label={t("operationHistory.filterConnection")}
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
        <select
          className="history-filter-select"
          aria-label={t("operationHistory.operationType")}
          value={filterType}
          onChange={(e) => setFilterType(e.target.value as OperationType | "")}
        >
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
          type="text"
          className="history-filter-input"
          placeholder={t("operationHistory.dataIdPlaceholder")}
          aria-label={t("operationHistory.dataIdPlaceholder")}
          value={filterDataId}
          onChange={(e) => setFilterDataId(e.target.value)}
        />
      </div>

      {error && <InlineError title={t("operationHistory.loadFailed")} message={error} />}
      {/* R55-E3：不支持中心历史的连接不再被假装拉过；说明用户该去哪看版本历史。 */}
      {centerNoteText && (
        <div className="history-center-note" role="note">
          {centerNoteText}
        </div>
      )}
      {/* 从变更计划页跳过来却没找到记录：讲明白「你要定位的那条不在本地历史里」，
          不能让玩家对着一个空列表自己猜跳转到底成没成。 */}
      {focusMissingId && (
        <div className="history-center-note" role="note">
          {t("operationHistory.focusRecordMissing", { id: focusMissingId })}
        </div>
      )}
      {loading && (
        <div className="history-loading" role="status" aria-live="polite">
          {t("common.loading")}
        </div>
      )}

      {/* 操作列表 */}
      <div className="data-split history-content">
        <div className="data-list op-history-list" ref={listScroll.ref} onScroll={listScroll.onScroll}>
          {allRecords.length === 0 ? (
            <div className="data-empty-state">
              <div>{t("operationHistory.noRecords")}</div>
              <span>{t("operationHistory.emptyHint")}</span>
            </div>
          ) : (
            allRecords.map((record) => (
              <button
                key={record.id}
                data-record-id={record.id}
                className={`data-list-item op-history-item ${selectedVisibleRecord?.id === record.id ? "active" : ""}`}
                onClick={() => setSelectedRecord(selectedVisibleRecord?.id === record.id ? null : record)}
              >
                <span className={`data-item-accent ${record.result === "failure" ? "danger" : record.type}`} />
                <div className="history-item-head">
                  <span className={`history-type ${record.type}`}>{t(OPERATION_LABELS[record.type])}</span>
                  <span className={`history-result ${record.result}`}>{t(RESULT_LABELS[record.result])}</span>
                  <span className="history-time">{formatDateTime(record.timestamp)}</span>
                </div>
                <div className="history-dataid" title={record.dataId}>
                  {record.dataId}
                </div>
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
                  // 回退入口的现场齐不齐（planId + 备份快照）；失败记录只有齐了才谈得上回退。
                  const rollbackEntryAvailable = canBuildRollbackEntry(selectedVisibleRecord);
                  // 沙箱验证与晋级只对成功执行过的记录有意义，失败记录不给这两个入口。
                  const followupSucceeded = selectedVisibleRecord.result === "success";
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
                    <span className="info-value">{formatDateTime(selectedVisibleRecord.timestamp)}</span>
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
                    {!followupSucceeded && <div className="field-hint">{t("operationHistory.partialFailureFollowupHint")}</div>}
                    <div className="history-detail-actions">
                      {rollbackEntryAvailable && (
                        <button
                          className="btn btn-primary btn-sm"
                          type="button"
                          onClick={() => startRollbackDryRun(selectedVisibleRecord)}
                          disabled={rollbackBusy}
                        >
                          {rollbackBusy
                            ? t("operationHistory.generatingFollowup")
                            : t(followupSucceeded ? "operationHistory.generateRollbackPlan" : "operationHistory.rollbackFromBackupPlan")}
                        </button>
                      )}
                      {followupSucceeded && (
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
                      )}
                    </div>
                    {followupSucceeded && (
                    <>
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
                    </>
                  )}
                  {visibleFollowupError && (
                    <InlineError title={t("operationHistory.followupFailed")} message={visibleFollowupError} />
                  )}
                </div>
              )}
              {selectedVisibleRecord.content && (
                <div className="history-detail-field">
                  <label>{t("operationHistory.content")}</label>
                  <pre
                    className="history-detail-content"
                    tabIndex={0}
                    role="region"
                    aria-label={t("operationHistory.content")}
                    ref={contentRef}
                  >
                    {selectedVisibleRecord.content}
                  </pre>
                </div>
              )}
              {selectedVisibleRecord.error && (
                <div className="history-detail-field">
                  <div className="data-section-head">
                    <label>{t("operationHistory.error")}</label>
                    <CopyButton text={selectedVisibleRecord.error} label={t("common.copyError")} />
                  </div>
                  <pre className="history-detail-error" tabIndex={0} role="region" aria-label={t("operationHistory.error")} ref={errorRef}>
                    {selectedVisibleRecord.error}
                  </pre>
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
