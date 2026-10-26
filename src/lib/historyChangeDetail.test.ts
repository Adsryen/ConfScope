import { describe, expect, it } from "vitest";
import { DOCUMENT_KEY, buildApplyPlan, type ApplyPlanItem, type BuildApplyPlanInput } from "./applyPlan";
import { appliedLocationsFromItems } from "./applyRecordScope";
import { buildHistoryChangeDetail } from "./historyChangeDetail";
import type { OperationRecord } from "../store/operationHistory";

// ApplyPlanRef.key 是必填的：整份配置的项走 DOCUMENT_KEY，标签里不会出现后缀（lib/applyPlan.ts:299）。
const ref = (dataId: string, key = DOCUMENT_KEY) => ({
  provider: "nacos" as const,
  connectionId: "conn-target",
  namespace: "public",
  group: "DEFAULT_GROUP",
  dataId,
  key,
});

const endpoint = {
  provider: "nacos" as const,
  connectionId: "conn-target",
  connectionName: "T",
  envId: "env-target",
  namespace: "public",
  label: "T / public",
};

function value(content: string, exists = true): BuildApplyPlanInput["items"][number]["sourceValue"] {
  return { exists, ...(exists ? { value: content, content } : {}), format: "YAML", parseStatus: "ok", valueType: "text" };
}

function planWith(items: BuildApplyPlanInput["items"]) {
  return buildApplyPlan({
    id: "plan-x",
    createdAt: "2026-10-26T00:00:00.000Z",
    scope: "batch",
    source: { ...endpoint, connectionId: "conn-source", connectionName: "S", envId: "env-source", label: "S / public" },
    target: endpoint,
    inputSummary: {
      sourceType: "diff",
      scope: "batch",
      sourceLabel: "S / public",
      targetLabel: "T / public",
      selectedCount: items.length,
    },
    items,
  });
}

function recordFor(plan: ReturnType<typeof planWith>, overrides: Partial<OperationRecord> = {}): OperationRecord {
  const executable = plan.items.filter((item) => item.action !== "skip" && item.action !== "parse_error");
  return {
    id: "rec-1",
    type: "apply",
    result: "success",
    timestamp: "2026-10-26T00:00:00.000Z",
    connectionId: "conn-target",
    connectionName: "T",
    namespace: "public",
    group: "DEFAULT_GROUP",
    dataId: "a.yaml",
    planId: plan.id,
    appliedLocations: appliedLocationsFromItems(executable as ApplyPlanItem[]),
    ...overrides,
  } as OperationRecord;
}

const twoItems = () =>
  planWith([
    { ref: ref("a.yaml"), sourceValue: value("server:\n  port: 8080"), targetValue: value("server:\n  port: 9090") },
    { ref: ref("b.yaml"), sourceValue: value("new: true"), targetValue: value("old: true") },
  ]);

