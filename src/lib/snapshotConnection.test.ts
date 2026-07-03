import { describe, expect, it } from "vitest";
import type { Snapshot } from "../api/snapshot";
import type { Connection } from "../store/connections";
import { buildSnapshotConnection, mergeSnapshotRuntimeConnection, snapshotConnectionId } from "./snapshotConnection";

const sourceConnection: Connection = {
  id: "conn-1",
  name: "dev",
  projectName: "订单系统",
  environmentName: "开发",
  sourceName: "云端",
  baseUrl: "http://localhost:8848/nacos",
  username: "",
  password: "",
  defaultNamespace: "public",
};

const snapshot: Snapshot = {
  id: "snap-1",
  path: "C:\\Users\\tester\\.confscope\\backups\\snap-1",
  name: "dev_public_20260101",
  description: "",
  createdAt: "2026-01-01T10:00:00Z",
  updatedAt: "2026-01-01T10:00:00Z",
  source: {
    connectionId: "conn-1",
    connectionName: "dev",
    namespace: "public",
    namespaceId: "public",
  },
  configs: [],
};

describe("snapshotConnection", () => {
  it("builds a readonly local snapshot connection for DiffView", () => {
    const conn = buildSnapshotConnection(snapshot, sourceConnection);

    expect(conn.id).toBe(snapshotConnectionId(snapshot.id));
    expect(conn.provider).toBe("local");
    expect(conn.sourceType).toBe("local-snapshot");
    expect(conn.readonly).toBe(true);
    expect(conn.projectName).toBe("订单系统");
    expect(conn.environmentName).toBe("本地快照");
    expect(conn.localPath).toBe(snapshot.path);
    expect(conn.baseUrl).toBe(snapshot.path);
    expect(conn.defaultNamespace).toBe("");
  });

  it("replaces an existing runtime snapshot connection without touching other connections", () => {
    const first = buildSnapshotConnection(snapshot, sourceConnection);
    const updated = buildSnapshotConnection({ ...snapshot, name: "renamed" }, sourceConnection);

    const merged = mergeSnapshotRuntimeConnection([sourceConnection, first], updated);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(sourceConnection);
    expect(merged[1].name).toBe("renamed");
  });
});
