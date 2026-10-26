import { describe, expect, it, vi } from "vitest";
import type { ConfigDocument } from "../api/nacos";
import type { Snapshot } from "../api/snapshot";
import type { Connection } from "../store/connections";
import type { ApplyVerification } from "../store/applyVerifications";
import type { OperationRecord } from "../store/operationHistory";
import { translate } from "../locales";
import { buildApplyPlan, fingerprintApplyPlanValue, type ApplyPlan, type ApplyPlanItem, type BuildApplyPlanInput } from "./applyPlan";
import {
  buildPromotionEntryFromVerification,
  buildRollbackEntryFromApplyRecord,
  canBuildRollbackEntry,
  executableItemsForRecord,
  fingerprintsForCurrentTargets,
  isPromotionTargetConnection,
  promotionTargetCandidates,
  type ApplyFollowupDeps,
} from "./applyFollowup";

const sourceConn = connection("conn-dev", "Dev", "Development");
const sandboxConn = connection("conn-sandbox", "Sandbox", "Sandbox");
const prodConn = connection("conn-prod", "Production", "Production");

function connection(id: string, name: string, environmentName: string): Connection {
  return {
    id,
    name,
    projectName: "Order",
    environmentName,
    sourceName: `${environmentName} Nacos`,
    sourceType: "nacos",
    provider: "nacos",
    distribution: "opensource",
    authType: "none",
    baseUrl: `http://${id}.example.com/nacos`,
    username: "",
    password: "",
    defaultNamespace: "public",
  };
}

function endpoint(conn: Connection): BuildApplyPlanInput["source"] {
  return {
    envId: conn.id,
    label: `${conn.name} / public`,
    provider: conn.provider ?? "nacos",
    connectionId: conn.id,
    connectionName: conn.name,
    namespace: "public",
  };
}

function ref(conn: Connection, dataId = "app.yaml"): BuildApplyPlanInput["items"][number]["ref"] {
  return {
    provider: conn.provider ?? "nacos",
    connectionId: conn.id,
    namespace: "public",
    group: "DEFAULT_GROUP",
    dataId,
    key: "__document",
  };
}

function value(content: string, version = "v1"): BuildApplyPlanInput["items"][number]["sourceValue"] {
  return {
    exists: true,
    value: content,
    valueType: "text",
    format: "YAML",
    parseStatus: "ok",
    content,
    version,
    updateTime: `2026-07-06T00:00:00.000Z-${version}`,
    md5: `md5-${version}`,
  };
}

function plan(overrides: Partial<BuildApplyPlanInput> = {}): ApplyPlan {
  return buildApplyPlan({
    id: "plan-apply-1",
    createdAt: "2026-07-06T00:00:00.000Z",
    scope: "config",
    source: endpoint(sourceConn),
    target: endpoint(sandboxConn),
    inputSummary: {
      sourceType: "diff",
      scope: "config",
      sourceLabel: "Dev / public",
      targetLabel: "Sandbox / public",
      selectedCount: 1,
    },
    items: [
      {
        ref: ref(sandboxConn),
        sourceValue: value("server:\n  port: 8080"),
        targetValue: value("server:\n  port: 9090"),
      },
    ],
    ...overrides,
  });
}

function record(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    id: "history-apply-1",
    type: "apply",
    result: "success",
    timestamp: "2026-07-06T00:00:00.000Z",
    connectionId: sandboxConn.id,
    connectionName: sandboxConn.name,
    namespace: "public",
    group: "DEFAULT_GROUP",
    dataId: "app.yaml",
    planId: "plan-apply-1",
    backupSnapshotId: "snap-before-1",
    backupSnapshotName: "before apply",
    taskId: "task-apply-1",
    rollbackable: false,
    rollbackReason: "operationHistory.rollbackApplyRequiresPlan",
    ...overrides,
  };
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id: "snap-before-1",
    path: "C:\\snapshots\\snap-before-1",
    name: "before apply",
    description: "",
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:00:00.000Z",
    source: {
      provider: "nacos",
      connectionId: sandboxConn.id,
      connectionName: sandboxConn.name,
      namespace: "public",
      namespaceId: "public",
    },
    configs: [],
    ...overrides,
  };
}

