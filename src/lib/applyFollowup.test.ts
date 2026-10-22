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
