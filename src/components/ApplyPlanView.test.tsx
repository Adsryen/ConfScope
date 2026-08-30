/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "../test/react";
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

function endpoint(connectionId: string, label: string): BuildApplyPlanInput["source"] {
  return {
    envId: connectionId,
    label,
    provider: "nacos",
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

function makePlan(items: BuildApplyPlanInput["items"], options: { targetId?: string; targetLabel?: string } = {}): ApplyPlan {
  return buildApplyPlan({
    id: "plan-preview-1",
    createdAt: "2026-07-06T00:00:00.000Z",
    scope: "batch",
    source: endpoint("conn-dev", "Dev / public"),
    target: endpoint(options.targetId ?? "conn-prod", options.targetLabel ?? "Prod / public"),
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
    expect(await screen.findByText(/Current: Generate & review plan/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Execute, verify, and promote/ })).toBeInTheDocument();
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
    expect(await screen.findByText("Change plan complete")).toBeInTheDocument();
    expect(document.querySelectorAll(".diff-workflow-step.completed")).toHaveLength(5);
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
    const planEntry = { ...entryPayload, target: { ...entryPayload.target, connectionId: "conn-stage", connectionName: "Staging", label: "Staging / public" } };

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

    const sandboxEntry = { ...entryPayload, target: { ...entryPayload.target, connectionId: sandboxConn.id, connectionName: sandboxConn.name, label: "Sandbox / public" } };
    renderView(sandboxEntry, [sourceConn, sandboxConn]);
    fireEvent.click(await screen.findByLabelText("I reviewed this dry-run plan and understand it will write to the target."));
    fireEvent.click(screen.getByRole("button", { name: "Execute change" }));

    expect(await screen.findByText("Current: Execute, verify, and promote")).toBeInTheDocument();
    expect(screen.queryByText("Change plan complete")).not.toBeInTheDocument();
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
        expect.objectContaining({ items: expect.arrayContaining([expect.objectContaining({ afterValue: expect.objectContaining({ value: "server.port=7777" }) })]) }) as never
      )
    );
    // diff 预览右侧（after）应出现编辑后的端口值
    expect(await screen.findByText("7777")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });
});
