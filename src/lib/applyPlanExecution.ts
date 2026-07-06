import type { Connection } from "../store/connections";
import type { ConfigDocument } from "../api/nacos";
import type { OperationRecord } from "../store/operationHistory";
import type { TaskManager } from "./taskmanager";
import {
  fingerprintApplyPlanValue,
  validateApplyPlanFreshness,
  type ApplyPlan,
  type ApplyPlanEndpoint,
  type ApplyPlanFreshnessSnapshot,
  type ApplyPlanItem,
  type ApplyPlanValueInput,
} from "./applyPlan";
import {
  buildApplyOperationHistoryInput,
  prepareApplyExecutionSafety,
  type ApplyBackupConfig,
  type ApplyBackupSummary,
  type ApplyTargetBeforeSnapshot,
} from "./applyExecutionSafety";
import { detectFormat, nacosType, type Format } from "./format";
import { normalizeConfig } from "./normalize";

const PROTECTED_TARGET_MARKERS = ["prod", "production", "生产", "真实", "线上"] as const;
const DOCUMENT_KEY = "__document";

export interface ExecuteApplyPlanDeps {
  connections: Connection[];
  getConfigDocument: (conn: Connection, namespace: string, dataId: string, group: string) => Promise<ConfigDocument>;
  publishConfig: (conn: Connection, namespace: string, dataId: string, group: string, content: string, configType: string) => Promise<void>;
  deleteConfig: (conn: Connection, namespace: string, dataId: string, group: string) => Promise<void>;
  createBackupSnapshot: (configs: ApplyBackupConfig[]) => Promise<{ id: string; name: string }>;
  recordOperation: (record: Omit<OperationRecord, "id" | "timestamp">) => OperationRecord;
  taskManager: TaskManager;
}

export type ExecuteApplyPlanResult =
  | { ok: true; taskId: string; historyId: string }
  | { ok: false; taskId?: string; historyId?: string; error: string };

function targetSearchText(connection: Connection | null | undefined, endpoint: ApplyPlanEndpoint): string {
  return [
    connection?.name,
    connection?.environmentName,
    connection?.sourceName,
    endpoint.label,
    endpoint.connectionName,
    endpoint.envId,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
}

export function isProtectedApplyTarget(connection: Connection | null | undefined, endpoint: ApplyPlanEndpoint): boolean {
  const text = targetSearchText(connection, endpoint);
  return PROTECTED_TARGET_MARKERS.some((marker) => text.includes(marker));
}

export function applyConfirmationText(plan: Pick<ApplyPlan, "id" | "target">): string {
  return `APPLY ${plan.id} TO ${plan.target.label}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingConfigError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("404") || message.includes("not found") || message.includes("not exist") || message.includes("notexists");
}

function findConnection(deps: ExecuteApplyPlanDeps, connectionId: string): Connection | string {
  return deps.connections.find((conn) => conn.id === connectionId) ?? `Missing connection ${connectionId}`;
}

function sourceRef(item: ApplyPlanItem) {
  return item.sourceRef ?? item.ref;
}

function targetRef(item: ApplyPlanItem) {
  return item.targetRef ?? item.ref;
}

function formatFromDocument(item: ApplyPlanItem, document: ConfigDocument, ref = targetRef(item)): Format {
  return detectFormat(ref.dataId, document.format, document.content);
}

function missingValue(item: ApplyPlanItem, ref = targetRef(item)): ApplyPlanValueInput {
  return { exists: false, fingerprint: fingerprintApplyPlanValue(ref, { exists: false }) };
}

function documentValue(item: ApplyPlanItem, document: ConfigDocument, ref = targetRef(item)): ApplyPlanValueInput {
  const format = formatFromDocument(item, document, ref);
  const normalized = normalizeConfig(document.content, format);
  const value: ApplyPlanValueInput = {
    exists: true,
    value: document.content,
    valueType: "text",
    format,
    parseStatus: normalized.parseStatus,
    ...(normalized.parseError ? { parseError: normalized.parseError } : {}),
    content: document.content,
    version: document.version,
    updateTime: document.updateTime,
  };
  return { ...value, fingerprint: fingerprintApplyPlanValue(ref, value) };
}

function keyValueFromLine(item: ApplyPlanItem, document: ConfigDocument, format: Format, ref = targetRef(item)): ApplyPlanValueInput | null {
  const escapedKey = ref.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*${escapedKey}\\s*[:=]\\s*(.*)$`, "m");
  const match = document.content.match(pattern);
  if (!match) return null;
  const value: ApplyPlanValueInput = {
    exists: true,
    value: match[1],
    valueType: "string",
    format,
    parseStatus: "ok",
  };
  return { ...value, fingerprint: fingerprintApplyPlanValue(ref, value) };
}

