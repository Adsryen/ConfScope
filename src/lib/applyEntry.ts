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
