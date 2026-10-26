// @vitest-environment jsdom
/**
 * 变更计划第5步的晋级面板（轮76）。
 *
 * 这面板是「沙箱→生产」那条写路径的起点，所以用例盯三件事：
 * 回读没确认完不给盖章、晋级的范围与目标只能来自验证状态戳、以及全程一个写接口都不碰。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "../test/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { buildApplyPlan, type ApplyPlan, type BuildApplyPlanInput } from "../lib/applyPlan";
import type { Connection } from "../store/connections";
import { saveApplyPlan } from "../store/applyPlans";
import { loadApplyVerifications } from "../store/applyVerifications";
import type { OperationRecord } from "../store/operationHistory";
import PostApplyPromotionPanel from "./PostApplyPromotionPanel";

const nacosMocks = vi.hoisted(() => ({
  getConfigDocument: vi.fn(),
  listNamespaces: vi.fn(),
  publishConfig: vi.fn(),
  deleteConfig: vi.fn(),
}));

vi.mock("../api/nacos", async () => {
  const actual = await vi.importActual<typeof import("../api/nacos")>("../api/nacos");
  return {
    ...actual,
    getConfigDocument: nacosMocks.getConfigDocument,
    listNamespaces: nacosMocks.listNamespaces,
    publishConfig: nacosMocks.publishConfig,
    deleteConfig: nacosMocks.deleteConfig,
  };
});

vi.mock("../lib/toast", () => ({
  toast: vi.fn(),
}));

function connection(id: string, name: string, environmentName: string): Connection {
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

const devConn = connection("conn-dev", "Dev", "Development");
const sandboxConn = connection("conn-sandbox", "Sandbox", "Sandbox");
const prodConn = connection("conn-prod", "Production", "Production");
const allConnections = [devConn, sandboxConn, prodConn];

function endpoint(conn: Connection): BuildApplyPlanInput["source"] {
  return {
    envId: conn.id,
    label: `${conn.name} / public`,
    provider: conn.provider ?? "nacos",
    connectionId: conn.id,
    connectionName: conn.name,
    namespace: "public",
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

/** 沙箱那一趟用的计划：晋级的范围与 ref 都从它出发。 */
function sandboxPlan(dataIds: string[] = ["app.yaml"]): ApplyPlan {
  return buildApplyPlan({
    id: "plan-sandbox-1",
    createdAt: "2026-07-06T00:00:00.000Z",
    scope: "batch",
    source: endpoint(devConn),
    target: endpoint(sandboxConn),
    inputSummary: {
      sourceType: "diff",
      scope: "batch",
      sourceLabel: "Dev / public",
      targetLabel: "Sandbox / public",
      selectedCount: dataIds.length,
    },
    items: dataIds.map((dataId) => ({
      ref: {
        provider: "nacos",
        connectionId: sandboxConn.id,
        namespace: "public",
        group: "DEFAULT_GROUP",
        dataId,
        key: "__document",
      },
      sourceValue: planValue("server:\n  port: 8080"),
      targetValue: planValue("server:\n  port: 9090"),
    })),
  });
}

function applyRecord(overrides: Partial<OperationRecord> = {}): OperationRecord {
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
    planId: "plan-sandbox-1",
    backupSnapshotId: "snap-before-1",
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

function renderPanel(props: Partial<React.ComponentProps<typeof PostApplyPromotionPanel>> = {}) {
  const onStartApply = vi.fn();
  const record = props.record ?? applyRecord();
  render(
    <I18nProvider>
      <PostApplyPromotionPanel
        record={record}
        connections={allConnections}
        readbackConfirmed
        readbackUnconfirmedCount={0}
        onStartApply={onStartApply}
        {...props}
      />
    </I18nProvider>
  );
  return { onStartApply, record };
}

function promoteButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Promote using this verification" }) as HTMLButtonElement;
}

function markButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Mark sandbox verified" }) as HTMLButtonElement;
}

