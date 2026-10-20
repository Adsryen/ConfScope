/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor, within } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import type { Connection } from "../store/connections";
import type { ApplyEntryPayload } from "../lib/applyEntry";
import type { Task } from "../lib/taskmanager";
import { buildApplyPlan, type ApplyPlan, type BuildApplyPlanInput } from "../lib/applyPlan";
import { applyConfirmationText } from "../lib/applyPlanExecution";
import ApplyPlanView from "./ApplyPlanView";

const draftMocks = vi.hoisted(() => ({
  buildApplyPlanFromEntry: vi.fn(),
}));

const storeMocks = vi.hoisted(() => ({
  saveApplyPlan: vi.fn((plan: ApplyPlan) => plan),
}));

const executionMocks = vi.hoisted(() => ({
  executeApplyPlan: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  getConfigDocument: vi.fn(),
  publishConfigFromApplyPlan: vi.fn(),
  deleteConfigFromApplyPlan: vi.fn(),
  publishConfigRefFromApplyPlan: vi.fn(),
  deleteConfigRefFromApplyPlan: vi.fn(),
}));

const snapshotMocks = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  createSnapshot: vi.fn(),
}));

const historyMocks = vi.hoisted(() => ({
  recordOperation: vi.fn(),
}));

const taskManagerMocks = vi.hoisted(() => ({
  manager: {
    createTask: vi.fn(),
    getTask: vi.fn(),
    listTasks: vi.fn(),
    startTask: vi.fn(),
    updateProgress: vi.fn(),
    completeTask: vi.fn(),
    cancelTask: vi.fn(),
    deleteTask: vi.fn(),
    clearCompleted: vi.fn(),
    onTaskUpdate: vi.fn(),
  },
  getTaskManager: vi.fn(),
}));

vi.mock("../lib/applyPlanDraft", () => ({
  buildApplyPlanFromEntry: draftMocks.buildApplyPlanFromEntry,
}));

vi.mock("../store/applyPlans", () => ({
  saveApplyPlan: storeMocks.saveApplyPlan,
}));

vi.mock("../lib/applyPlanExecution", async () => {
  const actual = await vi.importActual<typeof import("../lib/applyPlanExecution")>("../lib/applyPlanExecution");
  return {
    ...actual,
    executeApplyPlan: executionMocks.executeApplyPlan,
  };
});

vi.mock("../api/nacos", () => ({
  getConfigDocument: apiMocks.getConfigDocument,
  publishConfigFromApplyPlan: apiMocks.publishConfigFromApplyPlan,
  deleteConfigFromApplyPlan: apiMocks.deleteConfigFromApplyPlan,
  publishConfigRefFromApplyPlan: apiMocks.publishConfigRefFromApplyPlan,
  deleteConfigRefFromApplyPlan: apiMocks.deleteConfigRefFromApplyPlan,
}));

vi.mock("../api/snapshot", () => ({
  getSnapshot: snapshotMocks.getSnapshot,
  createSnapshot: snapshotMocks.createSnapshot,
}));

vi.mock("../store/operationHistory", () => ({
  recordOperation: historyMocks.recordOperation,
}));

vi.mock("../lib/taskmanager", () => ({
  getTaskManager: taskManagerMocks.getTaskManager,
}));

const sourceConn: Connection = {
  id: "conn-dev",
  name: "Dev",
  projectName: "Order",
  environmentName: "Development",
  sourceName: "LAN",
  sourceType: "nacos",
  provider: "nacos",
  distribution: "opensource",
  authType: "none",
  baseUrl: "http://dev.example.com/nacos",
  username: "",
  password: "",
  defaultNamespace: "public",
};

const targetConn: Connection = {
  ...sourceConn,
  id: "conn-prod",
  name: "Prod",
  environmentName: "Production",
  sourceName: "Cloud",
  baseUrl: "http://prod.example.com/nacos",
};

const safeTargetConn: Connection = {
  ...sourceConn,
  id: "conn-stage",
  name: "Staging",
  environmentName: "Staging",
  sourceName: "Cloud",
  baseUrl: "http://stage.example.com/nacos",
};

const snapshotSourceConn: Connection = {
  ...sourceConn,
  id: "snapshot:snap-before-1",
  name: "before apply",
  sourceName: "before apply",
  sourceType: "local-snapshot",
  provider: "local",
  authType: "none",
  baseUrl: "C:\\snapshots\\snap-before-1",
  localPath: "C:\\snapshots\\snap-before-1",
  readonly: true,
};

const entryPayload: ApplyEntryPayload = {
  sourceType: "diff",
  scope: "config",
  source: {
    provider: "nacos",
    connectionId: "conn-dev",
    connectionName: "Dev",
    namespace: "public",
    label: "Dev / public",
  },
  target: {
    provider: "nacos",
    connectionId: "conn-prod",
    connectionName: "Prod",
    namespace: "public",
    label: "Prod / public",
  },
  items: [
    {
      provider: "nacos",
      connectionId: "conn-prod",
      namespace: "public",
      group: "DEFAULT_GROUP",
      dataId: "app.properties",
      key: "__document",
      sourceRef: {
        provider: "nacos",
        connectionId: "conn-dev",
        namespace: "public",
        group: "DEFAULT_GROUP",
        dataId: "app.properties",
        key: "__document",
      },
      targetRef: {
        provider: "nacos",
        connectionId: "conn-prod",
        namespace: "public",
        group: "DEFAULT_GROUP",
        dataId: "app.properties",
        key: "__document",
      },
    },
  ],
  rangeSummary: {
    count: 1,
    skippedCount: 0,
    riskLevel: "low",
    riskReasons: [],
  },
  origin: { mode: "diff", returnMode: "diff" },
};

function endpoint(connectionId: string, label: string, provider: Connection["provider"] = "nacos"): BuildApplyPlanInput["source"] {
  return {
    envId: connectionId,
    label,
    provider,
    connectionId,
    connectionName: label,
    namespace: "public",
  };
}

function value(valueText: string, exists = true): BuildApplyPlanInput["items"][number]["sourceValue"] {
  return {
    exists,
    value: exists ? valueText : undefined,
    valueType: exists ? "string" : undefined,
    format: "Properties",
    parseStatus: "ok",
  };
}

