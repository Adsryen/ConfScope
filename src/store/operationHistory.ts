// 操作历史本地存储：记录用户在 ConfScope 中执行的配置操作。
const STORAGE_KEY = "cs.operationHistory";
const MAX_RECORDS = 1000;

/** 操作类型 */
export type OperationType = "publish" | "delete" | "rollback" | "snapshot" | "snapshot_delete" | "snapshot_compare" | "export";

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
  beforeContent?: string; // 操作前内容，用于回滚恢复
  afterContent?: string; // 操作后内容，用于审计展示
  configType?: string; // Nacos 配置类型
  rollbackable?: boolean; // 是否允许从该记录回滚
  rollbackReason?: string; // 不可回滚原因的 i18n key
  resourceId?: string; // 快照、历史版本等关联资源 ID
  resourceName?: string; // 快照、导出文件等关联资源名称
  error?: string; // 失败时的错误信息
  operator?: string; // 操作人（如果有）
}

const OPERATION_TYPES: readonly OperationType[] = ["publish", "delete", "rollback", "snapshot", "snapshot_delete", "snapshot_compare", "export"];
const OPERATION_RESULTS: readonly OperationResult[] = ["success", "failure"];

/** 生成唯一 ID */
function genId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeOperationType(value: unknown): OperationType | null {
  return typeof value === "string" && OPERATION_TYPES.includes(value as OperationType) ? (value as OperationType) : null;
}

function normalizeOperationResult(value: unknown): OperationResult | null {
  return typeof value === "string" && OPERATION_RESULTS.includes(value as OperationResult) ? (value as OperationResult) : null;
}

function normalizeOperationRecord(value: unknown): OperationRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<OperationRecord>;
  const type = normalizeOperationType(raw.type);
  const result = normalizeOperationResult(raw.result);
  const id = stringValue(raw.id);
  const timestamp = stringValue(raw.timestamp);
  if (!id || !type || !result || !timestamp) return null;

  const content = stringValue(raw.content);
  const previousContent = stringValue(raw.previousContent);
  const beforeContent = stringValue(raw.beforeContent) ?? previousContent;
  const afterContent = stringValue(raw.afterContent) ?? content;
  return {
    id,
    type,
    result,
    timestamp,
    connectionId: stringValue(raw.connectionId) ?? "",
    connectionName: stringValue(raw.connectionName) ?? "",
    namespace: stringValue(raw.namespace) ?? "public",
    group: stringValue(raw.group) ?? "DEFAULT_GROUP",
    dataId: stringValue(raw.dataId) ?? "",
    content,
    previousContent,
    beforeContent,
    afterContent,
    configType: stringValue(raw.configType),
    rollbackable: booleanValue(raw.rollbackable),
    rollbackReason: stringValue(raw.rollbackReason),
    resourceId: stringValue(raw.resourceId),
    resourceName: stringValue(raw.resourceName),
    error: stringValue(raw.error),
    operator: stringValue(raw.operator),
  };
}

/** 加载操作历史 */
export function loadOperationHistory(): OperationRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(normalizeOperationRecord).filter((record): record is OperationRecord => record !== null) : [];
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

/** 判断操作是否能通过重新发布旧内容回滚。 */
export function isRollbackableOperation(record: OperationRecord): boolean {
  if (record.result !== "success") return false;
  if (record.rollbackable === false) return false;
  if (!["publish", "delete", "rollback"].includes(record.type)) return false;
  return typeof record.beforeContent === "string";
}

/** 返回不可回滚原因的 i18n key；可回滚时返回空字符串。 */
export function rollbackUnavailableReason(record: OperationRecord): string {
  if (isRollbackableOperation(record)) return "";
  if (record.result !== "success") return "operationHistory.rollbackOnlySuccess";
  if (record.rollbackable === false) return record.rollbackReason || "operationHistory.rollbackDisabled";
  if (!["publish", "delete", "rollback"].includes(record.type)) return record.rollbackReason || "operationHistory.rollbackUnsupportedType";
  if (typeof record.beforeContent !== "string") return "operationHistory.rollbackMissingContent";
  return "operationHistory.rollbackDisabled";
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
