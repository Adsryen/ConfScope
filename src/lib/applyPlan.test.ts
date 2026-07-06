import { describe, expect, it } from "vitest";
import {
  buildApplyPlan,
  fingerprintApplyPlanValue,
  parseApplyPlanSnapshot,
  serializeApplyPlan,
  validateApplyPlanFreshness,
  type ApplyPlan,
  type BuildApplyPlanInput,
} from "./applyPlan";

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

const ref = {
  provider: "nacos",
  connectionId: "conn-prod",
  namespace: "public",
  group: "DEFAULT_GROUP",
  dataId: "app.yaml",
  key: "server.port",
} satisfies BuildApplyPlanInput["items"][number]["ref"];

function value(
  exists: boolean,
  content: string,
  options: Partial<BuildApplyPlanInput["items"][number]["sourceValue"]> = {}
): BuildApplyPlanInput["items"][number]["sourceValue"] {
  return {
    exists,
    value: exists ? content : undefined,
    valueType: exists ? "string" : undefined,
    format: "YAML",
    parseStatus: "ok",
    content: exists ? `server:\n  port: ${content}` : undefined,
    ...options,
  };
}

function input(items: BuildApplyPlanInput["items"]): BuildApplyPlanInput {
  return {
    id: "plan-1",
    createdAt: "2026-07-06T00:00:00.000Z",
    scope: "batch",
    source: sourceEndpoint,
    target: targetEndpoint,
    inputSummary: {
      sourceType: "audit",
      scope: "batch",
      sourceLabel: "Dev",
      targetLabel: "Prod",
      selectedCount: items.length,
    },
    items,
  };
}

function freshnessSnapshots(plan: ApplyPlan) {
  return plan.items.flatMap((item) => [
    { itemId: item.id, side: "source" as const, fingerprint: item.sourceFingerprint },
    { itemId: item.id, side: "target" as const, fingerprint: item.targetFingerprint },
  ]);
}

describe("buildApplyPlan", () => {
  it("classifies create, overwrite, delete, skip and parse_error items", () => {
    const plan = buildApplyPlan(
      input([
        { ref: { ...ref, key: "new.key" }, sourceValue: value(true, "new"), targetValue: value(false, "") },
        { ref: { ...ref, key: "changed.key" }, sourceValue: value(true, "new"), targetValue: value(true, "old") },
        { ref: { ...ref, key: "removed.key" }, sourceValue: value(false, ""), targetValue: value(true, "old") },
        { ref: { ...ref, key: "same.key" }, sourceValue: value(true, "same"), targetValue: value(true, "same") },
        {
          ref: { ...ref, key: "__document" },
          sourceValue: value(true, "{", { parseStatus: "error", parseError: "JSON:unexpected end" }),
          targetValue: value(true, "{}"),
        },
      ])
    );

    expect(plan.items.map((item) => [item.ref.key, item.action, item.blocked])).toEqual([
      ["new.key", "create", false],
      ["changed.key", "overwrite", false],
      ["removed.key", "delete", false],
      ["same.key", "skip", false],
      ["__document", "parse_error", true],
    ]);

    expect(plan.items[0].afterValue).toMatchObject({ exists: true, value: "new" });
    expect(plan.items[2].afterValue).toMatchObject({ exists: false });
    expect(plan.items[3].afterValue).toMatchObject({ exists: true, value: "same" });
    expect(plan.items[4].blockReason).toBe("source_parse_error");
    expect(plan.summary).toEqual({
      total: 5,
      create: 1,
      overwrite: 1,
      delete: 1,
      skip: 1,
      parse_error: 1,
      blocked: 1,
    });
  });

  it("creates stable fingerprints and changes them when content metadata changes", () => {
    const base = value(true, "8080", { updateTime: "2026-07-06T00:00:00.000Z" });

    expect(fingerprintApplyPlanValue(ref, base)).toBe(fingerprintApplyPlanValue(ref, { ...base }));
    expect(fingerprintApplyPlanValue(ref, base)).not.toBe(
      fingerprintApplyPlanValue(ref, { ...base, content: "server:\n  port: 9090" })
    );
    expect(fingerprintApplyPlanValue(ref, base)).not.toBe(
      fingerprintApplyPlanValue(ref, { ...base, updateTime: "2026-07-06T01:00:00.000Z" })
    );
  });

  it("round-trips serialized plans and rejects invalid snapshots", () => {
    const plan = buildApplyPlan(input([{ ref, sourceValue: value(true, "8080"), targetValue: value(true, "9090") }]));
    const parsed = parseApplyPlanSnapshot(JSON.parse(serializeApplyPlan(plan)));

    expect(parsed).toEqual(plan);
    expect(parseApplyPlanSnapshot({ ...plan, scope: "unknown" })).toBeNull();
    expect(parseApplyPlanSnapshot({ ...plan, items: [{ ...plan.items[0], action: "unknown" }] })).toBeNull();
  });

  it("round-trips promote source type snapshots", () => {
    const rawInput = input([{ ref, sourceValue: value(true, "8080"), targetValue: value(true, "9090") }]);
    const plan = buildApplyPlan({
      ...rawInput,
      inputSummary: {
        ...rawInput.inputSummary,
        sourceType: "promote",
      },
    });

    const parsed = parseApplyPlanSnapshot(JSON.parse(serializeApplyPlan(plan)));

    expect(parsed?.inputSummary.sourceType).toBe("promote");
  });

  it("blocks execution when the source fingerprint changes after planning", () => {
    const plan = buildApplyPlan(input([{ ref, sourceValue: value(true, "8080"), targetValue: value(true, "9090") }]));
    const snapshots = freshnessSnapshots(plan);
    const result = validateApplyPlanFreshness(plan, [{ ...snapshots[0], fingerprint: "changed-source" }, snapshots[1]]);

    expect(result).toEqual({
      ok: false,
      staleItems: [
        {
          itemId: plan.items[0].id,
          side: "source",
          plannedFingerprint: plan.items[0].sourceFingerprint,
          currentFingerprint: "changed-source",
          reason: "fingerprint_changed",
        },
      ],
    });
  });

  it("blocks execution when the target fingerprint changes after planning", () => {
    const plan = buildApplyPlan(input([{ ref, sourceValue: value(true, "8080"), targetValue: value(true, "9090") }]));
    const snapshots = freshnessSnapshots(plan);
    const result = validateApplyPlanFreshness(plan, [snapshots[0], { ...snapshots[1], fingerprint: "changed-target" }]);

    expect(result.ok).toBe(false);
    expect(result.staleItems).toEqual([
      expect.objectContaining({
        itemId: plan.items[0].id,
        side: "target",
        plannedFingerprint: plan.items[0].targetFingerprint,
        currentFingerprint: "changed-target",
      }),
    ]);
  });

  it("allows execution when source and target fingerprints still match the plan", () => {
    const plan = buildApplyPlan(input([{ ref, sourceValue: value(true, "8080"), targetValue: value(true, "9090") }]));

    expect(validateApplyPlanFreshness(plan, freshnessSnapshots(plan))).toEqual({ ok: true, staleItems: [] });
  });
});