function document(content: string, version = "v1"): ConfigDocument {
  return {
    content,
    format: "yaml",
    version,
    source: "nacos",
    updateTime: `2026-07-06T00:00:00.000Z-${version}`,
    md5: `md5-${version}`,
  };
}

/**
 * 写前备份快照的形态：把给定执行项的当前目标内容当作备份内容存进去。
 * 真实链路就是这样（collectApplyBackupConfigs 只覆盖本次执行的项），
 * 老记录没有 appliedLocations 时，回退范围就靠这份覆盖来收口（轮66 R66-WP9）。
 */
function snapshotCovering(items: ApplyPlanItem[], id: string): Snapshot {
  return snapshot({
    id,
    configs: items.map((item) => ({
      namespace: item.ref.namespace,
      dataId: item.ref.dataId,
      group: item.ref.group,
      content: item.targetValue.content ?? "",
      configType: "text",
      updateTime: item.targetValue.updateTime ?? "",
    })),
  });
}

function deps(applyPlan = plan(), getConfigDocument: ApplyFollowupDeps["getConfigDocument"] = vi.fn()): ApplyFollowupDeps {
  return {
    connections: [sourceConn, sandboxConn, prodConn],
    getApplyPlan: vi.fn((id) => (id === applyPlan.id ? applyPlan : null)),
    getSnapshot: vi.fn(async (id) => snapshotCovering(applyPlan.items, id)),
    getConfigDocument,
  };
}

function verification(applyPlan = plan(), fingerprint = fingerprintApplyPlanValue(applyPlan.items[0].ref, value("server:\n  port: 8080"))): ApplyVerification {
  return {
    id: "verify-1",
    planId: applyPlan.id,
    applyHistoryId: "history-apply-1",
    sandboxConnectionId: sandboxConn.id,
    sandboxConnectionName: sandboxConn.name,
    sandboxNamespace: "public",
    verifiedAt: "2026-07-06T01:00:00.000Z",
    verifiedTargetFingerprints: [{ itemId: applyPlan.items[0].id, fingerprint }],
  };
}

describe("canBuildRollbackEntry", () => {
  // R55-A4：判据是「回退现场齐不齐」，不是「这次成没成功」。
  // 逐项写入失败即停，失败项之前的配置已经落到目标上了——失败记录必须也有出口。
  it("allows failure records that still carry plan and before-snapshot", () => {
    expect(canBuildRollbackEntry(record({ result: "failure" }))).toBe(true);
    expect(canBuildRollbackEntry(record({ result: "failure", type: "promote" }))).toBe(true);
    expect(canBuildRollbackEntry(record({ result: "failure", type: "restore" }))).toBe(true);
  });

  it("rejects failure records with an incomplete rollback scene", () => {
    expect(canBuildRollbackEntry(record({ result: "failure", backupSnapshotId: undefined }))).toBe(false);
    expect(canBuildRollbackEntry(record({ result: "failure", planId: undefined }))).toBe(false);
  });

  it("落笔清单为空时不放出口：本次什么都没写成，没有要还原的现场（轮79 E4）", () => {
    // 新链路（scopeIsWritten）的空清单：prepare 阶段就失败，一条都没落笔
    expect(canBuildRollbackEntry(record({ appliedLocations: [], scopeIsWritten: true }))).toBe(false);
    expect(canBuildRollbackEntry(record({ result: "failure", appliedLocations: [], scopeIsWritten: true }))).toBe(false);
    // 有落笔项的半截失败仍然放行（R55-A4 那条口径不变）
    expect(
      canBuildRollbackEntry(
        record({ result: "failure", appliedLocations: [{ namespace: "public", group: "DEFAULT_GROUP", dataId: "app.yaml", key: "__document" }], scopeIsWritten: true })
      )
    ).toBe(true);
    // 老记录没有这个字段，维持原判定：不能因为「没带清单」就判成什么都没写
    expect(canBuildRollbackEntry(record({ result: "failure" }))).toBe(true);
  });

  it("still rejects success records with an incomplete scene, and types without a plan-backed rollback", () => {
    expect(canBuildRollbackEntry(record({ planId: undefined }))).toBe(false);
    expect(canBuildRollbackEntry(record({ backupSnapshotId: undefined }))).toBe(false);
    // publish / delete / rollback 这三类不带 planId+备份快照的现场，走的是旧的「重发旧内容」路线，
    // 不能因为 result 是 success 就从这里放出入口。
    expect(canBuildRollbackEntry(record({ type: "publish" }))).toBe(false);
    expect(canBuildRollbackEntry(record({ type: "delete" }))).toBe(false);
    expect(canBuildRollbackEntry(record({ type: "rollback" }))).toBe(false);
  });
});

