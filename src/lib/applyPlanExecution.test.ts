import { describe, expect, it, vi } from "vitest";
import type { Connection } from "../store/connections";
import type { ConfigDocument } from "../api/nacos";
import type { OperationRecord } from "../store/operationHistory";
import type { Task, TaskManager } from "./taskmanager";
import { buildApplyPlan, type ApplyPlan, type ApplyPlanEndpoint, type BuildApplyPlanInput } from "./applyPlan";
import { applyConfirmationText, executeApplyPlan, isProtectedApplyTarget } from "./applyPlanExecution";

const baseConnection: Connection = {
  id: "conn-safe",
  name: "Staging",
  projectName: "Order",
  environmentName: "Staging",
  sourceName: "Cloud",
  sourceType: "nacos",
  provider: "nacos",
  distribution: "opensource",
  authType: "none",
  baseUrl: "http://stage.example.com/nacos",
  username: "",
  password: "",
  defaultNamespace: "public",
};

const sourceConnection: Connection = {
  ...baseConnection,
  id: "conn-dev",
  name: "Dev",
  environmentName: "Development",
  baseUrl: "http://dev.example.com/nacos",
};

const targetConnection: Connection = {
  ...baseConnection,
  id: "conn-prod",
  name: "Prod",
  environmentName: "Production",
  baseUrl: "http://prod.example.com/nacos",
};

function endpoint(overrides: Partial<ApplyPlanEndpoint> = {}): ApplyPlanEndpoint {
  return {
    envId: "conn-safe",
    label: "Staging / public",
    provider: "nacos",
    connectionId: "conn-safe",
    connectionName: "Staging",
    namespace: "public",
    ...overrides,
  };
}

describe("apply plan execution confirmation helpers", () => {
  it.each([
    [{ environmentName: "Production" }, endpoint()],
    [{ sourceName: "prod-vpc" }, endpoint()],
    [{ name: "线上公网" }, endpoint()],
    [{ environmentName: "生产" }, endpoint()],
    [{ sourceName: "真实环境" }, endpoint()],
    [{}, endpoint({ label: "prod / public" })],
  ] as Array<[Partial<Connection>, ApplyPlanEndpoint]>)("detects protected apply targets", (connectionPatch, applyEndpoint) => {
    expect(isProtectedApplyTarget({ ...baseConnection, ...connectionPatch }, applyEndpoint)).toBe(true);
  });

  it("does not mark ordinary staging targets as protected", () => {
    expect(isProtectedApplyTarget(baseConnection, endpoint())).toBe(false);
  });

  it("builds a deterministic confirmation text from plan id and target label", () => {
    const plan = buildApplyPlan({
      id: "plan-confirm-1",
      createdAt: "2026-07-06T00:00:00.000Z",
      scope: "config",
      source: endpoint({ connectionId: "conn-dev", connectionName: "Dev", label: "Dev / public" }),
      target: endpoint({ connectionId: "conn-prod", connectionName: "Prod", label: "Prod / public" }),
      inputSummary: {
        sourceType: "diff",
        scope: "config",
        sourceLabel: "Dev / public",
        targetLabel: "Prod / public",
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
            key: "__document",
          },
          sourceValue: { exists: true, value: "next", format: "YAML", parseStatus: "ok" },
          targetValue: { exists: true, value: "old", format: "YAML", parseStatus: "ok" },
        },
      ],
    });

    expect(applyConfirmationText(plan)).toBe("APPLY plan-confirm-1 TO Prod / public");
  });
});

function planEndpoint(connection: Connection, label: string): ApplyPlanEndpoint {
  return {
    envId: connection.id,
    label,
    provider: connection.provider ?? "nacos",
    connectionId: connection.id,
    connectionName: connection.name,
    namespace: "public",
  };
}

function ref(dataId: string, key = "__document"): BuildApplyPlanInput["items"][number]["ref"] {
  return {
    provider: "nacos",
    connectionId: "conn-prod",
    namespace: "public",
    group: "DEFAULT_GROUP",
    dataId,
    key,
  };
}

