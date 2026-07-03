// 快照工具库
import type { Snapshot, ConfigSnapshot } from "../api/snapshot";

/** 快照统计信息 */
export interface SnapshotStats {
  totalConfigs: number;
  totalGroups: number;
  totalNamespaces: number;
  latestUpdateTime: string | null;
}

/** 获取快照统计 */
export function getSnapshotStats(snapshot: Snapshot): SnapshotStats {
  const groups = new Set<string>();
  const namespaces = new Set<string>();
  let latestUpdateTime: string | null = null;

  snapshot.configs.forEach((cfg) => {
    groups.add(cfg.group);
    if (snapshot.source.namespace) {
      namespaces.add(snapshot.source.namespace);
    }
    if (cfg.updateTime && (!latestUpdateTime || cfg.updateTime > latestUpdateTime)) {
      latestUpdateTime = cfg.updateTime;
    }
  });

  return {
    totalConfigs: snapshot.configs.length,
    totalGroups: groups.size,
    totalNamespaces: namespaces.size,
    latestUpdateTime,
  };
}

/** 格式化快照名称 */
export function formatSnapshotName(snapshot: Snapshot): string {
  return snapshot.name || snapshot.id;
}

/** 格式化时间 */
export function formatTime(time: string | Date): string {
  const d = typeof time === "string" ? new Date(time) : time;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 比较两个快照的差异 */
export function compareSnapshots(
  left: Snapshot,
  right: Snapshot
): Array<{
  dataId: string;
  group: string;
  leftContent: string;
  rightContent: string;
  diffType: "added" | "deleted" | "modified" | "unchanged";
}> {
  const leftMap = new Map<string, ConfigSnapshot>();
  const rightMap = new Map<string, ConfigSnapshot>();

  left.configs.forEach((cfg) => {
    const key = `${cfg.group}/${cfg.dataId}`;
    leftMap.set(key, cfg);
  });

  right.configs.forEach((cfg) => {
    const key = `${cfg.group}/${cfg.dataId}`;
    rightMap.set(key, cfg);
  });

  const allKeys = new Set([...leftMap.keys(), ...rightMap.keys()]);
  const diffs: Array<{
    dataId: string;
    group: string;
    leftContent: string;
    rightContent: string;
    diffType: "added" | "deleted" | "modified" | "unchanged";
  }> = [];

  allKeys.forEach((key) => {
    const leftCfg = leftMap.get(key);
    const rightCfg = rightMap.get(key);
    const [group, dataId] = key.split("/");

    if (!leftCfg && rightCfg) {
      diffs.push({
        dataId,
        group,
        leftContent: "",
        rightContent: rightCfg.content,
        diffType: "added",
      });
    } else if (leftCfg && !rightCfg) {
      diffs.push({
        dataId,
        group,
        leftContent: leftCfg.content,
        rightContent: "",
        diffType: "deleted",
      });
    } else if (leftCfg && rightCfg) {
      const diffType = leftCfg.content === rightCfg.content ? "unchanged" : "modified";
      diffs.push({
        dataId,
        group,
        leftContent: leftCfg.content,
        rightContent: rightCfg.content,
        diffType,
      });
    }
  });

  return diffs.sort((a, b) => a.dataId.localeCompare(b.dataId));
}