describe("apply follow-up entry builders", () => {
  it("builds rollback dry-run entries from successful apply records and before snapshots", async () => {
    const applyPlan = plan();
    const result = await buildRollbackEntryFromApplyRecord(record(), deps(applyPlan));

    expect(canBuildRollbackEntry(record())).toBe(true);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.detail);
    expect(result.entry.sourceType).toBe("rollback");
    expect(result.entry.source.connectionId).toBe("snapshot:snap-before-1");
    expect(result.entry.target.connectionId).toBe(sandboxConn.id);
    expect(result.entry.items[0].sourceRef).toMatchObject({ provider: "local", connectionId: "snapshot:snap-before-1", dataId: "app.yaml" });
    expect(result.entry.items[0].targetRef).toEqual(applyPlan.items[0].ref);
    expect(result.entry.origin).toEqual({ mode: "rollback", returnMode: "history" });
  });

  it("returns copyable rollback errors when plan or backup snapshot is unavailable", async () => {
    await expect(buildRollbackEntryFromApplyRecord(record({ planId: undefined }), deps())).resolves.toMatchObject({
      ok: false,
      error: "apply_followup_failed",
      detail: translate("apply.followupMissingPlanId", { id: "history-apply-1" }),
    });
    await expect(buildRollbackEntryFromApplyRecord(record({ backupSnapshotId: undefined }), deps())).resolves.toMatchObject({
      ok: false,
      error: "apply_followup_failed",
      detail: translate("apply.followupMissingBackupSnapshot", { id: "history-apply-1" }),
    });
    await expect(buildRollbackEntryFromApplyRecord(record(), { ...deps(), getApplyPlan: vi.fn(() => null) })).resolves.toMatchObject({
      ok: false,
      error: "apply_followup_failed",
      detail: translate("apply.followupPlanMissing", { id: "plan-apply-1" }),
    });
    await expect(
      buildRollbackEntryFromApplyRecord(record(), { ...deps(), getSnapshot: vi.fn(async () => snapshot({ path: "" })) })
    ).resolves.toMatchObject({
      ok: false,
      error: "apply_followup_failed",
      detail: translate("apply.followupSnapshotMissingPath", { id: "snap-before-1" }),
    });
  });

  it("blocks promotion when sandbox verification is missing, points to the same target, or has drifted", async () => {
    const applyPlan = plan();
    await expect(buildPromotionEntryFromVerification(record(), null, prodConn, deps(applyPlan))).resolves.toMatchObject({
      ok: false,
      error: "apply_followup_failed",
      detail: translate("apply.followupNoVerification", { id: "history-apply-1" }),
    });
    await expect(buildPromotionEntryFromVerification(record(), verification(applyPlan), sandboxConn, deps(applyPlan))).resolves.toMatchObject({
      ok: false,
      error: "apply_followup_failed",
      detail: translate("apply.followupSameConnection"),
    });
    // 沙箱在「标记验证通过」之后又被改过：拦住晋级，并把变化项说成人读标签（R55-B5）
    const drifted = await buildPromotionEntryFromVerification(
      record(),
      verification(applyPlan),
      prodConn,
      deps(applyPlan, vi.fn(async () => document("server:\n  port: 9091")))
    );
    expect(drifted).toMatchObject({
      ok: false,
      error: "apply_followup_failed",
      detail: translate("apply.followupVerificationDrift", { items: "public/DEFAULT_GROUP/app.yaml" }),
    });
    if (drifted.ok) throw new Error("expected promotion to be blocked");
    // 以前这里直接吐 itemId 的 `provider|conn|ns|group|dataId|key` 拼接串
    expect(drifted.detail).not.toContain("|");
  });

  it("captures verification fingerprints from the current sandbox target documents", async () => {
    const applyPlan = plan();
    const getConfigDocument = vi.fn(async () => document("server:\n  port: 8080", "sandbox-v2"));

    const fingerprints = await fingerprintsForCurrentTargets(executableItemsForRecord(applyPlan, record()), sandboxConn, deps(applyPlan, getConfigDocument));

    expect(getConfigDocument).toHaveBeenCalledWith(sandboxConn, "public", "app.yaml", "DEFAULT_GROUP");
    expect(fingerprints).toEqual([
      {
        itemId: applyPlan.items[0].id,
        fingerprint: fingerprintApplyPlanValue(applyPlan.items[0].ref, value("server:\n  port: 8080", "sandbox-v2")),
      },
    ]);
    // 新语义：指纹基于内容 + md5；version 元数据（含 md5）漂移才改变指纹
    expect(fingerprints[0].fingerprint).not.toBe(fingerprintApplyPlanValue(applyPlan.items[0].ref, value("server:\n  port: 8080", "v3")));
  });

  it("captures missing current target fingerprints for sandbox delete results", async () => {
    const applyPlan = plan({
      items: [
        {
          ref: ref(sandboxConn),
          sourceValue: { exists: false },
          targetValue: value("server:\n  port: 9090"),
        },
      ],
    });
    const getConfigDocument = vi.fn(async () => {
      throw new Error("404 not found");
    });

    const fingerprints = await fingerprintsForCurrentTargets(executableItemsForRecord(applyPlan, record()), sandboxConn, deps(applyPlan, getConfigDocument));

    expect(fingerprints).toEqual([
      {
        itemId: applyPlan.items[0].id,
        fingerprint: fingerprintApplyPlanValue(applyPlan.items[0].ref, { exists: false }),
      },
    ]);
  });

  it("builds promote dry-run entries from verified sandbox apply records", async () => {
    const applyPlan = plan();
    const getConfigDocument = vi.fn(async () => document("server:\n  port: 8080"));
    const result = await buildPromotionEntryFromVerification(record(), verification(applyPlan), prodConn, deps(applyPlan, getConfigDocument));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.detail);
    expect(getConfigDocument).toHaveBeenCalledWith(sandboxConn, "public", "app.yaml", "DEFAULT_GROUP");
    expect(result.entry.sourceType).toBe("promote");
    expect(result.entry.source.connectionId).toBe(sandboxConn.id);
    expect(result.entry.target.connectionId).toBe(prodConn.id);
    expect(result.entry.items[0].sourceRef).toEqual(applyPlan.items[0].ref);
    expect(result.entry.items[0].targetRef).toMatchObject({ connectionId: prodConn.id, dataId: "app.yaml" });
    expect(result.entry.origin).toEqual({ mode: "promote", returnMode: "history" });
  });
});

