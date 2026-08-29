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

  it("creates stable fingerprints: value changes them, content/timestamp-only drift does not", () => {
    const base = value(true, "8080", { updateTime: "2026-07-06T00:00:00.000Z" });

    expect(fingerprintApplyPlanValue(ref, base)).toBe(fingerprintApplyPlanValue(ref, { ...base }));
    // 值语义变化 → 指纹变化
    expect(fingerprintApplyPlanValue(ref, base)).not.toBe(fingerprintApplyPlanValue(ref, { ...base, value: "9090" }));
    // content（文档全文）不参与：它仅供会话记录展示/挂载，
    // key 级指纹必须与执行期 key 读取口径一致，否则挂全文后会误判 stale/overwrite
    expect(fingerprintApplyPlanValue(ref, base)).toBe(
      fingerprintApplyPlanValue(ref, { ...base, content: "server:\n  port: 9090" })
    );
    // updateTime 是服务端秒级时间戳，内容未变时不参与指纹（避免误判 stale）
    expect(fingerprintApplyPlanValue(ref, base)).toBe(
      fingerprintApplyPlanValue(ref, { ...base, updateTime: "2026-07-06T01:00:00.000Z" })
    );
    // md5 是内容摘要，参与指纹
    expect(fingerprintApplyPlanValue(ref, base)).not.toBe(
      fingerprintApplyPlanValue(ref, { ...base, updateTime: "2026-07-06T01:00:00.000Z", md5: "deadbeef" })
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

  it("allows materialized merge values while preserving original source freshness", () => {
    const materializedSource = value(true, "8080", { content: "server:\n  port: 8080\nfeature: true" });
    const originalSourceFingerprint = "source-before-merge";
    const originalTargetFingerprint = "target-before-merge";
    const plan = buildApplyPlan(
      input([
        {
          ref: { ...ref, key: "__document" },
          sourceRef: { ...ref, connectionId: "conn-dev", key: "__document" },
          targetRef: { ...ref, connectionId: "conn-prod", key: "__document" },
          sourceValue: materializedSource,
          targetValue: value(true, "9090", { content: "server:\n  port: 9090\nfeature: true" }),
          sourceFingerprint: originalSourceFingerprint,
          targetFingerprint: originalTargetFingerprint,
        },
      ])
    );

    expect(plan.items[0].action).toBe("overwrite");
    expect(plan.items[0].afterValue.content).toBe("server:\n  port: 8080\nfeature: true");
    expect(plan.items[0].sourceFingerprint).toBe(originalSourceFingerprint);
    expect(plan.items[0].targetFingerprint).toBe(originalTargetFingerprint);
    expect(
      validateApplyPlanFreshness(plan, [
        { itemId: plan.items[0].id, side: "source", fingerprint: originalSourceFingerprint },
        { itemId: plan.items[0].id, side: "target", fingerprint: originalTargetFingerprint },
      ])
    ).toEqual({ ok: true, staleItems: [] });
  });
});

import { withEditedAfterValue, type ApplyPlanItem } from "./applyPlan";

function makeItem(action: ApplyPlanItem["action"], sourceContent: string, targetContent: string): ApplyPlanItem {
  const plan = buildApplyPlan(
    input([
      {
        ref: { ...ref, key: "__document" },
        sourceRef: { ...ref, connectionId: "conn-dev", key: "__document" },
        targetRef: ref,
        sourceValue: value(true, "8080", { content: sourceContent }),
        targetValue: value(true, "9090", { content: targetContent }),
      },
    ])
  );
  const item = plan.items[0];
  if (action === item.action) return item;
  return { ...item, action, blocked: false };
}

describe("withEditedAfterValue", () => {
  it("overwrites afterValue content and recomputes fingerprint/action", () => {
    const item = makeItem("overwrite", "a: 1", "a: 2");
    const edited = withEditedAfterValue(item, "a: 99\nb: new");
    expect(edited.afterValue.content).toBe("a: 99\nb: new");
    expect(edited.afterValue.exists).toBe(true);
    expect(edited.afterValue.parseStatus).toBe("ok");
    expect(edited.action).toBe("overwrite");
    expect(edited.blocked).toBe(false);
    // 原始 targetValue 快照不受影响
    expect(edited.targetValue.content).toBe("a: 2");
  });

  it("turns a skip item into overwrite when manually edited", () => {
    const item = makeItem("skip", "a: 1", "a: 1");
    const edited = withEditedAfterValue(item, "a: 2");
    expect(edited.action).toBe("overwrite");
    expect(edited.afterValue.content).toBe("a: 2");
  });

  it("blocks when edited content has a YAML syntax error", () => {
    const item = makeItem("overwrite", "a: 1", "a: 2");
    const edited = withEditedAfterValue(item, "a: [unclosed");
    expect(edited.action).toBe("parse_error");
    expect(edited.blocked).toBe(true);
    expect(edited.blockReason).toBe("edited_parse_error");
  });

  it("keeps duplicate-key warning (parseStatus ok) without blocking", () => {
    const item = makeItem("overwrite", "a: 1", "a: 2");
    const edited = withEditedAfterValue(item, "a: 1\na: 2");
    expect(edited.blocked).toBe(false);
    expect(edited.action).toBe("overwrite");
    expect(edited.afterValue.parseError).toBeTruthy();
  });
});
