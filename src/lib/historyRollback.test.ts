// 轮72A：「这条记录能不能回退」只许有一份判据（.trellis/tasks/10-24-r72a-history-rollback-entry/prd.md）。
//
// 这里盯的是**入口放行与拒绝的边界**，不是 payload 形状
// （回退现场的构造由 applyFollowup.test.ts / directWriteExit.test.ts 各自守着）：
// 过去详情面板写着「不可回滚」、下面却挂着能点的按钮，两套口径各说各话；
// 反过来，把不可回退的记录放出去，用户要点下去才收到「变更记录 X 没有关联变更计划」。
import { describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../api/snapshot";
import type { Connection } from "../store/connections";
import type { OperationRecord } from "../store/operationHistory";
import zhCN from "../locales/zh-CN.json";
import enUS from "../locales/en-US.json";
import { buildApplyPlan, type ApplyPlan, type ApplyPlanItem, type BuildApplyPlanInput } from "./applyPlan";
import type { ApplyFollowupDeps } from "./applyFollowup";
import {
  assessHistoryRollback,
  buildHistoryRollbackEntry,
  type HistoryRollbackContext,
} from "./historyRollback";

const sandboxConn = nacosConn("conn-sandbox", "Sandbox");
const devConn = nacosConn("conn-dev", "Dev");
const readonlyConn: Connection = { ...nacosConn("conn-readonly", "Frozen"), readonly: true };
const snapshotConn: Connection = { ...nacosConn("conn-snap", "Snapshot"), sourceType: "local-snapshot" };

function nacosConn(id: string, name: string): Connection {
  return {
    id,
    name,
    projectName: "Order",
    environmentName: name,
    sourceName: `${name} Nacos`,
    sourceType: "nacos",
    provider: "nacos",
    distribution: "opensource",
    authType: "none",
    baseUrl: `http://${id}.example.com/nacos`,
    username: "",
    password: "",
    defaultNamespace: "public",
  };
}

function ctx(overrides: Partial<HistoryRollbackContext> = {}): HistoryRollbackContext {
  return {
    connections: [devConn, sandboxConn, readonlyConn, snapshotConn],
    knownPlanIds: new Set(["plan-apply-1"]),
    ...overrides,
  };
}

function applyRecord(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    id: "history-apply-1",
    type: "apply",
    result: "success",
    timestamp: "2026-07-06T00:00:00.000Z",
    connectionId: sandboxConn.id,
    connectionName: sandboxConn.name,
    namespace: "public",
    group: "DEFAULT_GROUP",
    dataId: "app.yaml",
    planId: "plan-apply-1",
    backupSnapshotId: "snap-before-1",
    backupSnapshotName: "before apply",
    taskId: "task-apply-1",
    targetConnectionId: sandboxConn.id,
    // 存档元数据：轮42 之前写死的 rollbackable:false 不能再当否决用，这里刻意留下反例。
    rollbackable: false,
    rollbackReason: "operationHistory.rollbackApplyRequiresPlan",
    ...overrides,
  };
}

function legacyPublishRecord(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    id: "legacy-publish-1",
    type: "publish",
    result: "success",
    timestamp: "2026-07-04T10:00:00Z",
    connectionId: sandboxConn.id,
    connectionName: sandboxConn.name,
    namespace: "public",
    group: "DEFAULT_GROUP",
    dataId: "app.yaml",
    configType: "yaml",
    beforeContent: "server:\n  port: 8080\n",
    rollbackable: true,
    ...overrides,
  };
}

function ref(conn: Connection, dataId = "app.yaml"): BuildApplyPlanInput["items"][number]["ref"] {
  return { provider: "nacos", connectionId: conn.id, namespace: "public", group: "DEFAULT_GROUP", dataId, key: "__document" };
}

function value(content: string, version = "v1"): BuildApplyPlanInput["items"][number]["sourceValue"] {
  return {
    exists: true,
    value: content,
    valueType: "text",
    format: "YAML",
    parseStatus: "ok",
    content,
    version,
    updateTime: `2026-07-06T00:00:00.000Z-${version}`,
    md5: `md5-${version}`,
  };
}

function plan(dataIds = ["app.yaml"]): ApplyPlan {
  return buildApplyPlan({
    id: "plan-apply-1",
    createdAt: "2026-07-06T00:00:00.000Z",
    scope: "config",
    source: { envId: devConn.id, label: "Dev / public", provider: "nacos", connectionId: devConn.id, connectionName: devConn.name, namespace: "public" },
    target: { envId: sandboxConn.id, label: "Sandbox / public", provider: "nacos", connectionId: sandboxConn.id, connectionName: sandboxConn.name, namespace: "public" },
    inputSummary: { sourceType: "diff", scope: "config", sourceLabel: "Dev / public", targetLabel: "Sandbox / public", selectedCount: dataIds.length },
    items: dataIds.map((dataId) => ({ ref: ref(sandboxConn, dataId), sourceValue: value("server:\n  port: 8080"), targetValue: value("server:\n  port: 9090", `v-${dataId}`) })),
  });
}