describe("rollback scope follows what one execution actually wrote (R66-WP9)", () => {
  function location(dataId: string, key = "__document") {
    return { namespace: "public", group: "DEFAULT_GROUP", dataId, key };
  }

  /** 完整计划 3 项：执行时用户只勾了其中 1 项，planId 仍然指向这份完整计划。 */
  function multiPlan(dataIds = ["app.yaml", "cache.yaml", "gateway.yaml"]): ApplyPlan {
    return plan({
      items: dataIds.map((dataId, index) => ({
        ref: ref(sandboxConn, dataId),
        sourceValue: value(`server:\n  port: 80${index}`, `src-${dataId}`),
        targetValue: value(`server:\n  port: 90${index}`, `tgt-${dataId}`),
      })),
    });
  }

  it("keeps untouched plan items out of the rollback entry", async () => {
    const applyPlan = multiPlan();
    const result = await buildRollbackEntryFromApplyRecord(
      record({ appliedLocations: [location("app.yaml")] }),
      deps(applyPlan)
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.detail);
    // 没勾选、没写入、也没进备份的 cache.yaml / gateway.yaml 一旦被收进回退计划，
    // 快照里没有旧内容就会判成删除，用户点执行就是删生产配置。
    expect(result.entry.items.map((item) => item.dataId)).toEqual(["app.yaml"]);
  });

  it("falls back to backup snapshot coverage for records without a location list", async () => {
    const applyPlan = multiPlan();
    const covered = deps(applyPlan);
    const result = await buildRollbackEntryFromApplyRecord(record(), {
      ...covered,
      getSnapshot: vi.fn(async (id) => snapshotCovering(applyPlan.items.filter((item) => item.ref.dataId === "app.yaml"), id)),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.detail);
    expect(result.entry.items.map((item) => item.dataId)).toEqual(["app.yaml"]);
  });

  it("still rolls back configs this run created but the snapshot has no copy of", async () => {
    const applyPlan = multiPlan();
    // 本次新建的 cache.yaml：写前目标上不存在，因此备份快照里没有它。
    const covered = deps(applyPlan);
    const result = await buildRollbackEntryFromApplyRecord(record({ appliedLocations: [location("cache.yaml")] }), {
      ...covered,
      getSnapshot: vi.fn(async (id) => snapshotCovering([], id)),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.detail);
    expect(result.entry.items.map((item) => item.dataId)).toEqual(["cache.yaml"]);
  });

  it("refuses a rollback entry when nothing from the run is covered by the scene", async () => {
    const applyPlan = multiPlan();
    await expect(
      buildRollbackEntryFromApplyRecord(record({ appliedLocations: [location("removed.yaml")] }), deps(applyPlan))
    ).resolves.toMatchObject({
      ok: false,
      error: "apply_followup_failed",
      detail: translate("apply.followupNoBackedUpItems", { id: "snap-before-1" }),
    });
  });

  it("narrows promotion to the same run so unverified configs are not pushed to production", async () => {
    const applyPlan = multiPlan();
    const scoped: ApplyPlanItem[] = [applyPlan.items[0]];
    const verify = {
      ...verification(applyPlan),
      verifiedTargetFingerprints: [{ itemId: scoped[0].id, fingerprint: fingerprintApplyPlanValue(scoped[0].ref, value("server:\n  port: 800")) }],
    };
    const result = await buildPromotionEntryFromVerification(
      record({ appliedLocations: [location("app.yaml")] }),
      verify,
      prodConn,
      deps(applyPlan, vi.fn(async () => document("server:\n  port: 800")))
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.detail);
    expect(result.entry.items.map((item) => item.dataId)).toEqual(["app.yaml"]);
  });
});

/**
 * 晋级的生产命名空间必须由调用方点明（轮76 S31 真机量出来的洞）。
 *
 * Nacos/MSE 的 namespace id 是每套集群各发各的（MSE 是 36 位 UUID）。以前沿用沙箱那个 id，
 * 计划把「同一个 id 在生产集群里不存在」报成新建，用户以为在覆盖生产配置，其实写进没人读的租户。
 */
describe("promotion writes the namespace the user named, not the sandbox one by reflex", () => {
  it("rewrites every item target ref and the entry endpoint with the chosen namespace", async () => {
    const applyPlan = plan();
    const result = await buildPromotionEntryFromVerification(
      record(),
      verification(applyPlan),
      prodConn,
      deps(applyPlan, vi.fn(async () => document("server:\n  port: 8080"))),
      { targetNamespace: "prod-tenant" }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.detail);
    // 计划项与入口端点必须一起换：只改一处的话 dry-run 报的「覆盖/新建」和真正落笔的位置会各说一套。
    expect(result.entry.items[0].targetRef?.namespace).toBe("prod-tenant");
    expect(result.entry.items[0].namespace).toBe("prod-tenant");
    expect(result.entry.target).toMatchObject({
      connectionId: prodConn.id,
      namespace: "prod-tenant",
      label: "Production / prod-tenant",
    });
    // 沙箱那侧不能被生产命名空间污染：漂移复检读的就是 sourceRef 那个位置。
    expect(result.entry.items[0].sourceRef?.namespace).toBe("public");
    expect(result.entry.source).toMatchObject({ connectionId: sandboxConn.id, namespace: "public" });
  });

  it("keeps the plan target namespace only when the caller names none", async () => {
    const applyPlan = plan();
    const getConfigDocument = vi.fn(async () => document("server:\n  port: 8080"));

    const legacy = await buildPromotionEntryFromVerification(record(), verification(applyPlan), prodConn, deps(applyPlan, getConfigDocument));
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) throw new Error(legacy.detail);
    expect(legacy.entry.target.namespace).toBe("public");
    expect(legacy.entry.items[0].targetRef?.namespace).toBe("public");

    // 空串是「公共空间」这一档，不是「没选」：Nacos 的 public 在接口里就是空 tenant。
    // 把它当假值退回沙箱那个 id，用户在面板里点了 public，实际写的却是别的租户。
    const publicNamespace = await buildPromotionEntryFromVerification(
      record(),
      verification(applyPlan),
      prodConn,
      deps(applyPlan, getConfigDocument),
      { targetNamespace: "" }
    );
    expect(publicNamespace.ok).toBe(true);
    if (!publicNamespace.ok) throw new Error(publicNamespace.detail);
    expect(publicNamespace.entry.target.namespace).toBe("");
    expect(publicNamespace.entry.target.label).toBe("Production / public");
    expect(publicNamespace.entry.items[0].targetRef?.namespace).toBe("");

    const padded = await buildPromotionEntryFromVerification(
      record(),
      verification(applyPlan),
      prodConn,
      deps(applyPlan, getConfigDocument),
      { targetNamespace: "  prod-tenant  " }
    );
    expect(padded.ok).toBe(true);
    if (!padded.ok) throw new Error(padded.detail);
    expect(padded.entry.target.namespace).toBe("prod-tenant");
  });});

/**
 * 「生产目标」这一栏只准挂真写得进去的连接（轮76 S31 补）。
 *
 * 本地快照与只读连接挂在候选里，用户要一路走到执行那步才会收到一条永远不可能成功的错误；
 * 但 apollo/consul 不能顺手一起剔——计划那条写链路在 Go 侧同样有 PublishConfig。
 */
describe("promotion targets must be writable environments", () => {
  const snapshotConn = { ...connection("conn-snap", "Mirror Snapshot", "Snapshot"), sourceType: "local-snapshot" as const };
  const readonlyConn = { ...connection("conn-ro", "Mirror Read Only", "Readonly"), readonly: true };
  const forcedConn = { ...connection("conn-force", "Mirror Forced Local", "Forced"), forceLocalSnapshot: true };
  const apolloProd = { ...connection("conn-apollo", "Apollo Production", "Apollo"), provider: "apollo" as const };
  const consulConn = { ...connection("conn-consul", "Consul Standard", "Consul"), provider: "consul" as const };

  it("drops local snapshots and read-only connections out of the candidate list", () => {
    const candidates = promotionTargetCandidates(
      [sourceConn, sandboxConn, prodConn, snapshotConn, readonlyConn, forcedConn],
      record(),
      verification(plan())
    );

    expect(candidates.map((conn) => conn.id)).toEqual(["conn-prod", "conn-dev"]);
    for (const conn of [snapshotConn, readonlyConn, forcedConn]) {
      expect(isPromotionTargetConnection(conn), conn.id + " 根本写不进去，不该出现在生产目标里").toBe(false);
    }
    expect(isPromotionTargetConnection(prodConn)).toBe(true);
  });

  it("keeps apollo and consul eligible, and still puts production-marked targets first", () => {
    const candidates = promotionTargetCandidates(
      [sourceConn, sandboxConn, consulConn, readonlyConn, apolloProd, prodConn],
      record(),
      verification(plan())
    );
    const ids = candidates.map((conn) => conn.id);

    expect(ids).toContain("conn-apollo");
    expect(ids).toContain("conn-consul");
    expect(ids).not.toContain("conn-ro");
    // 带生产标记的两条排在前面：下拉默认指着哪条，用户多半就晋级哪条。
    // 组内保持连接表原序：非标记的那组里 conn-dev 在前，因为它先出现在输入数组里。
    expect(ids).toEqual(["conn-apollo", "conn-prod", "conn-dev", "conn-consul"]);
  });
});
