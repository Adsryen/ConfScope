import { describe, expect, it, vi } from "vitest";
import type { ConfigDocument } from "../api/nacos";
import type { Snapshot } from "../api/snapshot";
import type { Connection } from "../store/connections";
import type { ApplyEntryPayload, ApplyEntryRef } from "./applyEntry";
import { snapshotConnectionId } from "./snapshotConnection";
import { buildApplyPlanFromEntry, type ApplyPlanDraftDeps } from "./applyPlanDraft";

const sourceConn = connection("conn-dev", "Dev", "Development");
const targetConn = connection("conn-prod", "Prod", "Production");

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

function document(content: string, format = "properties", updateTime = ""): ConfigDocument {
  return {
    content,
    format,
    version: updateTime ? `${updateTime}-version` : "",
    source: "nacos",
    updateTime,
  };
}

function applyRef(overrides: Partial<ApplyEntryRef> = {}): ApplyEntryRef {
  return {
    provider: "nacos",
    connectionId: "conn-prod",
    namespace: "public",
    group: "DEFAULT_GROUP",
    dataId: "app.properties",
    key: "__document",
    ...overrides,
  };
}

function entry(items: ApplyEntryPayload["items"], scope: ApplyEntryPayload["scope"] = "config"): ApplyEntryPayload {
  return {
    sourceType: "diff",
    scope,
    source: {
      provider: "nacos",
      connectionId: "conn-dev",
      connectionName: "Dev",
      namespace: "public",
      label: "Dev / public",
    },
    target: {
      provider: "nacos",
      connectionId: "conn-prod",
      connectionName: "Prod",
      namespace: "public",
      label: "Prod / public",
    },
    items,
    rangeSummary: {
      count: items.length,
      skippedCount: 0,
      riskLevel: items.length > 1 ? "medium" : "low",
      riskReasons: items.length > 1 ? ["batch_apply"] : [],
    },
    origin: { mode: "diff", returnMode: "diff" },
  };
}

function deps(getConfigDocument: ApplyPlanDraftDeps["getConfigDocument"], connections = [sourceConn, targetConn]): ApplyPlanDraftDeps {
  return {
    connections,
    getSnapshot: vi.fn(),
    getConfigDocument,
  };
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id: "snap-1",
    path: "C:\\backups\\snap-1",
    name: "snapshot-one",
    description: "",
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:00:00.000Z",
    source: {
      provider: "nacos",
      connectionId: "conn-prod",
      connectionName: "Prod",
      namespace: "public",
      namespaceId: "public",
    },
    configs: [],
    ...overrides,
  };
}