function makePlan(
  items: BuildApplyPlanInput["items"],
  options: { targetId?: string; targetLabel?: string; targetProvider?: Connection["provider"] } = {}
): ApplyPlan {
  return buildApplyPlan({
    id: "plan-preview-1",
    createdAt: "2026-07-06T00:00:00.000Z",
    scope: "batch",
    source: endpoint("conn-dev", "Dev / public"),
    target: endpoint(options.targetId ?? "conn-prod", options.targetLabel ?? "Prod / public", options.targetProvider ?? "nacos"),
    inputSummary: {
      sourceType: "diff",
      scope: "batch",
      sourceLabel: "Dev / public",
      targetLabel: options.targetLabel ?? "Prod / public",
      selectedCount: items.length,
    },
    items,
  });
}

function item(
  key: string,
  sourceValue: BuildApplyPlanInput["items"][number]["sourceValue"],
  targetValue: BuildApplyPlanInput["items"][number]["targetValue"]
): BuildApplyPlanInput["items"][number] {
  return {
    ref: {
      provider: "nacos",
      connectionId: "conn-prod",
      namespace: "public",
      group: "DEFAULT_GROUP",
      dataId: "app.properties",
      key,
    },
    sourceValue,
    targetValue,
  };
}

function renderView(entry: ApplyEntryPayload | null = entryPayload, connections: Connection[] = [sourceConn, targetConn]) {
  const onBack = vi.fn();
  render(
    <I18nProvider>
      <ApplyPlanView entry={entry} connections={connections} onBack={onBack} />
    </I18nProvider>
  );
  return { onBack };
}

