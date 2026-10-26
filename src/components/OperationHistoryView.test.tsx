// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { buildApplyPlan, type BuildApplyPlanInput } from "../lib/applyPlan";
import { saveApplyPlan } from "../store/applyPlans";
import type { Connection } from "../store/connections";
import { loadOperationHistory, type OperationRecord } from "../store/operationHistory";
import { loadApplyVerifications } from "../store/applyVerifications";
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

function planRef(connection: Connection, dataId = "app.yaml"): BuildApplyPlanInput["items"][number]["ref"] {
  return {
    provider: connection.provider ?? "nacos",
    connectionId: connection.id,
    namespace: "public",
    group: "DEFAULT_GROUP",
    dataId,
    key: "__document",
  };
}

/** 备份快照本体：configs 就是本次执行写前的现场。 */
function beforeApplySnapshot(configs: ReturnType<typeof snapshotConfig>[]) {
  return {
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
    configs,
  };
}

/** 备份快照里的一项：写前目标内容。 */
function snapshotConfig(dataId: string) {
  return {
    namespace: "public",
    dataId,
    group: "DEFAULT_GROUP",
    content: "server:\n  port: 9090",
    configType: "text",
    updateTime: "2026-07-06T00:00:00.000Z",
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

function savedApplyPlan(dataIds: string[] = ["app.yaml"]) {
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
    items: dataIds.map((dataId) => ({
      ref: planRef(sandboxConn, dataId),
      sourceValue: planValue("server:\n  port: 8080"),
      targetValue: planValue("server:\n  port: 9090"),
    })),
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
  const view = render(
    <I18nProvider>
      <OperationHistoryView connections={connections} onStartApply={onStartApply} />
    </I18nProvider>
  );
  return { onStartApply, view };
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
    snapshotMocks.getSnapshot.mockResolvedValue(beforeApplySnapshot([snapshotConfig("app.yaml")]));
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

  // 轮72A：这条用例的口径翻了个面。以前它钉的是「遗留记录一律说不可回滚」，
  // 而那句恒 false 的死口径与下面真能点的按钮互相打脸。现在钉的是判据本身：
  // 有写前正文 + 目标可写 ⇒ 徽章「可回退」并放出计划入口；仍然没有任何直写按钮。
  it("routes legacy records with recorded previous content to a rollback plan", async () => {
    localStorage.setItem("locale", "en-US");
    localStorage.setItem("cs.operationHistory", JSON.stringify([rollbackablePublishRecord]));
    const { onStartApply } = renderHistory([conn]);

    fireEvent.click(await screen.findByRole("button", { name: /app.yaml/ }));

    expect(screen.getByText("1 records")).toBeDefined();
    // 详情徽章与行 chip 都叫「可回退」，这里只断言徽章（行 chip 由专门的用例覆盖）。
    const rollbackStateCell = document.querySelector(".history-rollback-state");
    expect(rollbackStateCell?.textContent).toBe("Rollbackable");
    expect(rollbackStateCell?.className).toContain("available");
    expect(screen.queryByText("Rollback requires a change-plan dry-run and cannot publish previous content directly.")).toBeNull();
    expect(screen.getByRole("button", { name: "Copy Record" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Rollback this operation" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Build a rollback plan from the recorded previous content" }));
    await waitFor(() => expect(onStartApply).toHaveBeenCalledTimes(1));
    const payload = onStartApply.mock.calls[0][0];
    expect(payload).toMatchObject({
      sourceType: "rollback",
      target: { connectionId: "conn-1" },
      // 从操作历史进来的，计划页「返回」要落回操作历史，而不是被扔到配置浏览
      origin: { mode: "rollback", returnMode: "history" },
    });
    expect(payload.items[0]).toMatchObject({ dataId: "app.yaml", sourceValueOverride: { exists: true, content: "old: true" } });
    expect(nacosMocks.publishConfig).not.toHaveBeenCalled();
  });

  it("does not offer rollback for a legacy record whose target is not writable", async () => {
    localStorage.setItem("locale", "en-US");
    localStorage.setItem("cs.operationHistory", JSON.stringify([rollbackablePublishRecord]));
    const readonlyConn: Connection = { ...conn, readonly: true };
    renderHistory([readonlyConn]);

    fireEvent.click(await screen.findByRole("button", { name: /app.yaml/ }));

    expect(screen.getByText("Not rollbackable")).toBeDefined();
    expect(screen.getByText("The target of this record is a non-writable source (local snapshot or read-only connection); rollback only goes through a change plan, so no entry is offered.")).toBeDefined();
    expect(screen.queryByRole("button", { name: /rollback plan/i })).toBeNull();
  });

  it("explains why an apply record whose plan is gone cannot roll back", async () => {
    localStorage.setItem("locale", "en-US");
    // 没有 saveApplyPlan()：计划快照已不在本机（只保留最近 100 份），记录还在
    localStorage.setItem("cs.operationHistory", JSON.stringify([followupApplyRecord()]));
    renderHistory([devConn, sandboxConn, prodConn]);

    fireEvent.click(await screen.findByRole("button", { name: /app.yaml/ }));

    expect(screen.getByText("Not rollbackable")).toBeDefined();
    expect(screen.getByText(/no longer keeps a snapshot of that change plan/)).toBeDefined();
    expect(screen.queryByRole("button", { name: /rollback/i })).toBeNull();
  });

  // 轮75 E1：批量写入的执行记录里根本没有正文（buildApplyOperationHistoryInput 不写 content），
  // 用户想知道「这次改了什么」只能先生成一份计划跳走看。详情里必须直接读出逐项 before/after。
  it("lists what this run actually wrote and opens the per-item diff", async () => {
    localStorage.setItem("locale", "en-US");
    savedApplyPlan(["app.yaml", "gateway.yaml"]);
    localStorage.setItem(
      "cs.operationHistory",
      JSON.stringify([
        followupApplyRecord({
          appliedLocations: [
            { namespace: "public", group: "DEFAULT_GROUP", dataId: "app.yaml", key: "__document" },
            { namespace: "public", group: "DEFAULT_GROUP", dataId: "gateway.yaml", key: "__document" },
          ],
        }),
      ])
    );
    renderHistory([devConn, sandboxConn, prodConn]);
    fireEvent.click(await screen.findByRole("button", { name: /app.yaml/ }));

    const panel = document.querySelector(".history-change-detail") as HTMLElement;
    expect(panel, "成功的 apply 记录没有给出「本次改动」这一节").toBeTruthy();
    expect(within(panel).getByText("This change")).toBeDefined();
    expect(within(panel).getByText(/2 item\(s\) written, 2 actually changed/)).toBeDefined();
    // 只列本次执行范围内的项，且每条都带位置与变化结论
    const rows = within(panel).getAllByRole("button", { name: /DEFAULT_GROUP/ });
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("app.yaml"),
      expect.stringContaining("gateway.yaml"),
    ]);

    fireEvent.click(rows[0]);
    const diff = panel.querySelector(".udiff") as HTMLElement;
    expect(diff, "展开某一项后没有渲染差异视图").toBeTruthy();
    expect(diff.textContent).toContain("port: 8080");
    expect(within(panel).getByText(/did not exist on target|already existed on target/)).toBeDefined();
  });

  it("filters the change list down to the items that really changed", async () => {
    localStorage.setItem("locale", "en-US");
    const plan = savedApplyPlan(["app.yaml", "gateway.yaml"]);
    // gateway.yaml 人工微调成正好等于目标：确实执行了覆盖写，但目标没变
    saveApplyPlan({
      ...plan,
      items: plan.items.map((item) => (item.ref.dataId === "gateway.yaml" ? { ...item, afterValue: item.targetValue } : item)),
    });
    localStorage.setItem(
      "cs.operationHistory",
      JSON.stringify([
        followupApplyRecord({
          appliedLocations: [
            { namespace: "public", group: "DEFAULT_GROUP", dataId: "app.yaml", key: "__document" },
            { namespace: "public", group: "DEFAULT_GROUP", dataId: "gateway.yaml", key: "__document" },
          ],
        }),
      ])
    );
    renderHistory([devConn, sandboxConn, prodConn]);
    fireEvent.click(await screen.findByRole("button", { name: /app.yaml/ }));

    const panel = document.querySelector(".history-change-detail") as HTMLElement;
    expect(within(panel).getByText(/2 item\(s\) written, 1 actually changed/)).toBeDefined();
    const toggle = within(panel).getByRole("checkbox");
    fireEvent.click(toggle);
    expect(within(panel).queryByText(/gateway\.yaml/)).toBeNull();
    expect(within(panel).getByText(/app\.yaml/)).toBeDefined();
  });

  // 失败记录的 appliedLocations 记的是**全部勾选项**而不是真正落笔的那几条
  // （applyPlanExecution.recordFailure 复用同一条构造），拿它当「本次改动」会把没写过的说成写了。
  it("keeps the change section off failed apply records", async () => {
    localStorage.setItem("locale", "en-US");
    savedApplyPlan(["app.yaml", "gateway.yaml"]);
    localStorage.setItem("cs.operationHistory", JSON.stringify([followupApplyRecord({ result: "failure" })]));
    renderHistory([devConn, sandboxConn, prodConn]);
    fireEvent.click(await screen.findByRole("button", { name: /app.yaml/ }));
    expect(await screen.findByText(/This run did not finish/)).toBeDefined();
    expect(document.querySelector(".history-change-detail")).toBeNull();
  });

  it("says the plan is gone instead of inventing an empty diff", async () => {
    localStorage.setItem("locale", "en-US");
    // 不调用 savedApplyPlan：记录还在，计划快照已被 100 份上限挤掉
    localStorage.setItem("cs.operationHistory", JSON.stringify([followupApplyRecord()]));
    renderHistory([devConn, sandboxConn, prodConn]);
    fireEvent.click(await screen.findByRole("button", { name: /app.yaml/ }));
    const panel = await waitFor(() => {
      const node = document.querySelector(".history-change-detail") as HTMLElement | null;
      expect(node).toBeTruthy();
      return node as HTMLElement;
    });
    expect(within(panel).getByText(/change plan is gone/)).toBeDefined();
    expect(panel.querySelector(".udiff")).toBeNull();
  });

  it("keeps centre-history rows on the single-content view instead of an empty change list", async () => {
    localStorage.setItem("locale", "en-US");
    localStorage.setItem(
      "cs.operationHistory",
      JSON.stringify([{ ...rollbackablePublishRecord, content: "server:\n  port: 8080" }])
    );
    renderHistory([conn]);
    fireEvent.click(await screen.findByRole("button", { name: /app.yaml/ }));
    // 没有计划的行（配置中心历史 / 遗留单条）不硬凑一节空的「本次改动」
    expect(document.querySelector(".history-change-detail")).toBeNull();
    expect(await screen.findByText(/port: 8080/)).toBeDefined();
  });

  it("marks rollbackable rows with a chip and filters the list by it", async () => {
    savedApplyPlan();
    localStorage.setItem(
      "cs.operationHistory",
      JSON.stringify([
        followupApplyRecord(),
        { ...rollbackablePublishRecord, id: "legacy-publish-1" },
        { ...rollbackablePublishRecord, id: "snapshot-1", type: "snapshot", dataId: "*", group: "*", rollbackReason: "operationHistory.rollbackSnapshotOnly" },
      ])
    );
    renderHistory([devConn, sandboxConn, prodConn, conn]);

    const rows = () => Array.from(document.querySelectorAll(".op-history-item"));
    const chipRows = () => rows().filter((row) => row.querySelector(".history-rollback-chip"));

    // apply（备份快照现场齐）与遗留 publish（有写前正文）各带一枚 chip；snapshot 行没有
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(chipRows()).toHaveLength(2);

    fireEvent.click(screen.getByRole("checkbox", { name: "只看可回退" }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(chipRows()).toHaveLength(2);
    // 关掉开关回到全量，筛选口径记在 viewState（与其余筛选项同一处）
    fireEvent.click(screen.getByRole("checkbox", { name: "只看可回退" }));
    await waitFor(() => expect(rows()).toHaveLength(3));
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

  // R66-WP9：planId 指向完整计划，执行时只勾一部分。回退入口必须只带本次执行的位置，
  // 否则没写过的配置在回退计划里判成删除，用户点下去就是删生产。
  it("narrows rollback to the locations recorded on the apply record", async () => {
    localStorage.setItem("locale", "en-US");
    savedApplyPlan(["app.yaml", "gateway.yaml"]);
    snapshotMocks.getSnapshot.mockResolvedValue(beforeApplySnapshot([snapshotConfig("app.yaml"), snapshotConfig("gateway.yaml")]));
    localStorage.setItem(
      "cs.operationHistory",
      JSON.stringify([followupApplyRecord({ appliedLocations: [{ namespace: "public", group: "DEFAULT_GROUP", dataId: "app.yaml", key: "__document" }] })])
    );
    const { onStartApply } = renderHistory([devConn, sandboxConn, prodConn]);

    fireEvent.click(await screen.findByRole("button", { name: /app.yaml/ }));
    fireEvent.click(screen.getByRole("button", { name: "Generate rollback plan" }));

    await waitFor(() => {
      expect(onStartApply).toHaveBeenCalledTimes(1);
    });
    expect(onStartApply.mock.calls[0][0].items.map((item: { dataId: string }) => item.dataId)).toEqual(["app.yaml"]);
  });

  it("narrows legacy rollback records to what the backup snapshot covers", async () => {
    localStorage.setItem("locale", "en-US");
    savedApplyPlan(["app.yaml", "gateway.yaml"]);
    localStorage.setItem("cs.operationHistory", JSON.stringify([followupApplyRecord()]));
    const { onStartApply } = renderHistory([devConn, sandboxConn, prodConn]);

    fireEvent.click(await screen.findByRole("button", { name: /app.yaml/ }));
    fireEvent.click(screen.getByRole("button", { name: "Generate rollback plan" }));

    await waitFor(() => {
      expect(onStartApply).toHaveBeenCalledTimes(1);
    });
    // 默认快照只覆盖了 app.yaml，gateway.yaml 没进备份 = 本次没动过，绝不能出现在回退计划里。
    expect(onStartApply.mock.calls[0][0].items.map((item: { dataId: string }) => item.dataId)).toEqual(["app.yaml"]);
  });

  it("refuses rollback when the backup snapshot covers nothing from the run", async () => {
    localStorage.setItem("locale", "en-US");
    savedApplyPlan(["app.yaml", "gateway.yaml"]);
    snapshotMocks.getSnapshot.mockResolvedValue(beforeApplySnapshot([]));
    localStorage.setItem("cs.operationHistory", JSON.stringify([followupApplyRecord()]));
    const { onStartApply } = renderHistory([devConn, sandboxConn, prodConn]);

    fireEvent.click(await screen.findByRole("button", { name: /app.yaml/ }));
    fireEvent.click(screen.getByRole("button", { name: "Generate rollback plan" }));

    const detail = await screen.findByRole("alert");
    expect(detail.textContent).toContain("snap-before-1");
    expect(onStartApply).not.toHaveBeenCalled();
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
    // 晋级入口已整块撤出历史页（轮76）：半截写入的记录连状态戳那一行都不该出现。
    expect(screen.queryByRole("button", { name: /Promote/ })).toBeNull();
    expect(screen.queryByText("Production target")).toBeNull();
    expect(screen.queryByText("Sandbox verification:")).toBeNull();
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

  it("shows a copyable follow-up error when the backup snapshot cannot be loaded", async () => {
    localStorage.setItem("locale", "en-US");
    // 计划还在本机（判定放行），但备份快照文件读不出来：这是入口放行后唯一剩下的失败面，
    // 必须仍然给出可复制的错误，而不是把用户丢给 toast 一闪而过。
    savedApplyPlan();
    snapshotMocks.getSnapshot.mockRejectedValue(new Error("snapshot file is gone"));
    localStorage.setItem("cs.operationHistory", JSON.stringify([followupApplyRecord()]));
    const { onStartApply } = renderHistory([devConn, sandboxConn, prodConn]);

    fireEvent.click(await screen.findByRole("button", { name: /app.yaml/ }));
    fireEvent.click(screen.getByRole("button", { name: "Generate rollback plan" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("snap-before-1");
    expect(alert.textContent).toContain("snapshot file is gone");
    expect(screen.getByRole("button", { name: "Copy Error" })).toBeDefined();
    expect(onStartApply).not.toHaveBeenCalled();
  });

  it("marks the sandbox verification on the record and never offers promotion here", async () => {
    localStorage.setItem("locale", "en-US");
    savedApplyPlan();
    localStorage.setItem("cs.operationHistory", JSON.stringify([followupApplyRecord()]));
    const { onStartApply } = renderHistory([devConn, sandboxConn, prodConn]);

    fireEvent.click(await screen.findByRole("button", { name: /app.yaml/ }));

    // 历史页只剩「验过没有」这一行只读读数，没标记时是不带目标名的未验证。
    expect(screen.getByText("Sandbox verification:")).toBeDefined();
    expect(screen.getByText("Not verified")).toBeDefined();
    // 选目标 + 晋级整块搬去变更计划第5步：这里连按钮带选择器都不该有，只留一句去处提示。
    expect(screen.queryByRole("button", { name: /Promote/ })).toBeNull();
    expect(screen.queryByText("Production target")).toBeNull();
    expect(screen.getByText(/Promotion lives in step 5/)).toBeDefined();
    expect(onStartApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Mark sandbox verified" }));
    await waitFor(() => {
      expect(screen.getByText(/^Verified \(Sandbox/)).toBeDefined();
    });

    // 标记只是一枚本地状态戳：不产生写操作入口，也不碰目标中心。
    expect(onStartApply).not.toHaveBeenCalled();
    expect(nacosMocks.publishConfig).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Promote/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Re-mark sandbox verified" })).toBeDefined();
    expect(loadApplyVerifications().map((item) => item.applyHistoryId)).toEqual(["history-apply-1"]);
  });

  it("keeps the verification stamp across remounts because it lives in the store", async () => {
    localStorage.setItem("locale", "en-US");
    savedApplyPlan();
    localStorage.setItem("cs.operationHistory", JSON.stringify([followupApplyRecord()]));
    const { view } = renderHistory([devConn, sandboxConn, prodConn]);

    fireEvent.click(await screen.findByRole("button", { name: /app.yaml/ }));
    fireEvent.click(screen.getByRole("button", { name: "Mark sandbox verified" }));
    await waitFor(() => {
      expect(screen.getByText(/^Verified \(Sandbox/)).toBeDefined();
    });

    // 状态戳落在 store，不在组件内存里：整页卸载重挂（切页保活/重开应用）后读数必须还在，
    // 否则会误导用户以为沙箱没核对过，再标记一次覆盖掉当时的指纹。
    expect(loadApplyVerifications()).toHaveLength(1);
    view.unmount();
    cleanup();
    renderHistory([devConn, sandboxConn, prodConn]);
    // 选中的记录本身也走记忆态，重挂后详情就展开着，不用再去点行。
    const stamp = await screen.findByText(/^Verified \(Sandbox/);
    expect(stamp.textContent).toContain("Sandbox");
    expect(screen.getByRole("button", { name: "Re-mark sandbox verified" })).toBeDefined();
    expect(loadApplyVerifications()).toHaveLength(1);
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

  // 轮66 WP-2：变更计划页半截写入后跳到这页，必须落在本次记录上。
  // 旧行为是「跳过来了，列表还被上次的筛选挡着」，用户读到的是空列表，以为记录丢了。
  it("带着记录 id 跳进来时点亮本次记录，并只解挡路的那几项筛选", async () => {
    localStorage.setItem(
      "cs.operationHistory",
      JSON.stringify([
        {
          id: "apply-fail-1",
          type: "apply",
          result: "failure",
          timestamp: "2026-07-06T12:00:00Z",
          connectionId: sandboxConn.id,
          connectionName: sandboxConn.name,
          namespace: "public",
          group: "DEFAULT_GROUP",
          dataId: "app.yaml",
          planId: "plan-apply-1",
          backupSnapshotId: "snap-before-1",
          backupSnapshotName: "before apply",
          error: "Nacos returned 500",
          rollbackable: false,
        },
        {
          id: "publish-other",
          type: "publish",
          result: "success",
          timestamp: "2026-07-05T10:00:00Z",
          connectionId: devConn.id,
          connectionName: devConn.name,
          namespace: "public",
          group: "DEFAULT_GROUP",
          dataId: "other.yaml",
        },
      ])
    );

    // 先记住一组恰好把目标记录挡掉的筛选（连接筛到 Dev + dataId 筛 other），模拟用户上次留下的口径
    const first = render(
      <I18nProvider>
        <OperationHistoryView connections={[devConn, sandboxConn]} />
      </I18nProvider>
    );
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: devConn.id } });
    fireEvent.change(screen.getByPlaceholderText("输入 dataId 筛选"), { target: { value: "other" } });
    first.unmount();

    const onFocusConsumed = vi.fn();
    render(
      <I18nProvider>
        <OperationHistoryView
          connections={[devConn, sandboxConn]}
          focusRecordId="apply-fail-1"
          onFocusConsumed={onFocusConsumed}
        />
      </I18nProvider>
    );

    // 详情面板就是本次记录：错误原文得在屏上，用户才知道失败原因去哪儿复核
    expect(await screen.findByText("Nacos returned 500")).toBeDefined();
    const row = document.querySelector('[data-record-id="apply-fail-1"]');
    expect(row).not.toBeNull();
    expect(row?.className).toContain("active");
    // 只解挡路的两项：连接回到「全部」、dataId 清空；没设过的类型筛选不该被动
    expect((screen.getAllByRole("combobox")[0] as HTMLSelectElement).value).toBe("");
    expect((screen.getAllByRole("combobox")[1] as HTMLSelectElement).value).toBe("");
    expect((screen.getByPlaceholderText("输入 dataId 筛选") as HTMLInputElement).value).toBe("");
    await waitFor(() => expect(onFocusConsumed).toHaveBeenCalledTimes(1));
  });

  it("带着的记录 id 在本地历史里找不到时说明原因并消费掉请求", async () => {
    localStorage.setItem(
      "cs.operationHistory",
      JSON.stringify([
        {
          id: "publish-keep",
          type: "publish",
          result: "success",
          timestamp: "2026-07-05T10:00:00Z",
          connectionId: devConn.id,
          connectionName: devConn.name,
          namespace: "public",
          group: "DEFAULT_GROUP",
          dataId: "other.yaml",
        },
      ])
    );

    const onFocusConsumed = vi.fn();
    render(
      <I18nProvider>
        <OperationHistoryView connections={[devConn]} focusRecordId="ghost-record" onFocusConsumed={onFocusConsumed} />
      </I18nProvider>
    );

    expect(await screen.findByText(translate("operationHistory.focusRecordMissing", { id: "ghost-record" }))).toBeDefined();
    // 说明只在本次跳转有效：消费后不留在页面上反复提示，也不该把别的记录选中
    await waitFor(() => expect(onFocusConsumed).toHaveBeenCalledTimes(1));
    expect((screen.getAllByRole("combobox")[1] as HTMLSelectElement).value).toBe("");
  });

  it("没带记录 id 时不碰任何筛选（普通进页面不该被拽走口径）", async () => {
    localStorage.setItem(
      "cs.operationHistory",
      JSON.stringify([
        {
          id: "publish-keep2",
          type: "publish",
          result: "success",
          timestamp: "2026-07-05T10:00:00Z",
          connectionId: devConn.id,
          connectionName: devConn.name,
          namespace: "public",
          group: "DEFAULT_GROUP",
          dataId: "other.yaml",
        },
      ])
    );
    const first = render(
      <I18nProvider>
        <OperationHistoryView connections={[devConn, sandboxConn]} />
      </I18nProvider>
    );
    fireEvent.change(screen.getAllByRole("combobox")[1], { target: { value: "publish" } });
    first.unmount();

    render(
      <I18nProvider>
        <OperationHistoryView connections={[devConn, sandboxConn]} focusRecordId={null} />
      </I18nProvider>
    );
    expect(await screen.findByText("other.yaml")).toBeDefined();
    expect((screen.getAllByRole("combobox")[1] as HTMLSelectElement).value).toBe("publish");
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
