import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  loadOperationHistory,
  recordOperation,
  clearOperationHistory,
  filterOperationHistory,
  isRollbackableOperation,
  rollbackUnavailableReason,
  type OperationRecord,
} from "./operationHistory";

// mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
  };
})();

vi.stubGlobal("localStorage", localStorageMock);

beforeEach(() => {
  localStorageMock.clear();
  vi.clearAllMocks();
});

describe("loadOperationHistory", () => {
  it("返回空数组当没有记录时", () => {
    expect(loadOperationHistory()).toEqual([]);
  });

  it("加载已存储的记录", () => {
    const records: OperationRecord[] = [
      {
        id: "test1",
        type: "publish",
        result: "success",
        timestamp: "2025-01-01T00:00:00Z",
        connectionId: "c1",
        connectionName: "dev",
        namespace: "public",
        group: "DEFAULT_GROUP",
        dataId: "app.yaml",
      },
    ];
    localStorageMock.setItem("cs.operationHistory", JSON.stringify(records));
    expect(loadOperationHistory()).toEqual(records);
  });

  it("loads persisted snapshot compare records", () => {
    localStorageMock.setItem(
      "cs.operationHistory",
      JSON.stringify([
        {
          id: "compare-1",
          type: "snapshot_compare",
          result: "success",
          timestamp: "2026-07-06T10:00:00Z",
          connectionId: "conn-1",
          connectionName: "dev",
          namespace: "public",
          group: "DEFAULT_GROUP",
          dataId: "app.yaml",
          resourceId: "snap-1",
          resourceName: "dev_snapshot",
          content: "C:\\backups\\snap-1",
          rollbackable: false,
          rollbackReason: "operationHistory.rollbackSnapshotOnly",
        },
      ])
    );

    const [record] = loadOperationHistory();

    expect(record).toMatchObject({
      type: "snapshot_compare",
      result: "success",
      connectionId: "conn-1",
      namespace: "public",
      group: "DEFAULT_GROUP",
      dataId: "app.yaml",
      resourceId: "snap-1",
      content: "C:\\backups\\snap-1",
    });
  });

  it("返回空数组当存储数据格式错误时", () => {
    localStorageMock.setItem("cs.operationHistory", "invalid json");
    expect(loadOperationHistory()).toEqual([]);
  });

  it("将旧 content 字段迁移为可回滚元数据", () => {
    const records = [
      {
        id: "legacy-1",
        type: "publish",
        result: "success",
        timestamp: "2026-07-04T00:00:00Z",
        connectionId: "c1",
        connectionName: "dev",
        namespace: "public",
        group: "DEFAULT_GROUP",
        dataId: "app.yaml",
        previousContent: "old",
        content: "new",
      },
    ];
    localStorageMock.setItem("cs.operationHistory", JSON.stringify(records));

    const [record] = loadOperationHistory();

    expect(record.beforeContent).toBe("old");
    expect(record.afterContent).toBe("new");
    expect(isRollbackableOperation(record)).toBe(true);
  });

  it("加载 apply 记录并保留计划、备份和源目标摘要", () => {
    localStorageMock.setItem(
      "cs.operationHistory",
      JSON.stringify([
        {
          id: "apply-1",
          type: "apply",
          result: "success",
          timestamp: "2026-07-06T12:00:00Z",
          connectionId: "conn-prod",
          connectionName: "prod",
          namespace: "public",
          group: "DEFAULT_GROUP",
          dataId: "app.yaml",
          planId: "plan-1",
          planSummary: {
            scope: "batch",
            total: 3,
            create: 1,
            overwrite: 1,
            delete: 1,
            skip: 0,
            parseError: 0,
            blocked: 0,
            sourceLabel: "dev",
            targetLabel: "prod",
          },
          backupSnapshotId: "snap-before-1",
          backupSnapshotName: "prod_before_apply",
          taskId: "task-apply-1",
          sourceConnectionId: "conn-dev",
          sourceConnectionName: "dev",
          sourceNamespace: "public",
          targetConnectionId: "conn-prod",
          targetConnectionName: "prod",
          targetNamespace: "public",
          beforeContent: "old: true",
          afterContent: "new: true",
        },
      ])
    );

    const [record] = loadOperationHistory();

    expect(record).toMatchObject({
      type: "apply",
      result: "success",
      connectionId: "conn-prod",
      connectionName: "prod",
      namespace: "public",
      group: "DEFAULT_GROUP",
      dataId: "app.yaml",
      planId: "plan-1",
      planSummary: {
        scope: "batch",
        total: 3,
        create: 1,
        overwrite: 1,
        delete: 1,
        skip: 0,
        parseError: 0,
        blocked: 0,
        sourceLabel: "dev",
        targetLabel: "prod",
      },
      backupSnapshotId: "snap-before-1",
      backupSnapshotName: "prod_before_apply",
      taskId: "task-apply-1",
      sourceConnectionId: "conn-dev",
      sourceConnectionName: "dev",
      sourceNamespace: "public",
      targetConnectionId: "conn-prod",
      targetConnectionName: "prod",
      targetNamespace: "public",
      beforeContent: "old: true",
      afterContent: "new: true",
    });
  });

  it("忽略损坏的 apply 摘要字段但保留记录和旧 publish 记录", () => {
    localStorageMock.setItem(
      "cs.operationHistory",
      JSON.stringify([
        {
          id: "apply-1",
          type: "apply",
          result: "success",
          timestamp: "2026-07-06T12:00:00Z",
          connectionId: "conn-prod",
          connectionName: "prod",
          namespace: "public",
          group: "DEFAULT_GROUP",
          dataId: "app.yaml",
          planId: "plan-1",
          planSummary: {
            scope: "batch",
            total: "bad",
            create: 1,
            overwrite: 1,
            delete: 0,
            skip: 0,
            parseError: 0,
            blocked: 0,
            sourceLabel: "dev",
            targetLabel: "prod",
          },
          backupSnapshotId: 123,
        },
        {
          id: "publish-1",
          type: "publish",
          result: "success",
          timestamp: "2026-07-05T12:00:00Z",
          connectionId: "conn-prod",
          connectionName: "prod",
          namespace: "public",
          group: "DEFAULT_GROUP",
          dataId: "legacy.yaml",
        },
      ])
    );

    const records = loadOperationHistory();

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      id: "apply-1",
      type: "apply",
      planId: "plan-1",
    });
    expect(records[0].planSummary).toBeUndefined();
    expect(records[0].backupSnapshotId).toBeUndefined();
    expect(records[1].type).toBe("publish");
  });
});

