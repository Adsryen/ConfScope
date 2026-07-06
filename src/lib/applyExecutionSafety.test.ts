import { describe, expect, it, vi } from "vitest";
import { buildApplyPlan, type BuildApplyPlanInput } from "./applyPlan";
import {
  buildApplyOperationHistoryInput,
  collectApplyBackupConfigs,
  prepareApplyExecutionSafety,
  type ApplyTargetBeforeSnapshot,
} from "./applyExecutionSafety";

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

const baseRef = {
  provider: "nacos",
  connectionId: "conn-prod",
  namespace: "public",
  group: "DEFAULT_GROUP",
  dataId: "app.yaml",
  key: "server.port",
} satisfies BuildApplyPlanInput["items"][number]["ref"];

function value(exists: boolean, content: string): BuildApplyPlanInput["items"][number]["sourceValue"] {
  return {
    exists,
    value: exists ? content : undefined,
    valueType: exists ? "string" : undefined,
    format: "YAML",
    parseStatus: "ok",
    content: exists ? `server:\n  port: ${content}` : undefined,
    updateTime: exists ? "2026-07-06T00:00:00.000Z" : undefined,
  };
}

function plan(items: BuildApplyPlanInput["items"], sourceType: BuildApplyPlanInput["inputSummary"]["sourceType"] | "promote" = "diff") {
  return buildApplyPlan({
    id: "plan-1",
    createdAt: "2026-07-06T12:00:00.000Z",
    scope: "batch",
    source: sourceEndpoint,
    target: targetEndpoint,
    inputSummary: {
      sourceType,
      scope: "batch",
      sourceLabel: "Dev",
      targetLabel: "Prod",
      selectedCount: items.length,
    },
    items,
  });
}

function beforeSnapshot(input: Partial<ApplyTargetBeforeSnapshot> & Pick<ApplyTargetBeforeSnapshot, "itemId">): ApplyTargetBeforeSnapshot {
  return {
    itemId: input.itemId,
    namespace: input.namespace ?? "public",
    group: input.group ?? "DEFAULT_GROUP",
    dataId: input.dataId ?? "app.yaml",
    exists: input.exists ?? true,
    content: input.content ?? "old: true",
    configType: input.configType ?? "yaml",
    updateTime: input.updateTime ?? "2026-07-06T11:59:00.000Z",
  };
}

describe("buildApplyOperationHistoryInput", () => {
  it("maps promote plans to promote operation history", () => {
    const applyPlan = plan(
      [{ ref: { ...baseRef, key: "__document" }, sourceValue: value(true, "new"), targetValue: value(true, "old") }],
      "promote"
    );

    const result = buildApplyOperationHistoryInput(applyPlan, {
      result: "success",
      backup: { snapshotId: "snap-before-1", snapshotName: "before promote", backedUpCount: 1, missingBeforeCount: 0 },
      taskId: "task-1",
    });

    expect(result).toMatchObject({
      type: "promote",
      result: "success",
      planId: "plan-1",
      taskId: "task-1",
      backupSnapshotId: "snap-before-1",
    });
  });

  it("maps rollback plans to restore operation history", () => {
    const applyPlan = plan(
      [{ ref: { ...baseRef, key: "__document" }, sourceValue: value(true, "old"), targetValue: value(true, "new") }],
      "rollback"
    );

    const result = buildApplyOperationHistoryInput(applyPlan, {
      result: "success",
      backup: { snapshotId: "snap-before-2", snapshotName: "before restore", backedUpCount: 1, missingBeforeCount: 0 },
      taskId: "task-restore-1",
    });

    expect(result).toMatchObject({
      type: "restore",
      result: "success",
      planId: "plan-1",
      taskId: "task-restore-1",
      backupSnapshotId: "snap-before-2",
    });
  });
});

describe("collectApplyBackupConfigs", () => {
  it("收集 overwrite/delete 的 before content，跳过 skip，并统计 create 的缺失 before 内容", () => {
    const applyPlan = plan([
      { ref: { ...baseRef, dataId: "changed.yaml", key: "__document" }, sourceValue: value(true, "new"), targetValue: value(true, "old") },
      { ref: { ...baseRef, dataId: "removed.yaml", key: "__document" }, sourceValue: value(false, ""), targetValue: value(true, "old") },
      { ref: { ...baseRef, dataId: "same.yaml", key: "__document" }, sourceValue: value(true, "same"), targetValue: value(true, "same") },
      { ref: { ...baseRef, dataId: "created.yaml", key: "__document" }, sourceValue: value(true, "new"), targetValue: value(false, "") },
    ]);

    const result = collectApplyBackupConfigs(applyPlan, [
      beforeSnapshot({ itemId: applyPlan.items[0].id, dataId: "changed.yaml", content: "old changed", configType: "yaml" }),
      beforeSnapshot({ itemId: applyPlan.items[1].id, dataId: "removed.yaml", content: "old removed", configType: "properties" }),
      beforeSnapshot({ itemId: applyPlan.items[3].id, dataId: "created.yaml", exists: false, content: undefined }),
    ]);

    expect(result).toEqual({
      configs: [
        {
          namespace: "public",
          group: "DEFAULT_GROUP",
          dataId: "changed.yaml",
          content: "old changed",
          configType: "yaml",
          updateTime: "2026-07-06T11:59:00.000Z",
        },
        {
          namespace: "public",
          group: "DEFAULT_GROUP",
          dataId: "removed.yaml",
          content: "old removed",
          configType: "properties",
          updateTime: "2026-07-06T11:59:00.000Z",
        },
      ],
      missingBeforeCount: 1,
      missingItemIds: [],
    });
  });
});

