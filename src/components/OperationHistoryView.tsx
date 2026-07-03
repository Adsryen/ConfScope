// 操作历史页面：展示配置中心的操作记录和本地执行的操作。
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "../i18n";
import { Connection } from "../store/connections";
import {
  loadOperationHistory,
  filterOperationHistory,
  type OperationRecord,
  type OperationType,
} from "../store/operationHistory";
import { listHistory } from "../api/nacos";

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
  const fetchCenterHistory = useCallback(async (connId: string) => {
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
  }, [connections]);

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

  // 格式化时间
  const formatTime = (timestamp: string) => {
    try {
      return new Date(timestamp).toLocaleString();
    } catch {
      return timestamp;
    }
  };

  return (
    <div className="page-surface history-page">
      <div className="page-header">
        <div>
          <h3>{t("app.history")}</h3>
          <div className="page-subtitle">
            {allRecords.length > 0
              ? t("operationHistory.recordCount", { count: allRecords.length })
              : t("operationHistory.noRecords")}
          </div>
        </div>
      </div>

      {/* 筛选条件（一行内） */}
      <div className="history-filters">
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
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <select
          className="history-filter-select"
          value={filterType}
          onChange={(e) => setFilterType(e.target.value as OperationType | "")}
        >
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

      {error && <div className="test-msg err">{error}</div>}
      {loading && <div className="history-loading">{t("common.loading")}</div>}

      {/* 操作列表 */}
      <div className="history-list">
        {allRecords.length === 0 ? (
          <div className="pad-msg big">{t("operationHistory.noRecords")}</div>
        ) : (
          allRecords.map((record) => (
            <div
              key={record.id}
              className={`history-item ${selectedRecord?.id === record.id ? "selected" : ""}`}
              onClick={() => setSelectedRecord(selectedRecord?.id === record.id ? null : record)}
            >
              <div className="history-item-head">
                <span className={`history-type ${record.type}`}>
                  {t(OPERATION_LABELS[record.type])}
                </span>
                <span className={`history-result ${record.result}`}>
                  {t(RESULT_LABELS[record.result])}
                </span>
                <span className="history-dataid">{record.dataId}</span>
                <span className="history-time">{formatTime(record.timestamp)}</span>
              </div>
              <div className="history-item-meta">
                <span>{record.connectionName}</span>
                <span>{record.namespace}/{record.group}</span>
              </div>
              {selectedRecord?.id === record.id && (
                <div className="history-item-detail">
                  {record.content && (
                    <div className="history-detail-field">
                      <label>{t("operationHistory.content")}</label>
                      <pre className="history-detail-content">{record.content}</pre>
                    </div>
                  )}
                  {record.error && (
                    <div className="history-detail-field">
                      <label>{t("operationHistory.error")}</label>
                      <pre className="history-detail-error">{record.error}</pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
