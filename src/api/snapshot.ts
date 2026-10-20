// 快照 API 封装
import { CreateSnapshot, GetSnapshot, ListSnapshots, DeleteSnapshot, ValidateSnapshot } from "../../wailsjs/go/app/App";

/** 快照来源。 */
export interface SnapshotSource {
  provider?: "nacos" | "apollo" | "consul" | "local";
  connectionId: string;
  connectionName: string;
  namespace: string;
  namespaceId: string;
}

/** 快照中的单个配置。 */
export interface ConfigSnapshot {
  namespace?: string;
  dataId: string;
  group: string;
  contentType?: string;
  content: string;
  configType: string;
  updateTime: string;
}

/** 本地快照。 */
export interface Snapshot {
  schemaVersion?: number;
  toolVersion?: string;
  id: string;
  path: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  source: SnapshotSource;
  configs: ConfigSnapshot[];
  remoteSnapshotId?: string;
  importedFrom?: {
    type: string;
    remotePath: string;
    importedAt: string;
  };
}

// 创建快照
export async function createSnapshot(source: SnapshotSource, configs: ConfigSnapshot[]): Promise<Snapshot> {
  return CreateSnapshot(source, configs) as Promise<Snapshot>;
}

// 获取快照
export async function getSnapshot(id: string): Promise<Snapshot> {
  return GetSnapshot(id) as Promise<Snapshot>;
}

// 列出所有快照
export async function listSnapshots(): Promise<Snapshot[]> {
  return ListSnapshots() as Promise<Snapshot[]>;
}

// 删除快照
export async function deleteSnapshot(id: string): Promise<void> {
  return DeleteSnapshot(id);
}

// 验证快照目录
export async function validateSnapshot(path: string): Promise<boolean> {
  try {
    await ValidateSnapshot(path);
    return true;
  } catch {
    return false;
  }
}

// 从配置列表创建快照
export async function createSnapshotFromConfigs(
  connectionId: string,
  connectionName: string,
  namespace: string,
  namespaceId: string,
  configs: Array<{
    dataId: string;
    group: string;
    content: string;
    configType: string;
    updateTime: string;
  }>,
  /**
   * 来源中心类型（R55-D2 同口径）。省略时 Go 侧按 nacos 兜底——
   * 那就等于把 Apollo/Consul 的快照也标成 nacos，快照列表与恢复入口都认不出来。
   */
  provider: SnapshotSource["provider"] = "nacos"
): Promise<Snapshot> {
  const source: SnapshotSource = {
    provider,
    connectionId,
    connectionName,
    namespace,
    namespaceId,
  };

  const snapshotConfigs: ConfigSnapshot[] = configs.map((cfg) => ({
    namespace,
    dataId: cfg.dataId,
    group: cfg.group,
    contentType: cfg.configType,
    content: cfg.content,
    configType: cfg.configType,
    updateTime: cfg.updateTime,
  }));

  return createSnapshot(source, snapshotConfigs);
}
