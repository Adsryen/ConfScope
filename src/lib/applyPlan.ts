// ApplyPlan 领域模型：写入前 dry-run 计划的唯一可复用快照合同。
import type { ProviderType } from "../api/configCenter";
import { FORMATS, type Format } from "./format";
import type { ConfigEntry, ParseStatus } from "./normalize";

export const APPLY_PLAN_SCHEMA_VERSION = 1;

export type ApplyPlanScope = "key" | "config" | "batch";
export type ApplyPlanAction = "create" | "overwrite" | "delete" | "skip" | "parse_error";
export type ApplyPlanIntent = "sync" | "delete" | "skip";
export type ApplyPlanSourceType = "audit" | "diff" | "backup" | "promote" | "rollback" | "manual";

export interface ApplyPlanEndpoint {
  envId: string;
  label: string;
  provider: ProviderType;
  connectionId: string;
  connectionName: string;
  namespace: string;
}

export interface ApplyPlanRef {
  provider: ProviderType;
  connectionId: string;
  namespace: string;
  group: string;
  dataId: string;
  key: string;
}

export interface ApplyPlanValueSnapshot {
  exists: boolean;
  value?: string;
  valueType?: ConfigEntry["valueType"];
  format?: Format;
  parseStatus?: ParseStatus;
  parseError?: string;
  content?: string;
  version?: string;
  updateTime?: string;
  fingerprint: string;
}

export type ApplyPlanValueInput = Omit<ApplyPlanValueSnapshot, "fingerprint"> & { fingerprint?: string };

export interface ApplyPlanItem {
  id: string;
  ref: ApplyPlanRef;
  sourceRef?: ApplyPlanRef;
  targetRef?: ApplyPlanRef;
  sourceValue: ApplyPlanValueSnapshot;
  targetValue: ApplyPlanValueSnapshot;
  afterValue: ApplyPlanValueSnapshot;
  action: ApplyPlanAction;
  blocked: boolean;
  blockReason?: string;
  sourceFingerprint: string;
  targetFingerprint: string;
}

export interface ApplyPlanSummary {
  total: number;
  create: number;
  overwrite: number;
  delete: number;
  skip: number;
  parse_error: number;
  blocked: number;
}

export interface ApplyPlanInputSummary {
  sourceType: ApplyPlanSourceType;
  scope: ApplyPlanScope;
  sourceLabel: string;
  targetLabel: string;
  selectedCount: number;
  description?: string;
}

export interface ApplyPlan {
  schemaVersion: typeof APPLY_PLAN_SCHEMA_VERSION;
  id: string;
  createdAt: string;
  scope: ApplyPlanScope;
  source: ApplyPlanEndpoint;
  target: ApplyPlanEndpoint;
  inputSummary: ApplyPlanInputSummary;
  items: ApplyPlanItem[];
  summary: ApplyPlanSummary;
}

export interface BuildApplyPlanItemInput {
  ref: ApplyPlanRef;
  sourceRef?: ApplyPlanRef;
  targetRef?: ApplyPlanRef;
  sourceValue: ApplyPlanValueInput;
  targetValue: ApplyPlanValueInput;
  sourceFingerprint?: string;
  targetFingerprint?: string;
  intent?: ApplyPlanIntent;
}

export interface BuildApplyPlanInput {
  id?: string;
  createdAt?: string;
  scope: ApplyPlanScope;
  source: ApplyPlanEndpoint;
  target: ApplyPlanEndpoint;
  inputSummary: ApplyPlanInputSummary;
  items: BuildApplyPlanItemInput[];
}

export type ApplyPlanFreshnessSide = "source" | "target";
export type ApplyPlanFreshnessReason = "missing_current_snapshot" | "fingerprint_changed";

export interface ApplyPlanFreshnessSnapshot {
  itemId: string;
  side: ApplyPlanFreshnessSide;
  fingerprint: string;
}

export interface ApplyPlanFreshnessIssue {
  itemId: string;
  side: ApplyPlanFreshnessSide;
  plannedFingerprint: string;
  currentFingerprint?: string;
  reason: ApplyPlanFreshnessReason;
}

export interface ApplyPlanFreshnessResult {
  ok: boolean;
  staleItems: ApplyPlanFreshnessIssue[];
}

interface ClassifiedItem {
  action: ApplyPlanAction;
  blocked: boolean;
  blockReason?: string;
}