function snapshotCovering(items: ApplyPlanItem[]): Snapshot {
  return {
    id: "snap-before-1",
    path: "/snapshots/snap-before-1",
    name: "before apply",
    description: "",
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:00:00.000Z",
    source: { provider: "nacos", connectionId: sandboxConn.id, connectionName: sandboxConn.name, namespace: "public", namespaceId: "public" },
    configs: items.map((item) => ({
      namespace: item.ref.namespace,
      dataId: item.ref.dataId,
      group: item.ref.group,
      content: item.targetValue.content ?? "",
      configType: "text",
      updateTime: item.targetValue.updateTime ?? "",
    })),
  };
}

function deps(currentPlan = plan()): ApplyFollowupDeps {
  return {
    connections: [devConn, sandboxConn, readonlyConn, snapshotConn],
    getApplyPlan: vi.fn((id: string) => (id === currentPlan.id ? currentPlan : null)),
    getSnapshot: vi.fn(async () => snapshotCovering(currentPlan.items)),
    getConfigDocument: vi.fn(),
  };
}

function localeValue(bundle: Record<string, unknown>, key: string): unknown {
  return key.split(".").reduce<unknown>((acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined), bundle);
}

describe("assessHistoryRollback：apply/promote/restore 按备份快照回退", () => {
  it("现场齐备就放行，且存档里的 rollbackable:false 不再是否决", () => {
    const assessment = assessHistoryRollback(applyRecord(), ctx());
    expect(assessment).toMatchObject({ available: true, path: "apply-backup", reasonKey: "" });
    expect(assessment.actionLabelKey).toBe("operationHistory.generateRollbackPlan");
  });

  it("半截失败的记录同样放行（R55-A4：已写入的那几条必须有出口）", () => {
    const assessment = assessHistoryRollback(applyRecord({ result: "failure" }), ctx());
    expect(assessment.available).toBe(true);
    // 文案不许轻描淡写成「生成回退计划」：它做的是「把写进去的退回来」。
    expect(assessment.actionLabelKey).toBe("operationHistory.rollbackFromBackupPlan");
  });

  it("缺哪一环就说清哪一环", () => {
    expect(assessHistoryRollback(applyRecord({ planId: undefined }), ctx()).reasonKey).toBe("operationHistory.rollbackNoPlanOnRecord");
    expect(assessHistoryRollback(applyRecord({ backupSnapshotId: undefined }), ctx()).reasonKey).toBe("operationHistory.rollbackMissingBackupSnapshot");
    expect(assessHistoryRollback(applyRecord(), ctx({ knownPlanIds: new Set() })).reasonKey).toBe("operationHistory.rollbackPlanExpired");
    expect(
      assessHistoryRollback(applyRecord({ targetConnectionId: "conn-gone" }), ctx()).reasonKey
    ).toBe("operationHistory.rollbackTargetConnectionMissing");
    for (const key of ["rollbackNoPlanOnRecord", "rollbackMissingBackupSnapshot", "rollbackPlanExpired", "rollbackTargetConnectionMissing", "rollbackNothingWritten"]) {
      expect(assessHistoryRollback(applyRecord(), ctx()).available).toBe(true);
      expect(localeValue(zhCN, `operationHistory.${key}`)).toBeTypeOf("string");
      expect(localeValue(enUS, `operationHistory.${key}`)).toBeTypeOf("string");
    }
  });

  it("落笔清单为空的记录给专门原因，而不是混进「没有备份快照」（轮79 E4）", () => {
    const nothingWritten = applyRecord({ appliedLocations: [], scopeIsWritten: true });
    const assessment = assessHistoryRollback(nothingWritten, ctx());
    expect(assessment.available).toBe(false);
    expect(assessment.path).toBeNull();
    expect(assessment.reasonKey).toBe("operationHistory.rollbackNothingWritten");
    // 这条记录现场其实是齐的（planId + 备份快照都在），单说「缺备份」就是假话
    expect(nothingWritten.backupSnapshotId).toBeTruthy();
    // 半截失败写了 1 项：仍然放行，按钮叫「把已写入的那几条退回备份」
    const halfWritten = applyRecord({ result: "failure", appliedLocations: [{ namespace: "public", group: "DEFAULT_GROUP", dataId: "app.yaml", key: "__document" }], scopeIsWritten: true });
    expect(assessHistoryRollback(halfWritten, ctx())).toMatchObject({ available: true, path: "apply-backup" });
  });

  it("apply 记录带 beforeContent 也不降级成「按记录正文回退」", () => {
    // 批量记录里的 beforeContent 只是第一条配置的写前正文，放出去会被读成「整批都退回去了」。
    const record = applyRecord({ backupSnapshotId: undefined, beforeContent: "server:\n  port: 8080\n" });
    const assessment = assessHistoryRollback(record, ctx());
    expect(assessment.available).toBe(false);
    expect(assessment.path).toBeNull();
    expect(assessment.reasonKey).toBe("operationHistory.rollbackMissingBackupSnapshot");
  });
});