describe("recordOperation", () => {
  it("记录操作并自动生成 id 和 timestamp", () => {
    const record = recordOperation({
      type: "publish",
      result: "success",
      connectionId: "c1",
      connectionName: "dev",
      namespace: "public",
      group: "DEFAULT_GROUP",
      dataId: "app.yaml",
    });

    expect(record.id).toBeTruthy();
    expect(record.timestamp).toBeTruthy();
    expect(record.type).toBe("publish");
    expect(record.result).toBe("success");
  });

  it("记录保存到 localStorage", () => {
    recordOperation({
      type: "delete",
      result: "failure",
      connectionId: "c1",
      connectionName: "dev",
      namespace: "public",
      group: "DEFAULT_GROUP",
      dataId: "app.yaml",
      error: "permission denied",
    });

    const history = loadOperationHistory();
    expect(history).toHaveLength(1);
    expect(history[0].type).toBe("delete");
    expect(history[0].error).toBe("permission denied");
  });

  it("新记录插入到最前面", () => {
    recordOperation({
      type: "publish",
      result: "success",
      connectionId: "c1",
      connectionName: "dev",
      namespace: "public",
      group: "DEFAULT_GROUP",
      dataId: "first.yaml",
    });

    recordOperation({
      type: "delete",
      result: "success",
      connectionId: "c2",
      connectionName: "prod",
      namespace: "public",
      group: "DEFAULT_GROUP",
      dataId: "second.yaml",
    });

    const history = loadOperationHistory();
    expect(history).toHaveLength(2);
    expect(history[0].dataId).toBe("second.yaml");
    expect(history[1].dataId).toBe("first.yaml");
  });

  it("记录快照和导出操作但标记为不可回滚", () => {
    const snapshotRecord = recordOperation({
      type: "snapshot",
      result: "success",
      connectionId: "c1",
      connectionName: "dev",
      namespace: "public",
      group: "*",
      dataId: "*",
      rollbackable: false,
      rollbackReason: "operationHistory.rollbackSnapshotOnly",
    });

    const exportRecord = recordOperation({
      type: "export",
      result: "success",
      connectionId: "c1",
      connectionName: "dev",
      namespace: "public",
      group: "*",
      dataId: "*",
      rollbackable: false,
      rollbackReason: "operationHistory.rollbackExportOnly",
    });

    expect(isRollbackableOperation(snapshotRecord)).toBe(false);
    expect(isRollbackableOperation(exportRecord)).toBe(false);
    expect(rollbackUnavailableReason(snapshotRecord)).toBe("operationHistory.rollbackSnapshotOnly");
    expect(rollbackUnavailableReason(exportRecord)).toBe("operationHistory.rollbackExportOnly");
  });

  it("treats snapshot compare records as snapshot-only and not rollbackable", () => {
    localStorageMock.setItem(
      "cs.operationHistory",
      JSON.stringify([
        {
          id: "compare-1",
          type: "snapshot_compare",
          result: "success",
          timestamp: "2026-07-06T10:00:00Z",
          connectionId: "conn-1",
          connectionName: "dev",
          namespace: "public",
          group: "DEFAULT_GROUP",
          dataId: "app.yaml",
          rollbackable: false,
          rollbackReason: "operationHistory.rollbackSnapshotOnly",
        },
      ])
    );

    const [record] = loadOperationHistory();

    if (!record) throw new Error("snapshot_compare record was not loaded");
    expect(isRollbackableOperation(record)).toBe(false);
    expect(rollbackUnavailableReason(record)).toBe("operationHistory.rollbackSnapshotOnly");
  });

  it("只有成功且带操作前内容的配置变更可回滚", () => {
    const record = recordOperation({
      type: "publish",
      result: "success",
      connectionId: "c1",
      connectionName: "dev",
      namespace: "public",
      group: "DEFAULT_GROUP",
      dataId: "app.yaml",
      beforeContent: "old",
      afterContent: "new",
      rollbackable: true,
    });

    expect(isRollbackableOperation(record)).toBe(true);
    expect(rollbackUnavailableReason(record)).toBe("");
  });

  it("记录 apply 操作并保存计划、备份和源目标字段", () => {
    recordOperation({
      type: "apply",
      result: "success",
      connectionId: "conn-prod",
      connectionName: "prod",
      namespace: "public",
      group: "DEFAULT_GROUP",
      dataId: "app.yaml",
      planId: "plan-1",
      planSummary: {
        scope: "batch",
        total: 2,
        create: 1,
        overwrite: 1,
        delete: 0,
        skip: 0,
        parseError: 0,
        blocked: 0,
        sourceLabel: "dev",
        targetLabel: "prod",
      },
      backupSnapshotId: "snap-before-1",
      backupSnapshotName: "prod_before_apply",
      taskId: "task-apply-1",
      sourceConnectionId: "conn-dev",
      sourceConnectionName: "dev",
      sourceNamespace: "public",
      targetConnectionId: "conn-prod",
      targetConnectionName: "prod",
      targetNamespace: "public",
    });

    const [record] = loadOperationHistory();

    expect(record).toMatchObject({
      type: "apply",
      planId: "plan-1",
      backupSnapshotId: "snap-before-1",
      backupSnapshotName: "prod_before_apply",
      taskId: "task-apply-1",
      sourceConnectionId: "conn-dev",
      targetConnectionId: "conn-prod",
      planSummary: {
        total: 2,
        create: 1,
        overwrite: 1,
        sourceLabel: "dev",
        targetLabel: "prod",
      },
    });
  });

  it("apply 记录不可通过直接发布旧内容回滚", () => {
    const record: OperationRecord = {
      id: "apply-1",
      type: "apply",
      result: "success",
      timestamp: "2026-07-06T12:00:00Z",
      connectionId: "conn-prod",
      connectionName: "prod",
      namespace: "public",
      group: "DEFAULT_GROUP",
      dataId: "app.yaml",
      beforeContent: "old: true",
      planId: "plan-1",
      backupSnapshotId: "snap-before-1",
    };

    expect(isRollbackableOperation(record)).toBe(false);
    expect(rollbackUnavailableReason(record)).toBe("operationHistory.rollbackApplyRequiresPlan");
  });
});