function doc(content: string, format = "yaml", version = "v1"): ConfigDocument {
  return {
    content,
    format,
    version,
    source: "test",
    updateTime: `2026-07-06T00:00:00.000Z-${version}`,
  };
}

function documentValue(content: string, exists = true, format: BuildApplyPlanInput["items"][number]["sourceValue"]["format"] = "YAML") {
  return {
    exists,
    value: exists ? content : undefined,
    valueType: exists ? ("text" as const) : undefined,
    format,
    parseStatus: "ok" as const,
    content: exists ? content : undefined,
    version: exists ? "v1" : undefined,
    updateTime: exists ? "2026-07-06T00:00:00.000Z-v1" : undefined,
  };
}

function absentValue() {
  return { exists: false };
}

function applyPlan(
  items: BuildApplyPlanInput["items"],
  sourceType: BuildApplyPlanInput["inputSummary"]["sourceType"] | "promote" = "diff"
): ApplyPlan {
  return buildApplyPlan({
    id: "plan-1",
    createdAt: "2026-07-06T00:00:00.000Z",
    scope: "batch",
    source: planEndpoint(sourceConnection, "Dev / public"),
    target: planEndpoint(targetConnection, "Prod / public"),
    inputSummary: {
      sourceType,
      scope: "batch",
      sourceLabel: "Dev / public",
      targetLabel: "Prod / public",
      selectedCount: items.length,
    },
    items,
  });
}

function taskManager(): TaskManager {
  const task: Task = {
    id: "task-apply-1",
    name: "Apply plan",
    type: "apply",
    scope: "Prod / public",
    cancellable: false,
    status: "pending",
    progress: 0,
    total: 0,
    completed: 0,
    failed: 0,
    error: "",
    startTime: "2026-07-06T00:00:00.000Z",
    endTime: null,
    elapsedTime: 0,
  };
  return {
    createTask: vi.fn(() => task),
    getTask: vi.fn(() => task),
    listTasks: vi.fn(() => [task]),
    startTask: vi.fn(),
    updateProgress: vi.fn(),
    completeTask: vi.fn(),
    cancelTask: vi.fn(),
    deleteTask: vi.fn(),
    clearCompleted: vi.fn(),
    onTaskUpdate: vi.fn(() => () => undefined),
  };
}

function docReader(documents: Record<string, ConfigDocument | null>) {
  return vi.fn(async (conn: Connection, _namespace: string, dataId: string, _group: string) => {
    const value = documents[`${conn.id}:${dataId}`];
    if (value === null || value === undefined) throw new Error(`404 not found: ${conn.id}/${dataId}`);
    return value;
  });
}

function deps(documents: Record<string, ConfigDocument | null>, overrides: { backupReject?: Error; publishReject?: Error } = {}) {
  const manager = taskManager();
  const recordOperation = vi.fn((input: Omit<OperationRecord, "id" | "timestamp">): OperationRecord => {
    return { ...input, id: "history-1", timestamp: "2026-07-06T00:00:00.000Z" };
  });
  return {
    connections: [sourceConnection, targetConnection],
    getConfigDocument: docReader(documents),
    publishConfig: overrides.publishReject ? vi.fn().mockRejectedValue(overrides.publishReject) : vi.fn().mockResolvedValue(undefined),
    deleteConfig: vi.fn().mockResolvedValue(undefined),
    createBackupSnapshot: overrides.backupReject
      ? vi.fn().mockRejectedValue(overrides.backupReject)
      : vi.fn().mockResolvedValue({ id: "snap-before-1", name: "prod_before_apply" }),
    recordOperation,
    taskManager: manager,
  };
}

