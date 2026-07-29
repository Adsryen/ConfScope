// ApplyPlan dry-run 生成服务：从入口 payload 解析两端定位并读取当前配置快照。
import type { ConfigDocument } from "../api/nacos";
import type { Snapshot } from "../api/snapshot";
import type { Connection } from "../store/connections";
import type { ApplyEntryPayload, ApplyEntryRef } from "./applyEntry";
import {
  buildApplyPlan,
  fingerprintApplyPlanValue,
  type ApplyPlan,
  type ApplyPlanEndpoint,
  type ApplyPlanRef,
  type ApplyPlanValueInput,
  type BuildApplyPlanItemInput,
} from "./applyPlan";
import { detectFormat, type Format } from "./format";
import { normalizeConfig, type ConfigEntry } from "./normalize";
import { buildSnapshotConnection } from "./snapshotConnection";

const DOCUMENT_KEY = "__document";
const SNAPSHOT_PREFIX = "snapshot:";

export interface ApplyPlanDraftDeps {
  connections: Connection[];
  getSnapshot: (id: string) => Promise<Snapshot>;
  getConfigDocument: (conn: Connection, namespace: string, dataId: string, group: string) => Promise<ConfigDocument>;
}

export type ApplyPlanDraftResult =
  { ok: true; plan: ApplyPlan; sourceConnection: Connection; targetConnection: Connection } | { ok: false; error: string; detail: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(detail: string): ApplyPlanDraftResult {
  return {
    ok: false,
    error: "apply_plan_draft_failed",
    detail,
  };
}

function snapshotIdFromConnectionId(connectionId: string): string | null {
  return connectionId.startsWith(SNAPSHOT_PREFIX) ? connectionId.slice(SNAPSHOT_PREFIX.length) : null;
}

function isMissingConfigError(error: unknown): boolean {
  const message = errorText(error).toLowerCase();
  return (
    message.includes("404") ||
    message.includes("not found") ||
    message.includes("not exist") ||
    message.includes("notexists") ||
    message.includes("不存在") ||
    message.includes("未找到")
  );
}

function entrySourceRef(item: ApplyEntryPayload["items"][number]): ApplyEntryRef {
  return item.sourceRef ?? item;
}

function entryTargetRef(item: ApplyEntryPayload["items"][number]): ApplyEntryRef {
  return item.targetRef ?? item;
}

function endpointFromEntry(endpoint: ApplyEntryPayload["source"]): ApplyPlanEndpoint {
  return {
    envId: endpoint.connectionId,
    label: endpoint.label,
    provider: endpoint.provider,
    connectionId: endpoint.connectionId,
    connectionName: endpoint.connectionName,
    namespace: endpoint.namespace,
  };
}

function planRef(ref: ApplyEntryRef): ApplyPlanRef {
  return {
    provider: ref.provider,
    connectionId: ref.connectionId,
    namespace: ref.namespace,
    group: ref.group,
    dataId: ref.dataId,
    key: ref.key,
  };
}

function valueFromEntry(entry: ConfigEntry, format: Format): ApplyPlanValueInput {
  return {
    exists: true,
    value: entry.value,
    valueType: entry.valueType,
    format,
    parseStatus: entry.parseStatus,
    ...(entry.parseError ? { parseError: entry.parseError } : {}),
  };
}

function documentValue(format: Format, document: ConfigDocument): ApplyPlanValueInput {
  const normalized = normalizeConfig(document.content, format);
  return {
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
}

function missingValue(format?: Format, document?: ConfigDocument): ApplyPlanValueInput {
  if (!document || !format) return { exists: false };
  const normalized = normalizeConfig(document.content, format);
  return {
    exists: false,
    format,
    parseStatus: normalized.parseStatus,
    ...(normalized.parseError ? { parseError: normalized.parseError } : {}),
    version: document.version,
    updateTime: document.updateTime,
  };
}

function valueFromDocument(ref: ApplyEntryRef, document: ConfigDocument): ApplyPlanValueInput {
  const format = detectFormat(ref.dataId, document.format, document.content);
  if (ref.key === DOCUMENT_KEY) return documentValue(format, document);

  const normalized = normalizeConfig(document.content, format);
  const entry = normalized.entries.find((item) => item.key === ref.key);
  if (entry) return valueFromEntry(entry, format);
  return missingValue(format, document);
}

async function readValue(
  ref: ApplyEntryRef,
  conn: Connection,
  role: "source" | "target",
  deps: ApplyPlanDraftDeps
): Promise<ApplyPlanValueInput> {
  try {
    const document = await deps.getConfigDocument(conn, ref.namespace, ref.dataId, ref.group);
    return valueFromDocument(ref, document);
  } catch (error) {
    if (isMissingConfigError(error)) return { exists: false };
    throw new Error(
      `Failed to read ${role} config ${ref.connectionId}/${ref.namespace}/${ref.group}/${ref.dataId}/${ref.key}: ${errorText(error)}`
    );
  }
}

interface ResolveContext {
  snapshotConnections: Map<string, Connection>;
}

async function resolveSnapshotConnection(
  snapshotId: string,
  deps: ApplyPlanDraftDeps,
  context: ResolveContext
): Promise<Connection | string> {
  const cached = context.snapshotConnections.get(snapshotId);
  if (cached) return cached;

  let snapshot: Snapshot;
  try {
    snapshot = await deps.getSnapshot(snapshotId);
  } catch (error) {
    return `Failed to load snapshot ${SNAPSHOT_PREFIX}${snapshotId}: ${errorText(error)}`;
  }
  if (!snapshot.path) return `Snapshot source ${SNAPSHOT_PREFIX}${snapshotId} is missing path`;

  const sourceConnection = deps.connections.find((conn) => conn.id === snapshot.source.connectionId);
  if (!sourceConnection) {
    return `Snapshot source ${SNAPSHOT_PREFIX}${snapshotId} references missing source connection ${snapshot.source.connectionId}`;
  }

  const snapshotConnection = buildSnapshotConnection(snapshot, sourceConnection);
  context.snapshotConnections.set(snapshotId, snapshotConnection);
  return snapshotConnection;
}

async function resolveConnection(connectionId: string, deps: ApplyPlanDraftDeps, context: ResolveContext): Promise<Connection | string> {
  const snapshotId = snapshotIdFromConnectionId(connectionId);
  if (snapshotId) return resolveSnapshotConnection(snapshotId, deps, context);

  const conn = deps.connections.find((item) => item.id === connectionId);
  return conn ?? `Missing connection ${connectionId}`;
}

async function buildPlanItems(
  entry: ApplyEntryPayload,
  deps: ApplyPlanDraftDeps,
  context: ResolveContext
): Promise<BuildApplyPlanItemInput[] | string> {
  const items: BuildApplyPlanItemInput[] = [];
  for (const item of entry.items) {
    const sourceRef = entrySourceRef(item);
    const targetRef = entryTargetRef(item);
    const sourceConnection = await resolveConnection(sourceRef.connectionId, deps, context);
    if (typeof sourceConnection === "string") return sourceConnection;
    const targetConnection = await resolveConnection(targetRef.connectionId, deps, context);
    if (typeof targetConnection === "string") return targetConnection;

    try {
      const [sourceValue, targetValue] = await Promise.all([
        readValue(sourceRef, sourceConnection, "source", deps),
        readValue(targetRef, targetConnection, "target", deps),
      ]);
      const plannedSourceRef = planRef(sourceRef);
      const plannedTargetRef = planRef(targetRef);
      items.push({
        ref: plannedTargetRef,
        sourceRef: plannedSourceRef,
        targetRef: plannedTargetRef,
        sourceValue: item.sourceValueOverride ?? sourceValue,
        targetValue,
        ...(item.sourceValueOverride
          ? { sourceFingerprint: sourceValue.fingerprint ?? fingerprintApplyPlanValue(plannedSourceRef, sourceValue) }
          : {}),
      });
    } catch (error) {
      return errorText(error);
    }
  }
  return items;
}

export async function buildApplyPlanFromEntry(entry: ApplyEntryPayload, deps: ApplyPlanDraftDeps): Promise<ApplyPlanDraftResult> {
  const context: ResolveContext = { snapshotConnections: new Map() };
  const sourceConnection = await resolveConnection(entry.source.connectionId, deps, context);
  if (typeof sourceConnection === "string") return fail(sourceConnection);
  const targetConnection = await resolveConnection(entry.target.connectionId, deps, context);
  if (typeof targetConnection === "string") return fail(targetConnection);

  const items = await buildPlanItems(entry, deps, context);
  if (typeof items === "string") return fail(items);

  const plan = buildApplyPlan({
    scope: entry.scope,
    source: endpointFromEntry(entry.source),
    target: endpointFromEntry(entry.target),
    inputSummary: {
      sourceType: entry.sourceType,
      scope: entry.scope,
      sourceLabel: entry.source.label,
      targetLabel: entry.target.label,
      selectedCount: entry.rangeSummary.count,
    },
    items,
  });

  return {
    ok: true,
    plan,
    sourceConnection,
    targetConnection,
  };
}