describe("prepareApplyExecutionSafety", () => {
  it("计划存在 blocked item 时阻止执行且不创建备份", async () => {
    const applyPlan = plan([
      {
        ref: { ...baseRef, key: "__document" },
        sourceValue: { ...value(true, "{"), parseStatus: "error", parseError: "YAML: bad input" },
        targetValue: value(true, "old"),
      },
    ]);
    const createBackupSnapshot = vi.fn();

    const result = await prepareApplyExecutionSafety(applyPlan, [], { createBackupSnapshot, taskId: "task-1" });

    expect(createBackupSnapshot).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      reason: "plan_blocked",
      historyInput: {
        type: "apply",
        result: "failure",
        planId: "plan-1",
        taskId: "task-1",
        error: expect.stringContaining("blocked"),
      },
    });
  });

  it("执行前目标快照缺失时阻止执行且不创建备份", async () => {
    const applyPlan = plan([
      { ref: { ...baseRef, key: "__document" }, sourceValue: value(true, "new"), targetValue: value(true, "old") },
    ]);
    const createBackupSnapshot = vi.fn();

    const result = await prepareApplyExecutionSafety(applyPlan, [], { createBackupSnapshot });

    expect(createBackupSnapshot).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      reason: "missing_before_snapshot",
      historyInput: {
        type: "apply",
        result: "failure",
        planId: "plan-1",
        error: expect.stringContaining(applyPlan.items[0].id),
      },
    });
  });

  it("备份创建失败时返回 backup_failed 且生成失败历史输入", async () => {
    const applyPlan = plan([
      { ref: { ...baseRef, key: "__document" }, sourceValue: value(true, "new"), targetValue: value(true, "old") },
    ]);
    const createBackupSnapshot = vi.fn().mockRejectedValue(new Error("disk full"));

    const result = await prepareApplyExecutionSafety(applyPlan, [beforeSnapshot({ itemId: applyPlan.items[0].id })], {
      createBackupSnapshot,
    });

    expect(createBackupSnapshot).toHaveBeenCalledWith([
      {
        namespace: "public",
        group: "DEFAULT_GROUP",
        dataId: "app.yaml",
        content: "old: true",
        configType: "yaml",
        updateTime: "2026-07-06T11:59:00.000Z",
      },
    ]);
    expect(result).toMatchObject({
      ok: false,
      reason: "backup_failed",
      historyInput: {
        type: "apply",
        result: "failure",
        planId: "plan-1",
        error: expect.stringContaining("disk full"),
      },
    });
  });

  it("备份成功时返回快照信息和可写入操作历史的 apply 输入", async () => {
    const applyPlan = plan([
      { ref: { ...baseRef, key: "__document" }, sourceValue: value(true, "new"), targetValue: value(true, "old") },
    ]);
    const createBackupSnapshot = vi.fn().mockResolvedValue({ id: "snap-before-1", name: "prod_before_apply" });

    const result = await prepareApplyExecutionSafety(applyPlan, [beforeSnapshot({ itemId: applyPlan.items[0].id })], {
      createBackupSnapshot,
      taskId: "task-1",
    });

    expect(result).toMatchObject({
      ok: true,
      backup: {
        snapshotId: "snap-before-1",
        snapshotName: "prod_before_apply",
        backedUpCount: 1,
        missingBeforeCount: 0,
      },
      historyInput: {
        type: "apply",
        result: "success",
        connectionId: "conn-prod",
        connectionName: "prod",
        namespace: "public",
        group: "DEFAULT_GROUP",
        dataId: "app.yaml",
        planId: "plan-1",
        backupSnapshotId: "snap-before-1",
        backupSnapshotName: "prod_before_apply",
        taskId: "task-1",
        sourceConnectionId: "conn-dev",
        targetConnectionId: "conn-prod",
        planSummary: {
          scope: "batch",
          total: 1,
          overwrite: 1,
          sourceLabel: "Dev",
          targetLabel: "Prod",
        },
      },
    });
  });
});