describe("executeApplyPlan", () => {
  it("blocks stale plans before backup or write and records failed history", async () => {
    const plan = applyPlan([{ ref: ref("changed.yaml"), sourceValue: documentValue("new"), targetValue: documentValue("old") }]);
    const runDeps = deps({
      "conn-dev:changed.yaml": doc("newer"),
      "conn-prod:changed.yaml": doc("old"),
    });

    const result = await executeApplyPlan(plan, runDeps);

    expect(result).toMatchObject({ ok: false, taskId: "task-apply-1", error: expect.stringContaining("stale") });
    expect(runDeps.createBackupSnapshot).not.toHaveBeenCalled();
    expect(runDeps.publishConfig).not.toHaveBeenCalled();
    expect(runDeps.deleteConfig).not.toHaveBeenCalled();
    expect(runDeps.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "apply",
        result: "failure",
        planId: "plan-1",
        taskId: "task-apply-1",
        error: expect.stringContaining("stale"),
      })
    );
    expect(runDeps.taskManager.completeTask).toHaveBeenCalledWith("task-apply-1", false, expect.stringContaining("stale"));
  });

  it("stops when before backup fails and does not publish or delete", async () => {
    const plan = applyPlan([{ ref: ref("changed.yaml"), sourceValue: documentValue("new"), targetValue: documentValue("old") }]);
    const runDeps = deps(
      {
        "conn-dev:changed.yaml": doc("new"),
        "conn-prod:changed.yaml": doc("old"),
      },
      { backupReject: new Error("disk full") }
    );

    const result = await executeApplyPlan(plan, runDeps);

    expect(result).toMatchObject({ ok: false, taskId: "task-apply-1", error: "disk full" });
    expect(runDeps.publishConfig).not.toHaveBeenCalled();
    expect(runDeps.deleteConfig).not.toHaveBeenCalled();
    expect(runDeps.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "apply",
        result: "failure",
        planId: "plan-1",
        backupSnapshotId: undefined,
        error: "disk full",
      })
    );
  });

  it("executes document create, overwrite and delete while skipping unchanged items", async () => {
    const plan = applyPlan([
      { ref: ref("changed.yaml"), sourceValue: documentValue("next changed"), targetValue: documentValue("old changed") },
      { ref: ref("created.yaml"), sourceValue: documentValue("new file"), targetValue: absentValue() },
      { ref: ref("removed.yaml"), sourceValue: absentValue(), targetValue: documentValue("old removed") },
      { ref: ref("same.yaml"), sourceValue: documentValue("same"), targetValue: documentValue("same") },
    ]);
    const runDeps = deps({
      "conn-dev:changed.yaml": doc("next changed"),
      "conn-prod:changed.yaml": doc("old changed"),
      "conn-dev:created.yaml": doc("new file"),
      "conn-prod:created.yaml": null,
      "conn-dev:removed.yaml": null,
      "conn-prod:removed.yaml": doc("old removed"),
      "conn-dev:same.yaml": doc("same"),
      "conn-prod:same.yaml": doc("same"),
    });

    const result = await executeApplyPlan(plan, runDeps);

    expect(result).toEqual({ ok: true, taskId: "task-apply-1", historyId: "history-1" });
    expect(runDeps.publishConfig).toHaveBeenCalledWith(targetConnection, "public", "changed.yaml", "DEFAULT_GROUP", "next changed", "yaml");
    expect(runDeps.publishConfig).toHaveBeenCalledWith(targetConnection, "public", "created.yaml", "DEFAULT_GROUP", "new file", "yaml");
    expect(runDeps.deleteConfig).toHaveBeenCalledWith(targetConnection, "public", "removed.yaml", "DEFAULT_GROUP");
    expect(runDeps.publishConfig).toHaveBeenCalledTimes(2);
    expect(runDeps.deleteConfig).toHaveBeenCalledTimes(1);
    expect(runDeps.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "apply",
        result: "success",
        planId: "plan-1",
        backupSnapshotId: "snap-before-1",
        backupSnapshotName: "prod_before_apply",
        taskId: "task-apply-1",
      })
    );
    expect(runDeps.taskManager.completeTask).toHaveBeenCalledWith("task-apply-1", true);
  });

  it("creates restore tasks for rollback plans and backs up before writing", async () => {
    const plan = applyPlan([{ ref: ref("changed.yaml"), sourceValue: documentValue("old"), targetValue: documentValue("new") }], "rollback");
    const runDeps = deps({
      "conn-dev:changed.yaml": doc("old"),
      "conn-prod:changed.yaml": doc("new"),
    });

    const result = await executeApplyPlan(plan, runDeps);

    expect(result).toEqual({ ok: true, taskId: "task-apply-1", historyId: "history-1" });
    expect(runDeps.taskManager.createTask).toHaveBeenCalledWith("Apply plan plan-1", "restore", {
      scope: "Prod / public",
      cancellable: false,
    });
    expect(runDeps.createBackupSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      runDeps.publishConfig.mock.invocationCallOrder[0]
    );
    expect(runDeps.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "restore",
        result: "success",
        planId: "plan-1",
        backupSnapshotId: "snap-before-1",
        taskId: "task-apply-1",
      })
    );
  });

  it("re-reads source freshness from sourceRef when source and target locations differ", async () => {
    const sourceRef = ref("source.yaml");
    const targetRef = ref("target.yaml");
    const plan = applyPlan([
      {
        ref: targetRef,
        sourceRef,
        targetRef,
        sourceValue: documentValue("next from source"),
        targetValue: documentValue("old target"),
      },
    ]);
    const runDeps = deps({
      "conn-dev:source.yaml": doc("next from source"),
      "conn-prod:target.yaml": doc("old target"),
    });

    const result = await executeApplyPlan(plan, runDeps);

    expect(result).toEqual({ ok: true, taskId: "task-apply-1", historyId: "history-1" });
    expect(runDeps.getConfigDocument).toHaveBeenCalledWith(sourceConnection, "public", "source.yaml", "DEFAULT_GROUP");
    expect(runDeps.publishConfig).toHaveBeenCalledWith(targetConnection, "public", "target.yaml", "DEFAULT_GROUP", "next from source", "yaml");
  });

  it("blocks unsupported key-level materialization instead of overwriting the whole target document", async () => {
    const plan = applyPlan([
      {
        ref: ref("plain.txt", "feature.enabled"),
        sourceValue: { exists: true, value: "true", valueType: "string", format: "TEXT", parseStatus: "ok" },
        targetValue: { exists: true, value: "false", valueType: "string", format: "TEXT", parseStatus: "ok" },
      },
    ]);
    const runDeps = deps({
      "conn-dev:plain.txt": doc("feature.enabled=true", "text"),
      "conn-prod:plain.txt": doc("feature.enabled=false", "text"),
    });

    const result = await executeApplyPlan(plan, runDeps);

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Cannot materialize") });
    expect(runDeps.publishConfig).not.toHaveBeenCalled();
    expect(runDeps.deleteConfig).not.toHaveBeenCalled();
    expect(runDeps.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "apply",
        result: "failure",
        error: expect.stringContaining("Cannot materialize"),
      })
    );
  });

  it("records failure with backup metadata when a write fails", async () => {
    const plan = applyPlan([{ ref: ref("changed.yaml"), sourceValue: documentValue("new"), targetValue: documentValue("old") }]);
    const runDeps = deps(
      {
        "conn-dev:changed.yaml": doc("new"),
        "conn-prod:changed.yaml": doc("old"),
      },
      { publishReject: new Error("publish denied") }
    );

    const result = await executeApplyPlan(plan, runDeps);

    expect(result).toMatchObject({ ok: false, taskId: "task-apply-1", historyId: "history-1", error: "publish denied" });
    expect(runDeps.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "apply",
        result: "failure",
        planId: "plan-1",
        backupSnapshotId: "snap-before-1",
        backupSnapshotName: "prod_before_apply",
        taskId: "task-apply-1",
        error: "publish denied",
      })
    );
    expect(runDeps.taskManager.completeTask).toHaveBeenCalledWith("task-apply-1", false, "publish denied");
  });
});
