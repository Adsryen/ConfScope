// 操作历史本地存储：记录用户在 ConfScope 中执行的配置操作。
const STORAGE_KEY = "cs.operationHistory";
const MAX_RECORDS = 1000;

/** 操作类型 */
export type OperationType = "publish" | "delete" | "rollback";

/** 操作结果 */
export type OperationResult = "success" | "failure";

/** 操作记录 */
export interface OperationRecord {
  id: string;
  type: OperationType;
  result: OperationResult;
  timestamp: string; // ISO 8601
  connectionId: string;
  connectionName: string;
  namespace: string;
  group: string;
  dataId: string;
  content?: string; // 操作内容（发布时的新内容）
  previousContent?: string; // 操作前的内容（回滚时的原始内容）
  error?: string; // 失败时的错误信息
  operator?: string; // 操作人（如果有）
}

/** 生成唯一 ID */
function genId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** 加载操作历史 */
export function loadOperationHistory(): OperationRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr as OperationRecord[] : [];
  } catch {
    return [];
  }
}

/** 保存操作历史（自动截断到 MAX_RECORDS） */
function saveOperationHistory(records: OperationRecord[]): void {
  // 按时间倒序，保留最新的 MAX_RECORDS 条
  const sorted = records.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const truncated = sorted.slice(0, MAX_RECORDS);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(truncated));
}

/** 记录一次操作 */
export function recordOperation(record: Omit<OperationRecord, "id" | "timestamp">): OperationRecord {
  const fullRecord: OperationRecord = {
    ...record,
    id: genId(),
    timestamp: new Date().toISOString(),
  };
  const history = loadOperationHistory();
  history.unshift(fullRecord);
  saveOperationHistory(history);
  return fullRecord;
}

/** 清空操作历史 */
export function clearOperationHistory(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** 按条件筛选操作历史 */
export function filterOperationHistory(
  records: OperationRecord[],
  filters: {
    connectionId?: string;
    namespace?: string;
    dataId?: string;
    type?: OperationType;
    startTime?: string;
    endTime?: string;
  }
): OperationRecord[] {
  return records.filter((record) => {
    if (filters.connectionId && record.connectionId !== filters.connectionId) return false;
    if (filters.namespace && record.namespace !== filters.namespace) return false;
    if (filters.dataId && !record.dataId.includes(filters.dataId)) return false;
    if (filters.type && record.type !== filters.type) return false;
    if (filters.startTime && new Date(record.timestamp) < new Date(filters.startTime)) return false;
    if (filters.endTime && new Date(record.timestamp) > new Date(filters.endTime)) return false;
    return true;
  });
}
