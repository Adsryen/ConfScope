// Apply 后续动作入口构造：只生成 dry-run 入口，不执行任何写入。
import type { ConfigDocument } from "../api/nacos";
import type { Snapshot } from "../api/snapshot";
import type { Connection } from "../store/connections";
import { type ApplyVerification, type ApplyVerificationInput } from "../store/applyVerifications";
import type { OperationRecord } from "../store/operationHistory";
import {
  applyPlanItemLabel,
  fingerprintApplyPlanValue,
  type ApplyPlan,
  type ApplyPlanItem,
  type ApplyPlanRef,
  type ApplyPlanValueInput,
} from "./applyPlan";
import { applyEntryRiskSummary, type ApplyEntryEndpoint, type ApplyEntryPayload, type ApplyEntryRef } from "./applyEntry";
import { isProtectedApplyTarget } from "./applyPlanExecution";
import {
  restrictItemsByAppliedLocations,
  restrictItemsToSnapshotCoverage,
} from "./applyRecordScope";
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

/**
 * 本次执行的作用范围（轮66 R66-WP9）。
 *
 * planId 指向完整计划，执行时用户可能只勾选了一部分，所以任何从记录出发的后续动作
 * （回退、标记沙箱验证、晋升生产）都得先按记录里的位置清单收口，
 * 否则会把用户没动过的配置一起拖进写入。老记录没有清单时保持原行为。
 */
export function executableItemsForRecord(plan: ApplyPlan, record: OperationRecord): ApplyPlanItem[] {
  const executable = executableItems(plan);
  return record.appliedLocations ? restrictItemsByAppliedLocations(executable, record.appliedLocations) : executable;
}

/**
 * 回退范围 = 本次写入过的位置。
 *
 * 新记录按 appliedLocations 收口：清单里既有写前就存在的项（快照里有旧内容，回退=覆盖回去），
 * 也有本次新建的项（快照里没有，回退=删掉），两种都能还原到写前状态。
 * 老记录没有清单，退到备份快照的覆盖范围兜底——快照装的是本次写前的现场，
 * 快照里没有又无法证明本次动过的配置，宁可漏回退也绝不能判成删除。
 * 两条路都收不到项就说明没有可回退的现场，直接拒掉入口，不能放出一个全是删除的计划。
 */