function planId(): string {
  return `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function itemId(ref: ApplyPlanRef): string {
  return [ref.provider, ref.connectionId, ref.namespace, ref.group, ref.dataId, ref.key].join("|");
}

function valueForFingerprint(value: ApplyPlanValueInput): Record<string, string | boolean> {
  return {
    exists: value.exists,
    value: value.value ?? "",
    valueType: value.valueType ?? "",
    format: value.format ?? "",
    parseStatus: value.parseStatus ?? "",
    parseError: value.parseError ?? "",
    content: value.content ?? "",
    version: value.version ?? "",
    updateTime: value.updateTime ?? "",
  };
}

function comparableValueFingerprint(value: ApplyPlanValueSnapshot): string {
  return JSON.stringify(valueForFingerprint(value));
}

export function fingerprintApplyPlanValue(ref: ApplyPlanRef, value: Omit<ApplyPlanValueSnapshot, "fingerprint">): string {
  return JSON.stringify({
    provider: ref.provider,
    connectionId: ref.connectionId,
    namespace: ref.namespace,
    group: ref.group,
    dataId: ref.dataId,
    key: ref.key,
    ...valueForFingerprint(value),
  });
}

function snapshotValue(ref: ApplyPlanRef, value: ApplyPlanValueInput): ApplyPlanValueSnapshot {
  const snapshot: ApplyPlanValueSnapshot = {
    exists: value.exists,
    fingerprint: value.fingerprint ?? fingerprintApplyPlanValue(ref, value),
  };
  if (typeof value.value === "string") snapshot.value = value.value;
  if (value.valueType) snapshot.valueType = value.valueType;
  if (value.format) snapshot.format = value.format;
  if (value.parseStatus) snapshot.parseStatus = value.parseStatus;
  if (typeof value.parseError === "string") snapshot.parseError = value.parseError;
  if (typeof value.content === "string") snapshot.content = value.content;
  if (typeof value.version === "string") snapshot.version = value.version;
  if (typeof value.updateTime === "string") snapshot.updateTime = value.updateTime;
  return snapshot;
}

function deletedValue(ref: ApplyPlanRef, source: ApplyPlanValueSnapshot, target: ApplyPlanValueSnapshot): ApplyPlanValueSnapshot {
  return snapshotValue(ref, {
    exists: false,
    format: source.format ?? target.format,
    parseStatus: source.parseStatus ?? target.parseStatus,
  });
}

function classify(source: ApplyPlanValueSnapshot, target: ApplyPlanValueSnapshot, intent: ApplyPlanIntent): ClassifiedItem {
  if (source.parseStatus === "error") return { action: "parse_error", blocked: true, blockReason: "source_parse_error" };
  if (target.parseStatus === "error") return { action: "parse_error", blocked: true, blockReason: "target_parse_error" };
  if (intent === "skip") return { action: "skip", blocked: false };
  if (intent === "delete") return { action: target.exists ? "delete" : "skip", blocked: false };
  if (source.exists && !target.exists) return { action: "create", blocked: false };
  if (!source.exists && target.exists) return { action: "delete", blocked: false };
  if (source.exists && target.exists && comparableValueFingerprint(source) !== comparableValueFingerprint(target)) {
    return { action: "overwrite", blocked: false };
  }
  return { action: "skip", blocked: false };
}

function afterValueFor(
  ref: ApplyPlanRef,
  action: ApplyPlanAction,
  source: ApplyPlanValueSnapshot,
  target: ApplyPlanValueSnapshot
): ApplyPlanValueSnapshot {
  switch (action) {
    case "create":
    case "overwrite":
      return source;
    case "delete":
      return deletedValue(ref, source, target);
    case "parse_error":
    case "skip":
      return target;
  }
}

function emptySummary(): ApplyPlanSummary {
  return {
    total: 0,
    create: 0,
    overwrite: 0,
    delete: 0,
    skip: 0,
    parse_error: 0,
    blocked: 0,
  };
}

function summarize(items: ApplyPlanItem[]): ApplyPlanSummary {
  const summary = emptySummary();
  summary.total = items.length;
  for (const item of items) {
    summary[item.action] += 1;
    if (item.blocked) summary.blocked += 1;
  }
  return summary;
}

export function buildApplyPlan(input: BuildApplyPlanInput): ApplyPlan {
  const items = input.items.map((item) => {
    const sourceRef = item.sourceRef ?? item.ref;
    const targetRef = item.targetRef ?? item.ref;
    const sourceValue = snapshotValue(sourceRef, item.sourceValue);
    const targetValue = snapshotValue(targetRef, item.targetValue);
    const classified = classify(sourceValue, targetValue, item.intent ?? "sync");
    const afterValue = afterValueFor(targetRef, classified.action, sourceValue, targetValue);
    return {
      id: itemId(targetRef),
      ref: targetRef,
      ...(item.sourceRef ? { sourceRef } : {}),
      ...(item.targetRef ? { targetRef } : {}),
      sourceValue,
      targetValue,
      afterValue,
      action: classified.action,
      blocked: classified.blocked,
      ...(classified.blockReason ? { blockReason: classified.blockReason } : {}),
      sourceFingerprint: item.sourceFingerprint ?? sourceValue.fingerprint,
      targetFingerprint: item.targetFingerprint ?? targetValue.fingerprint,
    };
  });

  return {
    schemaVersion: APPLY_PLAN_SCHEMA_VERSION,
    id: input.id ?? planId(),
    createdAt: input.createdAt ?? new Date().toISOString(),
    scope: input.scope,
    source: input.source,
    target: input.target,
    inputSummary: input.inputSummary,
    items,
    summary: summarize(items),
  };
}

export function serializeApplyPlan(plan: ApplyPlan): string {
  return JSON.stringify(plan);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isProvider(value: unknown): value is ProviderType {
  return value === "nacos" || value === "apollo" || value === "consul" || value === "local";
}

function isScope(value: unknown): value is ApplyPlanScope {
  return value === "key" || value === "config" || value === "batch";
}

function isAction(value: unknown): value is ApplyPlanAction {
  return value === "create" || value === "overwrite" || value === "delete" || value === "skip" || value === "parse_error";
}

function isSourceType(value: unknown): value is ApplyPlanSourceType {
  return value === "audit" || value === "diff" || value === "backup" || value === "promote" || value === "rollback" || value === "manual";
}

function isFormat(value: unknown): value is Format {
  return typeof value === "string" && FORMATS.some((format) => format === value);
}

function isParseStatus(value: unknown): value is ParseStatus {
  return value === "ok" || value === "fallback" || value === "error";
}

function isValueType(value: unknown): value is ConfigEntry["valueType"] {
  return (
    value === "string" ||
    value === "number" ||
    value === "boolean" ||
    value === "array" ||
    value === "object" ||
    value === "null" ||
    value === "empty" ||
    value === "text"
  );
}

function parseEndpoint(value: unknown): ApplyPlanEndpoint | null {
  if (!isRecord(value)) return null;
  const envId = stringValue(value.envId);
  const label = stringValue(value.label);
  const provider = value.provider;
  const connectionId = stringValue(value.connectionId);
  const connectionName = stringValue(value.connectionName);
  const namespace = stringValue(value.namespace);
  if (!envId || !label || !isProvider(provider) || !connectionId || !connectionName || namespace === null) return null;
  return { envId, label, provider, connectionId, connectionName, namespace };
}

function parseRef(value: unknown): ApplyPlanRef | null {
  if (!isRecord(value)) return null;
  const provider = value.provider;
  const connectionId = stringValue(value.connectionId);
  const namespace = stringValue(value.namespace);
  const group = stringValue(value.group);
  const dataId = stringValue(value.dataId);
  const key = stringValue(value.key);
  if (!isProvider(provider) || !connectionId || namespace === null || !group || !dataId || key === null) return null;
  return { provider, connectionId, namespace, group, dataId, key };
}

function parseValueSnapshot(value: unknown): ApplyPlanValueSnapshot | null {
  if (!isRecord(value) || typeof value.exists !== "boolean") return null;
  const fingerprint = stringValue(value.fingerprint);
  if (!fingerprint) return null;

  const snapshot: ApplyPlanValueSnapshot = {
    exists: value.exists,
    fingerprint,
  };
  const rawValue = optionalString(value.value);
  const valueType = value.valueType === undefined ? undefined : value.valueType;
  const format = value.format === undefined ? undefined : value.format;
  const parseStatus = value.parseStatus === undefined ? undefined : value.parseStatus;
  if (rawValue !== undefined) snapshot.value = rawValue;
  if (valueType !== undefined) {
    if (!isValueType(valueType)) return null;
    snapshot.valueType = valueType;
  }
  if (format !== undefined) {
    if (!isFormat(format)) return null;
    snapshot.format = format;
  }
  if (parseStatus !== undefined) {
    if (!isParseStatus(parseStatus)) return null;
    snapshot.parseStatus = parseStatus;
  }
  const parseError = optionalString(value.parseError);
  const content = optionalString(value.content);
  const version = optionalString(value.version);
  const updateTime = optionalString(value.updateTime);
  if (parseError !== undefined) snapshot.parseError = parseError;
  if (content !== undefined) snapshot.content = content;
  if (version !== undefined) snapshot.version = version;
  if (updateTime !== undefined) snapshot.updateTime = updateTime;
  return snapshot;
}

function parseInputSummary(value: unknown): ApplyPlanInputSummary | null {
  if (!isRecord(value)) return null;
  const sourceType = value.sourceType;
  const scope = value.scope;
  const sourceLabel = stringValue(value.sourceLabel);
  const targetLabel = stringValue(value.targetLabel);
  const selectedCount = numberValue(value.selectedCount);
  if (!isSourceType(sourceType) || !isScope(scope) || !sourceLabel || !targetLabel || selectedCount === null) return null;
  return {
    sourceType,
    scope,
    sourceLabel,
    targetLabel,
    selectedCount,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
  };
}

function parseSummary(value: unknown): ApplyPlanSummary | null {
  if (!isRecord(value)) return null;
  const total = numberValue(value.total);
  const create = numberValue(value.create);
  const overwrite = numberValue(value.overwrite);
  const deleted = numberValue(value.delete);
  const skip = numberValue(value.skip);
  const parseError = numberValue(value.parse_error);
  const blocked = numberValue(value.blocked);
  if (
    total === null ||
    create === null ||
    overwrite === null ||
    deleted === null ||
    skip === null ||
    parseError === null ||
    blocked === null
  ) {
    return null;
  }
  return { total, create, overwrite, delete: deleted, skip, parse_error: parseError, blocked };
}

function parseItem(value: unknown): ApplyPlanItem | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const ref = parseRef(value.ref);
  const sourceRef = value.sourceRef === undefined ? undefined : parseRef(value.sourceRef);
  const targetRef = value.targetRef === undefined ? undefined : parseRef(value.targetRef);
  const sourceValue = parseValueSnapshot(value.sourceValue);
  const targetValue = parseValueSnapshot(value.targetValue);
  const afterValue = parseValueSnapshot(value.afterValue);
  const action = value.action;
  const blocked = value.blocked;
  const sourceFingerprint = stringValue(value.sourceFingerprint);
  const targetFingerprint = stringValue(value.targetFingerprint);
  if (
    !id ||
    !ref ||
    (value.sourceRef !== undefined && !sourceRef) ||
    (value.targetRef !== undefined && !targetRef) ||
    !sourceValue ||
    !targetValue ||
    !afterValue ||
    !isAction(action) ||
    typeof blocked !== "boolean" ||
    !sourceFingerprint ||
    !targetFingerprint
  ) {
    return null;
  }
  return {
    id,
    ref,
    ...(sourceRef ? { sourceRef } : {}),
    ...(targetRef ? { targetRef } : {}),
    sourceValue,
    targetValue,
    afterValue,
    action,
    blocked,
    ...(typeof value.blockReason === "string" ? { blockReason: value.blockReason } : {}),
    sourceFingerprint,
    targetFingerprint,
  };
}

export function parseApplyPlanSnapshot(value: unknown): ApplyPlan | null {
  if (typeof value === "string") {
    try {
      return parseApplyPlanSnapshot(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;
  const schemaVersion = numberValue(value.schemaVersion);
  const id = stringValue(value.id);
  const createdAt = stringValue(value.createdAt);
  const scope = value.scope;
  const source = parseEndpoint(value.source);
  const target = parseEndpoint(value.target);
  const inputSummary = parseInputSummary(value.inputSummary);
  const summary = parseSummary(value.summary);
  if (
    schemaVersion !== APPLY_PLAN_SCHEMA_VERSION ||
    !id ||
    !createdAt ||
    !isScope(scope) ||
    !source ||
    !target ||
    !inputSummary ||
    !summary ||
    !Array.isArray(value.items)
  ) {
    return null;
  }
  const items: ApplyPlanItem[] = [];
  for (const rawItem of value.items) {
    const item = parseItem(rawItem);
    if (!item) return null;
    items.push(item);
  }
  return {
    schemaVersion: APPLY_PLAN_SCHEMA_VERSION,
    id,
    createdAt,
    scope,
    source,
    target,
    inputSummary,
    items,
    summary,
  };
}

function freshnessKey(itemIdValue: string, side: ApplyPlanFreshnessSide): string {
  return `${itemIdValue}|${side}`;
}

function appendFreshnessIssue(
  issues: ApplyPlanFreshnessIssue[],
  itemIdValue: string,
  side: ApplyPlanFreshnessSide,
  plannedFingerprint: string,
  currentFingerprint: string | undefined
) {
  if (currentFingerprint === plannedFingerprint) return;
  issues.push({
    itemId: itemIdValue,
    side,
    plannedFingerprint,
    ...(currentFingerprint ? { currentFingerprint } : {}),
    reason: currentFingerprint ? "fingerprint_changed" : "missing_current_snapshot",
  });
}

export function validateApplyPlanFreshness(plan: ApplyPlan, snapshots: ApplyPlanFreshnessSnapshot[]): ApplyPlanFreshnessResult {
  const current = new Map<string, string>();
  for (const snapshot of snapshots) {
    current.set(freshnessKey(snapshot.itemId, snapshot.side), snapshot.fingerprint);
  }

  const staleItems: ApplyPlanFreshnessIssue[] = [];
  for (const item of plan.items) {
    appendFreshnessIssue(staleItems, item.id, "source", item.sourceFingerprint, current.get(freshnessKey(item.id, "source")));
    appendFreshnessIssue(staleItems, item.id, "target", item.targetFingerprint, current.get(freshnessKey(item.id, "target")));
  }

  return { ok: staleItems.length === 0, staleItems };
}