describe("buildHistoryChangeDetail", () => {
  it("给出逐项写前/写后正文，并把有实际变化的项计数", () => {
    const plan = twoItems();
    const detail = buildHistoryChangeDetail(plan, recordFor(plan));
    expect(detail.status).toBe("ready");
    expect(detail.items).toHaveLength(2);
    expect(detail.items[0].label).toBe("public/DEFAULT_GROUP/a.yaml");
    expect(detail.items[0].beforeText).toBe("server:\n  port: 9090");
    expect(detail.items[0].afterText).toBe("server:\n  port: 8080");
    expect(detail.items[0].changeState).toBe("changed");
    expect(detail.changedCount).toBe(2);
    expect(detail.scopeUnverified).toBe(false);
  });

  it("源与目标逐字相同的那条在计划里就是 skip，根本不进清单", () => {
    const plan = planWith([
      { ref: ref("a.yaml"), sourceValue: value("same: 1"), targetValue: value("same: 1") },
      { ref: ref("b.yaml"), sourceValue: value("other: 2"), targetValue: value("same: 1") },
    ]);
    const detail = buildHistoryChangeDetail(plan, recordFor(plan));
    expect(detail.items.map((item) => item.label)).toEqual(["public/DEFAULT_GROUP/b.yaml"]);
    expect(detail.changedCount).toBe(1);
  });

  it("人工微调成正好等于目标时判 unchanged：确实执行了覆盖写，但目标没变", () => {
    const plan = twoItems();
    const tuned = {
      ...plan,
      items: plan.items.map((item, index) => (index === 0 ? { ...item, afterValue: item.targetValue, manualTuned: true } : item)),
    };
    const detail = buildHistoryChangeDetail(tuned, recordFor(plan));
    expect(detail.items[0].changeState).toBe("unchanged");
    expect(detail.items[0].manualTuned).toBe(true);
    expect(detail.changedCount).toBe(1);
  });

  it("新建项：写前读作「目标上原本没有」，正文缺失也不算未知", () => {
    const plan = planWith([{ ref: ref("a.yaml"), sourceValue: value("brand: new"), targetValue: value("", false) }]);
    const detail = buildHistoryChangeDetail(plan, recordFor(plan));
    expect(detail.items[0].targetExisted).toBe(false);
    expect(detail.items[0].beforeText).toBe("");
    expect(detail.items[0].contentKnown).toBe(true);
    expect(detail.items[0].changeState).toBe("changed");
  });

  it("删除项：写后是空正文，结论仍是 changed 而不是「删掉了空内容」", () => {
    const plan = planWith([
      {
        ref: ref("a.yaml"),
        sourceValue: value("", false),
        targetValue: value("drop: me"),
        intent: "delete" as const,
      },
    ]);
    const detail = buildHistoryChangeDetail(plan, recordFor(plan));
    expect(detail.items[0].action).toBe("delete");
    expect(detail.items[0].afterText).toBe("");
    expect(detail.items[0].beforeText).toBe("drop: me");
    expect(detail.items[0].changeState).toBe("changed");
  });

  it("正文没随计划存下来时判 unknown，绝不拿空串比出「无变化」", () => {
    const plan = planWith([{ ref: ref("a.yaml"), sourceValue: value("port: 8080"), targetValue: value("port: 9090") }]);
    const stripped = {
      ...plan,
      items: plan.items.map((item) => ({
        ...item,
        targetValue: { ...item.targetValue, content: undefined, value: undefined },
      })),
    };
    const detail = buildHistoryChangeDetail(stripped, recordFor(plan));
    expect(detail.items[0].contentKnown).toBe(false);
    expect(detail.items[0].changeState).toBe("unknown");
    expect(detail.changedCount).toBe(0);
  });

  it("只勾选部分执行时，未勾选的项不得进入清单", () => {
    const plan = twoItems();
    const onlyFirst = recordFor(plan, {
      appliedLocations: [{ namespace: "public", group: "DEFAULT_GROUP", dataId: "a.yaml", key: "__document" }],
    });
    const detail = buildHistoryChangeDetail(plan, onlyFirst);
    expect(detail.items.map((item) => item.label)).toEqual(["public/DEFAULT_GROUP/a.yaml"]);
  });

  it("老记录没有 appliedLocations：照常列出可执行项，但必须标记范围未证实", () => {
    const plan = twoItems();
    const legacy = recordFor(plan, { appliedLocations: undefined });
    const detail = buildHistoryChangeDetail(plan, legacy);
    expect(detail.items).toHaveLength(2);
    expect(detail.scopeUnverified).toBe(true);
  });

  it("计划已被挤掉时给出原因，不输出假的空清单", () => {
    const plan = twoItems();
    const detail = buildHistoryChangeDetail(null, recordFor(plan));
    expect(detail.status).toBe("unavailable");
    expect(detail.reasonKey).toBe("operationHistory.changeDetailPlanExpired");
    expect(detail.items).toEqual([]);
  });

  it("配置中心历史行没有 planId：走另一句实话", () => {
    const plan = twoItems();
    const center = { ...recordFor(plan), planId: undefined } as OperationRecord;
    const detail = buildHistoryChangeDetail(null, center);
    expect(detail.status).toBe("unavailable");
    expect(detail.reasonKey).toBe("operationHistory.changeDetailNoPlan");
  });

  it("key 级项的标签带出 key，位置与整篇文档不会混成一个", () => {
    const plan = planWith([
      { ref: ref("a.yaml", "server.port"), sourceValue: value("8080"), targetValue: value("9090") },
    ]);
    const detail = buildHistoryChangeDetail(plan, recordFor(plan));
    expect(detail.items[0].label).toBe("public/DEFAULT_GROUP/a.yaml (server.port)");
    expect(detail.items[0].documentLevel).toBe(false);
  });

  it("人工微调过的项带着标记，审计时能认出不是左侧原样搬过来", () => {
    const plan = twoItems();
    const tuned = {
      ...plan,
      items: plan.items.map((item, index) => (index === 0 ? { ...item, manualTuned: true } : item)),
    };
    const detail = buildHistoryChangeDetail(tuned, recordFor(plan));
    expect(detail.items[0].manualTuned).toBe(true);
    expect(detail.items[1].manualTuned).toBe(false);
  });
});