function rollbackItemsForRecord(plan: ApplyPlan, record: OperationRecord, snapshot: Snapshot): ApplyPlanItem[] {
  if (record.appliedLocations) return restrictItemsByAppliedLocations(executableItems(plan), record.appliedLocations);
  return restrictItemsToSnapshotCoverage(executableItems(plan), snapshot);
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

function planFromRecord(
  record: OperationRecord,
  deps: Pick<ApplyFollowupDeps, "getApplyPlan">
): ApplyPlan | string {
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
  // 轮79 E4：清单是「真正落笔的位置」，空清单说明一份配置都没写出去，没有要还原的现场。
  // 放出口只会让用户点下去才收到「快照里没有可回退项」——那句谎话正是 R55-A4 要消灭的。
  // 老记录没有这个字段（那时记的是全部勾选项，不可信），维持原判定。
  if (record.appliedLocations && record.appliedLocations.length === 0) return false;
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
  const scopedItems = rollbackItemsForRecord(plan, record, snapshot);
  if (scopedItems.length === 0) {
    return fail(translate("apply.followupNoBackedUpItems", { id: record.backupSnapshotId }));
  }
  const items = scopedItems.map((item) => {
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
 * 人读的项标签：唯一实现见 `applyPlan.applyPlanItemLabel`（轮75 收口，本处只转发）。
 * 漂移文案是要给人看的，不是给人解码的，所以三处口径必须是同一份代码。
 */
function itemLabel(ref: ApplyPlanRef): string {
  return applyPlanItemLabel(ref);
}

function missingValue(ref: ApplyPlanRef): ApplyPlanValueInput {
  return { exists: false, fingerprint: fingerprintApplyPlanValue(ref, { exists: false }) };
}

/** 当前目标内容指纹；items 必须是本次执行范围内的项，调用方用 executableItemsForRecord 收口。 */
export async function fingerprintsForCurrentTargets(
  items: ApplyPlanItem[],
  sandboxConnection: Connection,
  deps: Pick<ApplyFollowupDeps, "getConfigDocument">
): Promise<Array<{ itemId: string; fingerprint: string }>> {
  const fingerprints: Array<{ itemId: string; fingerprint: string }> = [];
  for (const item of items) {
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
  verification: ApplyVerification,
  sandboxConnection: Connection,
  deps: Pick<ApplyFollowupDeps, "connections" | "getConfigDocument">,
  items: ApplyPlanItem[]
): Promise<string | null> {
  const verifiedByItemId = new Map(verification.verifiedTargetFingerprints.map((item) => [item.itemId, item.fingerprint]));
  const currentByItemId = new Map(
    (await fingerprintsForCurrentTargets(items, sandboxConnection, deps)).map((item) => [item.itemId, item.fingerprint])
  );
  const staleItems: string[] = [];
  for (const item of items) {
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
  // 晋级入口只读计划与沙箱现值，用不到备份快照（getSnapshot）：
  // 参数收到真正需要的三项，调用方就不用为凑类型塞一个会抛错的空壳（轮76）。
  deps: Pick<ApplyFollowupDeps, "connections" | "getApplyPlan" | "getConfigDocument">,
  // 生产侧落在哪个命名空间（轮76 S31 真机量出来的洞）：以前一律沿用沙箱那个 namespace id，
  // 而 Nacos/MSE 的命名空间 id 本来就是每套集群各发各的（MSE 是 36 位 UUID），
  // 把沙箱的 id 原样盖到生产集群上，plan 只会报「新建」——写进一个没人读的租户。
  // 不传就是沿用，保持旧口径；面板给得出候选时由用户点明（点「public」= 传空串，不是不传）。
  options?: { targetNamespace?: string }
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
    const drift = await verifySandboxStillMatches(verification, sandboxConnection, deps, executableItemsForRecord(plan, record));
    if (drift) return fail(drift);
  } catch (error) {
    return fail(translate("apply.followupVerifySandboxFailed", { detail: errorText(error) }));
  }

  // 「没传」才是沿用；传进来的空串就是 Nacos 的公共空间本身（接口里 public 写作空 tenant，
  // Go 侧 normalizeMSERequestNamespace 也按这个方向归一），不能当假值退回沙箱那一个——
  // 否则用户在面板里点了 public，实际写的还是沙箱那个租户。
  const targetNamespace =
    options?.targetNamespace === undefined ? plan.target.namespace : options.targetNamespace.trim();
  const items = executableItemsForRecord(plan, record).map((item) => {
    const sourceRef = toEntryRef(item.targetRef ?? item.ref);
    const targetRef: ApplyEntryRef = {
      ...sourceRef,
      provider: productionTarget.provider ?? "nacos",
      connectionId: productionTarget.id,
      namespace: targetNamespace,
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
      target: endpointFromConnection(productionTarget, targetNamespace),
      items,
      rangeSummary: applyEntryRiskSummary(items),
      origin: { mode: "promote", returnMode: "history" },
    },
  };
}

/**
 * 这条执行记录对应的沙箱验证结果（轮76 F3）。
 *
 * 历史页的「沙箱验证」状态行和第5步的晋级面板读的是同一份事实，
 * 判据留在页面里就会长成两份，将来谁改了 key 语义另一份不会跟着动。
 */
export function findVerificationForRecord(
  verifications: ApplyVerification[],
  record: OperationRecord
): ApplyVerification | null {
  if (!record.planId) return null;
  return verifications.find((item) => item.planId === record.planId && item.applyHistoryId === record.id) ?? null;
}

/** 晋级目标所在的命名空间：以验证结果为准，没标记验证时退到记录里的目标命名空间。 */
export function promotionTargetNamespace(record: OperationRecord, verification: ApplyVerification | null): string {
  return verification?.sandboxNamespace ?? record.targetNamespace ?? record.namespace ?? "";
}

/**
 * 这条连接的名字里有没有「生产」这一档的标记（轮76）。
 *
 * 判据不另起一套：直接复用执行层用来要求手敲确认的那组标记词，
 * 否则「第五步要手敲确认的目标」和「晋级面板默认指向的目标」会各认各的。
 */
export function isProductionMarkedConnection(connection: Connection, namespace: string): boolean {
  return isProtectedApplyTarget(connection, {
    envId: connection.id,
    label: `${connection.name} / ${namespace || "public"}`,
    provider: connection.provider ?? "nacos",
    connectionId: connection.id,
    connectionName: connection.name,
    namespace
  });
}

/**
 * 这条连接够不够格当晋级目标（轮76 S31 补的两条硬排除）。
 *
 * 与 lib/directWriteExit.isWritableConfigTarget 不同口径，而且是故意的：那颗判据管的是
 * 「浏览页有没有直接写出路」，只认 nacos；晋级走的是变更计划那条写链路，apollo/consul
 * 在 Go 侧同样有 PublishConfig，把它们从候选里剔掉等于夺走本来用得上的目标。
 * 这里只挡真正写不进去的两类——本地快照与只读连接：它们挂在「生产目标」这一栏里，
 * 用户要一路走到执行那一步才会收到一条永远不可能成功的错误（站规里叫「点了才报错」）。
 */
export function isPromotionTargetConnection(connection: Connection): boolean {
  return connection.sourceType !== "local-snapshot" && !connection.readonly && !connection.forceLocalSnapshot;
}

/**
 * 能作为晋级目标的连接（轮76 F3：同一份排除口径）。
 *
 * 沙箱自己不能当自己的生产目标；`sandboxConnectionId` 以验证结果为准，
 * 还没标记验证时退到记录里的目标连接，保证候选列表和后面的校验不会各说一套。
 * 带生产标记的排前面：下拉默认指着哪一条，用户多半就直接晋级哪一条，
 * 让「Production target」这一栏默认停在 Dev 上是给错的环境盖章。
 *
 * 先过 isPromotionTargetConnection 那道资格线（轮76 S31 补）：本地快照与只读连接
 * 从今往后不会出现在这一栏里。
 */
export function promotionTargetCandidates(
  connections: Connection[],
  record: OperationRecord,
  verification: ApplyVerification | null
): Connection[] {
  const sandboxConnectionId =
    verification?.sandboxConnectionId || record.targetConnectionId || record.connectionId;
  const namespace = promotionTargetNamespace(record, verification);
  const candidates = connections.filter(
    (conn) => conn.id !== sandboxConnectionId && isPromotionTargetConnection(conn)
  );
  return [
    ...candidates.filter((conn) => isProductionMarkedConnection(conn, namespace)),
    ...candidates.filter((conn) => !isProductionMarkedConnection(conn, namespace)),
  ];
}

export type SandboxVerificationResult =
  | { ok: true; verification: ApplyVerification }
  | { ok: false; detail: string };

/**
 * 标记沙箱验证通过：回读本次范围内各项目的现值，存成一枚状态戳（轮76 F3 从历史页组件提出）。
 *
 * 这里只读不写——`getConfigDocument` 拿现值算指纹，`saveVerification` 落本地状态，
 * 一个 publish/delete 都不碰。真正的写出口仍然只有变更计划第5步那条 dry-run 链路。
 * 存的是「验证时那一时刻目标上的指纹」，晋级时再比一次，沙箱被动过就会拒（`followupVerificationDrift`）。
 */
export async function recordSandboxVerification(
  record: OperationRecord,
  deps: Pick<ApplyFollowupDeps, "connections" | "getApplyPlan" | "getConfigDocument"> & {
    saveVerification: (input: ApplyVerificationInput) => ApplyVerification;
  }
): Promise<SandboxVerificationResult> {
  if (!record.planId) return { ok: false, detail: translate("apply.followupMissingPlanId", { id: record.id }) };
  const plan = deps.getApplyPlan(record.planId);
  if (!plan) return { ok: false, detail: translate("apply.followupPlanMissing", { id: record.planId }) };
  const sandboxConnectionId = record.targetConnectionId || plan.target.connectionId || record.connectionId;
  const sandboxConnection = findConnection(deps.connections, sandboxConnectionId);
  if (!sandboxConnection) {
    return { ok: false, detail: translate("apply.followupSandboxConnectionMissing", { id: sandboxConnectionId }) };
  }
  const verification = deps.saveVerification({
    planId: plan.id,
    applyHistoryId: record.id,
    sandboxConnectionId: sandboxConnection.id,
    sandboxConnectionName: sandboxConnection.name,
    sandboxNamespace: record.targetNamespace ?? plan.target.namespace ?? record.namespace,
    verifiedTargetFingerprints: await fingerprintsForCurrentTargets(
      executableItemsForRecord(plan, record),
      sandboxConnection,
      { getConfigDocument: deps.getConfigDocument }
    ),
  });
  return { ok: true, verification };
}
