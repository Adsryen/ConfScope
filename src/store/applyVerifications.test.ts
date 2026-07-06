import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearApplyVerifications,
  deleteApplyVerification,
  findApplyVerification,
  loadApplyVerifications,
  saveApplyVerification,
  type ApplyVerificationInput,
} from "./applyVerifications";

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

function input(overrides: Partial<ApplyVerificationInput> = {}): ApplyVerificationInput {
  return {
    planId: "plan-1",
    applyHistoryId: "history-1",
    sandboxConnectionId: "conn-sandbox",
    sandboxConnectionName: "Sandbox",
    sandboxNamespace: "public",
    verifiedTargetFingerprints: [{ itemId: "item-1", fingerprint: "fingerprint-1" }],
    ...overrides,
  };
}

describe("applyVerifications store", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves and loads verifications sorted by verifiedAt descending", () => {
    const first = saveApplyVerification(input({ planId: "plan-old", applyHistoryId: "history-old" }));
    vi.setSystemTime(new Date("2026-07-06T01:00:00.000Z"));
    const second = saveApplyVerification(input({ planId: "plan-new", applyHistoryId: "history-new" }));

    expect(loadApplyVerifications()).toEqual([second, first]);
    expect(second).toMatchObject({
      planId: "plan-new",
      applyHistoryId: "history-new",
      verifiedAt: "2026-07-06T01:00:00.000Z",
    });
    expect(second.id).toMatch(/^verify_/);
  });

  it("drops invalid storage values and malformed verification records", () => {
    localStorage.setItem("cs.applyVerifications", "{bad json");
    expect(loadApplyVerifications()).toEqual([]);

    localStorage.setItem("cs.applyVerifications", JSON.stringify({ id: "not-array" }));
    expect(loadApplyVerifications()).toEqual([]);

    const valid = saveApplyVerification(input());
    localStorage.setItem(
      "cs.applyVerifications",
      JSON.stringify([{ id: "invalid" }, valid, { ...valid, verifiedTargetFingerprints: [{ itemId: "x" }] }])
    );

    expect(loadApplyVerifications()).toEqual([valid]);
  });

  it("finds by plan id and optionally apply history id", () => {
    const first = saveApplyVerification(input({ planId: "plan-1", applyHistoryId: "history-1" }));
    const second = saveApplyVerification(input({ planId: "plan-1", applyHistoryId: "history-2" }));

    expect(findApplyVerification("plan-1")).toEqual(second);
    expect(findApplyVerification("plan-1", "history-1")).toEqual(first);
    expect(findApplyVerification("plan-1", "missing")).toBeNull();
  });

  it("deletes and clears verification records", () => {
    const first = saveApplyVerification(input({ planId: "plan-1" }));
    const second = saveApplyVerification(input({ planId: "plan-2", applyHistoryId: "history-2" }));

    deleteApplyVerification(first.id);
    expect(loadApplyVerifications()).toEqual([second]);

    clearApplyVerifications();
    expect(loadApplyVerifications()).toEqual([]);
  });
});
