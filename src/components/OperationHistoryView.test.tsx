// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { buildApplyPlan, type BuildApplyPlanInput } from "../lib/applyPlan";
import { saveApplyPlan } from "../store/applyPlans";
import type { Connection } from "../store/connections";
import { loadOperationHistory, type OperationRecord } from "../store/operationHistory";
import { translate } from "../locales";
import OperationHistoryView from "./OperationHistoryView";
import { clearViewState, readViewState } from "../lib/viewState";

const nacosMocks = vi.hoisted(() => ({
  listHistory: vi.fn(),
  getConfig: vi.fn(),
  getConfigDocument: vi.fn(),
  publishConfig: vi.fn(),
}));

const snapshotMocks = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
}));

vi.mock("../api/nacos", async () => {
  const actual = await vi.importActual<typeof import("../api/nacos")>("../api/nacos");
  return {
    ...actual,
    listHistory: nacosMocks.listHistory,
    getConfig: nacosMocks.getConfig,
    getConfigDocument: nacosMocks.getConfigDocument,
    publishConfig: nacosMocks.publishConfig,
  };
});

vi.mock("../api/snapshot", async () => {
  const actual = await vi.importActual<typeof import("../api/snapshot")>("../api/snapshot");
  return {
    ...actual,
    getSnapshot: snapshotMocks.getSnapshot,
  };
});

vi.mock("../lib/toast", () => ({
  toast: vi.fn(),
}));

const conn: Connection = {
  id: "conn-1",
  name: "prod",
  baseUrl: "http://localhost:8848/nacos",
  username: "nacos",
  password: "nacos",
  defaultNamespace: "public",
};

const rollbackablePublishRecord = {
  id: "record-rollbackable",
  type: "publish",
  result: "success",
  timestamp: "2026-07-04T10:00:00Z",
  connectionId: "conn-1",
  connectionName: "prod",
  namespace: "public",
  group: "DEFAULT_GROUP",
  dataId: "app.yaml",
  beforeContent: "old: true",
  afterContent: "new: true",
  configType: "yaml",
  rollbackable: true,
};

const applyRecord = {
  id: "apply-1",
  type: "apply",
  result: "success",
  timestamp: "2026-07-06T12:00:00Z",
  connectionId: "conn-1",
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
    sourceLabel: "Dev",
    targetLabel: "Prod",
  },
  backupSnapshotId: "snap-before-1",
  backupSnapshotName: "prod_before_apply",
  taskId: "task-apply-1",
  sourceConnectionId: "conn-dev",
  sourceConnectionName: "Dev",
  sourceNamespace: "public",
  targetConnectionId: "conn-1",
  targetConnectionName: "Prod",
  targetNamespace: "public",
  beforeContent: "old: true",
  rollbackable: false,
  rollbackReason: "operationHistory.rollbackApplyRequiresPlan",
};

