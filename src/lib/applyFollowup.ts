// Apply 后续动作入口构造：只生成 dry-run 入口，不执行任何写入。
import type { ConfigDocument } from "../api/nacos";
import type { Snapshot } from "../api/snapshot";
import type { Connection } from "../store/connections";
import type { ApplyVerification } from "../store/applyVerifications";
import type { OperationRecord } from "../store/operationHistory";
import {
  fingerprintApplyPlanValue,
  type ApplyPlan,
  type ApplyPlanItem,
  type ApplyPlanRef,
  type ApplyPlanValueInput,
} from "./applyPlan";
import { applyEntryRiskSummary, type ApplyEntryEndpoint, type ApplyEntryPayload, type ApplyEntryRef } from "./applyEntry";
import { detectFormat, type Format } from "./format";
import { normalizeConfig } from "./normalize";
import { snapshotConnectionId } from "./snapshotConnection";
import { errorText } from "./errorText";
import { translate } from "../locales";

const DOCUMENT_KEY = "__document";

export interface ApplyFollowupDeps {
  connections: Connection[];
  getApplyPlan: (id: string) => ApplyPlan | null;
  getSnapshot: (id: string) => Promise<Snapshot>;
  getConfigDocument: (conn: Connection, namespace: string, dataId: string, group: string) => Promise<ConfigDocument>;
}

export type ApplyFollowupResult =
  | { ok: true; entry: ApplyEntryPayload }
  | { ok: false; error: string; detail: string };

function fail(detail: string): ApplyFollowupResult {
  return { ok: false, error: "apply_followup_failed", detail };
}

function isMissingConfigError(error: unknown): boolean {
  const message = errorText(error).toLowerCase();
  return message.includes("404") || message.includes("not found") || message.includes("not exist") || message.includes("notexists");
}

function executableItems(plan: ApplyPlan): ApplyPlanItem[] {
  return plan.items.filter((item) => !item.blocked && item.action !== "skip" && item.action !== "parse_error");
}

function toEntryRef(ref: ApplyPlanRef): ApplyEntryRef {
  return {
    provider: ref.provider,
    connectionId: ref.connectionId,
    namespace: ref.namespace,
    group: ref.group,
    dataId: ref.dataId,
    key: ref.key,
  };
}

function endpointFromConnection(conn: Connection, namespace: string): ApplyEntryEndpoint {
  return {
    provider: conn.provider ?? "nacos",
    connectionId: conn.id,
    connectionName: conn.name,
    namespace,
    label: `${conn.name} / ${namespace || "public"}`,
  };
}

function endpointFromPlanTarget(plan: ApplyPlan): ApplyEntryEndpoint {
  return {
    provider: plan.target.provider,
    connectionId: plan.target.connectionId,
    connectionName: plan.target.connectionName,
    namespace: plan.target.namespace,
    label: plan.target.label,
  };
}

function snapshotEndpoint(snapshot: Snapshot, namespace: string): ApplyEntryEndpoint {
  return {
    provider: "local",
    connectionId: snapshotConnectionId(snapshot.id),
    connectionName: snapshot.name || snapshot.id,
    namespace,
    label: `${snapshot.name || snapshot.id} / ${namespace || "public"}`,
  };
}

function findConnection(connections: Connection[], connectionId: string): Connection | null {
  return connections.find((conn) => conn.id === connectionId) ?? null;
}

function planFromRecord(record: OperationRecord, deps: ApplyFollowupDeps): ApplyPlan | string {
  if (!record.planId) return translate("apply.followupMissingPlanId", { id: record.id });
  const plan = deps.getApplyPlan(record.planId);
  return plan ?? translate("apply.followupPlanMissing", { id: record.planId });
}

/**
 * 这条操作记录能不能构造回退入口（R55-A4）。
 *
 * 判据是「回退现场齐不齐」，而不是「这次执行成没成功」：逐项写入一失败就停，
 * 失败项之前已经有配置落到目标上了，失败记录同样带着 planId + 写前备份快照——
 * 只放行成功记录等于把半截改动留在生产上却没有出口。
 * 反过来，现场缺任何一样（没关联计划 / 没备份快照）就不该把入口放出去，
 * 让用户点下去才收到一句「变更记录 X 没有关联变更计划」。
 */
