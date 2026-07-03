import type { Snapshot } from "../api/snapshot";
import { DEFAULT_PROJECT_NAME, type Connection, connectionProjectName } from "../store/connections";

export function snapshotConnectionId(snapshotId: string): string {
  return `snapshot:${snapshotId}`;
}

export function snapshotNamespaceForDiff(snapshot: Pick<Snapshot, "source">): string {
  const namespace = snapshot.source.namespaceId || snapshot.source.namespace || "";
  return namespace === "public" ? "" : namespace;
}

export function buildSnapshotConnection(snapshot: Snapshot, sourceConnection?: Connection): Connection {
  const name = snapshot.name || snapshot.id;
  return {
    id: snapshotConnectionId(snapshot.id),
    name,
    projectName: sourceConnection ? connectionProjectName(sourceConnection) : DEFAULT_PROJECT_NAME,
    environmentName: "本地快照",
    sourceName: name,
    sourceType: "local-snapshot",
    localPath: snapshot.path,
    forceLocalSnapshot: true,
    readonly: true,
    isDefaultSource: false,
    tags: ["snapshot"],
    provider: "local",
    distribution: "opensource",
    authType: "none",
    baseUrl: snapshot.path,
    username: "",
    password: "",
    defaultNamespace: snapshotNamespaceForDiff(snapshot),
  };
}

export function mergeSnapshotRuntimeConnection(connections: Connection[], snapshotConnection: Connection): Connection[] {
  const index = connections.findIndex((conn) => conn.id === snapshotConnection.id);
  if (index < 0) return [...connections, snapshotConnection];
  return connections.map((conn, itemIndex) => (itemIndex === index ? snapshotConnection : conn));
}