function richConnection(id: string, name: string, environmentName: string): Connection {
  return {
    id,
    name,
    projectName: "Order",
    environmentName,
    sourceName: `${environmentName} Nacos`,
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

const devConn = richConnection("conn-dev", "Dev", "Development");
const sandboxConn = richConnection("conn-sandbox", "Sandbox", "Sandbox");
const prodConn = richConnection("conn-prod", "Production", "Production");

function endpoint(connection: Connection): BuildApplyPlanInput["source"] {
  return {
    envId: connection.id,
    label: `${connection.name} / public`,
    provider: connection.provider ?? "nacos",
    connectionId: connection.id,
    connectionName: connection.name,
    namespace: "public",
  };
}

function planRef(connection: Connection): BuildApplyPlanInput["items"][number]["ref"] {
  return {
    provider: connection.provider ?? "nacos",
    connectionId: connection.id,
    namespace: "public",
    group: "DEFAULT_GROUP",
    dataId: "app.yaml",
    key: "__document",
  };
}

function planValue(content: string): BuildApplyPlanInput["items"][number]["sourceValue"] {
  return {
    exists: true,
    value: content,
    valueType: "text",
    format: "YAML",
    parseStatus: "ok",
    content,
    version: "v1",
    updateTime: "2026-07-06T00:00:00.000Z-v1",
  };
}

function savedApplyPlan() {
  const plan = buildApplyPlan({
    id: "plan-apply-1",
    createdAt: "2026-07-06T00:00:00.000Z",
    scope: "config",
    source: endpoint(devConn),
    target: endpoint(sandboxConn),
    inputSummary: {
      sourceType: "diff",
      scope: "config",
      sourceLabel: "Dev / public",
      targetLabel: "Sandbox / public",
      selectedCount: 1,
    },
    items: [
      {
        ref: planRef(sandboxConn),
        sourceValue: planValue("server:\n  port: 8080"),
        targetValue: planValue("server:\n  port: 9090"),
      },
    ],
  });
  saveApplyPlan(plan);
  return plan;
}

function followupApplyRecord(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    id: "history-apply-1",
    type: "apply",
    result: "success",
    timestamp: "2026-07-06T12:00:00Z",
    connectionId: sandboxConn.id,
    connectionName: sandboxConn.name,
    namespace: "public",
    group: "DEFAULT_GROUP",
    dataId: "app.yaml",
    planId: "plan-apply-1",
    backupSnapshotId: "snap-before-1",
    backupSnapshotName: "before apply",
    taskId: "task-apply-1",
    sourceConnectionId: devConn.id,
    sourceConnectionName: devConn.name,
    sourceNamespace: "public",
    targetConnectionId: sandboxConn.id,
    targetConnectionName: sandboxConn.name,
    targetNamespace: "public",
    rollbackable: false,
    rollbackReason: "operationHistory.rollbackApplyRequiresPlan",
    ...overrides,
  };
}

function renderHistory(connections: Connection[], onStartApply = vi.fn()) {
  render(
    <I18nProvider>
      <OperationHistoryView connections={connections} onStartApply={onStartApply} />
    </I18nProvider>
  );
  return { onStartApply };
}

describe("OperationHistoryView", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    // 视图状态存在模块内存里（R27）：用例之间必须隔离
    clearViewState();
    localStorage.clear();
    localStorage.setItem("locale", "zh-CN");
    nacosMocks.listHistory.mockReset();
    nacosMocks.getConfig.mockReset();
    nacosMocks.getConfigDocument.mockReset();
    nacosMocks.publishConfig.mockReset();
    snapshotMocks.getSnapshot.mockReset();
    nacosMocks.listHistory.mockResolvedValue({ pageItems: [] });
    nacosMocks.getConfig.mockResolvedValue("current: true");
    nacosMocks.getConfigDocument.mockResolvedValue({
      content: "server:\n  port: 8080",
      format: "yaml",
      version: "v1",
      source: "nacos",
      updateTime: "2026-07-06T00:00:00.000Z-v1",
    });
    snapshotMocks.getSnapshot.mockResolvedValue({
      id: "snap-before-1",
      path: "C:\\snapshots\\snap-before-1",
      name: "before apply",
      description: "",
      createdAt: "2026-07-06T00:00:00.000Z",
      updatedAt: "2026-07-06T00:00:00.000Z",
      source: {
        provider: "nacos",
        connectionId: sandboxConn.id,
        connectionName: sandboxConn.name,
        namespace: "public",
        namespaceId: "public",
      },
      configs: [],
    });
    nacosMocks.publishConfig.mockResolvedValue(undefined);
  });

  it("allows copying the error detail from a failed operation record", async () => {
    localStorage.setItem(
      "cs.operationHistory",
      JSON.stringify([
        {
          id: "record-1",
          type: "delete",
          result: "failure",
          timestamp: "2026-07-03T10:00:00Z",
          connectionId: "conn-1",
          connectionName: "prod",
          namespace: "public",
          group: "DEFAULT_GROUP",
          dataId: "app.yaml",
          error: "permission denied",
        },
      ])
    );

    render(
      <I18nProvider>
        <OperationHistoryView connections={[]} />
      </I18nProvider>
    );

    await waitFor(() => {
      expect(screen.getByText("app.yaml")).toBeDefined();
    });

    fireEvent.click(screen.getByText("app.yaml"));

    expect(screen.getByText("permission denied")).toBeDefined();
    expect(screen.getByRole("button", { name: "复制错误" })).toBeDefined();
  });

  it("shows and filters snapshot compare records", async () => {
    localStorage.setItem("locale", "en-US");
    localStorage.setItem(
      "cs.operationHistory",
      JSON.stringify([
        {
          id: "compare-1",
          type: "snapshot_compare",
          result: "success",
          timestamp: "2026-07-06T10:00:00Z",
          connectionId: "conn-1",
          connectionName: "prod",
          namespace: "public",
          group: "DEFAULT_GROUP",
          dataId: "app.yaml",
          resourceId: "snap-1",
          resourceName: "prod_snapshot",
          rollbackable: false,
          rollbackReason: "operationHistory.rollbackSnapshotOnly",
        },
      ])
    );

    render(
      <I18nProvider>
        <OperationHistoryView connections={[conn]} />
      </I18nProvider>
    );

    expect((await screen.findAllByText("Snapshot compare")).length).toBeGreaterThan(0);
    expect(screen.getByText("app.yaml")).toBeDefined();

    const typeSelect = screen.getAllByRole("combobox")[1];
    expect(within(typeSelect).getByRole("option", { name: "Snapshot compare" })).toBeDefined();

    fireEvent.change(typeSelect, { target: { value: "snapshot_compare" } });

    if (!(typeSelect instanceof HTMLSelectElement)) throw new Error("type filter is not a select element");
    expect(typeSelect.value).toBe("snapshot_compare");
    expect(screen.getByText("app.yaml")).toBeDefined();
  });

  it("hides direct rollback for legacy rollbackable operation records", async () => {
    localStorage.setItem("locale", "en-US");
    localStorage.setItem("cs.operationHistory", JSON.stringify([rollbackablePublishRecord]));

    render(
      <I18nProvider>
        <OperationHistoryView connections={[conn]} />
      </I18nProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: /app.yaml/ }));

    expect(screen.getByText("1 records")).toBeDefined();
    expect(screen.getByText("Not rollbackable")).toBeDefined();
    expect(screen.getByText("Rollback requires a change-plan dry-run and cannot publish previous content directly.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Copy Record" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Rollback this operation" })).toBeNull();
  });

  it("shows and filters apply operation records", async () => {
    localStorage.setItem("cs.operationHistory", JSON.stringify([applyRecord]));

    render(
      <I18nProvider>
        <OperationHistoryView connections={[conn]} />
      </I18nProvider>
    );

    expect((await screen.findAllByText("配置变更计划")).length).toBeGreaterThan(0);
    expect(screen.getByText("app.yaml")).toBeDefined();

    const typeSelect = screen.getAllByRole("combobox")[1];
    expect(within(typeSelect).getByRole("option", { name: "配置变更计划" })).toBeDefined();

    fireEvent.change(typeSelect, { target: { value: "apply" } });

    if (!(typeSelect instanceof HTMLSelectElement)) throw new Error("type filter is not a select element");
    expect(typeSelect.value).toBe("apply");
    expect(screen.getByText("app.yaml")).toBeDefined();
  });

  it("shows apply plan, backup and source target details", async () => {
    localStorage.setItem("cs.operationHistory", JSON.stringify([applyRecord]));

    render(
      <I18nProvider>
        <OperationHistoryView connections={[conn]} />
      </I18nProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: /app.yaml/ }));

    expect(screen.getByText("计划 ID:")).toBeDefined();
    expect(screen.getByText("plan-1")).toBeDefined();
    expect(screen.getByText("计划摘要:")).toBeDefined();
    expect(screen.getByText("总计 2 · 新增 1 · 覆盖 1 · 删除 0 · 跳过 0 · 阻塞 0")).toBeDefined();
    expect(screen.getByText("备份快照:")).toBeDefined();
    expect(screen.getByText("prod_before_apply (snap-before-1)")).toBeDefined();
    expect(screen.getByText("变更方向:")).toBeDefined();
    expect(screen.getByText("Dev -> Prod")).toBeDefined();
    expect(screen.queryByRole("button", { name: "回滚此操作" })).toBeNull();
  });

  it("shows copyable failed apply error detail without direct rollback action", async () => {
    localStorage.setItem(
      "cs.operationHistory",
      JSON.stringify([
        {
          ...applyRecord,
          id: "apply-failed-1",
          result: "failure",
          error: "backup failed: disk full",
        },
      ])
    );

    render(
      <I18nProvider>
        <OperationHistoryView connections={[conn]} />
      </I18nProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: /app.yaml/ }));

    expect(screen.getByText("backup failed: disk full")).toBeDefined();
    expect(screen.getByRole("button", { name: "复制错误" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "回滚此操作" })).toBeNull();
  });

  it("starts a rollback dry-run from a successful apply record", async () => {
    localStorage.setItem("locale", "en-US");
    savedApplyPlan();
    localStorage.setItem("cs.operationHistory", JSON.stringify([followupApplyRecord()]));
    const { onStartApply } = renderHistory([devConn, sandboxConn, prodConn]);

    fireEvent.click(await screen.findByRole("button", { name: /app.yaml/ }));
    fireEvent.click(screen.getByRole("button", { name: "Generate rollback plan" }));

    await waitFor(() => {
      expect(onStartApply).toHaveBeenCalledTimes(1);
    });
    const payload = onStartApply.mock.calls[0][0];
    expect(payload).toMatchObject({
      sourceType: "rollback",
      source: { connectionId: "snapshot:snap-before-1" },
      target: { connectionId: sandboxConn.id },
      origin: { mode: "rollback", returnMode: "history" },
    });
  });

  // R55-A4：逐项写入「失败即停」，失败项之前的配置已经落到目标上了。
  // 过去整个后续面板只认成功记录，半截改动既看不到也没有出口。
  it("offers a backup-snapshot rollback for partially failed apply records", async () => {
    localStorage.setItem("locale", "en-US");
    savedApplyPlan();
    localStorage.setItem("cs.operationHistory", JSON.stringify([followupApplyRecord({ result: "failure", error: "boom on item 2" })]));
    const { onStartApply } = renderHistory([devConn, sandboxConn, prodConn]);

    fireEvent.click(await screen.findByRole("button", { name: /app.yaml/ }));

    // 说清「这次没跑完，已写入的还在目标上」
    expect(screen.getByText(/This run did not finish/)).toBeDefined();
    // 出口按现场齐不齐放，文案区别于成功记录的那条
    const rollbackButton = screen.getByRole("button", { name: "Roll back written items from the backup snapshot" });
    expect(rollbackButton).toBeDefined();
    fireEvent.click(rollbackButton);
    await waitFor(() => {
      expect(onStartApply).toHaveBeenCalledTimes(1);
    });
    expect(onStartApply.mock.calls[0][0]).toMatchObject({ sourceType: "rollback", source: { connectionId: "snapshot:snap-before-1" } });
  });

  it("keeps sandbox verification and promotion off partially failed apply records", async () => {
    localStorage.setItem("locale", "en-US");
    savedApplyPlan();
    localStorage.setItem("cs.operationHistory", JSON.stringify([followupApplyRecord({ result: "failure" })]));
    renderHistory([devConn, sandboxConn, prodConn]);

    fireEvent.click(await screen.findByRole("button", { name: /app.yaml/ }));

    // 回退留着，验证 / 晋级收掉——没跑成功的沙箱不配被标记为「已验证」。
    expect(screen.getByRole("button", { name: "Roll back written items from the backup snapshot" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Mark sandbox verified" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Promote to selected target" })).toBeNull();
    expect(screen.queryByLabelText("Production target")).toBeNull();
  });

  it("hides the follow-up panel when a failed record lacks a backup snapshot", async () => {
    localStorage.setItem("locale", "en-US");
    savedApplyPlan();
    localStorage.setItem("cs.operationHistory", JSON.stringify([followupApplyRecord({ result: "failure", backupSnapshotId: undefined })]));
    const { onStartApply } = renderHistory([devConn, sandboxConn, prodConn]);

    fireEvent.click(await screen.findByRole("button", { name: /app.yaml/ }));

    // 现场不齐就不放入口，免得点下去才收到一句「找不到备份快照」。
    expect(screen.queryByRole("button", { name: "Roll back written items from the backup snapshot" })).toBeNull();
    expect(screen.queryByText(/This run did not finish/)).toBeNull();
    expect(onStartApply).not.toHaveBeenCalled();
  });

  it("shows a copyable follow-up error when rollback plan data is missing", async () => {
    localStorage.setItem("locale", "en-US");
    localStorage.setItem("cs.operationHistory", JSON.stringify([followupApplyRecord({ planId: "missing-plan" })]));
    const { onStartApply } = renderHistory([devConn, sandboxConn, prodConn]);

    fireEvent.click(await screen.findByRole("button", { name: /app.yaml/ }));
    fireEvent.click(screen.getByRole("button", { name: "Generate rollback plan" }));

    await waitFor(() => {
      expect(screen.getByText("Configuration change plan missing-plan is missing.")).toBeDefined();
    });
    expect(screen.getByRole("button", { name: "Copy Error" })).toBeDefined();
    expect(onStartApply).not.toHaveBeenCalled();
  });

  it("keeps promotion disabled until the sandbox apply is manually verified", async () => {
    localStorage.setItem("locale", "en-US");
    savedApplyPlan();
    localStorage.setItem("cs.operationHistory", JSON.stringify([followupApplyRecord()]));
    renderHistory([devConn, sandboxConn, prodConn]);

    fireEvent.click(await screen.findByRole("button", { name: /app.yaml/ }));

    const promoteButton = screen.getByRole("button", { name: "Promote to selected target" }) as HTMLButtonElement;
    expect(promoteButton.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Mark sandbox verified" }));
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Promote to selected target" }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("starts a promote dry-run from a verified sandbox apply record", async () => {
    localStorage.setItem("locale", "en-US");
    savedApplyPlan();
    localStorage.setItem("cs.operationHistory", JSON.stringify([followupApplyRecord()]));
    nacosMocks.getConfigDocument.mockResolvedValue({
      content: "server:\n  port: 8080",
      format: "yaml",
      version: "sandbox-v2",
      source: "nacos",
      updateTime: "2026-07-06T02:00:00.000Z-sandbox-v2",
    });
    const { onStartApply } = renderHistory([devConn, sandboxConn, prodConn]);

    fireEvent.click(await screen.findByRole("button", { name: /app.yaml/ }));
    fireEvent.click(screen.getByRole("button", { name: "Mark sandbox verified" }));
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Promote to selected target" }) as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.change(screen.getByLabelText("Production target"), { target: { value: prodConn.id } });
    fireEvent.click(screen.getByRole("button", { name: "Promote to selected target" }));

    await waitFor(() => {
      expect(onStartApply).toHaveBeenCalledTimes(1);
    });
    const payload = onStartApply.mock.calls[0][0];
    expect(payload).toMatchObject({
      sourceType: "promote",
      source: { connectionId: sandboxConn.id },
      target: { connectionId: prodConn.id },
      origin: { mode: "promote", returnMode: "history" },
    });
  });

  it("does not call direct publish for legacy operation rollback records", async () => {
    localStorage.setItem("locale", "en-US");
    localStorage.setItem("cs.operationHistory", JSON.stringify([rollbackablePublishRecord]));

    render(
      <I18nProvider>
        <OperationHistoryView connections={[conn]} />
      </I18nProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: /app.yaml/ }));

    expect(screen.queryByRole("button", { name: "Rollback this operation" })).toBeNull();
    expect(nacosMocks.publishConfig).not.toHaveBeenCalled();
    expect(loadOperationHistory().filter((record) => record.type === "rollback")).toHaveLength(0);
  });
  it("切走再回来：连接/类型/dataId 筛选与选中记录都还在，且不再补拉中心历史（R27 + R55-E3）", async () => {
    localStorage.setItem(
      "cs.operationHistory",
      JSON.stringify([
        {
          id: "record-keepalive",
          type: "delete",
          result: "failure",
          timestamp: "2026-07-03T10:00:00Z",
          connectionId: "conn-1",
          connectionName: "prod",
          namespace: "public",
          group: "DEFAULT_GROUP",
          dataId: "app.yaml",
          error: "permission denied",
        },
      ])
    );

    const first = render(
      <I18nProvider>
        <OperationHistoryView connections={[conn]} />
      </I18nProvider>
    );
    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[0], { target: { value: "conn-1" } });
    fireEvent.change(selects[1], { target: { value: "delete" } });
    fireEvent.change(screen.getByPlaceholderText("输入 dataId 筛选"), { target: { value: "app" } });
    fireEvent.click(await screen.findByText("app.yaml"));
    expect(screen.getByText("permission denied")).toBeDefined();
    first.unmount();

    nacosMocks.listHistory.mockClear();
    const second = render(
      <I18nProvider>
        <OperationHistoryView connections={[conn]} />
      </I18nProvider>
    );

    expect((screen.getAllByRole("combobox")[0] as HTMLSelectElement).value).toBe("conn-1");
    expect((screen.getAllByRole("combobox")[1] as HTMLSelectElement).value).toBe("delete");
    expect((screen.getByPlaceholderText("输入 dataId 筛选") as HTMLInputElement).value).toBe("app");

    // R55-E3（真机取证）：命名空间级中心历史现有 provider 全都拿不到，闸门按能力关掉——
    // 记住的连接不再补拉请求，界面直接讲清去哪看版本级历史。
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(nacosMocks.listHistory).not.toHaveBeenCalled();
    expect(screen.getByText(translate("history.centerHistoryUnsupported"))).toBeDefined();

    // 连接数组换个引用也不该把请求捡回来（这条守卫正是当初假空的来源）
    act(() => {
      second.rerender(
        <I18nProvider>
          <OperationHistoryView connections={[{ ...conn }]} />
        </I18nProvider>
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(nacosMocks.listHistory).not.toHaveBeenCalled();

    expect(await screen.findByText("permission denied")).toBeDefined();
  });

  it("列表滚动位置写回并在重新挂载后恢复（R27）", async () => {
    localStorage.setItem(
      "cs.operationHistory",
      JSON.stringify([
        {
          id: "record-scroll-1",
          type: "publish",
          result: "success",
          timestamp: "2026-07-03T10:00:00Z",
          connectionId: "conn-1",
          connectionName: "prod",
          namespace: "public",
          group: "DEFAULT_GROUP",
          dataId: "app.yaml",
        },
      ])
    );

    const first = render(
      <I18nProvider>
        <OperationHistoryView connections={[conn]} />
      </I18nProvider>
    );
    const list = (await screen.findByText("app.yaml")).closest(".data-list") as HTMLElement;
    list.scrollTop = 260;
    fireEvent.scroll(list);
    expect(readViewState<number>("history.scroll.list")).toBe(260);
    first.unmount();

    // jsdom 无布局，挂载时不会把偏移夹回 0；夹回与二次恢复由 lib/viewState.test.tsx 的探针覆盖
    const second = render(
      <I18nProvider>
        <OperationHistoryView connections={[conn]} />
      </I18nProvider>
    );
    await screen.findByText("app.yaml");

    expect((second.container.querySelector(".data-list") as HTMLElement).scrollTop).toBe(260);
  });
});