export function canBuildRollbackEntry(record: OperationRecord): boolean {
  if (!["apply", "promote", "restore"].includes(record.type)) return false;
  if (!record.planId || !record.backupSnapshotId) return false;
  return record.result === "success" || record.result === "failure";
}

export async function buildRollbackEntryFromApplyRecord(
  record: OperationRecord,
  deps: ApplyFollowupDeps
): Promise<ApplyFollowupResult> {
  const plan = planFromRecord(record, deps);
  if (typeof plan === "string") return fail(plan);
  if (!record.backupSnapshotId) return fail(translate("apply.followupMissingBackupSnapshot", { id: record.id }));

  let snapshot: Snapshot;
  try {
    snapshot = await deps.getSnapshot(record.backupSnapshotId);
  } catch (error) {
    return fail(translate("apply.followupLoadSnapshotFailed", { id: record.backupSnapshotId, detail: errorText(error) }));
  }
  if (!snapshot.path) return fail(translate("apply.followupSnapshotMissingPath", { id: record.backupSnapshotId }));

  const targetConnection = findConnection(deps.connections, plan.target.connectionId);
  if (!targetConnection) return fail(translate("apply.followupTargetConnectionMissing", { id: plan.target.connectionId }));

  const sourceConnectionId = snapshotConnectionId(snapshot.id);
  const items = executableItems(plan).map((item) => {
    const targetRef = toEntryRef(item.targetRef ?? item.ref);
    const sourceRef: ApplyEntryRef = {
      ...targetRef,
      provider: "local",
      connectionId: sourceConnectionId,
    };
    return {
      ...targetRef,
      sourceRef,
      targetRef,
    };
  });

  return {
    ok: true,
    entry: {
      sourceType: "rollback",
      scope: plan.scope,
      source: snapshotEndpoint(snapshot, plan.target.namespace),
      target: endpointFromPlanTarget(plan),
      items,
      rangeSummary: applyEntryRiskSummary(items),
      origin: { mode: "rollback", returnMode: "history" },
    },
  };
}

function formatFromDocument(ref: ApplyPlanRef, document: ConfigDocument): Format {
  return detectFormat(ref.dataId, document.format, document.content);
}

function documentValue(ref: ApplyPlanRef, document: ConfigDocument): ApplyPlanValueInput {
  const format = formatFromDocument(ref, document);
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
    ...(document.md5 ? { md5: document.md5 } : {}),
  };
  return { ...value, fingerprint: fingerprintApplyPlanValue(ref, value) };
}

function keyValue(ref: ApplyPlanRef, document: ConfigDocument): ApplyPlanValueInput {
  const format = formatFromDocument(ref, document);
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
  const value: ApplyPlanValueInput = {
    exists: false,
    format,
    parseStatus: normalized.parseStatus,
    ...(normalized.parseError ? { parseError: normalized.parseError } : {}),
  };
  return { ...value, fingerprint: fingerprintApplyPlanValue(ref, value) };
}

function valueFromDocument(ref: ApplyPlanRef, document: ConfigDocument): ApplyPlanValueInput {
  return ref.key === DOCUMENT_KEY ? documentValue(ref, document) : keyValue(ref, document);
}

/**
 * 人读的项标签：`命名空间/分组/dataId`，key 级再补 `(key)`。
 * 与执行器 itemRefLabel 同一口径——漂移文案是要给人看的，不是给人解码的。
 */
function itemLabel(ref: ApplyPlanRef): string {
  const base = `${ref.namespace}/${ref.group}/${ref.dataId}`;
  return ref.key && ref.key !== DOCUMENT_KEY ? `${base} (${ref.key})` : base;
}

function missingValue(ref: ApplyPlanRef): ApplyPlanValueInput {
  return { exists: false, fingerprint: fingerprintApplyPlanValue(ref, { exists: false }) };
}