/** 目标集群上可读到的命名空间：public 既可能写作空串也可能写作 public，两种都要给一份。 */
function targetNamespaces() {
  return [
    { namespace: "", namespaceShowName: "public", configCount: 3, kind: 0 },
    { namespace: "tenant-a", namespaceShowName: "Tenant A", configCount: 1, kind: 1 },
  ];
}

/** 自绘下拉：点开触发器再按 option 的 mousedown（pick 挂在 mousedown 上）。 */
function pickTarget(name: string) {
  fireEvent.click(document.querySelector(".apply-promote-target .sel-trigger") as HTMLElement);
  fireEvent.mouseDown(screen.getByRole("option", { name }));
}

describe("PostApplyPromotionPanel", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("locale", "en-US");
    nacosMocks.getConfigDocument.mockReset();
    nacosMocks.publishConfig.mockReset();
    nacosMocks.deleteConfig.mockReset();
    nacosMocks.listNamespaces.mockReset();
    nacosMocks.listNamespaces.mockResolvedValue(targetNamespaces());
    nacosMocks.getConfigDocument.mockResolvedValue({
      content: "server:\n  port: 8080",
      format: "yaml",
      version: "sandbox-v2",
      source: "nacos",
      updateTime: "2026-07-06T02:00:00.000Z-sandbox-v2",
    });
    saveApplyPlan(sandboxPlan());
  });

  it("keeps verifying and promoting greyed out while the read-back still has unconfirmed items", () => {
    renderPanel({ readbackConfirmed: false, readbackUnconfirmedCount: 2 });

    // 回读还有 2 项没确认，这时候的「验证通过」是给假象盖章，两颗按钮都得灰着并说清原因。
    const mark = markButton();
    const promote = promoteButton();
    expect(mark.disabled).toBe(true);
    expect(promote.disabled).toBe(true);
    expect(mark.closest(".btn-guard")?.getAttribute("title")).toContain("2 items are still unconfirmed in the read-back");
    expect(promote.closest(".btn-guard")?.getAttribute("title")).toContain("2 items are still unconfirmed");

    // 灰掉不是装饰：点下去也不该去读沙箱现值、更不该产出入口。
    fireEvent.click(mark);
    fireEvent.click(promote);
    expect(nacosMocks.getConfigDocument).not.toHaveBeenCalled();
    // 两颗按钮都是真灰，不是「点了没反应」：验证状态仍是未验证。
    expect(screen.getByText("Not verified")).toBeInTheDocument();
  });

  it("promotes the verified sandbox run to the selected production target without touching any write api", async () => {
    const { onStartApply } = renderPanel();

    // 还没标记验证：目标可以选，但晋级不放行。
    expect(promoteButton().disabled).toBe(true);
    expect(promoteButton().closest(".btn-guard")?.getAttribute("title")).toContain("Mark the sandbox verified before promoting.");

    fireEvent.click(markButton());
    await waitFor(() => {
      expect(screen.getByText(/^Verified \(Sandbox/)).toBeInTheDocument();
    });
    expect(loadApplyVerifications().map((item) => item.applyHistoryId)).toEqual(["history-apply-1"]);

    // 面板自己不下任何写：标记只是读现值算指纹。
    expect(nacosMocks.publishConfig).not.toHaveBeenCalled();
    expect(nacosMocks.deleteConfig).not.toHaveBeenCalled();
    expect(onStartApply).not.toHaveBeenCalled();

    pickTarget("Production");
    await waitFor(() => expect(promoteButton().disabled).toBe(false));
    fireEvent.click(promoteButton());

    await waitFor(() => expect(onStartApply).toHaveBeenCalledTimes(1));
    const payload = onStartApply.mock.calls[0][0];
    expect(payload).toMatchObject({
      sourceType: "promote",
      source: { connectionId: sandboxConn.id },
      target: { connectionId: prodConn.id },
      origin: { mode: "promote", returnMode: "history" },
    });
    expect(payload.items.map((item: { connectionId: string; dataId: string }) => [item.connectionId, item.dataId])).toEqual([
      ["conn-prod", "app.yaml"],
    ]);
    expect(nacosMocks.publishConfig).not.toHaveBeenCalled();
    expect(nacosMocks.deleteConfig).not.toHaveBeenCalled();
  });

  it("defaults the production target to the connection that actually looks like production", () => {
    renderPanel();

    // 「Production target」这一栏默认指着谁，用户多半就直接晋级谁：默认必须是带生产标记的那条。
    expect(document.querySelector(".apply-promote-target .sel-value")?.textContent).toBe("Production");
    expect(document.querySelector(".apply-promote-target-note")).toBeNull();

    // 选到没有生产标记的连接时要把风险说出来，而不是让标题替它背书。
    pickTarget("Dev");
    const note = document.querySelector(".apply-promote-target-note");
    expect(note?.textContent).toContain("Dev");
    expect(note?.textContent).toContain("has no production marker");
  });

  it("refuses the sandbox as its own promotion target", () => {
    renderPanel();
    fireEvent.click(document.querySelector(".apply-promote-target .sel-trigger") as HTMLElement);
    const labels = [...document.querySelectorAll(".sel-menu .sel-option")].map((node) => node.textContent);
    expect(labels).toEqual(["Production", "Dev"]);
    expect(document.querySelector(".sel-menu .sel-option[aria-selected='true']")?.textContent).toBe("Production");
  });

  it("reports a copyable error when the sandbox plan is no longer on this machine", async () => {
    localStorage.removeItem("cs.applyPlans");
    renderPanel();

    fireEvent.click(markButton());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("plan-sandbox-1");
    expect(screen.getByRole("button", { name: "Copy Error" })).toBeInTheDocument();
    expect(loadApplyVerifications()).toHaveLength(0);
    expect(markButton().disabled).toBe(false);
  });
  /**
   * 生产命名空间这一栏（轮76 S31 真机量出来的洞）。
   *
   * 以前晋级把沙箱的 namespace id 原样盖到生产集群：Nacos/MSE 每套集群各发各的 id
   * （MSE 是 36 位 UUID），计划只会报「新建」，用户以为在覆盖生产配置，其实写进没人读的租户。
   * 现在这一栏把「落到哪套租户」变成用户点出来的事实，并且在读不到列表时不拦路、只说明。
   */
  describe("production namespace", () => {
    function namespaceValue(): string | undefined {
      return document.querySelector(".apply-promote-namespace .sel-value")?.textContent;
    }

    function namespaceNote(): Element | null {
      return document.querySelector(".apply-promote-namespace-note");
    }

    async function markVerifiedAndReadyToPromote() {
      fireEvent.click(markButton());
      await waitFor(() => {
        expect(screen.getByText(/^Verified \(Sandbox/)).toBeInTheDocument();
      });
      await waitFor(() => expect(promoteButton().disabled).toBe(false));
    }


    it("keeps the sandbox namespace by default and names it in the option label", async () => {
      const { onStartApply } = renderPanel();
      await markVerifiedAndReadyToPromote();

      // 沿用沙箱那个命名空间是默认口径，但必须写清楚沿用的是什么，不能只留一个空的下拉。
      expect(namespaceValue()).toContain("Keep the sandbox namespace (public)");
      expect(namespaceNote()).toBeNull();

      fireEvent.click(promoteButton());
      await waitFor(() => expect(onStartApply).toHaveBeenCalledTimes(1));
      expect(onStartApply.mock.calls[0][0].target.namespace).toBe("public");
    });

    it("says out loud when the sandbox namespace is not an existing one on the target", async () => {
      nacosMocks.listNamespaces.mockResolvedValue([
        { namespace: "tenant-a", namespaceShowName: "Tenant A", configCount: 1, kind: 1 },
      ]);
      const { onStartApply } = renderPanel();
      await markVerifiedAndReadyToPromote();

      await waitFor(() => expect(namespaceNote()).not.toBeNull());
      expect(namespaceNote()?.textContent).toContain("public isn't an existing namespace on Production");
      expect(namespaceNote()?.textContent).toContain("create it rather than overwrite");
      // 提醒只是提醒，不替用户扣住按钮：他可能就是要新建这个租户。
      expect(promoteButton().disabled).toBe(false);

      fireEvent.click(document.querySelector(".apply-promote-namespace .sel-trigger") as HTMLElement);
      fireEvent.mouseDown(screen.getByRole("option", { name: "Tenant A (tenant-a)" }));
      await waitFor(() => expect(namespaceNote()).toBeNull());

      fireEvent.click(promoteButton());
      await waitFor(() => expect(onStartApply).toHaveBeenCalledTimes(1));
      const payload = onStartApply.mock.calls[0][0];
      expect(payload.target).toMatchObject({ connectionId: prodConn.id, namespace: "tenant-a", label: "Production / tenant-a" });
      expect(payload.items[0].namespace).toBe("tenant-a");
      // 沙箱那侧的位置不能被生产命名空间带跑。
      expect(payload.items[0].sourceRef.namespace).toBe("public");
      expect(payload.source.namespace).toBe("public");
    });

    it("clears the chosen namespace when a different production target is picked", async () => {
      renderPanel();
      await markVerifiedAndReadyToPromote();

      fireEvent.click(document.querySelector(".apply-promote-namespace .sel-trigger") as HTMLElement);
      fireEvent.mouseDown(screen.getByRole("option", { name: "Tenant A (tenant-a)" }));
      await waitFor(() => expect(namespaceValue()).toContain("Tenant A (tenant-a)"));

      // 换一条连接就是换一套集群：上一套集群里挑的 namespace id 在这里毫无意义。
      pickTarget("Dev");
      await waitFor(() => expect(namespaceValue()).toContain("Keep the sandbox namespace (public)"));
      expect(nacosMocks.listNamespaces.mock.calls.map((call) => call[0].id)).toEqual(["conn-prod", "conn-dev"]);
    });

  it("lets public be picked for real instead of silently inheriting the sandbox one", async () => {
      // 沙箱那套租户在目标集群上不存在（tenant-sbx），目标集群自己只有 public 与 tenant-a。
      const { onStartApply } = renderPanel({ record: applyRecord({ targetNamespace: "tenant-sbx" }) });
      await markVerifiedAndReadyToPromote();
      await waitFor(() => expect(namespaceNote()).not.toBeNull());

      fireEvent.click(document.querySelector(".apply-promote-namespace .sel-trigger") as HTMLElement);
      const labels = [...document.querySelectorAll(".sel-menu .sel-option")].map((node) => node.textContent);
      // 公共空间的 id 是空串：括注上去就是「public ()」这种脏读数，留着等于把内部表示暴露给用户。
      expect(labels).toEqual(["Keep the sandbox namespace (tenant-sbx)", "public", "Tenant A (tenant-a)"]);
      fireEvent.mouseDown(screen.getByRole("option", { name: "public" }));
      await waitFor(() => expect(namespaceNote()).toBeNull());
      expect(namespaceValue()).toBe("public");

      fireEvent.click(promoteButton());
      await waitFor(() => expect(onStartApply).toHaveBeenCalledTimes(1));
      const payload = onStartApply.mock.calls[0][0];
      // 空串就是 Nacos 的公共空间，不能因为「空 = 没选」又退回沙箱那个 tenant-sbx。
      expect(payload.items[0].targetRef.namespace).toBe("");
      expect(payload.target.namespace).toBe("");
      expect(payload.target.label).toBe("Production / public");
      expect(payload.items[0].sourceRef.namespace).toBe("public");
    });

  it("still promotes when the namespace list cannot be read, and flags the guess", async () => {
      nacosMocks.listNamespaces.mockRejectedValue(new Error("boom"));
      const { onStartApply } = renderPanel();
      await markVerifiedAndReadyToPromote();

      await waitFor(() => expect(namespaceNote()).not.toBeNull());
      expect(namespaceNote()?.textContent).toContain("Couldn't list namespaces on Production");
      expect(namespaceNote()?.textContent).toContain("verify the target location in the plan");
      expect(promoteButton().disabled).toBe(false);

      fireEvent.click(promoteButton());
      await waitFor(() => expect(onStartApply).toHaveBeenCalledTimes(1));
      expect(onStartApply.mock.calls[0][0].target.namespace).toBe("public");
    });
  });
});