function keyValue(item: ApplyPlanItem, document: ConfigDocument, ref = targetRef(item)): ApplyPlanValueInput {
  const format = formatFromDocument(item, document, ref);
  const normalized = normalizeConfig(document.content, format);
  const entry = normalized.entries.find((candidate) => candidate.key === ref.key);
  if (entry) {
    const value: ApplyPlanValueInput = {
      exists: true,
      value: entry.value,
      valueType: entry.valueType,
      format,
      parseStatus: entry.parseStatus,
      ...(entry.parseError ? { parseError: entry.parseError } : {}),
    };
    return { ...value, fingerprint: fingerprintApplyPlanValue(ref, value) };
  }
  const fallback = keyValueFromLine(item, document, format, ref);
  if (fallback) return fallback;
  const value: ApplyPlanValueInput = {
    exists: false,
    format,
    parseStatus: normalized.parseStatus,
    ...(normalized.parseError ? { parseError: normalized.parseError } : {}),
  };
  return { ...value, fingerprint: fingerprintApplyPlanValue(ref, value) };
}

function valueFromDocument(item: ApplyPlanItem, document: ConfigDocument, ref = targetRef(item)): ApplyPlanValueInput {
  return ref.key === DOCUMENT_KEY ? documentValue(item, document, ref) : keyValue(item, document, ref);
}

async function readCurrentValue(
  item: ApplyPlanItem,
  conn: Connection,
  role: "source" | "target",
  deps: ExecuteApplyPlanDeps
): Promise<ApplyPlanValueInput> {
  const ref = role === "source" ? sourceRef(item) : targetRef(item);
  try {
    const document = await deps.getConfigDocument(conn, ref.namespace, ref.dataId, ref.group);
    return valueFromDocument(item, document, ref);
  } catch (error) {
    if (isMissingConfigError(error)) return missingValue(item, ref);
    throw new Error(`Failed to read ${role} config ${ref.namespace}/${ref.group}/${ref.dataId}: ${errorMessage(error)}`);
  }
}

async function readBeforeSnapshot(
  item: ApplyPlanItem,
  targetConnection: Connection,
  deps: ExecuteApplyPlanDeps
): Promise<ApplyTargetBeforeSnapshot> {
  const ref = targetRef(item);
  try {
    const document = await deps.getConfigDocument(targetConnection, ref.namespace, ref.dataId, ref.group);
    return {
      itemId: item.id,
      namespace: ref.namespace,
      group: ref.group,
      dataId: ref.dataId,
      exists: true,
      content: document.content,
      configType: document.format || "text",
      updateTime: document.updateTime,
    };
  } catch (error) {
    if (isMissingConfigError(error)) {
      return {
        itemId: item.id,
        namespace: ref.namespace,
        group: ref.group,
        dataId: ref.dataId,
        exists: false,
      };
    }
    throw new Error(`Failed to read before snapshot ${ref.namespace}/${ref.group}/${ref.dataId}: ${errorMessage(error)}`);
  }
}

function executableItems(plan: ApplyPlan): ApplyPlanItem[] {
  return plan.items.filter((item) => item.action !== "skip" && item.action !== "parse_error");
}

async function freshnessSnapshots(
  plan: ApplyPlan,
  sourceConnection: Connection,
  targetConnection: Connection,
  deps: ExecuteApplyPlanDeps
): Promise<ApplyPlanFreshnessSnapshot[]> {
  const snapshots: ApplyPlanFreshnessSnapshot[] = [];
  for (const item of plan.items) {
    const [sourceValue, targetValue] = await Promise.all([
      readCurrentValue(item, sourceConnection, "source", deps),
      readCurrentValue(item, targetConnection, "target", deps),
    ]);
    snapshots.push({
      itemId: item.id,
      side: "source",
      fingerprint: sourceValue.fingerprint ?? fingerprintApplyPlanValue(sourceRef(item), sourceValue),
    });
    snapshots.push({
      itemId: item.id,
      side: "target",
      fingerprint: targetValue.fingerprint ?? fingerprintApplyPlanValue(targetRef(item), targetValue),
    });
  }
  return snapshots;
}

async function beforeSnapshots(plan: ApplyPlan, targetConnection: Connection, deps: ExecuteApplyPlanDeps): Promise<ApplyTargetBeforeSnapshot[]> {
  const snapshots: ApplyTargetBeforeSnapshot[] = [];
  for (const item of executableItems(plan)) {
    snapshots.push(await readBeforeSnapshot(item, targetConnection, deps));
  }
  return snapshots;
}

