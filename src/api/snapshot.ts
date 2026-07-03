// 快照 API 封装
import {
  CreateSnapshot,
  GetSnapshot,
  ListSnapshots,
  DeleteSnapshot,
  ValidateSnapshot,
} from "../../wailsjs/go/main/App";
import type { SnapshotSource, ConfigSnapshot, Snapshot } from "../../wailsjs/go/main/App";

// 快照来源
export type { SnapshotSource, ConfigSnapshot, Snapshot };

// 创建快照
export async function createSnapshot(
  source: SnapshotSource,
  configs: ConfigSnapshot[]
): Promise<Snapshot> {
  return CreateSnapshot(source, configs);
}

// 获取快照
export async function getSnapshot(id: string): Promise<Snapshot> {
  return GetSnapshot(id);
}

// 列出所有快照
export async function listSnapshots(): Promise<Snapshot[]> {
  return ListSnapshots();
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
  }>
): Promise<Snapshot> {
  const source: SnapshotSource = {
    connectionId,
    connectionName,
    namespace,
    namespaceId,
  };

  const snapshotConfigs: ConfigSnapshot[] = configs.map((cfg) => ({
    dataId: cfg.dataId,
    group: cfg.group,
    content: cfg.content,
    configType: cfg.configType,
    updateTime: cfg.updateTime,
  }));

  return createSnapshot(source, snapshotConfigs);
}