describe("buildApplyPlanFromEntry", () => {
  it("builds a dry-run plan from ordinary Nacos documents and summarizes actions", async () => {
    const getConfigDocument = vi.fn(async (conn: Connection) =>
      conn.id === "conn-dev"
        ? document("new.key=from-source\nchanged.key=from-source\nsame.key=same")
        : document("changed.key=from-target\nremoved.key=old\nsame.key=same")
    );
    const payload = entry(
      ["new.key", "changed.key", "removed.key", "same.key"].map((key) => {
        const sourceRef = applyRef({ connectionId: "conn-dev", key });
        const targetRef = applyRef({ connectionId: "conn-prod", key });
        return { ...targetRef, sourceRef, targetRef };
      }),
      "batch"
    );

    const result = await buildApplyPlanFromEntry(payload, deps(getConfigDocument));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.detail);
    expect(result.plan.summary).toEqual({
      total: 4,
      create: 1,
      overwrite: 1,
      delete: 1,
      skip: 1,
      parse_error: 0,
      blocked: 0,
    });
    expect(result.plan.items.map((item) => [item.ref.key, item.action])).toEqual([
      ["new.key", "create"],
      ["changed.key", "overwrite"],
      ["removed.key", "delete"],
      ["same.key", "skip"],
    ]);
    expect(result.plan.source.label).toBe("Dev / public");
    expect(result.plan.target.label).toBe("Prod / public");
  });

  it("reads sourceRef and targetRef locations independently and writes target refs into plan items", async () => {
    const getConfigDocument = vi.fn(async (conn: Connection, _namespace: string, dataId: string) =>
      conn.id === "conn-dev" && dataId === "source.properties"
        ? document("feature.enabled=true")
        : document("feature.enabled=false")
    );
    const sourceRef = applyRef({ connectionId: "conn-dev", dataId: "source.properties", key: "feature.enabled" });
    const targetRef = applyRef({ connectionId: "conn-prod", dataId: "target.properties", key: "feature.enabled" });

    const result = await buildApplyPlanFromEntry(entry([{ ...targetRef, sourceRef, targetRef }], "key"), deps(getConfigDocument));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.detail);
    expect(getConfigDocument).toHaveBeenCalledWith(sourceConn, "public", "source.properties", "DEFAULT_GROUP");
    expect(getConfigDocument).toHaveBeenCalledWith(targetConn, "public", "target.properties", "DEFAULT_GROUP");
    expect(result.plan.items[0].ref).toEqual(targetRef);
    expect(result.plan.items[0].sourceValue.value).toBe("true");
    expect(result.plan.items[0].targetValue.value).toBe("false");
  });

  it("resolves snapshot sources through getSnapshot and buildSnapshotConnection", async () => {
    const snap = snapshot();
    const getSnapshot = vi.fn(async () => snap);
    const getConfigDocument = vi.fn(async (conn: Connection) =>
      conn.id === snapshotConnectionId("snap-1") ? document("server:\n  port: 8080", "yaml") : document("server:\n  port: 9090", "yaml")
    );
    const sourceRef = applyRef({
      provider: "local",
      connectionId: snapshotConnectionId("snap-1"),
      namespace: "",
      dataId: "app.yaml",
    });
    const targetRef = applyRef({
      connectionId: "conn-prod",
      namespace: "",
      dataId: "app.yaml",
    });
    const payload: ApplyEntryPayload = {
      ...entry([{ ...targetRef, sourceRef, targetRef }]),
      sourceType: "backup",
      source: {
        provider: "local",
        connectionId: snapshotConnectionId("snap-1"),
        connectionName: "snapshot-one",
        namespace: "",
        label: "snapshot-one / public",
      },
      origin: { mode: "backup", returnMode: "backup" },
    };

    const result = await buildApplyPlanFromEntry(payload, {
      connections: [targetConn],
      getSnapshot,
      getConfigDocument,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.detail);
    expect(getSnapshot).toHaveBeenCalledWith("snap-1");
    expect(result.sourceConnection).toMatchObject({
      id: snapshotConnectionId("snap-1"),
      sourceType: "local-snapshot",
      localPath: "C:\\backups\\snap-1",
      readonly: true,
    });
    expect(result.targetConnection).toEqual(targetConn);
    expect(getConfigDocument).toHaveBeenCalledWith(
      expect.objectContaining({ id: snapshotConnectionId("snap-1"), sourceType: "local-snapshot" }),
      "",
      "app.yaml",
      "DEFAULT_GROUP"
    );
    expect(result.plan.items[0].action).toBe("overwrite");
  });

  it("returns copyable errors for invalid snapshot sources and config read failures", async () => {
    const sourceRef = applyRef({
      provider: "local",
      connectionId: snapshotConnectionId("snap-missing-path"),
      namespace: "",
      dataId: "app.yaml",
    });
    const targetRef = applyRef({ connectionId: "conn-prod", namespace: "", dataId: "app.yaml" });
    const payload: ApplyEntryPayload = {
      ...entry([{ ...targetRef, sourceRef, targetRef }]),
      sourceType: "backup",
      source: {
        provider: "local",
        connectionId: snapshotConnectionId("snap-missing-path"),
        connectionName: "missing path",
        namespace: "",
        label: "missing path",
      },
      origin: { mode: "backup", returnMode: "backup" },
    };

    const missingPath = await buildApplyPlanFromEntry(payload, {
      connections: [targetConn],
      getSnapshot: vi.fn(async () => snapshot({ id: "snap-missing-path", path: "" })),
      getConfigDocument: vi.fn(),
    });

    expect(missingPath.ok).toBe(false);
    if (missingPath.ok) throw new Error("expected missing path to fail");
    expect(missingPath.detail).toContain("snapshot:snap-missing-path");
    expect(missingPath.detail).toContain("path");

    const readFailure = await buildApplyPlanFromEntry(
      entry([{ ...targetRef, sourceRef: applyRef({ connectionId: "conn-dev", dataId: "app.yaml" }), targetRef }]),
      {
        connections: [sourceConn, targetConn],
        getSnapshot: vi.fn(),
        getConfigDocument: vi.fn(async () => {
          throw new Error("network EOF");
        }),
      }
    );

    expect(readFailure.ok).toBe(false);
    if (readFailure.ok) throw new Error("expected read failure to fail");
    expect(readFailure.detail).toContain("network EOF");
    expect(readFailure.detail).toContain("app.yaml");
  });
});
