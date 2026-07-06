/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import type { Connection } from "../store/connections";
import type { ApplyEntryPayload } from "../lib/applyEntry";
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
  publishConfig: vi.fn(),
  deleteConfig: vi.fn(),
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
  publishConfig: apiMocks.publishConfig,
  deleteConfig: apiMocks.deleteConfig,
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

function makePlan(
  items: BuildApplyPlanInput["items"],
  options: { targetId?: string; targetLabel?: string } = {}
): ApplyPlan {
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
    apiMocks.publishConfig.mockReset();
    apiMocks.deleteConfig.mockReset();
    snapshotMocks.getSnapshot.mockReset();
    snapshotMocks.createSnapshot.mockReset();
    snapshotMocks.createSnapshot.mockResolvedValue({ id: "snap-before-1", name: "before_apply" });
    historyMocks.recordOperation.mockReset();
    taskManagerMocks.getTaskManager.mockReset();
    taskManagerMocks.getTaskManager.mockReturnValue(taskManagerMocks.manager);
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
    expect(draftMocks.buildApplyPlanFromEntry).toHaveBeenCalledWith(entryPayload, expect.objectContaining({ connections: [sourceConn, targetConn] }));
    expect(storeMocks.saveApplyPlan).toHaveBeenCalledWith(plan);
    expect(screen.getByText("Total 1")).toBeInTheDocument();
    expect(screen.getByText("Overwrite 1")).toBeInTheDocument();
    expect(screen.getByText("Blocked 0")).toBeInTheDocument();
  });

  it("shows item actions and selected item source, target, after and block details", async () => {
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

    fireEvent.click(screen.getByRole("button", { name: /changed.key/ }));
    expect(screen.getByText("Action: overwrite")).toBeInTheDocument();
    expect(screen.getAllByText("from-source")).toHaveLength(2);
    expect(screen.getByText("from-target")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /broken.key/ }));
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
    expect(screen.queryByRole("button", { name: "Execute apply" })).not.toBeInTheDocument();
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

    const executeButton = await screen.findByRole("button", { name: "Execute apply" });
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

    const executeButton = await screen.findByRole("button", { name: "Execute apply" });
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

    const executeButton = await screen.findByRole("button", { name: "Execute apply" });
    fireEvent.click(screen.getByLabelText("I reviewed this dry-run plan and understand it will write to the target."));
    fireEvent.click(executeButton);

    expect(await screen.findAllByText("plan-saved-1")).toHaveLength(2);
    expect(executionMocks.executeApplyPlan).toHaveBeenCalledWith(savedPlan, expect.any(Object));
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

    const executeButton = await screen.findByRole("button", { name: "Execute apply" });
    fireEvent.click(screen.getByLabelText("I reviewed this dry-run plan and understand it will write to the target."));
    fireEvent.click(executeButton);

    const executionDeps = executionMocks.executeApplyPlan.mock.calls[0][1];
    expect(executionDeps).toMatchObject({
      connections: [sourceConn, safeTargetConn],
      getConfigDocument: apiMocks.getConfigDocument,
      publishConfig: apiMocks.publishConfig,
      deleteConfig: apiMocks.deleteConfig,
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
});
