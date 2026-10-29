import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "../store/connections";
import type { ConfigDocument } from "../api/nacos";
import type { OperationRecord } from "../store/operationHistory";
import type { Task, TaskManager } from "./taskmanager";
import { buildApplyPlan, fingerprintApplyPlanValue, type ApplyPlan, type ApplyPlanEndpoint, type ApplyPlanRef, type BuildApplyPlanInput } from "./applyPlan";
import { applyConfirmationText, executeApplyPlan, isProtectedApplyTarget, requiresManualApplyConfirm } from "./applyPlanExecution";
import { translate } from "../locales";

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
    [{ environmentName: "UAT" }, endpoint()],
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

  it("keeps the confirmation text short enough to type by hand", () => {
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

    // 旧格式把整条目标标签塞进确认串，复测真机量到 80 字符（真实 MSE 命名空间是 36 位
    // UUID 时约 110 字符），而承载它的 <code> 当时还是禁选的——抄不走又敲不完（轮67 / R67-WP10）。
    expect(applyConfirmationText(plan)).toBe("APPLY plan-confirm-1");
    expect(applyConfirmationText(plan)).not.toContain("Prod / public");
    // 上限按真实 planId 形态留余量：`APPLY plan_mvksd3zy_8akc2s` 实测 26 字符。
    const realistic = { id: `plan_${Date.now().toString(36)}_abcdef`, target: plan.target };
    expect(applyConfirmationText(realistic).length).toBeLessThanOrEqual(32);
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

function documentValueWithVersion(
  content: string,
  version: string,
  format: BuildApplyPlanInput["items"][number]["sourceValue"]["format"] = "YAML"
) {
  return {
    ...documentValue(content, true, format),
    version,
    updateTime: `2026-07-06T00:00:00.000Z-${version}`,
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
    name: "Change plan",
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

/**
 * 假 provider：**写入会改内存里的那份文档**，后续读取读到写后的值。
 *
 * 轮55 B线之前这套 fixture 的 publishConfig 是个空 mock——写完再读还是旧值，
 * 这跟真机行为不一样，会把「写后回读验证」的每条正常用例都拖成 drift 退避（1.1 秒）。
 * 现在直接改传进来的 documents（同一对象引用，批读并发那组用例也靠它拿到写后值），
 * 想模拟「写了但读不到」的用例再单独覆盖 getConfigDocument。
 */
function applyDocWrite(documents: Record<string, ConfigDocument | null>, connId: string, dataId: string, content: string, configType: string) {
  documents[`${connId}:${dataId}`] = doc(content, configType, "v-after-write");
}

function applyKeyWrite(documents: Record<string, ConfigDocument | null>, connId: string, dataId: string, key: string, content: string, configType: string) {
  const current = documents[`${connId}:${dataId}`];
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*${escapedKey}\\s*[:=]\\s*.*$`, "m");
  const body = current?.content ?? "";
  const written = `${key}=${content}`;
  const next = pattern.test(body) ? body.replace(pattern, written) : `${body}${body && !body.endsWith("\n") ? "\n" : ""}${written}\n`;
  documents[`${connId}:${dataId}`] = doc(next, current?.format ?? configType, "v-after-write");
}

function deps(documents: Record<string, ConfigDocument | null>, overrides: { backupReject?: Error; publishReject?: Error } = {}) {
  const manager = taskManager();
  const recordOperation = vi.fn((input: Omit<OperationRecord, "id" | "timestamp">): OperationRecord => {
    return { ...input, id: "history-1", timestamp: "2026-07-06T00:00:00.000Z" };
  });
  const publishConfigImpl = async (conn: Connection, _namespace: string, dataId: string, _group: string, content: string, configType: string) => {
    if (overrides.publishReject) throw overrides.publishReject;
    applyDocWrite(documents, conn.id, dataId, content, configType);
  };
  const deleteConfigImpl = async (conn: Connection, _namespace: string, dataId: string) => {
    documents[`${conn.id}:${dataId}`] = null;
  };
  const publishConfigRefImpl = async (
    conn: Connection,
    refValue: { dataId: string; key: string },
    content: string,
    configType: string
  ) => {
    if (refValue.key === "__document") applyDocWrite(documents, conn.id, refValue.dataId, content, configType);
    else applyKeyWrite(documents, conn.id, refValue.dataId, refValue.key, content, configType);
  };
  const deleteConfigRefImpl = async (conn: Connection, refValue: { dataId: string; key: string }) => {
    if (refValue.key === "__document") {
      documents[`${conn.id}:${refValue.dataId}`] = null;
      return;
    }
    // key 级删除是「整行没了」，不是「值变空串」——回读要按 exists:false 判确认
    const current = documents[`${conn.id}:${refValue.dataId}`];
    const escapedKey = refValue.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const withoutKey = (current?.content ?? "").replace(new RegExp(`^\\s*${escapedKey}\\s*[:=].*\\n?`, "m"), "");
    documents[`${conn.id}:${refValue.dataId}`] = withoutKey
      ? doc(withoutKey, current?.format ?? "properties", "v-after-write")
      : null;
  };
  return {
    connections: [sourceConnection, targetConnection],
    getConfigDocument: docReader(documents),
    publishConfig: overrides.publishReject ? vi.fn().mockRejectedValue(overrides.publishReject) : vi.fn(publishConfigImpl),
    deleteConfig: vi.fn(deleteConfigImpl),
    publishConfigRef: vi.fn(publishConfigRefImpl),
    deleteConfigRef: vi.fn(deleteConfigRefImpl),
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

    expect(result).toMatchObject({
      ok: false,
      taskId: "task-apply-1",
      error: expect.stringContaining("public/DEFAULT_GROUP/changed.yaml"),
    });
    // R55-A3：文案里不许再出现 itemId 的 `|` 拼接串，也不许漏出内部连接 id
    if (result.ok) throw new Error("expected execution to fail");
    expect(result.error).not.toContain("|");
    expect(result.error).not.toContain("conn-prod");
    expect(runDeps.createBackupSnapshot).not.toHaveBeenCalled();
    expect(runDeps.publishConfig).not.toHaveBeenCalled();
    expect(runDeps.deleteConfig).not.toHaveBeenCalled();
    expect(runDeps.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "apply",
        result: "failure",
        planId: "plan-1",
        taskId: "task-apply-1",
        error: expect.stringContaining("public/DEFAULT_GROUP/changed.yaml"),
      })
    );
    expect(runDeps.taskManager.completeTask).toHaveBeenCalledWith(
      "task-apply-1",
      false,
      expect.stringContaining("public/DEFAULT_GROUP/changed.yaml")
    );
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

    expect(result).toEqual({
      ok: true,
      taskId: "task-apply-1",
      historyId: "history-1",
      verification: expect.objectContaining({ total: 3, confirmedCount: 3, drifted: [], unreadable: [] }),
    });
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

    expect(result).toEqual({
      ok: true,
      taskId: "task-apply-1",
      historyId: "history-1",
      verification: expect.objectContaining({ total: 1, confirmedCount: 1, drifted: [], unreadable: [] }),
    });
    expect(runDeps.taskManager.createTask).toHaveBeenCalledWith(expect.stringContaining("plan-1"), "restore", {
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

    expect(result).toEqual({
      ok: true,
      taskId: "task-apply-1",
      historyId: "history-1",
      verification: expect.objectContaining({ total: 1, confirmedCount: 1, drifted: [], unreadable: [] }),
    });
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

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("plain.txt/feature.enabled") });
    expect(runDeps.publishConfig).not.toHaveBeenCalled();
    expect(runDeps.deleteConfig).not.toHaveBeenCalled();
    expect(runDeps.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "apply",
        result: "failure",
        error: expect.stringContaining("plain.txt/feature.enabled"),
        // 轮79 E4：写入清单都没构造出来 ⇒ 一条都没写，落笔范围是空清单
        appliedLocations: [],
        scopeIsWritten: true,
      })
    );
  });

  it("executes Apollo key-level writes through provider refs without falling back to document overwrite", async () => {
    const apolloSource: Connection = {
      ...sourceConnection,
      id: "apollo-dev",
      provider: "apollo",
      sourceType: "nacos",
      apolloEnv: "DEV",
      apolloAppId: "order-service",
      apolloCluster: "default",
      apolloNamespaceName: "application",
      apolloToken: "apollo-token",
    };
    const apolloTarget: Connection = {
      ...targetConnection,
      id: "apollo-prod",
      provider: "apollo",
      sourceType: "nacos",
      apolloEnv: "DEV",
      apolloAppId: "order-service",
      apolloCluster: "default",
      apolloNamespaceName: "application",
      apolloToken: "apollo-token",
    };
    const targetRef: BuildApplyPlanInput["items"][number]["ref"] = {
      provider: "apollo",
      connectionId: "apollo-prod",
      namespace: "order-service",
      group: "default",
      dataId: "application",
      key: "feature.enabled",
    };
    const sourceRef: BuildApplyPlanInput["items"][number]["ref"] = { ...targetRef, connectionId: "apollo-dev" };
    const plan = buildApplyPlan({
      id: "plan-apollo-key",
      createdAt: "2026-07-06T00:00:00.000Z",
      scope: "key",
      source: planEndpoint(apolloSource, "Apollo Dev / application"),
      target: planEndpoint(apolloTarget, "Apollo Prod / application"),
      inputSummary: {
        sourceType: "audit",
        scope: "key",
        sourceLabel: "Apollo Dev / application",
        targetLabel: "Apollo Prod / application",
        selectedCount: 1,
      },
      items: [
        {
          ref: targetRef,
          sourceRef,
          targetRef,
          sourceValue: { exists: true, value: "enabled", valueType: "string", format: "Properties", parseStatus: "ok" },
          targetValue: { exists: true, value: "disabled", valueType: "string", format: "Properties", parseStatus: "ok" },
        },
      ],
    });
    const runDeps = deps({
      "apollo-dev:application": doc("feature.enabled=enabled", "properties"),
      "apollo-prod:application": doc("feature.enabled=disabled", "properties"),
    });
    runDeps.connections = [apolloSource, apolloTarget];

    const result = await executeApplyPlan(plan, runDeps);

    expect(result).toEqual({
      ok: true,
      taskId: "task-apply-1",
      historyId: "history-1",
      verification: expect.objectContaining({ total: 1, confirmedCount: 1, drifted: [], unreadable: [] }),
    });
    expect(runDeps.publishConfigRef).toHaveBeenCalledWith(apolloTarget, targetRef, "enabled", "properties");
    expect(runDeps.publishConfig).not.toHaveBeenCalled();
    expect(runDeps.deleteConfig).not.toHaveBeenCalled();
    // 轮79 E4：key 级写入的落笔范围记到 key 这一层。塌成 `__document` 的话，
    // 回退会把整篇正文当成一项去覆盖，别人在同一个 dataId 下写的 key 也跟着遭殃。
    const [recordInput] = runDeps.recordOperation.mock.calls[runDeps.recordOperation.mock.calls.length - 1];
    expect(recordInput).toMatchObject({
      appliedLocations: [
        { namespace: "order-service", group: "default", dataId: "application", key: "feature.enabled" },
      ],
      scopeIsWritten: true,
    });
  });

  it("executes Consul document writes through provider refs with expected ModifyIndex versions", async () => {
    const consulSource: Connection = {
      ...sourceConnection,
      id: "consul-dev",
      provider: "consul",
      sourceType: "nacos",
      defaultNamespace: "dc1",
      consulDatacenter: "dc1",
      consulKeyPrefix: "apps/order/",
      consulToken: "consul-token",
    };
    const consulTarget: Connection = {
      ...targetConnection,
      id: "consul-prod",
      provider: "consul",
      sourceType: "nacos",
      defaultNamespace: "dc1",
      consulDatacenter: "dc1",
      consulKeyPrefix: "apps/order/",
      consulToken: "consul-token",
    };
    const consulEndpoint = (connection: Connection, label: string): ApplyPlanEndpoint => ({
      envId: connection.id,
      label,
      provider: "consul",
      connectionId: connection.id,
      connectionName: connection.name,
      namespace: "dc1",
    });
    const consulRef = (dataId: string): BuildApplyPlanInput["items"][number]["ref"] => ({
      provider: "consul",
      connectionId: "consul-prod",
      namespace: "dc1",
      group: "apps/order/",
      dataId,
      key: "__document",
    });
    const plan = buildApplyPlan({
      id: "plan-consul-document",
      createdAt: "2026-07-06T00:00:00.000Z",
      scope: "batch",
      source: consulEndpoint(consulSource, "Consul Dev / apps/order/"),
      target: consulEndpoint(consulTarget, "Consul Prod / apps/order/"),
      inputSummary: {
        sourceType: "diff",
        scope: "batch",
        sourceLabel: "Consul Dev / apps/order/",
        targetLabel: "Consul Prod / apps/order/",
        selectedCount: 3,
      },
      items: [
        {
          ref: consulRef("apps/order/app.yaml"),
          sourceRef: { ...consulRef("apps/order/app.yaml"), connectionId: "consul-dev" },
          targetRef: consulRef("apps/order/app.yaml"),
          sourceValue: documentValue("server:\n  port: 9090\n", true, "YAML"),
          targetValue: documentValueWithVersion("server:\n  port: 8080\n", "42", "YAML"),
        },
        {
          ref: consulRef("apps/order/new.yaml"),
          sourceRef: { ...consulRef("apps/order/new.yaml"), connectionId: "consul-dev" },
          targetRef: consulRef("apps/order/new.yaml"),
          sourceValue: documentValue("created: true\n", true, "YAML"),
          targetValue: absentValue(),
        },
        {
          ref: consulRef("apps/order/old.yaml"),
          sourceRef: { ...consulRef("apps/order/old.yaml"), connectionId: "consul-dev" },
          targetRef: consulRef("apps/order/old.yaml"),
          sourceValue: absentValue(),
          targetValue: documentValueWithVersion("remove: true\n", "51", "YAML"),
        },
      ],
    });
    const runDeps = deps({
      "consul-dev:apps/order/app.yaml": doc("server:\n  port: 9090\n", "yaml"),
      "consul-prod:apps/order/app.yaml": doc("server:\n  port: 8080\n", "yaml", "42"),
      "consul-dev:apps/order/new.yaml": doc("created: true\n", "yaml"),
      "consul-prod:apps/order/new.yaml": null,
      "consul-dev:apps/order/old.yaml": null,
      "consul-prod:apps/order/old.yaml": doc("remove: true\n", "yaml", "51"),
    });
    runDeps.connections = [consulSource, consulTarget];

    const result = await executeApplyPlan(plan, runDeps);

    expect(result).toEqual({
      ok: true,
      taskId: "task-apply-1",
      historyId: "history-1",
      verification: expect.objectContaining({ total: 3, confirmedCount: 3, drifted: [], unreadable: [] }),
    });
    expect(runDeps.publishConfigRef).toHaveBeenCalledWith(
      consulTarget,
      expect.objectContaining({ dataId: "apps/order/app.yaml", expectedVersion: "42" }),
      "server:\n  port: 9090\n",
      "yaml"
    );
    expect(runDeps.publishConfigRef).toHaveBeenCalledWith(
      consulTarget,
      expect.objectContaining({ dataId: "apps/order/new.yaml", expectedVersion: "0" }),
      "created: true\n",
      "yaml"
    );
    expect(runDeps.deleteConfigRef).toHaveBeenCalledWith(
      consulTarget,
      expect.objectContaining({ dataId: "apps/order/old.yaml", expectedVersion: "51" })
    );
    expect(runDeps.publishConfig).not.toHaveBeenCalled();
    expect(runDeps.deleteConfig).not.toHaveBeenCalled();
  });

  it("records Consul CAS conflicts as failed apply operations after backup", async () => {
    const consulTarget: Connection = {
      ...targetConnection,
      id: "consul-prod",
      provider: "consul",
      sourceType: "nacos",
      defaultNamespace: "dc1",
      consulDatacenter: "dc1",
      consulKeyPrefix: "apps/order/",
      consulToken: "consul-token",
    };
    const consulSource: Connection = { ...consulTarget, id: "consul-dev", name: "Consul Dev" };
    const targetRef: BuildApplyPlanInput["items"][number]["ref"] = {
      provider: "consul",
      connectionId: "consul-prod",
      namespace: "dc1",
      group: "apps/order/",
      dataId: "apps/order/app.yaml",
      key: "__document",
    };
    const plan = buildApplyPlan({
      id: "plan-consul-cas-conflict",
      createdAt: "2026-07-06T00:00:00.000Z",
      scope: "config",
      source: planEndpoint(consulSource, "Consul Dev / apps/order/"),
      target: planEndpoint(consulTarget, "Consul Prod / apps/order/"),
      inputSummary: {
        sourceType: "diff",
        scope: "config",
        sourceLabel: "Consul Dev / apps/order/",
        targetLabel: "Consul Prod / apps/order/",
        selectedCount: 1,
      },
      items: [
        {
          ref: targetRef,
          sourceRef: { ...targetRef, connectionId: "consul-dev" },
          targetRef,
          sourceValue: documentValue("server:\n  port: 9090\n", true, "YAML"),
          targetValue: documentValueWithVersion("server:\n  port: 8080\n", "42", "YAML"),
        },
      ],
    });
    const runDeps = deps({
      "consul-dev:apps/order/app.yaml": doc("server:\n  port: 9090\n", "yaml"),
      "consul-prod:apps/order/app.yaml": doc("server:\n  port: 8080\n", "yaml", "42"),
    });
    runDeps.connections = [consulSource, consulTarget];
    runDeps.publishConfigRef.mockRejectedValueOnce(new Error("Consul CAS 冲突，目标已变化: apps/order/app.yaml"));

    const result = await executeApplyPlan(plan, runDeps);

    expect(result).toMatchObject({ ok: false, taskId: "task-apply-1", historyId: "history-1", error: expect.stringContaining("CAS") });
    expect(runDeps.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "apply",
        result: "failure",
        backupSnapshotId: "snap-before-1",
        error: expect.stringContaining("CAS"),
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
  it("executes only the selected subset when item ids are provided", async () => {
    const plan = applyPlan([
      { ref: ref("changed.yaml"), sourceValue: documentValue("next changed"), targetValue: documentValue("old changed") },
      { ref: ref("removed.yaml"), sourceValue: absentValue(), targetValue: documentValue("old removed") },
    ]);
    const runDeps = deps({
      "conn-dev:changed.yaml": doc("next changed"),
      "conn-prod:changed.yaml": doc("old changed"),
      "conn-dev:removed.yaml": null,
      "conn-prod:removed.yaml": doc("old removed"),
    });

    const result = await executeApplyPlan(plan, runDeps, { selectedItemIds: [plan.items[0].id] });

    expect(result).toEqual({
      ok: true,
      taskId: "task-apply-1",
      historyId: "history-1",
      verification: expect.objectContaining({ total: 1, confirmedCount: 1, drifted: [], unreadable: [] }),
    });
    expect(runDeps.publishConfig).toHaveBeenCalledTimes(1);
    expect(runDeps.deleteConfig).not.toHaveBeenCalled();
    expect(runDeps.createBackupSnapshot).toHaveBeenCalledTimes(1);
    expect(runDeps.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "apply",
        result: "success",
        planId: "plan-1",
      })
    );
  });

  // R55-A1：批量新鲜度校验只覆盖「校验那一刻」，从校验到真正落库之间被人改过的值
  // 会照写不误。写前最后一刻用同一次读取的指纹复检，是这个窗口里唯一能兜住的手段。
  describe("写前最后一刻指纹复检", () => {
    /**
     * 让目标连接上某个 dataId 的第 fromCall 次（含）之后的读取返回另一份内容，
     * 用来模拟「校验时还好好的、落库前被人改了一刀」。
     * 单项计划下目标连接的读取顺序固定：①批量新鲜度 ②写前备份快照 ③写入前复检。
     */
    function depsWithLateTargetRead(
      documents: Record<string, ConfigDocument | null>,
      options: { dataId: string; lateContent?: string; fromCall: number; failFromCall?: number }
    ) {
      const base = deps(documents);
      const original = base.getConfigDocument;
      let targetReads = 0;
      base.getConfigDocument = vi.fn(async (conn: Connection, namespace: string, dataId: string, group: string) => {
        if (conn.id === "conn-prod" && dataId === options.dataId) {
          targetReads += 1;
          if (options.failFromCall !== undefined && targetReads >= options.failFromCall) {
            throw new Error(`network boom: ${dataId}`);
          }
          if (options.lateContent !== undefined && targetReads >= options.fromCall) {
            return doc(options.lateContent, "yaml", `late-${targetReads}`);
          }
        }
        return original(conn, namespace, dataId, group);
      });
      return base;
    }

    it("目标在校验后被人改动时停止该项，不覆盖别人的值", async () => {
      const plan = applyPlan([{ ref: ref("changed.yaml"), sourceValue: documentValue("new"), targetValue: documentValue("old") }]);
      const runDeps = depsWithLateTargetRead(
        { "conn-dev:changed.yaml": doc("new"), "conn-prod:changed.yaml": doc("old") },
        { dataId: "changed.yaml", lateContent: "someone-else-wrote-this", fromCall: 3 }
      );

      const result = await executeApplyPlan(plan, runDeps);

      if (result.ok) throw new Error("expected execution to fail");
      expect(result.error).toBe(translate("apply.writeConflictDetected", { ref: "public/DEFAULT_GROUP/changed.yaml" }));
      expect(runDeps.publishConfig).not.toHaveBeenCalled();
      expect(result.progress).toEqual({
        completedWrites: 0,
        totalWrites: 1,
        failedIndex: 1,
        failedRef: "public/DEFAULT_GROUP/changed.yaml",
        // 轮98：界面「跳过这一项，继续剩下的」要的是 id，不是那段人读标签
        failedItemId: plan.items[0].id,
      });
      expect(runDeps.recordOperation).toHaveBeenCalledWith(
        expect.objectContaining({ result: "failure", planId: "plan-1", backupSnapshotId: "snap-before-1" })
      );
    });

    it("复检读不到现值时维持 best-effort，照常执行写入", async () => {
      const plan = applyPlan([{ ref: ref("changed.yaml"), sourceValue: documentValue("new"), targetValue: documentValue("old") }]);
      const runDeps = depsWithLateTargetRead(
        { "conn-dev:changed.yaml": doc("new"), "conn-prod:changed.yaml": doc("old") },
        { dataId: "changed.yaml", fromCall: 99, failFromCall: 3 }
      );

      const result = await executeApplyPlan(plan, runDeps, { verifyDelaysMs: [0, 0, 0] });

      expect(result).toEqual({
        ok: true,
        taskId: "task-apply-1",
        historyId: "history-1",
        verification: expect.objectContaining({ total: 1, confirmedCount: 0, drifted: [], unreadable: [expect.stringContaining("changed.yaml")] }),
      });
      expect(runDeps.publishConfig).toHaveBeenCalledTimes(1);
    });

    it("逐项失败时外露「已写入几项 / 第几项失败」的进度", async () => {
      const plan = applyPlan([
        { ref: ref("a.yaml"), sourceValue: documentValue("a2"), targetValue: documentValue("a1") },
        { ref: ref("b.yaml"), sourceValue: documentValue("b2"), targetValue: documentValue("b1") },
      ]);
      const documents: Record<string, ConfigDocument | null> = {
        "conn-dev:a.yaml": doc("a2"),
        "conn-prod:a.yaml": doc("a1"),
        "conn-dev:b.yaml": doc("b2"),
        "conn-prod:b.yaml": doc("b1"),
      };
      const base = deps(documents);
      const runDeps = {
        ...base,
        // 只有 b 被 provider 拒了，a 照常落到假 store 上——不然写后回读会把正常项判成漂移
        publishConfig: vi.fn(async (conn: Connection, _namespace: string, dataId: string, _group: string, content: string, configType: string) => {
          if (dataId === "b.yaml") throw new Error("publish denied: b.yaml");
          applyDocWrite(documents, conn.id, dataId, content, configType);
        }),
      };

      const result = await executeApplyPlan(plan, runDeps);

      if (result.ok) throw new Error("expected execution to fail");
      expect(result.error).toBe("publish denied: b.yaml");
      expect(result.progress).toEqual({
        completedWrites: 1,
        totalWrites: 2,
        failedIndex: 2,
        failedRef: "public/DEFAULT_GROUP/b.yaml",
        failedItemId: plan.items[1].id,
      });
      // 第二条确实发起过写入请求（失败在 provider 侧），成功落库的只有第一条
      expect(runDeps.publishConfig.mock.calls.map((call: unknown[]) => call[2])).toEqual(["a.yaml", "b.yaml"]);
    });

    it("第二项在写前复检时被人改动，进度按已成功项计数", async () => {
      const plan = applyPlan([
        { ref: ref("a.yaml"), sourceValue: documentValue("a2"), targetValue: documentValue("a1") },
        { ref: ref("b.yaml"), sourceValue: documentValue("b2"), targetValue: documentValue("b1") },
      ]);
      const runDeps = depsWithLateTargetRead(
        {
          "conn-dev:a.yaml": doc("a2"),
          "conn-prod:a.yaml": doc("a1"),
          "conn-dev:b.yaml": doc("b2"),
          "conn-prod:b.yaml": doc("b1"),
        },
        { dataId: "b.yaml", lateContent: "b-late", fromCall: 3 }
      );

      const result = await executeApplyPlan(plan, runDeps);

      if (result.ok) throw new Error("expected execution to fail");
      expect(result.progress).toMatchObject({ completedWrites: 1, totalWrites: 2, failedIndex: 2 });
      expect(runDeps.publishConfig).toHaveBeenCalledTimes(1);
    });
  });

  it("supports dry-run without writing, backup snapshots or history records", async () => {
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

    const result = await executeApplyPlan(plan, runDeps, { dryRun: true });

    expect(result).toEqual({ ok: true, dryRun: true, taskId: "task-apply-1", plannedWrites: 3 });
    expect(runDeps.createBackupSnapshot).not.toHaveBeenCalled();
    expect(runDeps.publishConfig).not.toHaveBeenCalled();
    expect(runDeps.deleteConfig).not.toHaveBeenCalled();
    expect(runDeps.publishConfigRef).not.toHaveBeenCalled();
    expect(runDeps.deleteConfigRef).not.toHaveBeenCalled();
    expect(runDeps.recordOperation).not.toHaveBeenCalled();
    expect(runDeps.taskManager.completeTask).toHaveBeenCalledWith("task-apply-1", true);
  });
});


describe("执行记录的落笔范围（轮79 E4）", () => {
  /** 从 recordOperation 的调用里取那份记录输入。 */
  function recorded(runDeps: ReturnType<typeof deps>) {
    const calls = runDeps.recordOperation.mock.calls;
    const call = calls[calls.length - 1];
    if (!call) throw new Error("没有落操作历史，先确认这条路径该不该记");
    return call[0];
  }

  const locationOf = (dataId: string, key = "__document") => ({
    namespace: "public",
    group: "DEFAULT_GROUP",
    dataId,
    key,
  });

  it("一条都没写成时记空清单，不再谎报成「全部勾选项都写了」", async () => {
    const plan = applyPlan([{ ref: ref("changed.yaml"), sourceValue: documentValue("new"), targetValue: documentValue("old") }]);
    // 新鲜度不过 ⇒ 连备份都没做，一条都没写出去
    const runDeps = deps({
      "conn-dev:changed.yaml": doc("newer"),
      "conn-prod:changed.yaml": doc("old"),
    });

    const result = await executeApplyPlan(plan, runDeps);

    expect(result.ok).toBe(false);
    const record = recorded(runDeps);
    expect(record.result).toBe("failure");
    expect(record.appliedLocations, "前置失败也记「全部可执行项」，回退入口就会多出没碰过的配置").toEqual([]);
    expect(record.scopeIsWritten).toBe(true);
  });

  it("备份阶段失败同样记空清单：计划范围不能冒充落笔范围", async () => {
    const plan = applyPlan([
      { ref: ref("a.yaml"), sourceValue: documentValue("a2"), targetValue: documentValue("a1") },
      { ref: ref("b.yaml"), sourceValue: documentValue("b2"), targetValue: documentValue("b1") },
    ]);
    const runDeps = deps(
      {
        "conn-dev:a.yaml": doc("a2"),
        "conn-prod:a.yaml": doc("a1"),
        "conn-dev:b.yaml": doc("b2"),
        "conn-prod:b.yaml": doc("b1"),
      },
      { backupReject: new Error("snapshot disk full") }
    );

    await executeApplyPlan(plan, runDeps);

    const record = recorded(runDeps);
    expect(record.result).toBe("failure");
    expect(record.appliedLocations).toEqual([]);
    expect(record.scopeIsWritten).toBe(true);
    expect(runDeps.publishConfig).not.toHaveBeenCalled();
  });

  it("半截失败只记真正写成的那几条，并与进度里的 completedWrites 对齐", async () => {
    const plan = applyPlan([
      { ref: ref("a.yaml"), sourceValue: documentValue("a2"), targetValue: documentValue("a1") },
      { ref: ref("b.yaml"), sourceValue: documentValue("b2"), targetValue: documentValue("b1") },
    ]);
    const documents: Record<string, ConfigDocument | null> = {
      "conn-dev:a.yaml": doc("a2"),
      "conn-prod:a.yaml": doc("a1"),
      "conn-dev:b.yaml": doc("b2"),
      "conn-prod:b.yaml": doc("b1"),
    };
    const base = deps(documents);
    const runDeps = {
      ...base,
      publishConfig: vi.fn(async (conn: Connection, _ns: string, dataId: string, _g: string, content: string, configType: string) => {
        if (dataId === "b.yaml") throw new Error("403 Forbidden");
        applyDocWrite(documents, conn.id, dataId, content, configType);
      }),
    };

    const result = await executeApplyPlan(plan, runDeps);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    const record = recorded(runDeps);
    expect(record.result).toBe("failure");
    expect(record.appliedLocations).toEqual([locationOf("a.yaml")]);
    expect(record.scopeIsWritten).toBe(true);
    // 两个来源必须是同一个数：进度说写成 1 项，范围就只能有 1 条位置
    const scope = record.appliedLocations ?? [];
    expect(scope.length, "落笔清单与 completedWrites 打脸").toBe(result.progress?.completedWrites);
    expect(result.progress).toMatchObject({ completedWrites: 1, totalWrites: 2, failedIndex: 2 });
  });

  it("执行成功时清单等于全部落笔项，且带 scopeIsWritten 标记", async () => {
    const plan = applyPlan([
      { ref: ref("a.yaml"), sourceValue: documentValue("a2"), targetValue: documentValue("a1") },
      { ref: ref("b.yaml"), sourceValue: documentValue("b2"), targetValue: documentValue("b1") },
    ]);
    const runDeps = deps({
      "conn-dev:a.yaml": doc("a2"),
      "conn-prod:a.yaml": doc("a1"),
      "conn-dev:b.yaml": doc("b2"),
      "conn-prod:b.yaml": doc("b1"),
    });

    const result = await executeApplyPlan(plan, runDeps);

    expect(result.ok).toBe(true);
    const record = recorded(runDeps);
    expect(record.result).toBe("success");
    expect(record.appliedLocations).toEqual([locationOf("a.yaml"), locationOf("b.yaml")]);
    expect(record.scopeIsWritten).toBe(true);
  });

  it("只勾选一部分执行时，清单只含勾选项：没勾的不能出现在回退范围里", async () => {
    const plan = applyPlan([
      { ref: ref("a.yaml"), sourceValue: documentValue("a2"), targetValue: documentValue("a1") },
      { ref: ref("b.yaml"), sourceValue: documentValue("b2"), targetValue: documentValue("b1") },
    ]);
    const runDeps = deps({
      "conn-dev:a.yaml": doc("a2"),
      "conn-prod:a.yaml": doc("a1"),
      "conn-dev:b.yaml": doc("b2"),
      "conn-prod:b.yaml": doc("b1"),
    });

    const result = await executeApplyPlan(plan, runDeps, { selectedItemIds: [plan.items[1].id] });

    expect(result.ok).toBe(true);
    expect(recorded(runDeps).appliedLocations).toEqual([locationOf("b.yaml")]);
  });

  it("dry-run 不落操作历史，也不该攒出落笔清单", async () => {
    const plan = applyPlan([{ ref: ref("a.yaml"), sourceValue: documentValue("a2"), targetValue: documentValue("a1") }]);
    const runDeps = deps({ "conn-dev:a.yaml": doc("a2"), "conn-prod:a.yaml": doc("a1") });

    const result = await executeApplyPlan(plan, runDeps, { dryRun: true });

    expect(result).toMatchObject({ ok: true, dryRun: true, plannedWrites: 1 });
    expect(runDeps.recordOperation).not.toHaveBeenCalled();
    expect(runDeps.publishConfig).not.toHaveBeenCalled();
  });
});

describe("content-replace 风格计划（source override + 原文基线指纹）", () => {
  const devRef: ApplyPlanRef = {
    provider: "nacos",
    connectionId: "conn-dev",
    namespace: "public",
    group: "DEFAULT_GROUP",
    dataId: "app.yaml",
    key: "__document",
  };
  const ORIGINAL = "server:\n  port: 8080";
  const REPLACED = "server:\n  port: 9090";
  const baselineFingerprint = fingerprintApplyPlanValue(devRef, {
    exists: true,
    value: ORIGINAL,
    valueType: "text",
    format: "YAML",
    parseStatus: "ok",
  });

  /** 模拟 buildApplyPlanFromEntry 对内容替换条目的产物：sourceValue=替换后 override，sourceFingerprint=原文基线。 */
  function contentReplacePlan(targetConnectionId: "conn-dev" | "conn-prod"): ApplyPlan {
    const targetConn = targetConnectionId === "conn-dev" ? sourceConnection : targetConnection;
    const targetLabel = targetConnectionId === "conn-dev" ? "Dev / public" : "Prod / public";
    return buildApplyPlan({
      id: "plan-cr-1",
      createdAt: "2026-07-06T00:00:00.000Z",
      scope: "batch",
      source: planEndpoint(sourceConnection, "Dev / public"),
      target: planEndpoint(targetConn, targetLabel),
      inputSummary: {
        sourceType: "manual",
        scope: "batch",
        sourceLabel: "Dev / public",
        targetLabel,
        selectedCount: 1,
      },
      items: [
        {
          ref: { ...devRef, connectionId: targetConnectionId },
          sourceRef: devRef,
          sourceValue: { exists: true, value: REPLACED, valueType: "text", format: "YAML", parseStatus: "ok", content: REPLACED },
          targetValue: documentValue(ORIGINAL),
          sourceFingerprint: baselineFingerprint,
        },
      ],
    });
  }

  it("来源文档未变时执行成功，发布替换后内容", async () => {
    const plan = contentReplacePlan("conn-prod");
    const runDeps = deps({
      "conn-dev:app.yaml": doc(ORIGINAL),
      "conn-prod:app.yaml": doc(ORIGINAL),
    });

    const result = await executeApplyPlan(plan, runDeps);

    expect(result).toEqual({
      ok: true,
      taskId: "task-apply-1",
      historyId: "history-1",
      verification: expect.objectContaining({ total: 1, confirmedCount: 1, drifted: [], unreadable: [] }),
    });
    expect(runDeps.publishConfig).toHaveBeenCalledWith(targetConnection, "public", "app.yaml", "DEFAULT_GROUP", REPLACED, "yaml");
    expect(runDeps.createBackupSnapshot).toHaveBeenCalled();
  });

  it("来源文档在计划生成后被改动时报 source stale 且不写入", async () => {
    const plan = contentReplacePlan("conn-prod");
    const runDeps = deps({
      "conn-dev:app.yaml": doc("server:\n  port: 9999"),
      "conn-prod:app.yaml": doc(ORIGINAL),
    });

    const result = await executeApplyPlan(plan, runDeps);

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("public/DEFAULT_GROUP/app.yaml") });
    if (result.ok) throw new Error("expected execution to fail");
    expect(result.error).not.toContain("|");
    expect(runDeps.publishConfig).not.toHaveBeenCalled();
    expect(runDeps.createBackupSnapshot).not.toHaveBeenCalled();
  });

  it("来源与目标为同一连接时原地执行成功（issue #2 场景）", async () => {
    const plan = contentReplacePlan("conn-dev");
    const runDeps = deps({
      "conn-dev:app.yaml": doc(ORIGINAL),
    });

    const result = await executeApplyPlan(plan, runDeps);

    expect(result).toEqual({
      ok: true,
      taskId: "task-apply-1",
      historyId: "history-1",
      verification: expect.objectContaining({ total: 1, confirmedCount: 1, drifted: [], unreadable: [] }),
    });
    expect(runDeps.publishConfig).toHaveBeenCalledWith(sourceConnection, "public", "app.yaml", "DEFAULT_GROUP", REPLACED, "yaml");
    expect(runDeps.publishConfig).toHaveBeenCalledTimes(1);
  });
});

// 轮43：配置浏览 / 配置对比页是保活的，它们唯一能知道「服务端真值变了」的通道就是这条广播。
// 发布点必须钉在执行器里（全站唯一 sanctioned 写入者），所以这几条锁的是发布时机而不是文案。
describe("executeApplyPlan 写后失效广播", () => {
  it("dry-run 不广播（一条都没写，视图不该白重取一次）", async () => {
    const plan = applyPlan([{ ref: ref("changed.yaml"), sourceValue: documentValue("new"), targetValue: documentValue("old") }]);
    const runDeps = {
      ...deps({ "conn-dev:changed.yaml": doc("new"), "conn-prod:changed.yaml": doc("old") }),
      onConfigsChanged: vi.fn(),
    };

    const result = await executeApplyPlan(plan, runDeps, { dryRun: true });

    expect(result.ok).toBe(true);
    expect(runDeps.onConfigsChanged).not.toHaveBeenCalled();
  });

  it("执行成功时按命名空间广播真正写过的 ref，跳过项不算", async () => {
    const plan = applyPlan([
      { ref: ref("created.yaml"), sourceValue: documentValue("new file"), targetValue: absentValue() },
      { ref: ref("removed.yaml"), sourceValue: absentValue(), targetValue: documentValue("old removed") },
      { ref: ref("same.yaml"), sourceValue: documentValue("same"), targetValue: documentValue("same") },
    ]);
    const runDeps = {
      ...deps({
        "conn-dev:created.yaml": doc("new file"),
        "conn-prod:created.yaml": null,
        "conn-dev:removed.yaml": null,
        "conn-prod:removed.yaml": doc("old removed"),
        "conn-dev:same.yaml": doc("same"),
        "conn-prod:same.yaml": doc("same"),
      }),
      onConfigsChanged: vi.fn(),
    };

    const result = await executeApplyPlan(plan, runDeps);

    expect(result.ok).toBe(true);
    expect(runDeps.onConfigsChanged).toHaveBeenCalledTimes(1);
    const notice = runDeps.onConfigsChanged.mock.calls[0][0];
    expect(notice.connectionId).toBe("conn-prod");
    expect(notice.namespace).toBe("public");
    expect(notice.refs.map((item: { dataId: string }) => item.dataId).sort()).toEqual(["created.yaml", "removed.yaml"]);
  });

  it("逐项失败也广播，且只带失败之前写成功的那几条", async () => {
    const plan = applyPlan([
      { ref: ref("a.yaml"), sourceValue: documentValue("a2"), targetValue: documentValue("a1") },
      { ref: ref("b.yaml"), sourceValue: documentValue("b2"), targetValue: documentValue("b1") },
    ]);
    const documents: Record<string, ConfigDocument | null> = {
      "conn-dev:a.yaml": doc("a2"),
      "conn-prod:a.yaml": doc("a1"),
      "conn-dev:b.yaml": doc("b2"),
      "conn-prod:b.yaml": doc("b1"),
    };
    const base = deps(documents);
    const runDeps = {
      ...base,
      publishConfig: vi.fn(async (conn: Connection, _namespace: string, dataId: string, _group: string, content: string, configType: string) => {
        if (dataId === "b.yaml") throw new Error("publish denied: b.yaml");
        applyDocWrite(documents, conn.id, dataId, content, configType);
      }),
      onConfigsChanged: vi.fn(),
    };

    const result = await executeApplyPlan(plan, runDeps);

    expect(result.ok).toBe(false);
    expect(runDeps.onConfigsChanged).toHaveBeenCalledTimes(1);
    expect(runDeps.onConfigsChanged.mock.calls[0][0].refs).toEqual([{ dataId: "a.yaml", group: "DEFAULT_GROUP" }]);
  });

  it("空命名空间归一成 public，否则视图会认为这次写入与己无关", async () => {
    const plan = applyPlan([
      {
        ref: { ...ref("orphan.yaml"), namespace: "" },
        sourceValue: documentValue("new"),
        targetValue: documentValue("old"),
      },
    ]);
    const runDeps = {
      ...deps({ "conn-dev:orphan.yaml": doc("new"), "conn-prod:orphan.yaml": doc("old") }),
      onConfigsChanged: vi.fn(),
    };

    const result = await executeApplyPlan(plan, runDeps);

    expect(result.ok).toBe(true);
    expect(runDeps.onConfigsChanged).toHaveBeenCalledTimes(1);
    expect(runDeps.onConfigsChanged.mock.calls[0][0].namespace).toBe("public");
  });

  it("没接 onConfigsChanged 时照旧执行成功（回调是可选依赖）", async () => {
    const plan = applyPlan([{ ref: ref("changed.yaml"), sourceValue: documentValue("new"), targetValue: documentValue("old") }]);
    const runDeps = deps({ "conn-dev:changed.yaml": doc("new"), "conn-prod:changed.yaml": doc("old") });

    const result = await executeApplyPlan(plan, runDeps);

    expect(result).toEqual({
      ok: true,
      taskId: "task-apply-1",
      historyId: "history-1",
      verification: expect.objectContaining({ total: 1, confirmedCount: 1, drifted: [], unreadable: [] }),
    });
  });
});

// ── 波17：批量读快照的并发口径（R55-D1）──

describe("executeApplyPlan 批读并发", () => {
  /**
   * 4 项计划、每项两端各读一次，串行版同时在飞的请求最多 2 个
   * （一项的 source/target 那一对 Promise.all）；改成共用并发口径后必然交叠。
   * 这条用例钉的是「不再逐条 await」这个事实本身，不是具体数字。
   */
  it("新鲜度与写前两趟批读交叠在飞，不再逐条串行", async () => {
    const dataIds = ["a.yaml", "b.yaml", "c.yaml", "d.yaml"];
    const documents: Record<string, ConfigDocument | null> = {};
    for (const dataId of dataIds) {
      documents[`conn-dev:${dataId}`] = doc("new");
      documents[`conn-prod:${dataId}`] = doc("old");
    }
    const runDeps = deps(documents);
    let active = 0;
    let peak = 0;
    runDeps.getConfigDocument = vi.fn(async (conn: Connection, _namespace: string, dataId: string, _group: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return documents[`${conn.id}:${dataId}`] ?? doc("unexpected");
    });

    const result = await executeApplyPlan(
      applyPlan(dataIds.map((dataId) => ({ ref: ref(dataId), sourceValue: documentValue("new"), targetValue: documentValue("old") }))),
      runDeps
    );

    expect(result.ok).toBe(true);
    expect(peak).toBeGreaterThanOrEqual(4);
    // 并发回填必须与计划同序：备份快照的顺序决定了历史页「写前现场」的对应关系
    const configs = runDeps.createBackupSnapshot.mock.calls[0][0] as Array<{ dataId: string }>;
    expect(configs.map((config) => config.dataId)).toEqual(dataIds);
  });
});

// ── 轮55 B线：写后回读验证（R55-B1）──

describe("executeApplyPlan 写后回读验证", () => {
  /**
   * 目标连接上「第 fromCall 次（含）之后」的读取返回另一份内容。
   * 单项计划下目标读取顺序固定：①批量新鲜度 ②写前备份快照 ③写入前复检 ④起是写后回读。
   */
  function depsWithTargetReads(
    documents: Record<string, ConfigDocument | null>,
    options: { dataId: string; contentForRead: (targetReads: number) => string | null | undefined; fromCall: number }
  ) {
    const runDeps = deps(documents);
    const original = runDeps.getConfigDocument;
    let targetReads = 0;
    runDeps.getConfigDocument = vi.fn(async (conn: Connection, namespace: string, dataId: string, group: string) => {
      if (conn.id === "conn-prod" && dataId === options.dataId) {
        targetReads += 1;
        const override = targetReads >= options.fromCall ? options.contentForRead(targetReads) : undefined;
        if (override === undefined) return original(conn, namespace, dataId, group);
        if (override === null) throw new Error(`404 not found: ${conn.id}/${dataId}`);
        return doc(override, "yaml", `read-${targetReads}`);
      }
      return original(conn, namespace, dataId, group);
    });
    return runDeps;
  }

  it("首读还是旧值、二读追上写入值时判 confirmed——默认退避必须真跑满可见窗口", async () => {
    const plan = applyPlan([{ ref: ref("lagging.yaml"), sourceValue: documentValue("new"), targetValue: absentValue() }]);
    const documents: Record<string, ConfigDocument | null> = { "conn-dev:lagging.yaml": doc("new") };
    // 只有回读会打到 conn-prod:第 4 次读（写完第一次）返回旧值，之后返回写后的值
    const runDeps = depsWithTargetReads(documents, {
      dataId: "lagging.yaml",
      fromCall: 4,
      contentForRead: (targetReads) => (targetReads === 4 ? "not-yet-visible" : "new"),
    });

    const startedAt = Date.now();
    const result = await executeApplyPlan(plan, runDeps);
    const elapsed = Date.now() - startedAt;

    if (!result.ok || "dryRun" in result) throw new Error("expected execution to succeed");
    expect(result.verification).toMatchObject({
      total: 1,
      confirmedCount: 1,
      drifted: [],
      unreadable: [],
      items: [{ ref: "public/DEFAULT_GROUP/lagging.yaml", verdict: "confirmed" }],
    });
    // 真机取证：单节点 loopback 写后可见窗口 54–145ms，所以第二次读要等过退避才可能追上
    expect(elapsed).toBeGreaterThanOrEqual(100);
  });

  it("覆盖写后一直读到旧值判 drifted，而不是替用户断言写入成功", async () => {
    const plan = applyPlan([{ ref: ref("stale.yaml"), sourceValue: documentValue("new"), targetValue: documentValue("old") }]);
    const runDeps = depsWithTargetReads(
      { "conn-dev:stale.yaml": doc("new"), "conn-prod:stale.yaml": doc("old") },
      { dataId: "stale.yaml", fromCall: 4, contentForRead: () => "old" }
    );

    const result = await executeApplyPlan(plan, runDeps, { verifyDelaysMs: [0, 0, 0, 0] });

    if (!result.ok || "dryRun" in result) throw new Error("expected execution to succeed");
    // 验证不翻转执行结果：写请求已经落库，回读不一致是「要人看一眼」而不是「执行失败」
    expect(result.historyId).toBe("history-1");
    expect(result.verification).toMatchObject({
      total: 1,
      confirmedCount: 0,
      drifted: ["public/DEFAULT_GROUP/stale.yaml"],
      unreadable: [],
    });
  });

  it("删除后目标仍读得到就算没删掉（drifted），窗口内消失才算确认", async () => {
    const plan = applyPlan([{ ref: ref("gone.yaml"), sourceValue: absentValue(), targetValue: documentValue("old") }]);
    const stillThere = depsWithTargetReads({ "conn-prod:gone.yaml": doc("old") }, {
      dataId: "gone.yaml",
      fromCall: 4,
      contentForRead: () => "old",
    });

    const drifted = await executeApplyPlan(plan, stillThere, { verifyDelaysMs: [0, 0] });
    if (!drifted.ok || "dryRun" in drifted) throw new Error("expected execution to succeed");
    expect(drifted.verification).toMatchObject({ total: 1, confirmedCount: 0, drifted: ["public/DEFAULT_GROUP/gone.yaml"] });
    expect(stillThere.deleteConfig).toHaveBeenCalledTimes(1);

    const documents: Record<string, ConfigDocument | null> = { "conn-prod:gone.yaml": doc("old") };
    const confirmedDeps = deps(documents);
    const original = confirmedDeps.getConfigDocument;
    let deleteSettled = false;
    setTimeout(() => {
      deleteSettled = true;
    }, 160);
    confirmedDeps.getConfigDocument = vi.fn(async (conn: Connection, namespace: string, dataId: string, group: string) => {
      if (conn.id === "conn-prod" && dataId === "gone.yaml" && deleteSettled) throw new Error("404 not found");
      return original(conn, namespace, dataId, group);
    });

    const confirmed = await executeApplyPlan(plan, confirmedDeps);
    if (!confirmed.ok || "dryRun" in confirmed) throw new Error("expected execution to succeed");
    expect(confirmed.verification).toMatchObject({ total: 1, confirmedCount: 1, drifted: [] });
  });

  it("回读本身失败时判 unreadable，既不说成功也不说写坏", async () => {
    const plan = applyPlan([{ ref: ref("noisy.yaml"), sourceValue: documentValue("new"), targetValue: documentValue("old") }]);
    const base = deps({ "conn-dev:noisy.yaml": doc("new"), "conn-prod:noisy.yaml": doc("old") });
    const healthyRead = base.getConfigDocument;
    let prodReads = 0;
    base.getConfigDocument = vi.fn(async (conn: Connection, namespace: string, dataId: string, group: string) => {
      if (conn.id === "conn-prod") {
        prodReads += 1;
        // ①批量新鲜度 ②写前快照 ③写前复检都还是好的，从第 4 次（写后回读）起整条读路断了
        if (prodReads > 3) throw new Error("500 Internal Server Error");
      }
      return healthyRead(conn, namespace, dataId, group);
    });

    const result = await executeApplyPlan(plan, base, { verifyDelaysMs: [0, 0] });

    if (!result.ok || "dryRun" in result) throw new Error("expected execution to succeed");
    expect(result.verification).toMatchObject({
      total: 1,
      confirmedCount: 0,
      drifted: [],
      unreadable: ["public/DEFAULT_GROUP/noisy.yaml"],
    });
  });

  it("key 级写入按这一项的回读值确认，不看整篇正文也不看 md5", async () => {
    const apolloTarget: Connection = { ...targetConnection, id: "apollo-prod", provider: "apollo", apolloEnv: "DEV" };
    const apolloSource: Connection = { ...sourceConnection, id: "apollo-dev", provider: "apollo", apolloEnv: "DEV" };
    const keyRef: BuildApplyPlanInput["items"][number]["ref"] = {
      provider: "apollo",
      connectionId: "apollo-prod",
      namespace: "order-service",
      group: "default",
      dataId: "application",
      key: "feature.enabled",
    };
    const plan = buildApplyPlan({
      id: "plan-apollo-verify",
      createdAt: "2026-07-06T00:00:00.000Z",
      scope: "key",
      source: planEndpoint(apolloSource, "Apollo Dev / application"),
      target: planEndpoint(apolloTarget, "Apollo Prod / application"),
      inputSummary: {
        sourceType: "audit",
        scope: "key",
        sourceLabel: "Apollo Dev / application",
        targetLabel: "Apollo Prod / application",
        selectedCount: 1,
      },
      items: [
        {
          ref: keyRef,
          sourceRef: { ...keyRef, connectionId: "apollo-dev" },
          targetRef: keyRef,
          sourceValue: { exists: true, value: "enabled", valueType: "string", format: "Properties", parseStatus: "ok" },
          targetValue: { exists: true, value: "disabled", valueType: "string", format: "Properties", parseStatus: "ok" },
        },
      ],
    });
    const runDeps = deps({
      "apollo-dev:application": doc("feature.enabled=enabled", "properties"),
      "apollo-prod:application": doc("feature.enabled=disabled", "properties"),
    });
    runDeps.connections = [apolloSource, apolloTarget];

    const result = await executeApplyPlan(plan, runDeps);

    if (!result.ok || "dryRun" in result) throw new Error("expected execution to succeed");
    expect(result.verification).toMatchObject({
      total: 1,
      confirmedCount: 1,
      items: [{ ref: "order-service/default/application (feature.enabled)", verdict: "confirmed" }],
    });
  });

  it("半截写入：失败项之前落成功的条目照样回读，进度与验证一起给", async () => {
    const plan = applyPlan([
      { ref: ref("kept.yaml"), sourceValue: documentValue("kept2"), targetValue: documentValue("kept1") },
      { ref: ref("broken.yaml"), sourceValue: documentValue("broken2"), targetValue: documentValue("broken1") },
    ]);
    const documents: Record<string, ConfigDocument | null> = {
      "conn-dev:kept.yaml": doc("kept2"),
      "conn-prod:kept.yaml": doc("kept1"),
      "conn-dev:broken.yaml": doc("broken2"),
      "conn-prod:broken.yaml": doc("broken1"),
    };
    const base = deps(documents);
    base.publishConfig = vi.fn(async (conn: Connection, _namespace: string, dataId: string, _group: string, content: string, configType: string) => {
      if (dataId === "broken.yaml") throw new Error("publish denied: broken.yaml");
      applyDocWrite(documents, conn.id, dataId, content, configType);
    });

    const result = await executeApplyPlan(plan, base, { verifyDelaysMs: [0, 0] });

    if (result.ok) throw new Error("expected execution to fail");
    expect(result.progress).toMatchObject({ completedWrites: 1, totalWrites: 2, failedIndex: 2 });
    expect(result.verification).toMatchObject({
      total: 1,
      confirmedCount: 1,
      drifted: [],
      unreadable: [],
      items: [{ ref: "public/DEFAULT_GROUP/kept.yaml", verdict: "confirmed" }],
    });
  });

  it("dry-run 一条都不回读，也不带验证结论", async () => {
    const plan = applyPlan([{ ref: ref("changed.yaml"), sourceValue: documentValue("new"), targetValue: documentValue("old") }]);
    const runDeps = deps({ "conn-dev:changed.yaml": doc("new"), "conn-prod:changed.yaml": doc("old") });

    const result = await executeApplyPlan(plan, runDeps, { dryRun: true });

    expect("verification" in result).toBe(false);
    // 目标侧只有批量新鲜度一次读取，没有写前快照、没有复检、没有回读
    expect(runDeps.getConfigDocument.mock.calls.filter((call: unknown[]) => (call[0] as Connection).id === "conn-prod")).toHaveLength(1);
  });
});

describe("本机版本历史：只有写后回读确认才算本程序写的那一版（R57）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 装一颗绑定替身并把调用抓下来：这一层没有别的出口，只能按真接线打桩。 */
  function captureRevisions(opts: { reject?: boolean } = {}) {
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal("window", {
      go: {
        app: {
          App: {
            AppendConfigRevision: (input: Record<string, unknown>) => {
              calls.push(input);
              return opts.reject ? Promise.reject(new Error("本机历史写不进去")) : Promise.resolve({ appended: true, reason: "", record: {} });
            },
          },
        },
      },
    });
    return calls;
  }

  /** fire-and-forget：等一个宏任务让绑定的 then/catch 跑完。 */
  async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** 让 conn-prod 从第 fromCall 次读起固定拿到指定正文（用来造 drifted / unreadable）。 */
  function depsWithForcedTargetRead(
    documents: Record<string, ConfigDocument | null>,
    options: { dataId: string; fromCall: number; content?: string; throwOnRead?: boolean }
  ) {
    const runDeps = deps(documents);
    const original = runDeps.getConfigDocument;
    let targetReads = 0;
    runDeps.getConfigDocument = vi.fn(async (conn: Connection, namespace: string, dataId: string, group: string) => {
      if (conn.id === "conn-prod" && dataId === options.dataId) {
        targetReads += 1;
        if (targetReads >= options.fromCall) {
          if (options.throwOnRead) throw new Error("500 Internal Server Error");
          return doc(options.content ?? "someone-else-changed-it", "yaml", `forced-${targetReads}`);
        }
      }
      return original(conn, namespace, dataId, group);
    });
    return runDeps;
  }

  it("整篇写入确认后记 confirmed-write：带 planId、归属与写后的完整正文", async () => {
    const calls = captureRevisions();
    const plan = applyPlan([{ ref: ref("history.yaml"), sourceValue: documentValue("gateway: on\n"), targetValue: absentValue() }]);
    const result = await executeApplyPlan(plan, deps({ "conn-dev:history.yaml": doc("gateway: on\n") }), { verifyDelaysMs: [0, 0] });

    if (!result.ok || "dryRun" in result) throw new Error("expected execution to succeed");
    expect(result.verification).toMatchObject({ total: 1, confirmedCount: 1 });
    await settle();

    expect(calls.length).toBe(1);
    expect(calls[0]).toMatchObject({
      kind: "confirmed-write",
      connectionId: "conn-prod",
      provider: "nacos",
      namespace: "public",
      group: "DEFAULT_GROUP",
      dataId: "history.yaml",
      content: "gateway: on\n",
      planId: "plan-1",
    });
  });

  it("key 级写入记整篇正文与真实 provider，不记单个 key 的值", async () => {
    const calls = captureRevisions();
    const apolloTarget: Connection = { ...targetConnection, id: "apollo-prod", provider: "apollo", apolloEnv: "DEV" };
    const apolloSource: Connection = { ...sourceConnection, id: "apollo-dev", provider: "apollo", apolloEnv: "DEV" };
    const keyRef: BuildApplyPlanInput["items"][number]["ref"] = {
      provider: "apollo",
      connectionId: "apollo-prod",
      namespace: "order-service",
      group: "default",
      dataId: "application",
      key: "feature.enabled",
    };
    const plan = buildApplyPlan({
      id: "plan-apollo-revision",
      createdAt: "2026-07-06T00:00:00.000Z",
      scope: "key",
      source: planEndpoint(apolloSource, "Apollo Dev / application"),
      target: planEndpoint(apolloTarget, "Apollo Prod / application"),
      inputSummary: {
        sourceType: "audit",
        scope: "key",
        sourceLabel: "Apollo Dev / application",
        targetLabel: "Apollo Prod / application",
        selectedCount: 1,
      },
      items: [
        {
          ref: keyRef,
          sourceRef: { ...keyRef, connectionId: "apollo-dev" },
          targetRef: keyRef,
          sourceValue: { exists: true, value: "enabled", valueType: "string", format: "Properties", parseStatus: "ok" },
          targetValue: { exists: true, value: "disabled", valueType: "string", format: "Properties", parseStatus: "ok" },
        },
      ],
    });
    const runDeps = deps({
      "apollo-dev:application": doc("feature.enabled=enabled", "properties"),
      "apollo-prod:application": doc("feature.enabled=disabled", "properties"),
    });
    runDeps.connections = [apolloSource, apolloTarget];

    const result = await executeApplyPlan(plan, runDeps, { verifyDelaysMs: [0, 0] });
    if (!result.ok || "dryRun" in result) throw new Error("expected execution to succeed");
    await settle();

    expect(calls.length).toBe(1);
    expect(calls[0]).toMatchObject({
      kind: "confirmed-write",
      connectionId: "apollo-prod",
      provider: "apollo",
      namespace: "order-service",
      group: "default",
      dataId: "application",
      planId: "plan-apollo-revision",
    });
    // 整篇正文：只记这一项的值会让人以为配置只剩这一行
    expect(calls[0].content).toBe("feature.enabled=enabled");
    expect(calls[0].content).not.toBe("enabled");
  });

  it("drifted 不算本程序写成的那一版：没确认就不许记 confirmed-write", async () => {
    const calls = captureRevisions();
    const plan = applyPlan([{ ref: ref("drift.yaml"), sourceValue: documentValue("new"), targetValue: absentValue() }]);
    const runDeps = depsWithForcedTargetRead({ "conn-dev:drift.yaml": doc("new") }, { dataId: "drift.yaml", fromCall: 4 });

    const result = await executeApplyPlan(plan, runDeps, { verifyDelaysMs: [0, 0] });
    if (!result.ok || "dryRun" in result) throw new Error("expected execution to succeed");
    expect(result.verification).toMatchObject({ total: 1, confirmedCount: 0, drifted: ["public/DEFAULT_GROUP/drift.yaml"] });
    await settle();

    expect(calls.length).toBe(0);
  });

  it("回读不通（unreadable）也不记：确认不了就是确认不了", async () => {
    const calls = captureRevisions();
    const plan = applyPlan([{ ref: ref("dark.yaml"), sourceValue: documentValue("new"), targetValue: absentValue() }]);
    const runDeps = depsWithForcedTargetRead({ "conn-dev:dark.yaml": doc("new") }, { dataId: "dark.yaml", fromCall: 4, throwOnRead: true });

    const result = await executeApplyPlan(plan, runDeps, { verifyDelaysMs: [0, 0] });
    if (!result.ok || "dryRun" in result) throw new Error("expected execution to succeed");
    await settle();

    expect(calls.length).toBe(0);
  });

  it("dry-run 一条都不记：还没写就不存在「本程序写的那一版」", async () => {
    const calls = captureRevisions();
    const plan = applyPlan([{ ref: ref("dry.yaml"), sourceValue: documentValue("new"), targetValue: absentValue() }]);
    const result = await executeApplyPlan(plan, deps({ "conn-dev:dry.yaml": doc("new") }), { dryRun: true });

    expect(result.ok).toBe(true);
    await settle();
    expect(calls.length).toBe(0);
  });

  it("本机历史写不进去时执行照常成功：记不上是日志问题，不是写入失败", async () => {
    const calls = captureRevisions({ reject: true });
    const plan = applyPlan([{ ref: ref("boom.yaml"), sourceValue: documentValue("new"), targetValue: absentValue() }]);
    const result = await executeApplyPlan(plan, deps({ "conn-dev:boom.yaml": doc("new") }), { verifyDelaysMs: [0, 0] });

    expect(result.ok).toBe(true);
    await settle();
    expect(calls.length).toBe(1);
  });
});

/**
 * 轮98：半截写入后的第二条出口。
 *
 * 现场是用户手上最难受的那一刻——10 项写到第 4 项被权限打回，前 3 项已经落在生产上。
 * 他想留着那 3 项、把 5–10 也写完，可重试进来先撞新鲜度判据：前 3 项的目标现值当然
 * 和「写入前」不等 ⇒ 整份计划被判过期 ⇒ 连没写过的 6 项一起堵死。
 * 根因不是判据太严，是它把「已经干完的活」当成了「现场被人改了」。这里按 prd 的
 * A2/A3/A4/A5 逐条钉住，每条都用「发起过几次写入」这类硬证据说话。
 */
describe("目标已经是这一版的项不重复写入（轮98）", () => {
  /** 从 recordOperation 的调用里取那份记录输入。 */
  function recorded(runDeps: ReturnType<typeof deps>) {
    const calls = runDeps.recordOperation.mock.calls;
    const call = calls[calls.length - 1];
    if (!call) throw new Error("没有落操作历史，先确认这条路径该不该记");
    return call[0];
  }

  const locationOf = (dataId: string, key = "__document") => ({
    namespace: "public",
    group: "DEFAULT_GROUP",
    dataId,
    key,
  });

  const labelOf = (dataId: string) => `public/DEFAULT_GROUP/${dataId}`;

  it("已达成的项不写入、不建写前快照、不进落笔清单，结果如实报出来", async () => {
    const plan = applyPlan([
      { ref: ref("a.yaml"), sourceValue: documentValue("a2"), targetValue: documentValue("a1") },
      { ref: ref("b.yaml"), sourceValue: documentValue("b2"), targetValue: documentValue("b1") },
    ]);
    // a 的目标现值已经等于要写的那一版（上一轮半截执行里写成的样子）
    const runDeps = deps({
      "conn-dev:a.yaml": doc("a2"),
      "conn-prod:a.yaml": doc("a2"),
      "conn-dev:b.yaml": doc("b2"),
      "conn-prod:b.yaml": doc("b1"),
    });

    const result = await executeApplyPlan(plan, runDeps, { verifyDelaysMs: [0] });

    expect(result).toMatchObject({
      ok: true,
      taskId: "task-apply-1",
      alreadyApplied: [labelOf("a.yaml")],
      verification: expect.objectContaining({ total: 1, confirmedCount: 1 }),
    });
    expect(runDeps.publishConfig.mock.calls.map((call: unknown[]) => call[2])).toEqual(["b.yaml"]);
    // 备份只含真正要落笔的那一条：已达成的项这一轮一个字节没动，没什么可备份的
    const [configs] = runDeps.createBackupSnapshot.mock.calls[0] as unknown as [Array<{ dataId: string }>];
    expect(configs.map((config) => config.dataId)).toEqual(["b.yaml"]);
    // 落笔清单是回退/晋级的唯一依据，混进 a 就等于承诺回退一个本轮没碰过的配置
    expect(recorded(runDeps).appliedLocations).toEqual([locationOf("b.yaml")]);
  });

  it("删除类同样判达成：目标已经不存在就不再发起删除", async () => {
    const plan = applyPlan([
      { ref: ref("removed.yaml"), sourceValue: absentValue(), targetValue: documentValue("old removed") },
      { ref: ref("b.yaml"), sourceValue: documentValue("b2"), targetValue: documentValue("b1") },
    ]);
    const runDeps = deps({
      "conn-dev:removed.yaml": null,
      "conn-prod:removed.yaml": null,
      "conn-dev:b.yaml": doc("b2"),
      "conn-prod:b.yaml": doc("b1"),
    });

    const result = await executeApplyPlan(plan, runDeps, { verifyDelaysMs: [0] });

    expect(result).toMatchObject({ ok: true, alreadyApplied: [labelOf("removed.yaml")] });
    expect(runDeps.deleteConfig).not.toHaveBeenCalled();
    expect(runDeps.publishConfig.mock.calls.map((call: unknown[]) => call[2])).toEqual(["b.yaml"]);
  });

  it("dry-run 也按同一口径报数：已达成的项不进计划写入数", async () => {
    const plan = applyPlan([
      { ref: ref("a.yaml"), sourceValue: documentValue("a2"), targetValue: documentValue("a1") },
      { ref: ref("b.yaml"), sourceValue: documentValue("b2"), targetValue: documentValue("b1") },
    ]);
    const runDeps = deps({
      "conn-dev:a.yaml": doc("a2"),
      "conn-prod:a.yaml": doc("a2"),
      "conn-dev:b.yaml": doc("b2"),
      "conn-prod:b.yaml": doc("b1"),
    });

    const result = await executeApplyPlan(plan, runDeps, { dryRun: true });

    // 第 4 步报 2 项、第 5 步只写 1 项，用户会以为少写了一项出了 bug
    expect(result).toEqual({
      ok: true,
      dryRun: true,
      taskId: "task-apply-1",
      plannedWrites: 1,
      alreadyApplied: [labelOf("a.yaml")],
    });
  });

  it("source 侧变了照样拦：目标恰好等于要写的那版也不能豁免", async () => {
    const plan = applyPlan([{ ref: ref("a.yaml"), sourceValue: documentValue("a2"), targetValue: documentValue("a1") }]);
    const runDeps = deps({
      // 源在计划生成后被改成 a3，而目标已经是要写的 a2 —— 这份计划不再代表用户勾的那件事
      "conn-dev:a.yaml": doc("a3"),
      "conn-prod:a.yaml": doc("a2"),
    });

    const result = await executeApplyPlan(plan, runDeps);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected stale rejection");
    expect(result.error).toContain(labelOf("a.yaml"));
    expect(runDeps.publishConfig).not.toHaveBeenCalled();
    expect(runDeps.createBackupSnapshot).not.toHaveBeenCalled();
  });

  it("目标变成第三个值是真过期，不能当成已达成放过去", async () => {
    const plan = applyPlan([{ ref: ref("a.yaml"), sourceValue: documentValue("a2"), targetValue: documentValue("a1") }]);
    const runDeps = deps({
      "conn-dev:a.yaml": doc("a2"),
      "conn-prod:a.yaml": doc("a9"),
    });

    const result = await executeApplyPlan(plan, runDeps);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected stale rejection");
    expect(result.error).toContain(labelOf("a.yaml"));
    expect(runDeps.publishConfig).not.toHaveBeenCalled();
  });

  it("过期清单里只列真冲突的项，已达成的不许混进来吓人", async () => {
    const plan = applyPlan([
      { ref: ref("a.yaml"), sourceValue: documentValue("a2"), targetValue: documentValue("a1") },
      { ref: ref("b.yaml"), sourceValue: documentValue("b2"), targetValue: documentValue("b1") },
    ]);
    const runDeps = deps({
      "conn-dev:a.yaml": doc("a2"),
      "conn-prod:a.yaml": doc("a2"), // 已达成
      "conn-dev:b.yaml": doc("b2"),
      "conn-prod:b.yaml": doc("b9"), // 真冲突
    });

    const result = await executeApplyPlan(plan, runDeps);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected stale rejection");
    expect(result.error).toContain(labelOf("b.yaml"));
    expect(result.error, "把已达成报成过期，用户下一步该做的事就被说反了").not.toContain(labelOf("a.yaml"));
  });

  it("半截失败后摘掉失败项重试：已写成的被跳过，剩下的照常写完", async () => {
    const plan = applyPlan([
      { ref: ref("a.yaml"), sourceValue: documentValue("a2"), targetValue: documentValue("a1") },
      { ref: ref("b.yaml"), sourceValue: documentValue("b2"), targetValue: documentValue("b1") },
      { ref: ref("c.yaml"), sourceValue: documentValue("c2"), targetValue: documentValue("c1") },
    ]);
    const documents: Record<string, ConfigDocument | null> = {
      "conn-dev:a.yaml": doc("a2"),
      "conn-prod:a.yaml": doc("a1"),
      "conn-dev:b.yaml": doc("b2"),
      "conn-prod:b.yaml": doc("b1"),
      "conn-dev:c.yaml": doc("c2"),
      "conn-prod:c.yaml": doc("c1"),
    };
    const base = deps(documents);
    const runDeps = {
      ...base,
      publishConfig: vi.fn(async (conn: Connection, _ns: string, dataId: string, _g: string, content: string, configType: string) => {
        if (dataId === "b.yaml") throw new Error("403 Forbidden: accessKeyId can't be null");
        applyDocWrite(documents, conn.id, dataId, content, configType);
      }),
    };

    const first = await executeApplyPlan(plan, runDeps, { verifyDelaysMs: [0] });
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error("expected partial write");
    expect(first.progress).toMatchObject({ completedWrites: 1, totalWrites: 3, failedIndex: 2, failedItemId: plan.items[1].id });

    const writesAfterFirst = runDeps.publishConfig.mock.calls.length;
    const second = await executeApplyPlan(plan, runDeps, {
      verifyDelaysMs: [0],
      selectedItemIds: [plan.items[0].id, plan.items[2].id],
    });

    expect(second).toMatchObject({
      ok: true,
      taskId: "task-apply-1",
      historyId: "history-1",
      alreadyApplied: [labelOf("a.yaml")],
      verification: expect.objectContaining({ total: 1, confirmedCount: 1 }),
    });
    // 重试这一次只发起 c 一条：a 被判已达成跳过，b 已被摘掉
    const retryWrites = runDeps.publishConfig.mock.calls.slice(writesAfterFirst).map((call: unknown[]) => call[2]);
    expect(retryWrites).toEqual(["c.yaml"]);
    expect(documents["conn-prod:a.yaml"]?.content).toBe("a2");
    expect(documents["conn-prod:c.yaml"]?.content).toBe("c2");
    // 第二次的落笔清单只有 c：a 这一轮没动，回退范围里不能出现它
    expect(recorded(runDeps).appliedLocations).toEqual([locationOf("c.yaml")]);
    // 界面横幅那个「已应用 N 项」的数就取这份回读结论的 total：两者必须由同一个数组攒出来，
    // 否则跳过出口之后，第 5 步的横幅与操作历史的记录会各报各的数（轮98）。
    // 收窄到「真写过」那一条返回：dry-run 与全部已达成都没有回读结论，也就没有可对齐的落笔数
    if (!("verification" in second) || !second.verification) throw new Error("跳过重试这一轮没有回读结论");
    expect(second.verification.total, "回读结论的条数与落笔清单不同源").toBe(recorded(runDeps).appliedLocations?.length);
    // 已达成的 a 不进第二次的备份
    const lastBackup = runDeps.createBackupSnapshot.mock.calls[
      runDeps.createBackupSnapshot.mock.calls.length - 1
    ][0] as Array<{ dataId: string }>;
    expect(lastBackup.map((config) => config.dataId)).toEqual(["c.yaml"]);
  });

  it("勾选项全部已达成：不写、不备份、不记历史，也不报成执行完成", async () => {
    const plan = applyPlan([
      { ref: ref("a.yaml"), sourceValue: documentValue("a2"), targetValue: documentValue("a1") },
      { ref: ref("c.yaml"), sourceValue: documentValue("c2"), targetValue: documentValue("c1") },
    ]);
    const runDeps = deps({
      "conn-dev:a.yaml": doc("a2"),
      "conn-prod:a.yaml": doc("a2"),
      "conn-dev:c.yaml": doc("c2"),
      "conn-prod:c.yaml": doc("c2"),
    });

    const result = await executeApplyPlan(plan, runDeps);

    expect(result).toEqual({
      ok: true,
      alreadyAppliedOnly: true,
      taskId: "task-apply-1",
      alreadyApplied: [labelOf("a.yaml"), labelOf("c.yaml")],
    });
    // 用 not.toHaveProperty 而不是 result.historyId：这一支返回的是 alreadyAppliedOnly 变体，
    // 收窄到「普通成功」才能读 historyId，而这里要的恰恰是「没写 ⇒ 没有记录、没有回读结论」。
    expect(result, "没写任何东西却留下一条历史记录").not.toHaveProperty("historyId");
    expect(result).not.toHaveProperty("verification");
    expect(runDeps.publishConfig).not.toHaveBeenCalled();
    expect(runDeps.createBackupSnapshot).not.toHaveBeenCalled();
    expect(runDeps.recordOperation).not.toHaveBeenCalled();
    expect(runDeps.taskManager.completeTask).toHaveBeenCalledWith("task-apply-1", true);
  });

  it("老计划没有 failedItemId 时行为不变：进度里不带这个字段就不算异常", async () => {
    const plan = applyPlan([{ ref: ref("a.yaml"), sourceValue: documentValue("a2"), targetValue: documentValue("a1") }]);
    const runDeps = deps({ "conn-dev:a.yaml": doc("a2"), "conn-prod:a.yaml": doc("a1") });

    const result = await executeApplyPlan(plan, runDeps, { verifyDelaysMs: [0] });

    expect(result).toMatchObject({ ok: true });
    expect((result as { alreadyApplied?: string[] }).alreadyApplied, "没有已达成项时不该冒出空数组之外的东西").toBeUndefined();
  });
});
describe("显式环境角色与写入确认策略（r114）", () => {
  const plainEndpoint = endpoint(); // label "Staging / public"，名称无任何保护标记

  it("显式生产：名称无标记也判受保护", () => {
    const conn: Connection = {
      ...baseConnection,
      id: "conn-hz",
      name: "hz-core-01",
      environmentName: "core",
      sourceName: "intranet",
      envRole: "production",
    };
    expect(isProtectedApplyTarget(conn, plainEndpoint)).toBe(true);
  });

  it.each(["development", "testing", "staging"] as const)("显式%：名称带生产标记也判不受保护", (role) => {
    const conn: Connection = {
      ...baseConnection,
      name: "prod-mirror",
      environmentName: "生产",
      sourceName: "真实环境",
      envRole: role,
    };
    expect(isProtectedApplyTarget(conn, plainEndpoint)).toBe(false);
  });

  it("未声明：原样走名称推断，判据与今天一致", () => {
    expect(isProtectedApplyTarget({ ...baseConnection, name: "prod-vpc" }, plainEndpoint)).toBe(true);
    expect(isProtectedApplyTarget({ ...baseConnection, name: "线上公网" }, plainEndpoint)).toBe(true);
    expect(isProtectedApplyTarget(baseConnection, plainEndpoint)).toBe(false);
  });

  it("写入确认策略：always 一律手敲、never 一律不手敲、protected-only 与未声明落到受保护判定", () => {
    const safe: Connection = { ...baseConnection }; // staging，无标记
    const prod: Connection = { ...baseConnection, name: "Prod", environmentName: "Production" };

    expect(requiresManualApplyConfirm({ ...safe, writeConfirmPolicy: "always" }, plainEndpoint)).toBe(true);
    expect(requiresManualApplyConfirm({ ...prod, writeConfirmPolicy: "never" }, plainEndpoint)).toBe(false);
    expect(requiresManualApplyConfirm({ ...safe, writeConfirmPolicy: "protected-only" }, plainEndpoint)).toBe(false);
    expect(requiresManualApplyConfirm({ ...prod, writeConfirmPolicy: "protected-only" }, plainEndpoint)).toBe(true);
    expect(requiresManualApplyConfirm(safe, plainEndpoint)).toBe(false);
    expect(requiresManualApplyConfirm(prod, plainEndpoint)).toBe(true);
  });
});
