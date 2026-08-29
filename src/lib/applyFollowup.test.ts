import { describe, expect, it, vi } from "vitest";
import type { ConfigDocument } from "../api/nacos";
import type { Snapshot } from "../api/snapshot";
import type { Connection } from "../store/connections";
import type { ApplyVerification } from "../store/applyVerifications";
import type { OperationRecord } from "../store/operationHistory";
import { buildApplyPlan, fingerprintApplyPlanValue, type ApplyPlan, type BuildApplyPlanInput } from "./applyPlan";
import {
  buildPromotionEntryFromVerification,
  buildRollbackEntryFromApplyRecord,
  canBuildRollbackEntry,
  fingerprintsForCurrentPlanTargets,
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

function deps(applyPlan = plan(), getConfigDocument: ApplyFollowupDeps["getConfigDocument"] = vi.fn()): ApplyFollowupDeps {
  return {
    connections: [sourceConn, sandboxConn, prodConn],
    getApplyPlan: vi.fn((id) => (id === applyPlan.id ? applyPlan : null)),
    getSnapshot: vi.fn(async (id) => snapshot({ id })),
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
      detail: expect.stringContaining("planId"),
    });
    await expect(buildRollbackEntryFromApplyRecord(record({ backupSnapshotId: undefined }), deps())).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining("backupSnapshotId"),
    });
    await expect(buildRollbackEntryFromApplyRecord(record(), { ...deps(), getApplyPlan: vi.fn(() => null) })).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining("plan-apply-1"),
    });
    await expect(
      buildRollbackEntryFromApplyRecord(record(), { ...deps(), getSnapshot: vi.fn(async () => snapshot({ path: "" })) })
    ).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining("path"),
    });
  });

  it("blocks promotion when sandbox verification is missing, points to the same target, or has drifted", async () => {
    const applyPlan = plan();
    await expect(buildPromotionEntryFromVerification(record(), null, prodConn, deps(applyPlan))).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining("verification"),
    });
    await expect(buildPromotionEntryFromVerification(record(), verification(applyPlan), sandboxConn, deps(applyPlan))).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining("same"),
    });
    await expect(
      buildPromotionEntryFromVerification(record(), verification(applyPlan), prodConn, deps(applyPlan, vi.fn(async () => document("server:\n  port: 9091"))))
    ).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining("drift"),
    });
  });

  it("captures verification fingerprints from the current sandbox target documents", async () => {
    const applyPlan = plan();
    const getConfigDocument = vi.fn(async () => document("server:\n  port: 8080", "sandbox-v2"));

    const fingerprints = await fingerprintsForCurrentPlanTargets(applyPlan, sandboxConn, deps(applyPlan, getConfigDocument));

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

    const fingerprints = await fingerprintsForCurrentPlanTargets(applyPlan, sandboxConn, deps(applyPlan, getConfigDocument));

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