export async function fingerprintsForCurrentPlanTargets(
  plan: ApplyPlan,
  sandboxConnection: Connection,
  deps: Pick<ApplyFollowupDeps, "getConfigDocument">
): Promise<Array<{ itemId: string; fingerprint: string }>> {
  const fingerprints: Array<{ itemId: string; fingerprint: string }> = [];
  for (const item of executableItems(plan)) {
    const ref = item.targetRef ?? item.ref;
    let current: ApplyPlanValueInput;
    try {
      const document = await deps.getConfigDocument(sandboxConnection, ref.namespace, ref.dataId, ref.group);
      current = valueFromDocument(ref, document);
    } catch (error) {
      if (!isMissingConfigError(error)) throw error;
      current = missingValue(ref);
    }
    fingerprints.push({
      itemId: item.id,
      fingerprint: current.fingerprint ?? fingerprintApplyPlanValue(ref, current),
    });
  }
  return fingerprints;
}

async function verifySandboxStillMatches(
  plan: ApplyPlan,
  verification: ApplyVerification,
  sandboxConnection: Connection,
  deps: ApplyFollowupDeps
): Promise<string | null> {
  const verifiedByItemId = new Map(verification.verifiedTargetFingerprints.map((item) => [item.itemId, item.fingerprint]));
  const currentByItemId = new Map(
    (await fingerprintsForCurrentPlanTargets(plan, sandboxConnection, deps)).map((item) => [item.itemId, item.fingerprint])
  );
  const staleItems: string[] = [];
  for (const item of executableItems(plan)) {
    // R55-B5：以前这里直接 join item.id——`provider|conn|ns|group|dataId|key` 的拼接串
    // 甩进「沙箱配置在验证后已变化，变化项：…」的句子中间，用户根本读不出是哪一份配置。
    // itemId 仍然是比对用的键，只有拿去显示的那一层换成人读标签。
    const label = itemLabel(item.targetRef ?? item.ref);
    const expected = verifiedByItemId.get(item.id);
    const current = currentByItemId.get(item.id);
    if (!expected || !current) {
      staleItems.push(label);
      continue;
    }
    if (current !== expected) staleItems.push(label);
  }
  return staleItems.length > 0 ? translate("apply.followupVerificationDrift", { items: staleItems.join(", ") }) : null;
}

export async function buildPromotionEntryFromVerification(
  record: OperationRecord,
  verification: ApplyVerification | null,
  productionTarget: Connection,
  deps: ApplyFollowupDeps
): Promise<ApplyFollowupResult> {
  if (!verification) return fail(translate("apply.followupNoVerification", { id: record.id }));
  const plan = planFromRecord(record, deps);
  if (typeof plan === "string") return fail(plan);
  if (verification.planId !== plan.id || verification.applyHistoryId !== record.id) {
    return fail(translate("apply.followupVerificationMismatch", { verificationId: verification.id, id: record.id }));
  }
  if (verification.sandboxConnectionId === productionTarget.id) {
    return fail(translate("apply.followupSameConnection"));
  }
  const sandboxConnection = findConnection(deps.connections, verification.sandboxConnectionId);
  if (!sandboxConnection) return fail(translate("apply.followupSandboxConnectionMissing", { id: verification.sandboxConnectionId }));

  try {
    const drift = await verifySandboxStillMatches(plan, verification, sandboxConnection, deps);
    if (drift) return fail(drift);
  } catch (error) {
    return fail(translate("apply.followupVerifySandboxFailed", { detail: errorText(error) }));
  }

  const items = executableItems(plan).map((item) => {
    const sourceRef = toEntryRef(item.targetRef ?? item.ref);
    const targetRef: ApplyEntryRef = {
      ...sourceRef,
      provider: productionTarget.provider ?? "nacos",
      connectionId: productionTarget.id,
    };
    return {
      ...targetRef,
      sourceRef,
      targetRef,
    };
  });

  return {
    ok: true,
    entry: {
      sourceType: "promote",
      scope: plan.scope,
      source: endpointFromConnection(sandboxConnection, plan.target.namespace),
      target: endpointFromConnection(productionTarget, plan.target.namespace),
      items,
      rangeSummary: applyEntryRiskSummary(items),
      origin: { mode: "promote", returnMode: "history" },
    },
  };
}
