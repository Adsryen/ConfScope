// 操作历史页面：展示配置中心的操作记录和本地执行的操作。
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "../i18n";
import { Connection } from "../store/connections";
import { loadOperationHistory, filterOperationHistory, type OperationRecord, type OperationType } from "../store/operationHistory";
import { listHistory } from "../api/nacos";
import CopyButton from "./CopyButton";

interface Props {
  connections: Connection[];
}

const OPERATION_LABELS: Record<OperationType, string> = {
  publish: "operationHistory.opPublish",
  delete: "operationHistory.opDelete",
  rollback: "operationHistory.opRollback",
};

const RESULT_LABELS: Record<string, string> = {
  success: "operationHistory.resultSuccess",
  failure: "operationHistory.resultFailure",
};

export default function OperationHistoryView({ connections }: Props) {
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
  const formatTime = (timestamp: string) => {
    try {
      return new Date(timestamp).toLocaleString();
    } catch {
      return timestamp;
    }
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
              </div>
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
