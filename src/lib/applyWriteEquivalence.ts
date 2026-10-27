/**
 * 「这一次写入到底有没有必要」的唯一判据（轮98）。
 *
 * 同一句比较原先只长在写后回读里（`applyPlanExecution` 私有的 `writeMatchesReadBack`）。
 * 半截写入的用户需要第二条出口：摘掉失败项重试一次，而重试进来先撞新鲜度判据——
 * 前面已经写成功的那几项，目标当然和「写入前」不一样，于是整份计划被判过期，
 * 连没写过的剩下几项也一起堵死（见 .trellis/tasks/10-27-r98-partial-write-exits/prd.md）。
 *
 * 解法不是放宽过期判据，而是让「写前」与「写后」共用同一条「目标已经是这一版了吗」：
 * 回读确认说写成了，写前就该说已达成。两处若各写一套比较，迟早出现
 * 「回读说没写成、写前说已达成」这种没人能解释的矛盾。
 *
 * 口径沿用轮55「比较用字符串精确比较」：正文差一个空格就是另一版，不做 normalize。
 */
import type { ApplyPlanValueInput } from "./applyPlan";

/** 一次落笔的形状，与执行器里的 PlannedWrite 同源（执行器反过来依赖本文件，避免两份定义）。 */
export type ApplyWriteKind = "publish" | "delete" | "publish_ref" | "delete_ref";

export interface PlannedWriteShape {
  kind: ApplyWriteKind;
  content?: string;
}

/**
 * 要写的这一版与目标现值是否同一版。
 *
 * - 删除类：目标已经不存在 = 已达成（不存在的东西没有"更没了"可写）。
 * - 写入类：目标必须存在，且读回来的正文（整篇 `content` 优先，key 级写取 `value`）
 *   与要写进去的那一份**完全相等**。
 * - 现值既没有 content 也没有 value：判不成已达成。宁可照常写一次，
 *   也不能因为读不出可比字段就宣布"不用写了"。
 */
export function writeMatchesReadBack(write: PlannedWriteShape, current: ApplyPlanValueInput): boolean {
  if (write.kind === "delete" || write.kind === "delete_ref") return !current.exists;
  if (!current.exists) return false;
  const actual = current.content ?? current.value;
  if (actual === undefined) return false;
  return actual === (write.content ?? "");
}

/**
 * 面向调用处的语义名：这一笔不用落笔，因为目标已经是这一版。
 * 与 `writeMatchesReadBack` 同一实现，只是把"为什么调用"写在名字上。
 */
export function isTargetAlreadyApplied(write: PlannedWriteShape, currentTargetValue: ApplyPlanValueInput): boolean {
  return writeMatchesReadBack(write, currentTargetValue);
}
