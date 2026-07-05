// ApplyPlan 本地快照仓库：保存写入前 dry-run 计划，供预览、执行和审计复用。
import { parseApplyPlanSnapshot, type ApplyPlan } from "../lib/applyPlan";

const KEY = "cs.applyPlans";
const MAX_PLANS = 100;

function createdAtTime(plan: ApplyPlan): number {
  const time = new Date(plan.createdAt).getTime();
  return Number.isFinite(time) ? time : 0;
}

function sortPlans(plans: ApplyPlan[]): ApplyPlan[] {
  return [...plans].sort((a, b) => createdAtTime(b) - createdAtTime(a));
}

function saveAll(plans: ApplyPlan[]): void {
  localStorage.setItem(KEY, JSON.stringify(sortPlans(plans).slice(0, MAX_PLANS)));
}

export function loadApplyPlans(): ApplyPlan[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return sortPlans(parsed.map(parseApplyPlanSnapshot).filter((plan): plan is ApplyPlan => plan !== null));
  } catch {
    return [];
  }
}

export function saveApplyPlan(plan: ApplyPlan): ApplyPlan {
  const next = [plan, ...loadApplyPlans().filter((item) => item.id !== plan.id)];
  saveAll(next);
  return plan;
}

export function getApplyPlan(id: string): ApplyPlan | null {
  return loadApplyPlans().find((plan) => plan.id === id) ?? null;
}

export function deleteApplyPlan(id: string): void {
  saveAll(loadApplyPlans().filter((plan) => plan.id !== id));
}

export function clearApplyPlans(): void {
  localStorage.removeItem(KEY);
}