describe("clearOperationHistory", () => {
  it("清空所有记录", () => {
    recordOperation({
      type: "publish",
      result: "success",
      connectionId: "c1",
      connectionName: "dev",
      namespace: "public",
      group: "DEFAULT_GROUP",
      dataId: "app.yaml",
    });

    clearOperationHistory();
    expect(loadOperationHistory()).toEqual([]);
  });
});

describe("filterOperationHistory", () => {
  const records: OperationRecord[] = [
    {
      id: "1",
      type: "publish",
      result: "success",
      timestamp: "2025-01-01T00:00:00Z",
      connectionId: "c1",
      connectionName: "dev",
      namespace: "public",
      group: "DEFAULT_GROUP",
      dataId: "app.yaml",
    },
    {
      id: "2",
      type: "delete",
      result: "failure",
      timestamp: "2025-01-02T00:00:00Z",
      connectionId: "c2",
      connectionName: "prod",
      namespace: "prod-ns",
      group: "PROD_GROUP",
      dataId: "config.yaml",
      error: "permission denied",
    },
    {
      id: "3",
      type: "publish",
      result: "success",
      timestamp: "2025-01-03T00:00:00Z",
      connectionId: "c1",
      connectionName: "dev",
      namespace: "public",
      group: "DEFAULT_GROUP",
      dataId: "app.yaml",
    },
    {
      id: "4",
      type: "apply",
      result: "success",
      timestamp: "2025-01-04T00:00:00Z",
      connectionId: "c2",
      connectionName: "prod",
      namespace: "public",
      group: "DEFAULT_GROUP",
      dataId: "deploy-target.yaml",
      planId: "plan-1",
    },
  ];

  it("按 connectionId 筛选", () => {
    const filtered = filterOperationHistory(records, { connectionId: "c1" });
    expect(filtered).toHaveLength(2);
    expect(filtered.every((r) => r.connectionId === "c1")).toBe(true);
  });

  it("按 namespace 筛选", () => {
    const filtered = filterOperationHistory(records, { namespace: "prod-ns" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].namespace).toBe("prod-ns");
  });

  it("按 dataId 模糊筛选", () => {
    const filtered = filterOperationHistory(records, { dataId: "app" });
    expect(filtered).toHaveLength(2);
  });

  it("按 type 筛选", () => {
    const filtered = filterOperationHistory(records, { type: "delete" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].type).toBe("delete");
  });

  it("按 apply type 筛选", () => {
    const filtered = filterOperationHistory(records, { type: "apply" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("4");
  });

  it("按时间范围筛选", () => {
    const filtered = filterOperationHistory(records, {
      startTime: "2025-01-02T00:00:00Z",
      endTime: "2025-01-03T23:59:59Z",
    });
    expect(filtered).toHaveLength(2);
  });

  it("组合筛选", () => {
    const filtered = filterOperationHistory(records, {
      connectionId: "c1",
      type: "publish",
    });
    expect(filtered).toHaveLength(2);
  });
});
