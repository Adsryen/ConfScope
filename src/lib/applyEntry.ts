// 应用入口上下文：只描述从差异页面进入 dry-run 计划流程的范围与定位。
import type { ProviderType } from "../api/configCenter";
import type { ApplyPlanValueInput } from "./applyPlan";

export type ApplyEntrySourceType = "audit" | "diff" | "backup" | "promote" | "rollback" | "manual";
export type ApplyEntryScope = "key" | "config" | "batch";
export type ApplyEntryRiskLevel = "low" | "medium" | "high";
export type ApplyEntryRiskReason = "batch_apply" | "has_skipped_items";

export interface ApplyEntryEndpoint {
  provider: ProviderType;
  connectionId: string;
  connectionName: string;
  namespace: string;
  label: string;
}

export interface ApplyEntryRef {
  provider: ProviderType;
  connectionId: string;
  namespace: string;
  group: string;
  dataId: string;
  key: string;
}

export interface ApplyEntryItem extends ApplyEntryRef {
  sourceRef?: ApplyEntryRef;
  targetRef?: ApplyEntryRef;
  /** 可选的物化来源值：用于生成安全本地计划，同时不改变当前来源快照校验合同。 */
  sourceValueOverride?: ApplyPlanValueInput;
  /**
   * 物化文本是人手写的（第三步「微调」），不是整块从左挑到右的合并结果。
   * 两种情况都会带 sourceValueOverride，计划里必须靠这个标记才分得开（轮60 R4）。
   */
  manualTuned?: boolean;
}

export interface ApplyEntryRangeSummary {
  count: number;
  skippedCount: number;
  riskLevel: ApplyEntryRiskLevel;
  riskReasons: ApplyEntryRiskReason[];
}

export interface ApplyEntryOrigin {
  mode: ApplyEntrySourceType;
  returnMode?: string;
}

export interface ApplyEntryPayload {
  sourceType: ApplyEntrySourceType;
  scope: ApplyEntryScope;
  source: ApplyEntryEndpoint;
  target: ApplyEntryEndpoint;
  items: ApplyEntryItem[];
  rangeSummary: ApplyEntryRangeSummary;
  origin: ApplyEntryOrigin;
}

export function applyEntryTargetCount(payload: Pick<ApplyEntryPayload, "items">): number {
  return payload.items.length;
}

export function applyEntryRiskSummary(items: ApplyEntryItem[], skippedCount = 0): ApplyEntryRangeSummary {
  const riskReasons: ApplyEntryRiskReason[] = [];
  if (items.length > 1) riskReasons.push("batch_apply");
  if (skippedCount > 0) riskReasons.push("has_skipped_items");
  const riskLevel: ApplyEntryRiskLevel = skippedCount > 0 || items.length > 1 ? "medium" : "low";
  return {
    count: items.length,
    skippedCount,
    riskLevel,
    riskReasons,
  };
}

/**
 * 这份入口的「返回」该落到哪儿：写在入口里就按写的算，没写就退回它的来源模式。
 * 判据只在这儿一份——App 用它决定模式跳转，计划页用它决定步骤条能不能点（轮76）。
 */
export function applyEntryReturnMode(payload: Pick<ApplyEntryPayload, "origin">): string {
  return payload.origin.returnMode ?? payload.origin.mode;
}

/**
 * 计划页的步骤条是不是真的能「回到某一步」。
 *
 * 那条五步流程长在配置对比上：点第 1/2/3 步 = 离开计划页回到对比页的那一步。
 * 从操作历史（回退/晋级）、审计、备份、配置浏览进来的计划没有可回的对比现场，
 * 同样这些按钮点下去只是把人丢到别的页面，气泡却写着「回到「确认方向」（进度保留）」——
 * 轮76 把晋级入口搬回第5步后，这条谎每份晋级计划都会踩一次，所以在这里收口：
 * 返回落点不是对比页时，步骤条退回纯指示（不可点，气泡回到「步骤名: 步骤说明」）。
 */
export function applyEntryStepsAreNavigable(payload: Pick<ApplyEntryPayload, "origin"> | null | undefined): boolean {
  if (!payload) return false;
  return applyEntryReturnMode(payload) === "diff";
}

export function applyEntryId(payload: ApplyEntryPayload): string {
  const first = payload.items[0];
  const targetRef = first?.targetRef ?? first;
  return [
    payload.sourceType,
    payload.scope,
    payload.source.connectionId,
    payload.target.connectionId,
    targetRef?.namespace ?? payload.target.namespace,
    targetRef?.group ?? "",
    targetRef?.dataId ?? "",
    targetRef?.key ?? "",
  ].join("|");
}
