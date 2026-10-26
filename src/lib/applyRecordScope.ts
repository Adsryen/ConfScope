// 执行现场范围：一次 apply 真正写了哪些配置位置，回退/晋升就只能作用于这些位置。
//
// 为什么要单独一层（轮66 R66-WP9）：操作记录里的 planId 指向**完整计划**，而执行时用户只勾选了
// 其中一部分（selectPlanItems 造 workingPlan，但 plan.id 不变）。以前回退入口直接拿完整计划的
// 全部可执行项去比对备份快照，没被勾选、也就没被备份的配置一律判成 delete 且默认勾选——
// 用户照着「按备份快照回退已写入项」点下去，删掉的是本次根本没碰的配置。
// 这一层把「本次现场」定义成可测的纯函数：新记录按记录里的 appliedLocations 收口，
// 老记录（没有这个字段）退到备份快照的覆盖范围，两者都收不到就拒绝构造入口。
import type { Snapshot } from "../api/snapshot";
import type { ApplyPlanItem, ApplyPlanRef } from "./applyPlan";
import { DOCUMENT_KEY } from "./applyPlan";
import type { AppliedConfigLocation } from "../store/operationHistory";

/** 空命名空间与 public 是同一个地方，比对两侧都要归一。 */
function normNamespace(value: string | undefined): string {
  return value && value.trim() ? value : "public";
}

function normKey(value: string | undefined): string {
  return value && value !== DOCUMENT_KEY ? value : DOCUMENT_KEY;
}

/** 位置标识：命名空间 + 分组 + dataId + key（文档级用 __document）。 */
export function appliedLocationKey(namespace: string, group: string, dataId: string, key?: string): string {
  return [normNamespace(namespace), group, dataId, normKey(key)].join("\u0000");
}

/** 写入位置取 target 侧（跨连接时 targetRef 才是真正落点）。 */
function writeLocation(item: ApplyPlanItem): ApplyPlanRef {
  return item.targetRef ?? item.ref;
}

/** 单个落笔位置：与清单同一套归一口径，逐条累积与整批构造共用这一支笔。 */
export function appliedLocationForItem(item: ApplyPlanItem): AppliedConfigLocation {
  const ref = writeLocation(item);
  return { namespace: ref.namespace, group: ref.group, dataId: ref.dataId, key: ref.key };
}

/**
 * 落笔位置收集器（轮79 E4）。
 *
 * 执行器逐条写、逐条记，同一位置的重复落笔（同 dataId 先删后建这类）只留一条，
 * 口径与 `appliedLocationsFromItems` 完全一致——「本次真正写了哪儿」不能有第二套算法。
 */
export function createAppliedLocationCollector(): {
  add: (item: ApplyPlanItem) => void;
  list: () => AppliedConfigLocation[];
} {
  const seen = new Set<string>();
  const locations: AppliedConfigLocation[] = [];
  return {
    add(item: ApplyPlanItem) {
      const location = appliedLocationForItem(item);
      const key = appliedLocationKey(location.namespace, location.group, location.dataId, location.key);
      if (seen.has(key)) return;
      seen.add(key);
      locations.push(location);
    },
    list: () => locations.slice(),
  };
}

/** 把一批项记成位置清单（计划范围口径；落笔范围请走收集器）。 */
export function appliedLocationsFromItems(items: ApplyPlanItem[]): AppliedConfigLocation[] {
  const collector = createAppliedLocationCollector();
  for (const item of items) collector.add(item);
  return collector.list();
}

/**
 * 按记录里的位置清单收口执行项。
 *
 * 只保留能对上号的项：计划被重新生成过、id 变了但位置没变也能对上；对不上的项直接丢掉，
 * 宁可为漏掉一条改动作说明，也不把没写过的配置算进回退范围。
 */
export function restrictItemsByAppliedLocations(
  items: ApplyPlanItem[],
  locations: AppliedConfigLocation[]
): ApplyPlanItem[] {
  const wanted = new Set(
    locations.map((location) => appliedLocationKey(location.namespace, location.group, location.dataId, location.key))
  );
  return items.filter((item) => {
    const ref = writeLocation(item);
    return wanted.has(appliedLocationKey(ref.namespace, ref.group, ref.dataId, ref.key));
  });
}

/**
 * 备份快照覆盖到的配置（文档级：命名空间 + 分组 + dataId）。
 *
 * 快照是按 item.ref 存的，跨命名空间执行时落点又看 targetRef，所以两侧任一能对上都算覆盖到——
 * 只会放宽「漏回退」，不会放宽成「误删」。key 级项按它所属文档判断，粒度不变。
 */
export function restrictItemsToSnapshotCoverage(items: ApplyPlanItem[], snapshot: Snapshot): ApplyPlanItem[] {
  const covered = new Set(
    (snapshot.configs ?? []).map((config) => appliedLocationKey(config.namespace ?? "", config.group, config.dataId, DOCUMENT_KEY))
  );
  return items.filter((item) =>
    [item.ref, item.targetRef].some((ref) => ref && covered.has(appliedLocationKey(ref.namespace, ref.group, ref.dataId, DOCUMENT_KEY)))
  );
}
