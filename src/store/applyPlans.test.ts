import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApplyPlan, type ApplyPlan, type BuildApplyPlanInput } from "../lib/applyPlan";
import { clearApplyPlans, deleteApplyPlan, getApplyPlan, loadApplyPlans, saveApplyPlan } from "./applyPlans";

class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

vi.stubGlobal("localStorage", new MemoryStorage());

const sourceEndpoint = {
  envId: "dev",
  label: "Dev",
  provider: "nacos",
  connectionId: "conn-dev",
  connectionName: "dev",
  namespace: "public",
} satisfies BuildApplyPlanInput["source"];

const targetEndpoint = {
  envId: "prod",
  label: "Prod",
  provider: "nacos",
  connectionId: "conn-prod",
  connectionName: "prod",
  namespace: "public",
} satisfies BuildApplyPlanInput["target"];

function makePlan(id: string, createdAt: string): ApplyPlan {
  return buildApplyPlan({
    id,
    createdAt,
    scope: "key",
    source: sourceEndpoint,
    target: targetEndpoint,
    inputSummary: {
      sourceType: "diff",
      scope: "key",
      sourceLabel: "Dev",
      targetLabel: "Prod",
      selectedCount: 1,
    },
    items: [
      {
        ref: {
          provider: "nacos",
          connectionId: "conn-prod",
          namespace: "public",
          group: "DEFAULT_GROUP",
          dataId: "app.yaml",
          key: "server.port",
        },
        sourceValue: {
          exists: true,
          value: "8080",
          valueType: "string",
          format: "YAML",
          parseStatus: "ok",
        },
        targetValue: {
          exists: true,
          value: "9090",
          valueType: "string",
          format: "YAML",
          parseStatus: "ok",
        },
      },
    ],
  });
}

beforeEach(() => {
  localStorage.clear();
});

describe("applyPlans store", () => {
  it("saves and loads plans ordered by createdAt descending", () => {
    const oldPlan = makePlan("old", "2026-07-06T00:00:00.000Z");
    const newPlan = makePlan("new", "2026-07-06T01:00:00.000Z");

    saveApplyPlan(oldPlan);
    saveApplyPlan(newPlan);

    expect(loadApplyPlans().map((plan) => plan.id)).toEqual(["new", "old"]);
    expect(getApplyPlan("old")).toEqual(oldPlan);
  });

  it("drops bad JSON, non-array payloads and invalid plan records", () => {
    expect(loadApplyPlans()).toEqual([]);

    localStorage.setItem("cs.applyPlans", "{bad json");
    expect(loadApplyPlans()).toEqual([]);

    localStorage.setItem("cs.applyPlans", JSON.stringify({ id: "not-array" }));
    expect(loadApplyPlans()).toEqual([]);

    const validPlan = makePlan("valid", "2026-07-06T00:00:00.000Z");
    localStorage.setItem("cs.applyPlans", JSON.stringify([{ id: "invalid" }, validPlan, "bad"]));

    expect(loadApplyPlans()).toEqual([validPlan]);
  });

  it("updates existing plans with the same id instead of appending", () => {
    const first = makePlan("same", "2026-07-06T00:00:00.000Z");
    const updated = makePlan("same", "2026-07-06T02:00:00.000Z");

    saveApplyPlan(first);
    saveApplyPlan(updated);

    expect(loadApplyPlans()).toEqual([updated]);
  });

  it("deletes one plan and clears all plans", () => {
    saveApplyPlan(makePlan("a", "2026-07-06T00:00:00.000Z"));
    saveApplyPlan(makePlan("b", "2026-07-06T01:00:00.000Z"));

    deleteApplyPlan("a");
    expect(loadApplyPlans().map((plan) => plan.id)).toEqual(["b"]);

    clearApplyPlans();
    expect(loadApplyPlans()).toEqual([]);
  });
});