interface PlannedWrite {
  item: ApplyPlanItem;
  kind: "publish" | "delete";
  content?: string;
  configType?: string;
}

function contentForDocumentWrite(item: ApplyPlanItem): string {
  return item.afterValue.content ?? item.afterValue.value ?? "";
}

function formatForWrite(item: ApplyPlanItem): Format {
  return item.afterValue.format ?? item.sourceValue.format ?? item.targetValue.format ?? "TEXT";
}

function planWrites(plan: ApplyPlan): PlannedWrite[] | string {
  const writes: PlannedWrite[] = [];
  for (const item of plan.items) {
    const ref = targetRef(item);
    if (item.blocked || item.action === "parse_error") return `Cannot execute blocked item ${item.id}.`;
    if (item.action === "skip") continue;
    if (ref.key !== DOCUMENT_KEY) {
      return `Cannot materialize key-level apply for ${ref.dataId}/${ref.key} with format ${formatForWrite(item)}.`;
    }
    if (item.action === "delete") {
      writes.push({ item, kind: "delete" });
      continue;
    }
    if (item.action === "create" || item.action === "overwrite") {
      writes.push({ item, kind: "publish", content: contentForDocumentWrite(item), configType: nacosType(formatForWrite(item)) });
    }
  }
  return writes;
}

function emptyBackup(): ApplyBackupSummary {
  return { backedUpCount: 0, missingBeforeCount: 0 };
}

function createTask(plan: ApplyPlan, deps: ExecuteApplyPlanDeps): string {
  const task = deps.taskManager.createTask(`Apply plan ${plan.id}`, "apply", { scope: plan.target.label, cancellable: false });
  deps.taskManager.startTask(task.id);
  return task.id;
}

function recordFailure(
  plan: ApplyPlan,
  deps: ExecuteApplyPlanDeps,
  taskId: string,
  error: string,
  backup: ApplyBackupSummary = emptyBackup()
): ExecuteApplyPlanResult {
  const history = deps.recordOperation(
    buildApplyOperationHistoryInput(plan, {
      result: "failure",
      backup,
      taskId,
      error,
    })
  );
  deps.taskManager.completeTask(taskId, false, error);
  return { ok: false, taskId, historyId: history.id, error };
}

export async function executeApplyPlan(plan: ApplyPlan, deps: ExecuteApplyPlanDeps): Promise<ExecuteApplyPlanResult> {
  const taskId = createTask(plan, deps);
  const sourceConnection = findConnection(deps, plan.source.connectionId);
  if (typeof sourceConnection === "string") return recordFailure(plan, deps, taskId, sourceConnection);
  const targetConnection = findConnection(deps, plan.target.connectionId);
  if (typeof targetConnection === "string") return recordFailure(plan, deps, taskId, targetConnection);

  try {
    const currentSnapshots = await freshnessSnapshots(plan, sourceConnection, targetConnection, deps);
    const freshness = validateApplyPlanFreshness(plan, currentSnapshots);
    if (!freshness.ok) {
      const error = `Apply plan is stale: ${freshness.staleItems.map((item) => `${item.itemId}/${item.side}`).join(", ")}`;
      return recordFailure(plan, deps, taskId, error);
    }

    const writes = planWrites(plan);
    if (typeof writes === "string") return recordFailure(plan, deps, taskId, writes);

    const before = await beforeSnapshots(plan, targetConnection, deps);
    const safety = await prepareApplyExecutionSafety(plan, before, {
      createBackupSnapshot: deps.createBackupSnapshot,
      taskId,
    });
    if (!safety.ok) {
      const history = deps.recordOperation(safety.historyInput);
      deps.taskManager.completeTask(taskId, false, safety.error);
      return { ok: false, taskId, historyId: history.id, error: safety.error };
    }

    try {
      let completed = 0;
      for (const write of writes) {
        const ref = targetRef(write.item);
        if (write.kind === "publish") {
          await deps.publishConfig(
            targetConnection,
            ref.namespace,
            ref.dataId,
            ref.group,
            write.content ?? "",
            write.configType ?? "text"
          );
        } else {
          await deps.deleteConfig(targetConnection, ref.namespace, ref.dataId, ref.group);
        }
        completed += 1;
        deps.taskManager.updateProgress(taskId, completed, 0, writes.length);
      }
    } catch (error) {
      return recordFailure(plan, deps, taskId, errorMessage(error), safety.backup);
    }

    const history = deps.recordOperation(safety.historyInput);
    deps.taskManager.completeTask(taskId, true);
    return { ok: true, taskId, historyId: history.id };
  } catch (error) {
    return recordFailure(plan, deps, taskId, errorMessage(error));
  }
}
