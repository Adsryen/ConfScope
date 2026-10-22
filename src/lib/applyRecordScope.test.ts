import { describe, expect, it } from "vitest";
import type { Snapshot } from "../api/snapshot";
import { buildApplyPlan, type ApplyPlan, type ApplyPlanItem, type ApplyPlanRef, type BuildApplyPlanInput } from "./applyPlan";
import { appliedLocationKey, appliedLocationsFromItems, restrictItemsByAppliedLocations, restrictItemsToSnapshotCoverage } from "./applyRecordScope";

const target = {
  envId: "prod",
  label: "Prod",
  provider: "nacos",
  connectionId: "conn-prod",
  connectionName: "prod",
  namespace: "public",
} satisfies BuildApplyPlanInput["target"];

function ref(dataId: string, namespace = "public", key = "__document"): ApplyPlanRef {
  return { provider: "nacos", connectionId: "conn-prod", namespace, group: "DEFAULT_GROUP", dataId, key };
}

function value(content: string): BuildApplyPlanInput["items"][number]["sourceValue"] {
  return { exists: true, value: content, valueType: "text", format: "YAML", parseStatus: "ok", content };
}

function plan(items: BuildApplyPlanInput["items"]): ApplyPlan {
  return buildApplyPlan({
    id: "plan-1",
    createdAt: "2026-07-06T12:00:00.000Z",
    scope: "config",
    source: { ...target, connectionId: "conn-dev", connectionName: "dev", envId: "dev", label: "Dev" },
    target,
    inputSummary: { sourceType: "diff", scope: "config", sourceLabel: "Dev", targetLabel: "Prod", selectedCount: items.length },
    items,
  });
}

function items(...dataIds: string[]): ApplyPlanItem[] {
  return plan(dataIds.map((dataId) => ({ ref: ref(dataId), sourceValue: value("new"), targetValue: value(`old-${dataId}`) }))).items;
}

function snapshotWith(configs: Snapshot["configs"]): Snapshot {
  return { id: "snap-1", path: "/snap", name: "snap", description: "", createdAt: "", updatedAt: "", source: { connectionId: "conn-prod", connectionName: "prod", namespace: "public", namespaceId: "public" }, configs };
}

describe("appliedLocationsFromItems", () => {
  it("按写入位置去重，优先用 targetRef", () => {
    const [item] = plan([
      {
        ref: ref("app.yaml"),
        targetRef: ref("app.yaml", "qa"),
        sourceValue: value("new"),
        targetValue: value("old"),
      },
    ]).items;
    const [dup] = plan([{ ref: ref("app.yaml", "qa"), sourceValue: value("new"), targetValue: value("old") }]).items;

    expect(appliedLocationsFromItems([item, { ...dup }])).toEqual([
      { namespace: "qa", group: "DEFAULT_GROUP", dataId: "app.yaml", key: "__document" },
    ]);
  });
});

describe("restrictItemsByAppliedLocations", () => {
  it("空命名空间与 public 认成同一个位置，缺省 key 与 __document 同样对齐", () => {
    const [publicItem] = items("app.yaml");
    const [blankItem] = plan([{ ref: ref("app.yaml", ""), sourceValue: value("new"), targetValue: value("old") }]).items;
    const [keyItem] = plan([{ ref: ref("app.yaml", "public", "server.port"), sourceValue: value("new"), targetValue: value("old") }]).items;

    expect(restrictItemsByAppliedLocations([publicItem, blankItem], [{ namespace: "public", group: "DEFAULT_GROUP", dataId: "app.yaml" }])).toHaveLength(2);
    expect(restrictItemsByAppliedLocations([keyItem], [{ namespace: "public", group: "DEFAULT_GROUP", dataId: "app.yaml", key: "server.port" }])).toHaveLength(1);
    expect(restrictItemsByAppliedLocations([keyItem], [{ namespace: "public", group: "DEFAULT_GROUP", dataId: "app.yaml", key: "__document" }])).toHaveLength(0);
  });

  it("对不上号的项一律不收进来", () => {
    expect(restrictItemsByAppliedLocations(items("a.yaml", "b.yaml"), [{ namespace: "public", group: "DEFAULT_GROUP", dataId: "b.yaml" }]).map((item) => item.ref.dataId)).toEqual(["b.yaml"]);
    expect(restrictItemsByAppliedLocations(items("a.yaml"), [{ namespace: "public", group: "OTHER_GROUP", dataId: "a.yaml" }])).toEqual([]);
  });
});

describe("restrictItemsToSnapshotCoverage", () => {
  it("按文档覆盖判断，key 级项跟着它所属的文档走", () => {
    const [docItem] = items("app.yaml");
    const [keyItem] = plan([{ ref: ref("cache.yaml", "public", "ttl"), sourceValue: value("new"), targetValue: value("old") }]).items;
    const snapshot = snapshotWith([{ namespace: "public", group: "DEFAULT_GROUP", dataId: "app.yaml", content: "old", configType: "yaml", updateTime: "" }]);

    expect(restrictItemsToSnapshotCoverage([docItem, keyItem], snapshot)).toEqual([docItem]);
  });

  it("按项自己的命名空间判断覆盖，不拿计划端点里的 public 去套", () => {
    const [devItem] = plan([{ ref: ref("app.yaml", "dev"), sourceValue: value("new"), targetValue: value("old") }]).items;
    const [publicItem] = plan([{ ref: ref("app.yaml", "public"), sourceValue: value("new"), targetValue: value("old") }]).items;
    const snapshot = snapshotWith([{ namespace: "dev", group: "DEFAULT_GROUP", dataId: "app.yaml", content: "old", configType: "yaml", updateTime: "" }]);

    expect(restrictItemsToSnapshotCoverage([devItem, publicItem], snapshot)).toEqual([devItem]);
  });

  it("快照缺 configs 字段时一项都不收，绝不放行成删除", () => {
    expect(restrictItemsToSnapshotCoverage(items("a.yaml"), { ...snapshotWith([]), configs: undefined as unknown as Snapshot["configs"] })).toEqual([]);
  });
});

describe("appliedLocationKey", () => {
  it("分组与 dataId 大小写敏感，不同分组不会撞键", () => {
    expect(appliedLocationKey("public", "A", "app.yaml")).not.toBe(appliedLocationKey("public", "a", "app.yaml"));
  });
});