describe("ApplyPlanView", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("locale", "en-US");
    draftMocks.buildApplyPlanFromEntry.mockReset();
    storeMocks.saveApplyPlan.mockClear();
    executionMocks.executeApplyPlan.mockReset();
    executionMocks.executeApplyPlan.mockResolvedValue({ ok: true, taskId: "task-1", historyId: "history-1" });
    apiMocks.getConfigDocument.mockReset();
    apiMocks.publishConfigFromApplyPlan.mockReset();
    apiMocks.deleteConfigFromApplyPlan.mockReset();
    apiMocks.publishConfigRefFromApplyPlan.mockReset();
    apiMocks.deleteConfigRefFromApplyPlan.mockReset();
    snapshotMocks.getSnapshot.mockReset();
    snapshotMocks.createSnapshot.mockReset();
    snapshotMocks.createSnapshot.mockResolvedValue({ id: "snap-before-1", name: "before_apply" });
    historyMocks.recordOperation.mockReset();
    taskManagerMocks.manager.getTask.mockReset();
    taskManagerMocks.manager.onTaskUpdate.mockReset();
    taskManagerMocks.getTaskManager.mockReset();
    taskManagerMocks.getTaskManager.mockReturnValue(taskManagerMocks.manager);
  });

  it("uses configuration change plan wording for primary actions", async () => {
    const plan = makePlan([item("__document", value("server.port=8080"), value("server.port=9090"))], {
      targetId: "conn-stage",
      targetLabel: "Staging / public",
    });
    draftMocks.buildApplyPlanFromEntry.mockResolvedValue({
      ok: true,
      plan,
      sourceConnection: sourceConn,
      targetConnection: safeTargetConn,
    });

    renderView(entryPayload, [sourceConn, safeTargetConn]);

    expect(await screen.findByRole("heading", { name: "Configuration change plan" })).toBeInTheDocument();
    const planStepLabel = await screen.findByText("Generate & review plan (dry-run, no writes)");
    expect(planStepLabel.closest("li")).toHaveAttribute("aria-current", "step");
    expect(screen.getByText("Execute, verify, and promote")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Execute change" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Execute apply" })).not.toBeInTheDocument();
  });

  it("generates and saves a dry-run plan, then displays plan summary counts", async () => {
    const plan = makePlan([item("__document", value("server.port=8080"), value("server.port=9090"))]);
    draftMocks.buildApplyPlanFromEntry.mockResolvedValue({
      ok: true,
      plan,
      sourceConnection: sourceConn,
      targetConnection: targetConn,
    });

    renderView();

    expect(await screen.findAllByText("plan-preview-1")).toHaveLength(2);
    expect(draftMocks.buildApplyPlanFromEntry).toHaveBeenCalledWith(
      entryPayload,
      expect.objectContaining({ connections: [sourceConn, targetConn] })
    );
    expect(storeMocks.saveApplyPlan).toHaveBeenCalledWith(plan);
    expect(screen.getByText("Total 1")).toBeInTheDocument();
    expect(screen.getByText("Overwrite 1")).toBeInTheDocument();
    expect(screen.getByText("Blocked 0")).toBeInTheDocument();
  });

  it("shows item actions and target-to-after diff without duplicate value blocks", async () => {
    const plan = makePlan([
      item("new.key", value("from-source"), value("", false)),
      item("changed.key", value("from-source"), value("from-target")),
      item("removed.key", value("", false), value("old")),
      item("same.key", value("same"), value("same")),
      item("broken.key", { ...value("{"), parseStatus: "error", parseError: "bad properties" }, value("old")),
    ]);
    draftMocks.buildApplyPlanFromEntry.mockResolvedValue({
      ok: true,
      plan,
      sourceConnection: sourceConn,
      targetConnection: targetConn,
    });

    renderView();

    expect(await screen.findByText("Create 1")).toBeInTheDocument();
    expect(screen.getByText("Overwrite 1")).toBeInTheDocument();
    expect(screen.getByText("Delete 1")).toBeInTheDocument();
    expect(screen.getByText("Skip 1")).toBeInTheDocument();
    expect(screen.getByText("Parse error 1")).toBeInTheDocument();
    expect(screen.getByText("Blocked 1")).toBeInTheDocument();

    fireEvent.click(screen.getByText("changed.key"));
    expect(screen.getByText("Action: overwrite")).toBeInTheDocument();
    expect(screen.getAllByText("from-source")).toHaveLength(1);
    expect(screen.getAllByText("from-target")).toHaveLength(1);
    expect(screen.queryByText("Source value")).not.toBeInTheDocument();
    expect(screen.getByText("Target value")).toBeInTheDocument();
    expect(screen.getByText("After value")).toBeInTheDocument();

    fireEvent.click(screen.getByText("broken.key"));
    expect(screen.getByText("Block reason: source_parse_error")).toBeInTheDocument();
    expect(screen.getByText("bad properties")).toBeInTheDocument();
  });

  // 轮26 F-5：引擎原文是数据（要随快照持久化、要能被内容搜索命中），
  // 但红字块是给人看的——必须显示本地化框架 + 行列，而不是 `Expected ... in JSON at position 5`。
  it("renders parse errors and parse warnings as localized copy, not the raw engine sentence", async () => {
    const plan = makePlan([
      item(
        "broken.json",
        { ...value('{\"a\" 1}'), parseStatus: "error", parseError: "JSON:Expected ':' after property name in JSON at position 5 (line 1 column 6)" },
        value("old")
      ),
      item(
        "dup.yaml",
        {
          ...value("a: 1\na: 2\n"),
          parseError: "YAML:Map keys must be unique at line 2, column 1:（duplicate key 已按后值覆盖处理，不阻塞同步）",
        },
        value("old")
      ),
    ]);
    draftMocks.buildApplyPlanFromEntry.mockResolvedValue({
      ok: true,
      plan,
      sourceConnection: sourceConn,
      targetConnection: targetConn,
    });

    renderView();
    expect(await screen.findByText("Parse error 1")).toBeInTheDocument();

    fireEvent.click(screen.getByText("broken.json"));
    expect(screen.getByText("JSON parse failed:expected ':' after property name (line 1, column 6)")).toBeInTheDocument();
    expect(screen.queryByText(/in JSON at position/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("dup.yaml"));
    // afterValue 与 sourceValue 同源，同一条提示只许显示一遍
    expect(screen.queryAllByText((_, element) => Boolean(element?.classList?.contains("apply-parse-warning")))).toHaveLength(1);
    const warning = screen.getByText((_, element) => Boolean(element?.classList?.contains("apply-parse-warning")));
    // 句尾那段中文说明是产出侧的数据（normalize.ts 拼上去的），翻不了但不能被吞
    expect(warning.textContent).toBe(
      "\u26A0 YAML parse failed:map keys must be unique（duplicate key 已按后值覆盖处理，不阻塞同步） (line 2, column 1)"
    );
    expect(screen.queryByText(/at line 2, column 1:/)).not.toBeInTheDocument();
  });

  it("shows a copyable generation error and does not expose execution controls", async () => {
    draftMocks.buildApplyPlanFromEntry.mockResolvedValue({
      ok: false,
      error: "apply_plan_draft_failed",
      detail: "network EOF\napp.properties",
    });

    renderView();

    expect(await screen.findByRole("alert")).toHaveTextContent("network EOF");
    expect(screen.getByRole("button", { name: "Copy error" })).toBeInTheDocument();
    expect(storeMocks.saveApplyPlan).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Execute change" })).not.toBeInTheDocument();
  });

  it("requires checkbox confirmation before executing a normal target", async () => {
    const plan = makePlan([item("__document", value("server.port=8080"), value("server.port=9090"))], {
      targetId: "conn-stage",
      targetLabel: "Staging / public",
    });
    draftMocks.buildApplyPlanFromEntry.mockResolvedValue({
      ok: true,
      plan,
      sourceConnection: sourceConn,
      targetConnection: safeTargetConn,
    });

    renderView(entryPayload, [sourceConn, safeTargetConn]);

    const executeButton = await screen.findByRole("button", { name: "Execute change" });
    expect(executeButton).toBeDisabled();

    fireEvent.click(screen.getByLabelText("I reviewed this dry-run plan and understand it will write to the target."));

    expect(executeButton).toBeEnabled();
  });

  it("requires exact confirmation text for protected targets", async () => {
    const plan = makePlan([item("__document", value("server.port=8080"), value("server.port=9090"))], {
      targetId: "conn-prod",
      targetLabel: "Production / public",
    });
    draftMocks.buildApplyPlanFromEntry.mockResolvedValue({
      ok: true,
      plan,
      sourceConnection: sourceConn,
      targetConnection: targetConn,
    });

    renderView();

    const executeButton = await screen.findByRole("button", { name: "Execute change" });
    expect(screen.getByText(applyConfirmationText(plan))).toBeInTheDocument();
    expect(executeButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Confirmation text"), { target: { value: "APPLY something else" } });
    expect(executeButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Confirmation text"), { target: { value: applyConfirmationText(plan) } });
    expect(executeButton).toBeEnabled();
  });

  it("executes the saved plan snapshot instead of recalculating from entry", async () => {
    const plan = makePlan([item("__document", value("server.port=8080"), value("server.port=9090"))], {
      targetId: "conn-stage",
      targetLabel: "Staging / public",
    });
    const savedPlan = { ...plan, id: "plan-saved-1" };
    storeMocks.saveApplyPlan.mockReturnValueOnce(savedPlan);
    draftMocks.buildApplyPlanFromEntry.mockResolvedValue({
      ok: true,
      plan,
      sourceConnection: sourceConn,
      targetConnection: safeTargetConn,
    });

    renderView(entryPayload, [sourceConn, safeTargetConn]);

    const executeButton = await screen.findByRole("button", { name: "Execute change" });
    fireEvent.click(screen.getByLabelText("I reviewed this dry-run plan and understand it will write to the target."));
    await waitFor(() => expect(executeButton).toBeEnabled());
    fireEvent.click(executeButton);

    expect(await screen.findAllByText("plan-saved-1")).toHaveLength(2);
    // 计划完成后五步全部标记 completed，且不再有当前高亮
    expect(document.querySelectorAll(".diff-workflow-step.completed")).toHaveLength(5);
    expect(document.querySelectorAll(".diff-workflow-step-mark")).toHaveLength(5);
    expect(document.querySelector(".diff-workflow-step.current")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(executionMocks.executeApplyPlan).toHaveBeenCalledWith(
        savedPlan,
        expect.any(Object),
        expect.objectContaining({ selectedItemIds: savedPlan.items.map((item) => item.id) })
      )
    );
    expect(draftMocks.buildApplyPlanFromEntry).toHaveBeenCalledTimes(1);
  });

  it("passes write, backup, history and task dependencies to execution", async () => {
    const plan = makePlan([item("__document", value("server.port=8080"), value("server.port=9090"))], {
      targetId: "conn-stage",
      targetLabel: "Staging / public",
    });
    draftMocks.buildApplyPlanFromEntry.mockResolvedValue({
      ok: true,
      plan,
      sourceConnection: sourceConn,
      targetConnection: safeTargetConn,
    });

    renderView(entryPayload, [sourceConn, safeTargetConn]);

    const executeButton = await screen.findByRole("button", { name: "Execute change" });
    fireEvent.click(screen.getByLabelText("I reviewed this dry-run plan and understand it will write to the target."));
    await waitFor(() => expect(executeButton).toBeEnabled());
    fireEvent.click(executeButton);

    await waitFor(() => expect(executionMocks.executeApplyPlan).toHaveBeenCalledTimes(1));
    const executionDeps = executionMocks.executeApplyPlan.mock.calls[0][1];
    expect(executionDeps).toMatchObject({
      connections: [sourceConn, safeTargetConn],
      getConfigDocument: apiMocks.getConfigDocument,
      publishConfig: apiMocks.publishConfigFromApplyPlan,
      deleteConfig: apiMocks.deleteConfigFromApplyPlan,
      publishConfigRef: apiMocks.publishConfigRefFromApplyPlan,
      deleteConfigRef: apiMocks.deleteConfigRefFromApplyPlan,
      recordOperation: historyMocks.recordOperation,
      taskManager: taskManagerMocks.manager,
    });

    const backupConfigs = [
      {
        namespace: "public",
        group: "DEFAULT_GROUP",
        dataId: "app.properties",
        content: "old",
        configType: "properties",
        updateTime: "2026-07-06T00:00:00.000Z",
      },
    ];
    await expect(executionDeps.createBackupSnapshot(backupConfigs)).resolves.toEqual({ id: "snap-before-1", name: "before_apply" });
    expect(snapshotMocks.createSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "nacos",
        connectionId: "conn-stage",
        connectionName: "Staging",
        namespace: "public",
        namespaceId: "public",
      }),
      backupConfigs
    );
  });

  // R55-D2：以前这里无条件写死 nacos，Apollo/Consul 计划的备份元数据全被标错，
  // 快照列表与恢复入口都认不出它到底是哪个中心的现场。
  it("backs up under the plan target provider instead of a hardcoded nacos", async () => {
    const plan = makePlan([item("__document", value("server.port=8080"), value("server.port=9090"))], {
      targetId: "conn-apollo",
      targetLabel: "Apollo / default",
      targetProvider: "apollo",
    });
    draftMocks.buildApplyPlanFromEntry.mockResolvedValue({
      ok: true,
      plan,
      sourceConnection: sourceConn,
      targetConnection: safeTargetConn,
    });

    renderView(entryPayload, [sourceConn, safeTargetConn]);
    const executeButton = await screen.findByRole("button", { name: "Execute change" });
    fireEvent.click(screen.getByLabelText("I reviewed this dry-run plan and understand it will write to the target."));
    await waitFor(() => expect(executeButton).toBeEnabled());
    fireEvent.click(executeButton);

    await waitFor(() => expect(executionMocks.executeApplyPlan).toHaveBeenCalledTimes(1));
    const executionDeps = executionMocks.executeApplyPlan.mock.calls[0][1];
    const backupConfigs = [
      {
        namespace: "default",
        group: "DEFAULT_GROUP",
        dataId: "application",
        content: "server.port=9090",
        configType: "properties",
        updateTime: "2026-07-06T00:00:00.000Z",
      },
    ];
    await executionDeps.createBackupSnapshot(backupConfigs);

    expect(snapshotMocks.createSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "apollo", connectionId: "conn-apollo" }),
      backupConfigs
    );
  });

  it("passes the selected item subset and dry-run flag to execution", async () => {
    const plan = makePlan(
      [item("first.key", value("first-source"), value("first-target")), item("second.key", value("second-source"), value("second-target"))],
      {
        targetId: "conn-stage",
        targetLabel: "Staging / public",
      }
    );
    draftMocks.buildApplyPlanFromEntry.mockResolvedValue({
      ok: true,
      plan,
      sourceConnection: sourceConn,
      targetConnection: safeTargetConn,
    });
    executionMocks.executeApplyPlan.mockResolvedValueOnce({ ok: true, dryRun: true, taskId: "task-2", plannedWrites: 1 });

    renderView(entryPayload, [sourceConn, safeTargetConn]);

    expect(await screen.findByText("first.key")).toBeInTheDocument();
    const itemChecks = document.querySelectorAll(".apply-item-check");
    fireEvent.click(itemChecks[0]);

    const dryRunButton = screen.getByRole("button", { name: "Dry-run selected (1)" });
    fireEvent.click(screen.getByLabelText("I reviewed this dry-run plan and understand it will write to the target."));
    fireEvent.click(dryRunButton);

    await waitFor(() => expect(executionMocks.executeApplyPlan).toHaveBeenCalledTimes(1));
    expect(executionMocks.executeApplyPlan).toHaveBeenCalledWith(
      plan,
      expect.any(Object),
      expect.objectContaining({ selectedItemIds: [plan.items[1].id], dryRun: true })
    );
    expect(await screen.findByText("Dry-run passed. Planned writes: 1")).toBeInTheDocument();
  });

  it("shows the execution task progress and task id", async () => {
    const plan = makePlan([item("__document", value("server.port=8080"), value("server.port=9090"))], {
      targetId: "conn-stage",
      targetLabel: "Staging / public",
    });
    const task: Task = {
      id: "task-live-1",
      name: "Change plan plan-preview-1",
      type: "apply",
      scope: "Staging / public",
      cancellable: false,
      status: "success",
      progress: 100,
      total: 1,
      completed: 1,
      failed: 0,
      error: "",
      startTime: "2026-07-06T00:00:00.000Z",
      endTime: "2026-07-06T00:00:01.000Z",
      elapsedTime: 1000,
    };
    taskManagerMocks.manager.getTask.mockReturnValue(task);
    executionMocks.executeApplyPlan.mockImplementationOnce(async (_plan, _deps, options: { onTaskCreated?: (taskId: string) => void }) => {
      options.onTaskCreated?.(task.id);
      return { ok: true, taskId: task.id, historyId: "history-1" };
    });
    const planEntry = {
      ...entryPayload,
      target: { ...entryPayload.target, connectionId: "conn-stage", connectionName: "Staging", label: "Staging / public" },
    };

    draftMocks.buildApplyPlanFromEntry.mockResolvedValue({
      ok: true,
      plan,
      sourceConnection: sourceConn,
      targetConnection: safeTargetConn,
    });

    renderView(planEntry, [sourceConn, safeTargetConn]);
    fireEvent.click(await screen.findByLabelText("I reviewed this dry-run plan and understand it will write to the target."));
    fireEvent.click(screen.getByRole("button", { name: "Execute change" }));

    expect(await screen.findByText("Execution progress")).toBeInTheDocument();
    expect(screen.getByText("Processed 1/1 items")).toBeInTheDocument();
    expect(screen.getByText("task-live-1")).toBeInTheDocument();
  });

  it("keeps the fifth step current after a successful sandbox execution", async () => {
    const sandboxConn: Connection = {
      ...safeTargetConn,
      id: "conn-sandbox",
      name: "Sandbox",
      environmentName: "Sandbox",
    };
    const plan = makePlan([item("__document", value("server.port=8080"), value("server.port=9090"))], {
      targetId: sandboxConn.id,
      targetLabel: "Sandbox / public",
    });
    draftMocks.buildApplyPlanFromEntry.mockResolvedValue({
      ok: true,
      plan,
      sourceConnection: sourceConn,
      targetConnection: sandboxConn,
    });

    const sandboxEntry = {
      ...entryPayload,
      target: { ...entryPayload.target, connectionId: sandboxConn.id, connectionName: sandboxConn.name, label: "Sandbox / public" },
    };
    renderView(sandboxEntry, [sourceConn, sandboxConn]);
    fireEvent.click(await screen.findByLabelText("I reviewed this dry-run plan and understand it will write to the target."));
    fireEvent.click(screen.getByRole("button", { name: "Execute change" }));

    const verifyStepLabel = await screen.findByText("Execute, verify, and promote");
    expect(verifyStepLabel.closest("li")).toHaveAttribute("aria-current", "step");
    // 当前步的 hover 气泡含步骤说明（安全语义保留在气泡内）
    expect(verifyStepLabel.closest("li")).toHaveAttribute("title", expect.stringContaining("After sandbox verification"));
    // 前四步已完成，第五步仍为当前（沙箱执行后未整体完结）
    expect(document.querySelectorAll(".diff-workflow-step.completed")).toHaveLength(4);
  });

  it("stepper navigation: back steps return to diff with focus; verify step not clickable before execution", async () => {
    draftMocks.buildApplyPlanFromEntry.mockResolvedValue({
      ok: true,
      plan: makePlan([item("__document", value("server.port=8080"), value("server.port=9090"))]),
      sourceConnection: sourceConn,
      targetConnection: safeTargetConn,
    });
    const { onBack } = renderView();
    // 计划加载完成后 stepper 出现
    await screen.findByText("Generate & review plan (dry-run, no writes)");
    const steps = Array.from(document.querySelectorAll(".diff-workflow-step")) as HTMLElement[];
    expect(steps).toHaveLength(5);
    // 前三步可点（回退到对比页并携带聚焦提示）
    expect(steps[0].querySelector("button")).toBeInTheDocument();
    expect(steps[1].querySelector("button")).toBeInTheDocument();
    expect(steps[2].querySelector("button")).toBeInTheDocument();
    // 第 4 步为当前（不可点）；第 5 步未完成（不可点，须先用页面按钮执行变更，绝不自动执行）
    expect(steps[3].querySelector("button")).not.toBeInTheDocument();
    expect(steps[4].querySelector("button")).not.toBeInTheDocument();
    expect(steps[4].classList.contains("locked")).toBe(true);
    expect(steps[4]).toHaveAttribute("title", expect.stringContaining("After sandbox verification"));
    fireEvent.click(steps[2].querySelector("button")!);
    expect(onBack).toHaveBeenCalledWith("plan");
    fireEvent.click(steps[0].querySelector("button")!);
    expect(onBack).toHaveBeenLastCalledWith("choose");
  });

  it("includes resolved runtime source connections when executing rollback plans", async () => {
    const targetRef = {
      provider: "nacos" as const,
      connectionId: safeTargetConn.id,
      namespace: "public",
      group: "DEFAULT_GROUP",
      dataId: "app.properties",
      key: "__document",
    };
    const sourceRef = {
      ...targetRef,
      provider: "local" as const,
      connectionId: snapshotSourceConn.id,
    };
    const plan = buildApplyPlan({
      id: "plan-rollback-1",
      createdAt: "2026-07-06T00:00:00.000Z",
      scope: "config",
      source: {
        envId: snapshotSourceConn.id,
        label: "before apply / public",
        provider: "local",
        connectionId: snapshotSourceConn.id,
        connectionName: snapshotSourceConn.name,
        namespace: "public",
      },
      target: endpoint(safeTargetConn.id, "Staging / public"),
      inputSummary: {
        sourceType: "rollback",
        scope: "config",
        sourceLabel: "before apply / public",
        targetLabel: "Staging / public",
        selectedCount: 1,
      },
      items: [
        {
          ref: targetRef,
          sourceRef,
          targetRef,
          sourceValue: value("server.port=9090"),
          targetValue: value("server.port=8080"),
        },
      ],
    });
    draftMocks.buildApplyPlanFromEntry.mockResolvedValue({
      ok: true,
      plan,
      sourceConnection: snapshotSourceConn,
      targetConnection: safeTargetConn,
    });

    renderView(entryPayload, [safeTargetConn]);

    fireEvent.click(await screen.findByLabelText("I reviewed this dry-run plan and understand it will write to the target."));
    const executeButton = screen.getByRole("button", { name: "Execute change" });
    await waitFor(() => expect(executeButton).toBeEnabled());
    fireEvent.click(executeButton);

    await waitFor(() =>
      expect(executionMocks.executeApplyPlan).toHaveBeenCalledWith(
        plan,
        expect.objectContaining({
          connections: [safeTargetConn, snapshotSourceConn],
        }),
        expect.objectContaining({ selectedItemIds: plan.items.map((item) => item.id) })
      )
    );
  });

  it("human-edits target content: validation, save, and diff update", async () => {
    const plan = makePlan([item("__document", value("server.port=8080"), value("server.port=9090"))]);
    draftMocks.buildApplyPlanFromEntry.mockResolvedValue({
      ok: true,
      plan,
      sourceConnection: sourceConn,
      targetConnection: targetConn,
    });

    renderView();

    // 编辑入口出现（非 delete 项）
    const editBtn = await screen.findByRole("button", { name: "Edit Target" });
    fireEvent.click(editBtn);
    expect(await screen.findByText(/manually adjust/i)).toBeInTheDocument();

    // 无效 properties 内容被校验拦截，不保存
    const ta = document.querySelector(".apply-edit-editor textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set?.bind(ta);
    // 合法内容保存：afterValue 更新，diff 预览展示编辑结果
    setter?.("server.port=7777");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    const savesBeforeCommit = storeMocks.saveApplyPlan.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Save & Re-validate" }));
    await waitFor(() => expect(storeMocks.saveApplyPlan.mock.calls.length).toBeGreaterThan(savesBeforeCommit));
    await waitFor(() =>
      expect(storeMocks.saveApplyPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          items: expect.arrayContaining([expect.objectContaining({ afterValue: expect.objectContaining({ value: "server.port=7777" }) })]),
        }) as never
      )
    );
    // diff 预览右侧（after）应出现编辑后的端口值
    expect(await screen.findByText("7777")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });
  it("explains which step is missing before the confirmation checkbox is ticked", async () => {
    const plan = makePlan([item("__document", value("server.port=8080"), value("server.port=9090"))], {
      targetId: "conn-stage",
      targetLabel: "Staging / public",
    });
    draftMocks.buildApplyPlanFromEntry.mockResolvedValue({
      ok: true,
      plan,
      sourceConnection: sourceConn,
      targetConnection: safeTargetConn,
    });

    renderView(entryPayload, [sourceConn, safeTargetConn]);

    const missingReason = "Tick the confirmation checkbox first.";
    const executeButton = await screen.findByRole("button", { name: "Execute change" });
    const dryRunButton = screen.getByRole("button", { name: "Dry-run check" });

    expect(executeButton).toBeDisabled();
    // 原因既进读屏可达的行内清单，也挂在包裹按钮的守卫 title 上——disabled 按钮自身收不到 pointer 事件，tooltip 弹不出来
    expect(screen.getByText(missingReason)).toBeInTheDocument();
    expect(executeButton.closest(".btn-guard")).toHaveAttribute("title", missingReason);
    // dry-run 不要求勾选确认，不能被这条原因误伤
    expect(dryRunButton).toBeEnabled();
    expect(dryRunButton.closest(".btn-guard")).not.toHaveAttribute("title");

    fireEvent.click(screen.getByLabelText("I reviewed this dry-run plan and understand it will write to the target."));

    await waitFor(() => expect(executeButton).toBeEnabled());
    expect(screen.queryByText(missingReason)).not.toBeInTheDocument();
    expect(executeButton.closest(".btn-guard")).not.toHaveAttribute("title");
  });

  it("asks for a selection on both buttons after the user clears the checkboxes", async () => {
    const plan = makePlan([item("__document", value("server.port=8080"), value("server.port=9090"))], {
      targetId: "conn-stage",
      targetLabel: "Staging / public",
    });
    draftMocks.buildApplyPlanFromEntry.mockResolvedValue({
      ok: true,
      plan,
      sourceConnection: sourceConn,
      targetConnection: safeTargetConn,
    });

    renderView(entryPayload, [sourceConn, safeTargetConn]);
    fireEvent.click(await screen.findByLabelText("I reviewed this dry-run plan and understand it will write to the target."));
    fireEvent.click(screen.getByRole("button", { name: "Select none" }));

    const missingReason = "Select at least one item.";
    expect(await screen.findByText(missingReason)).toBeInTheDocument();
    // 没勾选连 dry-run 也做不了，所以两个按钮的守卫都要带上这条原因
    const guards = Array.from(document.querySelectorAll<HTMLElement>(".apply-confirmation-actions .btn-guard"));
    expect(guards).toHaveLength(2);
    guards.forEach((guard) => {
      expect(guard).toHaveAttribute("title", missingReason);
      expect(guard.querySelector("button")).toBeDisabled();
    });

    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    await waitFor(() => expect(guards[1].querySelector("button")).toBeEnabled());
    expect(screen.queryByText(missingReason)).not.toBeInTheDocument();
  });

  it("stays quiet while a task runs and explains the lock after it succeeds", async () => {
    const plan = makePlan([item("__document", value("server.port=8080"), value("server.port=9090"))], {
      targetId: "conn-stage",
      targetLabel: "Staging / public",
    });
    draftMocks.buildApplyPlanFromEntry.mockResolvedValue({
      ok: true,
      plan,
      sourceConnection: sourceConn,
      targetConnection: safeTargetConn,
    });
    // 手动收尾的执行，用来把组件停在「任务进行中」这一帧
    let finishExecution: ((result: { ok: true; taskId: string; historyId: string }) => void) | undefined;
    executionMocks.executeApplyPlan.mockImplementationOnce(
      () =>
        new Promise<{ ok: true; taskId: string; historyId: string }>((resolve) => {
          finishExecution = resolve;
        })
    );

    renderView(entryPayload, [sourceConn, safeTargetConn]);
    fireEvent.click(await screen.findByLabelText("I reviewed this dry-run plan and understand it will write to the target."));
    const executeButton = await screen.findByRole("button", { name: "Execute change" });
    await waitFor(() => expect(executeButton).toBeEnabled());
    fireEvent.click(executeButton);

    const runningButton = await screen.findByRole("button", { name: "Executing..." });
    expect(runningButton).toBeDisabled();
    const runningReason = "A task is already running; wait for it to finish.";
    // 悬停提示保留，但行内清单不播报——执行中进度面板自己会说话，避免两处重复
    expect(runningButton.closest(".btn-guard")).toHaveAttribute("title", runningReason);
    expect(screen.queryByText(runningReason)).not.toBeInTheDocument();
    expect(document.querySelector(".apply-blocker-hint")).not.toBeInTheDocument();

    finishExecution?.({ ok: true, taskId: "task-blocker-1", historyId: "history-blocker-1" });

    const succeededReason = "This plan already ran successfully; generate a new plan to run again.";
    expect(await screen.findByText(succeededReason)).toBeInTheDocument();
    // 执行成功后只读预演照样能跑（R55-D3）：dry-run 按钮可用且守卫不带原因，
    // 「已执行过」只挡真正会落笔的执行按钮。
    const dryRunButton = screen.getByRole("button", { name: "Dry-run check" });
    expect(dryRunButton).toBeEnabled();
    expect(dryRunButton.closest(".btn-guard")).not.toHaveAttribute("title");
    expect(screen.getByRole("button", { name: "Execute change" }).closest(".btn-guard")).toHaveAttribute("title", succeededReason);
  });

  // ── 波16：执行安全网三条（R55-A5 关窗/离开、R55-A6 失败重试、R55-A2 部分写入进度） ──

  /** 把组件停在「写入进行中」这一帧：执行 promise 由用例自己收尾。 */
  async function renderRunningApply() {
    draftMocks.buildApplyPlanFromEntry.mockResolvedValue({
      ok: true,
      plan: makePlan([item("__document", value("server.port=8080"), value("server.port=9090"))], {
        targetId: "conn-stage",
        targetLabel: "Staging / public",
      }),
      sourceConnection: sourceConn,
      targetConnection: safeTargetConn,
    });
    let finishExecution: ((result: { ok: true; taskId: string; historyId: string }) => void) | undefined;
    executionMocks.executeApplyPlan.mockImplementation(
      () =>
        new Promise<{ ok: true; taskId: string; historyId: string }>((resolve) => {
          finishExecution = resolve;
        })
    );
    const { onBack } = renderView(entryPayload, [sourceConn, safeTargetConn]);
    fireEvent.click(await screen.findByLabelText("I reviewed this dry-run plan and understand it will write to the target."));
    const executeButton = await screen.findByRole("button", { name: "Execute change" });
    await waitFor(() => expect(executeButton).toBeEnabled());
    fireEvent.click(executeButton);
    await screen.findByRole("button", { name: "Executing..." });
    return { onBack, finishExecution: () => finishExecution?.({ ok: true, taskId: "task-leave-1", historyId: "history-leave-1" }) };
  }

  it("blocks closing the app while writes are in flight, and stops blocking afterwards", async () => {
    const { finishExecution } = await renderRunningApply();

    const closing = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(closing);
    expect(closing.defaultPrevented).toBe(true);

    // 任务收尾后守卫必须摘掉：留在 body 上会拦掉之后每一次正常关窗
    finishExecution();
    await screen.findByText(/This plan already ran successfully/);
    const closingAgain = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(closingAgain);
    expect(closingAgain.defaultPrevented).toBe(false);
  });

  it("does not block closing the app during a dry-run", async () => {
    draftMocks.buildApplyPlanFromEntry.mockResolvedValue({
      ok: true,
      plan: makePlan([item("__document", value("server.port=8080"), value("server.port=9090"))], {
        targetId: "conn-stage",
        targetLabel: "Staging / public",
      }),
      sourceConnection: sourceConn,
      targetConnection: safeTargetConn,
    });
    let finishDryRun: ((result: { ok: true; dryRun: true; taskId: string; plannedWrites: number }) => void) | undefined;
    executionMocks.executeApplyPlan.mockImplementation(
      () =>
        new Promise<{ ok: true; dryRun: true; taskId: string; plannedWrites: number }>((resolve) => {
          finishDryRun = resolve;
        })
    );
    renderView(entryPayload, [sourceConn, safeTargetConn]);
    fireEvent.click(await screen.findByRole("button", { name: "Dry-run check" }));
    await screen.findByRole("button", { name: "Dry-run checking..." });

    // dry-run 什么都不写，关窗不该被拦
    const closing = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(closing);
    expect(closing.defaultPrevented).toBe(false);
    finishDryRun?.({ ok: true, dryRun: true, taskId: "task-dry-1", plannedWrites: 1 });
  });

  it("asks before leaving mid-write and keeps the stepper target step", async () => {
    const { onBack } = await renderRunningApply();

    fireEvent.click(backButton());
    const ask = await screen.findByRole("dialog", { name: "Changes are still being applied" });
    expect(ask).toBeInTheDocument();
    expect(onBack).not.toHaveBeenCalled();

    fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Changes are still being applied" })).not.toBeInTheDocument();
    expect(onBack).not.toHaveBeenCalled();

    // stepper 回退走同一个守卫，确认后仍带着目标步骤走
    fireEvent.click(document.querySelector(".diff-workflow-step button") as HTMLElement);
    expect(await screen.findByRole("dialog", { name: "Changes are still being applied" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Leave anyway" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledWith("choose");
  });

  it("retries plan generation from the inline error without leaving the page", async () => {
    draftMocks.buildApplyPlanFromEntry
      .mockResolvedValueOnce({ ok: false, error: "apply_plan_draft_failed", detail: "connect ECONNREFUSED" })
      .mockResolvedValue({
        ok: true,
        plan: makePlan([item("__document", value("server.port=8080"), value("server.port=9090"))]),
        sourceConnection: sourceConn,
        targetConnection: safeTargetConn,
      });

    renderView();

    expect(await screen.findByRole("alert")).toHaveTextContent("connect ECONNREFUSED");
    // 以前生成失败只有「退出再进来」一条路，行内错误上连个重试都挂不住
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(draftMocks.buildApplyPlanFromEntry).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "Dry-run check" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows how far the write got and offers one-click retry on the failed item", async () => {
    draftMocks.buildApplyPlanFromEntry.mockResolvedValue({
      ok: true,
      plan: makePlan([item("__document", value("server.port=8080"), value("server.port=9090"))], {
        targetId: "conn-stage",
        targetLabel: "Staging / public",
      }),
      sourceConnection: sourceConn,
      targetConnection: safeTargetConn,
    });
    executionMocks.executeApplyPlan.mockResolvedValueOnce({
      ok: false,
      taskId: "task-partial-1",
      error: "write failed: HTTP 500 on app.yaml",
      progress: { completedWrites: 1, totalWrites: 3, failedIndex: 2, failedRef: "public/DEFAULT_GROUP/app.yaml" },
    });

    renderView(entryPayload, [sourceConn, safeTargetConn]);
    fireEvent.click(await screen.findByLabelText("I reviewed this dry-run plan and understand it will write to the target."));
    const executeButton = await screen.findByRole("button", { name: "Execute change" });
    await waitFor(() => expect(executeButton).toBeEnabled());
    fireEvent.click(executeButton);

    // 断在哪一条、已经落了几条，得写在脸上（R55-A2）
    expect(await screen.findByRole("alert")).toHaveTextContent("write failed: HTTP 500");
    const partial = document.querySelector(".apply-partial-write");
    expect(partial).not.toBeNull();
    expect(partial).toHaveTextContent("1 of 3 items written; item 2 failed: public/DEFAULT_GROUP/app.yaml");
    expect(partial).toHaveTextContent("rolled back with this run");

    // 行内错误的重试不许绕过确认守卫：仍走 onExecute，勾选状态没丢就能再点
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(executionMocks.executeApplyPlan).toHaveBeenCalledTimes(2));
  });

  it("keeps the partial-write notice off the screen when execution gives no progress", async () => {
    draftMocks.buildApplyPlanFromEntry.mockResolvedValue({
      ok: true,
      plan: makePlan([item("__document", value("server.port=8080"), value("server.port=9090"))], {
        targetId: "conn-stage",
        targetLabel: "Staging / public",
      }),
      sourceConnection: sourceConn,
      targetConnection: safeTargetConn,
    });
    executionMocks.executeApplyPlan.mockResolvedValueOnce({ ok: false, error: "plan is stale" });

    renderView(entryPayload, [sourceConn, safeTargetConn]);
    fireEvent.click(await screen.findByLabelText("I reviewed this dry-run plan and understand it will write to the target."));
    const executeButton = await screen.findByRole("button", { name: "Execute change" });
    await waitFor(() => expect(executeButton).toBeEnabled());
    fireEvent.click(executeButton);

    // 计划层面就失败（一项都没写）时不许凭空报「已写入几项」
    expect(await screen.findByRole("alert")).toHaveTextContent("plan is stale");
    expect(document.querySelector(".apply-partial-write")).toBeNull();
  });

  // ── 波16：内联「编辑目标内容」的未保存草稿（R60 串内容 / R58 静默丢弃） ──
  function renderTwoItems() {
    draftMocks.buildApplyPlanFromEntry.mockResolvedValue({
      ok: true,
      plan: makePlan([
        item("first.key", value("server.port=8080"), value("server.port=9090")),
        item("second.key", value("log.level=info"), value("log.level=warn")),
      ]),
      sourceConnection: sourceConn,
      targetConnection: safeTargetConn,
    });
    return renderView();
  }

  function itemRows(): HTMLElement[] {
    return Array.from(document.querySelectorAll(".apply-item-row")) as HTMLElement[];
  }

  function editorTextarea(): HTMLTextAreaElement | null {
    return document.querySelector(".apply-edit-panel .code-editor-ta") as HTMLTextAreaElement | null;
  }

  /** 页头「返回」：确认框打开时也有个同名样式的按钮，必须锁定在 page-actions 里。 */
  function backButton(): HTMLElement {
    return document.querySelector(".page-actions button") as HTMLElement;
  }

  it("keeps an unsaved target edit attached to the item it was written for", async () => {
    renderTwoItems();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Target" }));
    fireEvent.change(editorTextarea()!, { target: { value: "server.port=8099" } });

    // 切到第二项：面板必须收起。以前它跟着组件活下来，第二项上点「保存」会把第一项的正文写进第二项。
    fireEvent.click(itemRows()[1]);
    expect(editorTextarea()).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit Target" })).toBeInTheDocument();

    // 切回第一项：草稿还在，不因为换行选中就丢
    fireEvent.click(itemRows()[0]);
    expect(editorTextarea()!.value).toBe("server.port=8099");
  });

  it("saves the draft into the item it belongs to, not the newly selected one", async () => {
    renderTwoItems();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Target" }));
    fireEvent.change(editorTextarea()!, { target: { value: "server.port=8099" } });
    // 切到第二项时不许留着「保存并重新校验」：留着它就等于把第一项的正文写进第二项
    fireEvent.click(itemRows()[1]);
    expect(screen.queryByRole("button", { name: "Save & Re-validate" })).not.toBeInTheDocument();
    fireEvent.click(itemRows()[0]);
    fireEvent.click(screen.getByRole("button", { name: "Save & Re-validate" }));

    await waitFor(() => expect(storeMocks.saveApplyPlan).toHaveBeenCalled());
    const saveCalls = storeMocks.saveApplyPlan.mock.calls;
    const saved = saveCalls[saveCalls.length - 1]?.[0] as ApplyPlan;
    expect(saved.items.find((candidate) => candidate.ref.key === "first.key")?.afterValue.content).toBe("server.port=8099");
    expect(saved.items.find((candidate) => candidate.ref.key === "second.key")?.afterValue.content).not.toBe("server.port=8099");
  });

  it("asks before going back while a target edit is unsaved", async () => {
    const { onBack } = renderTwoItems();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Target" }));
    fireEvent.change(editorTextarea()!, { target: { value: "server.port=8099" } });

    fireEvent.click(backButton());
    const ask = await screen.findByRole("dialog", { name: "Discard unsaved target content?" });
    expect(ask).toBeInTheDocument();
    expect(onBack).not.toHaveBeenCalled();

    // 取消：留在本页，草稿也还在
    fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Discard unsaved target content?" })).not.toBeInTheDocument();
    expect(onBack).not.toHaveBeenCalled();
    expect(editorTextarea()!.value).toBe("server.port=8099");

    // 确认放弃才真的走
    fireEvent.click(backButton());
    fireEvent.click(await screen.findByRole("button", { name: "Discard and go back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledWith(undefined);
  });

  it("returns immediately when nothing is unsaved, and after cancelling the panel", async () => {
    const { onBack } = renderTwoItems();
    await screen.findByRole("button", { name: "Edit Target" });
    fireEvent.click(backButton());
    expect(onBack).toHaveBeenCalledTimes(1);

    // 面板里点「取消」＝草稿作废，之后再按「返回」不该再多问一句
    fireEvent.click(screen.getByRole("button", { name: "Edit Target" }));
    fireEvent.change(editorTextarea()!, { target: { value: "server.port=8099" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" })); // 编辑面板自己的「取消」
    expect(editorTextarea()).not.toBeInTheDocument();
    fireEvent.click(backButton());
    expect(onBack).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("the stepper back route goes through the same guard and keeps its focus step", async () => {
    const { onBack } = renderTwoItems();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Target" }));
    fireEvent.change(editorTextarea()!, { target: { value: "server.port=8099" } });

    const steps = Array.from(document.querySelectorAll(".diff-workflow-step")) as HTMLElement[];
    fireEvent.click(steps[0].querySelector("button")!);
    expect(await screen.findByRole("dialog", { name: "Discard unsaved target content?" })).toBeInTheDocument();
    expect(onBack).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Discard and go back" }));
    expect(onBack).toHaveBeenCalledWith("choose");
  });

  it("keeps the failed validation message with the draft instead of dropping it", async () => {
    renderTwoItems();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Target" }));
    // Properties 重复 key：validateConfig 报错，面板不许被关掉
    fireEvent.change(editorTextarea()!, { target: { value: "server.port=8099\nserver.port=9000" } });
    // 计划加载时已经落过一次盘，这里只关心「校验没过就不许多写一次」
    const savedCalls = storeMocks.saveApplyPlan.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Save & Re-validate" }));
    expect(editorTextarea()).toBeInTheDocument();
    expect(document.querySelector(".apply-edit-errors")).toHaveTextContent(/server\.port/);
    expect(storeMocks.saveApplyPlan.mock.calls).toHaveLength(savedCalls);

    // 改对之后保存：错误提示随草稿一起消失
    fireEvent.change(editorTextarea()!, { target: { value: "server.port=7000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save & Re-validate" }));
    await waitFor(() => expect(storeMocks.saveApplyPlan).toHaveBeenCalled());
    expect(document.querySelector(".apply-edit-panel")).not.toBeInTheDocument();
  });
});
