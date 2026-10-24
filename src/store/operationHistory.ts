// 操作历史本地存储：记录用户在 ConfScope 中执行的配置操作。
import type { ApplyPlan } from "../lib/applyPlan";

const STORAGE_KEY = "cs.operationHistory";
const MAX_RECORDS = 1000;

/** 操作类型 */
export type OperationType =
  | "publish"
  | "delete"
  | "rollback"
  | "snapshot"
  | "snapshot_delete"
  | "snapshot_compare"
  | "export"
  | "apply"
  | "promote"
  | "restore";

/** 操作结果 */
export type OperationResult = "success" | "failure";

/** 应用计划摘要：只保存操作历史列表和详情展示需要的字段。 */
export interface OperationPlanSummary {
  scope: ApplyPlan["scope"];
  total: number;
  create: number;
  overwrite: number;
  delete: number;
  skip: number;
  parseError: number;
  blocked: number;
  sourceLabel: string;
  targetLabel: string;
}

/**
 * 本次执行覆盖的配置位置：用户勾选执行的那一组项（轮66 R66-WP9）。
 *
 * 回退/晋升的作用范围必须以它为准：planId 指向的是完整计划，用户执行时只勾选了一部分，
 * 没勾选项既没被备份也不该被回退——否则回退计划会把它们判成删除。
 * 老记录没有这个字段，读到时按 undefined 处理（回退退到备份快照覆盖范围）。
 */
export interface AppliedConfigLocation {
  namespace: string;
  group: string;
  dataId: string;
  key?: string;
}

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
  /**
   * 存档元数据，不是能力判定（轮72A）。
   *
   * 「这条记录能不能回退」只由 lib/historyRollback 判定；这里保留两个字段是因为
   * 快照/导出这类不写配置中心的操作会把原因文案记在这儿，供判定的兜底文案使用。
   */
  rollbackable?: boolean;
  rollbackReason?: string;
  resourceId?: string; // 快照、历史版本等关联资源 ID
  resourceName?: string; // 快照、导出文件等关联资源名称
  error?: string; // 失败时的错误信息
  operator?: string; // 操作人（如果有）
  planId?: string; // ApplyPlan 快照 ID
  planSummary?: OperationPlanSummary; // ApplyPlan 展示摘要
  backupSnapshotId?: string; // 写入前备份快照 ID
  appliedLocations?: AppliedConfigLocation[]; // 本次执行覆盖的配置位置（回退/晋升的作用范围）
  backupSnapshotName?: string; // 写入前备份快照名称
  taskId?: string; // 任务中心 ID
  sourceConnectionId?: string; // 应用源连接 ID
  sourceConnectionName?: string; // 应用源连接名称
  sourceNamespace?: string; // 应用源 namespace
  targetConnectionId?: string; // 应用目标连接 ID
  targetConnectionName?: string; // 应用目标连接名称
  targetNamespace?: string; // 应用目标 namespace
}

const OPERATION_TYPES: readonly OperationType[] = [
  "publish",
  "delete",
  "rollback",
  "snapshot",
  "snapshot_delete",
  "snapshot_compare",
  "export",
  "apply",
  "promote",
  "restore",
];
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

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeOperationType(value: unknown): OperationType | null {
  return typeof value === "string" && OPERATION_TYPES.includes(value as OperationType) ? (value as OperationType) : null;
}

function normalizeOperationResult(value: unknown): OperationResult | null {
  return typeof value === "string" && OPERATION_RESULTS.includes(value as OperationResult) ? (value as OperationResult) : null;
}

function normalizeOperationPlanScope(value: unknown): OperationPlanSummary["scope"] | null {
  return value === "key" || value === "config" || value === "batch" ? value : null;
}

function normalizeOperationPlanSummary(value: unknown): OperationPlanSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<OperationPlanSummary>;
  const scope = normalizeOperationPlanScope(raw.scope);
  const total = numberValue(raw.total);
  const create = numberValue(raw.create);
  const overwrite = numberValue(raw.overwrite);
  const deleted = numberValue(raw.delete);
  const skip = numberValue(raw.skip);
  const parseError = numberValue(raw.parseError);
  const blocked = numberValue(raw.blocked);
  const sourceLabel = stringValue(raw.sourceLabel);
  const targetLabel = stringValue(raw.targetLabel);
  if (
    !scope ||
    total === undefined ||
    create === undefined ||
    overwrite === undefined ||
    deleted === undefined ||
    skip === undefined ||
    parseError === undefined ||
    blocked === undefined ||
    sourceLabel === undefined ||
    targetLabel === undefined
  ) {
    return undefined;
  }
  return { scope, total, create, overwrite, delete: deleted, skip, parseError, blocked, sourceLabel, targetLabel };
}

/** 位置清单读盘校验：缺字段的条目丢掉，整体不是数组当作没有这个字段。 */
function normalizeAppliedLocations(value: unknown): AppliedConfigLocation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const locations: AppliedConfigLocation[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Partial<AppliedConfigLocation>;
    const dataId = stringValue(raw.dataId);
    const group = stringValue(raw.group);
    if (!dataId || group === undefined) continue;
    locations.push({
      namespace: stringValue(raw.namespace) ?? "public",
      group,
      dataId,
      key: stringValue(raw.key),
    });
  }
  return locations;
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
    planId: stringValue(raw.planId),
    planSummary: normalizeOperationPlanSummary(raw.planSummary),
    backupSnapshotId: stringValue(raw.backupSnapshotId),
    appliedLocations: normalizeAppliedLocations(raw.appliedLocations),
    backupSnapshotName: stringValue(raw.backupSnapshotName),
    taskId: stringValue(raw.taskId),
    sourceConnectionId: stringValue(raw.sourceConnectionId),
    sourceConnectionName: stringValue(raw.sourceConnectionName),
    sourceNamespace: stringValue(raw.sourceNamespace),
    targetConnectionId: stringValue(raw.targetConnectionId),
    targetConnectionName: stringValue(raw.targetConnectionName),
    targetNamespace: stringValue(raw.targetNamespace),
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