describe("assessHistoryRollback：轮42 之前遗留的单条直写记录按写前正文回退", () => {
  it("publish/delete/rollback 成功且有写前正文 + 可写目标 → 放行", () => {
    for (const type of ["publish", "delete", "rollback"] as const) {
      const assessment = assessHistoryRollback(legacyPublishRecord({ id: `legacy-${type}`, type }), ctx());
      expect(assessment).toMatchObject({ available: true, path: "recorded-content" });
      expect(assessment.actionLabelKey).toBe("operationHistory.rollbackFromRecordedContent");
    }
  });

  it("缺件即拒绝，并给出具体原因", () => {
    expect(assessHistoryRollback(legacyPublishRecord({ result: "failure" }), ctx()).reasonKey).toBe("operationHistory.rollbackOnlySuccess");
    expect(assessHistoryRollback(legacyPublishRecord({ beforeContent: undefined }), ctx()).reasonKey).toBe("operationHistory.rollbackMissingContent");
    expect(assessHistoryRollback(legacyPublishRecord({ dataId: "   " }), ctx()).reasonKey).toBe("operationHistory.rollbackMissingContent");
    expect(assessHistoryRollback(legacyPublishRecord(), ctx({ connections: [] })).reasonKey).toBe("operationHistory.rollbackTargetConnectionMissing");
    expect(assessHistoryRollback(legacyPublishRecord({ connectionId: readonlyConn.id }), ctx()).reasonKey).toBe("operationHistory.rollbackTargetNotWritable");
    expect(assessHistoryRollback(legacyPublishRecord({ connectionId: snapshotConn.id }), ctx()).reasonKey).toBe("operationHistory.rollbackTargetNotWritable");
  });
});

describe("assessHistoryRollback：不写配置中心的记录没有回退这回事", () => {
  it("沿用记录里自带的原因，没有就兜底", () => {
    const snapshotRecord: OperationRecord = {
      ...legacyPublishRecord(),
      id: "snapshot-1",
      type: "snapshot",
      rollbackReason: "operationHistory.rollbackSnapshotOnly",
    };
    const withOwnReason = assessHistoryRollback(snapshotRecord, ctx());
    expect(withOwnReason.available).toBe(false);
    expect(withOwnReason.reasonKey).toBe("operationHistory.rollbackSnapshotOnly");

    expect(assessHistoryRollback({ ...snapshotRecord, rollbackReason: undefined }, ctx()).reasonKey).toBe(
      "operationHistory.rollbackUnsupportedType"
    );
  });
});

describe("buildHistoryRollbackEntry", () => {
  it("遗留记录按写前正文物化计划来源值，返回口落在操作历史", async () => {
    const result = await buildHistoryRollbackEntry(legacyPublishRecord(), ctx(), deps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry).toMatchObject({
      sourceType: "rollback",
      scope: "config",
      target: { connectionId: sandboxConn.id },
      // directWriteExit 恒给 returnMode:"browse"（那是浏览页内 tab 的口径），历史入口必须覆盖回 history。
      origin: { mode: "rollback", returnMode: "history" },
    });
    expect(result.entry.items[0]).toMatchObject({
      dataId: "app.yaml",
      group: "DEFAULT_GROUP",
      sourceValueOverride: { exists: true, content: "server:\n  port: 8080\n" },
    });
  });

  it("apply 记录按备份快照构造，来源指向本地备份而不是线上", async () => {
    // 回退范围如何按「本次执行的位置」收口由 applyFollowup.test.ts 守（R66-WP9），
    // 这里只确认历史入口没有另起一套构造：原样交给备份快照那条链。
    const currentPlan = plan();
    const result = await buildHistoryRollbackEntry(applyRecord(), ctx(), deps(currentPlan));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.origin).toMatchObject({ mode: "rollback", returnMode: "history" });
    expect(result.entry.items.map((item) => item.dataId)).toEqual(["app.yaml"]);
    expect(result.entry.source.provider).toBe("local");
  });

  it("不可回退的记录返回人话原因，不返回 key，也不产出计划", async () => {
    const result = await buildHistoryRollbackEntry(applyRecord({ planId: undefined }), ctx(), deps());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("history_rollback_unavailable");
    expect(result.detail).not.toContain("operationHistory.");
    expect(result.detail.trim().length).toBeGreaterThan(0);
  });

  it("判定刚过目标连接就被删掉时不放空计划", async () => {
    // 模拟状态在两次读之间变了（连接被删）：入口不能把一条没有目标的计划丢给计划页。
    const context = ctx();
    const record = legacyPublishRecord();
    expect(assessHistoryRollback(record, context).available).toBe(true);
    const tornDown = { ...context, connections: [] as Connection[] };
    const result = await buildHistoryRollbackEntry(record, tornDown, deps());
    expect(result.ok).toBe(false);
  });
});
