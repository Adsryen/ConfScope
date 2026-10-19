/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import type { Connection } from "../store/connections";
import DiffView from "./DiffView";
import { listAllConfigsBridge } from "../test/listAllConfigsBridge";
import { __clearWheelSurfacesForTest } from "../lib/wheelScroll";
import { publishConfigChange } from "../lib/configChangeBus";

const apiMocks = vi.hoisted(() => ({
  listNamespaces: vi.fn(),
  listConfigs: vi.fn(),
  listAllConfigs: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock("../api/nacos", async () => {
  const actual = await vi.importActual<typeof import("../api/nacos")>("../api/nacos");
  return {
    ...actual,
    listNamespaces: apiMocks.listNamespaces,
    listConfigs: apiMocks.listConfigs,
    listAllConfigs: apiMocks.listAllConfigs,
    getConfig: apiMocks.getConfig,
  };
});

const nacosConn: Connection = {
  id: "dev-nacos",
  name: "dev",
  projectName: "订单系统",
  environmentName: "开发",
  sourceName: "云上内网",
  sourceType: "nacos",
  provider: "nacos",
  distribution: "opensource",
  authType: "nacos-password",
  baseUrl: "http://dev.example.com/nacos",
  username: "nacos",
  password: "secret",
  defaultNamespace: "dev-tenant",
  defaultGroup: "RETEST-PROD",
};

const snapshotConn: Connection = {
  ...nacosConn,
  id: "dev-snapshot",
  name: "dev-local",
  sourceName: "本地快照",
  sourceType: "local-snapshot",
  localPath: "C:\\backup\\dev",
  baseUrl: "C:\\backup\\dev",
  username: "",
  password: "",
  defaultNamespace: "",
};

const prodConn: Connection = {
  ...nacosConn,
  id: "prod-nacos",
  name: "prod",
  environmentName: "生产",
  sourceName: "云上公网",
  baseUrl: "http://prod.example.com/nacos",
  defaultNamespace: "prod-tenant",
};

const otherProjectConn: Connection = {
  ...nacosConn,
  id: "other-nacos",
  projectName: "支付系统",
  environmentName: "开发",
  sourceName: "支付内网",
  baseUrl: "http://pay.example.com/nacos",
};

const leftApplyConn: Connection = {
  ...nacosConn,
  id: "left-nacos",
  name: "dev",
  projectName: "Order",
  environmentName: "Development",
  sourceName: "LAN",
  defaultNamespace: "shared",
};

const rightApplyConn: Connection = {
  ...prodConn,
  id: "right-nacos",
  name: "prod",
  projectName: "Order",
  environmentName: "Production",
  sourceName: "Cloud",
  defaultNamespace: "shared",
};

function renderDiff(connections: Connection[], onConnectionsChange?: (connections: Connection[]) => void) {
  localStorage.setItem("locale", "zh-CN");
  return render(
    <I18nProvider>
      <DiffView connections={connections} onConnectionsChange={onConnectionsChange} />
    </I18nProvider>
  );
}

describe("DiffView", () => {
  beforeEach(() => {
    localStorage.clear();
    apiMocks.listNamespaces.mockReset();
    apiMocks.listConfigs.mockReset();
    apiMocks.listAllConfigs.mockReset();
    apiMocks.getConfig.mockReset();
    // 组件已改用 listAllConfigs 聚合翻页：默认用单页 mock 桥接，保持既有分页夹具可用
    apiMocks.listAllConfigs.mockImplementation(listAllConfigsBridge(apiMocks.listConfigs));
    apiMocks.listNamespaces.mockResolvedValue([{ namespace: "dev-tenant", namespaceShowName: "开发命名空间", configCount: 1, kind: 0 }]);
    apiMocks.listConfigs.mockResolvedValue({
      totalCount: 1,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [{ dataId: "app.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" }],
    });
  });

  it("explains the safe compare-to-change workflow before comparing", () => {
    localStorage.setItem("locale", "en-US");
    render(
      <I18nProvider>
        <DiffView connections={[leftApplyConn, rightApplyConn]} />
      </I18nProvider>
    );

    // 顶栏极简进度条：五步 + 当前高亮，不可点击（进度指示不与 tab 语义混淆）
    const workflow = screen.getByRole("navigation", { name: "Configuration compare workflow" });
    expect(workflow.querySelectorAll(".diff-workflow-step")).toHaveLength(5);
    const direction = screen.getByLabelText("Apply direction");
    expect(direction.querySelector(".diff-source-direction-label")).not.toBeInTheDocument();
    // 应用方向箭头是一个可点击的按钮：对比完成前点击只提示先加载
    expect(direction).toBeInstanceOf(HTMLButtonElement);
    expect(direction).toHaveTextContent("→");
    expect(screen.getByText("Confirm direction")).toBeInTheDocument();
    expect(screen.getByText("Select changes")).toBeInTheDocument();
    expect(screen.getByText("Execute, verify, and promote")).toBeInTheDocument();
    const currentStep = document.querySelector(".diff-workflow-step.current");
    expect(currentStep).toHaveAttribute("aria-current", "step");
    expect(currentStep).toHaveTextContent("Confirm direction");
    expect(currentStep?.querySelector("button")).not.toBeInTheDocument();
    // 每步 hover 气泡展示「步骤名: 步骤说明」（stepper 仅回退，无前进锁定气泡）
    const currentStepEl = document.querySelector(".diff-workflow-step.current") as HTMLElement;
    expect(currentStepEl).toHaveAttribute("title", expect.stringContaining("safer trial path"));
    const planStep = screen.getByText("Generate & review plan (dry-run, no writes)").closest("li");
    expect(planStep).toHaveAttribute("title", expect.stringContaining("the right-side target is NOT modified at this point"));
    expect(screen.getByText(/To use a sandbox/)).toBeInTheDocument();
  });

  it("stepper navigation: only back steps are clickable; forward goes through page actions", async () => {
    const onStartApply = vi.fn();
    apiMocks.getConfig.mockImplementation(async (conn: Connection) =>
      conn.id === "left-nacos" ? "server:\n  port: 8080" : "server:\n  port: 9090"
    );
    localStorage.setItem("locale", "en-US");
    render(
      <I18nProvider>
        <DiffView
          connections={[leftApplyConn, rightApplyConn]}
          initialParams={{
            leftConnId: "left-nacos",
            rightConnId: "right-nacos",
            left: { tenant: "shared", group: "DEFAULT_GROUP", dataId: "app.yaml" },
            right: { tenant: "shared", group: "DEFAULT_GROUP", dataId: "app.yaml" },
          }}
          onStartApply={onStartApply}
        />
      </I18nProvider>
    );

    const stepEls = () => Array.from(document.querySelectorAll(".diff-workflow-step")) as HTMLElement[];
    // choose 状态：没有更早的步骤 → 整个 stepper 不可点（前进走页面内「加载并对比」按钮）
    let steps = stepEls();
    expect(steps).toHaveLength(5);
    for (const stepEl of steps) {
      expect(stepEl.querySelector("button")).not.toBeInTheDocument();
    }
    // hover 气泡：每步展示「步骤名: 步骤说明」
    expect(steps[1]).toHaveAttribute("title", expect.stringContaining("Click Load & Compare"));
    expect(steps[4]).toHaveAttribute("title", expect.stringContaining("After sandbox verification"));

    // 前进 = 点页面内操作按钮（stepper 不提供前进入口）
    fireEvent.click(screen.getByRole("button", { name: "Load & Compare" }));
    expect(await screen.findByText("8080")).toBeInTheDocument();

    // plan 状态：第 1/2 步可点（回退）；当前步 3 与后续步 4/5 不可点
    steps = stepEls();
    expect(steps[0].querySelector("button")).toBeInTheDocument();
    expect(steps[1].querySelector("button")).toBeInTheDocument();
    expect(steps[1]).toHaveAttribute("title", expect.stringContaining("Back to"));
    expect(steps[2].querySelector("button")).not.toBeInTheDocument();
    expect(steps[3].querySelector("button")).not.toBeInTheDocument();
    expect(steps[4].querySelector("button")).not.toBeInTheDocument();
    expect(steps[3].classList.contains("locked")).toBe(true);
    expect(steps[4].classList.contains("locked")).toBe(true);

    // 回退到第 2 步：滚动到对比结果区 + 目标区闪烁高亮，不触发任何计划动作
    fireEvent.click(steps[1].querySelector("button")!);
    expect(onStartApply).not.toHaveBeenCalled();
    const resultEl = document.querySelector(".diff-result") as HTMLElement;
    expect(resultEl.classList.contains("workflow-flash")).toBe(true);

    // 回退到第 1 步：来源面板闪烁高亮（来源面板保持展开）
    steps = stepEls();
    fireEvent.click(steps[0].querySelector("button")!);
    expect(onStartApply).not.toHaveBeenCalled();
    const sourcesEl = document.querySelector(".diff-sources") as HTMLElement;
    expect(sourcesEl.classList.contains("workflow-flash")).toBe(true);
    expect(document.querySelector(".diff-source-panel")?.classList.contains("collapsed")).toBe(false);
  });

  it("stepper back navigation: consumes focusStep hint from plan page", () => {
    const onFocusStepConsumed = vi.fn();
    localStorage.setItem("locale", "en-US");
    render(
      <I18nProvider>
        <DiffView
          connections={[leftApplyConn, rightApplyConn]}
          initialParams={{
            leftConnId: "left-nacos",
            rightConnId: "right-nacos",
            left: { tenant: "shared", group: "DEFAULT_GROUP", dataId: "app.yaml" },
            right: { tenant: "shared", group: "DEFAULT_GROUP", dataId: "app.yaml" },
          }}
          focusStep="choose"
          onFocusStepConsumed={onFocusStepConsumed}
        />
      </I18nProvider>
    );
    expect(onFocusStepConsumed).toHaveBeenCalledTimes(1);
  });

  it("候选 dataId 按 pagesAvailable 聚合翻页取全，而不是只取首页", async () => {
    apiMocks.listConfigs.mockImplementation(
      async (_conn: Connection, _tenant: string, _dataId: string, _group: string, pageNo: number) => ({
        totalCount: 1,
        pageNumber: pageNo,
        pagesAvailable: 3,
        pageItems: [{ dataId: `app-${pageNo}.yaml`, group: "RETEST-PROD", content: "", configType: "yaml" }],
      })
    );

    renderDiff([nacosConn]);

    await waitFor(() => {
      expect(apiMocks.listConfigs).toHaveBeenCalledWith(nacosConn, "dev-tenant", "", "", 3, 1000);
    });
    // 两侧来源面板都拿到了 3 页各 1 条（单页夹具只会得到 1 条）
    // 波23：计数后缀拆进了带 aria-live 的内层 span（读屏要能播报加载状态），
    // 字段名与计数不再是同一个文本节点，所以按整段 textContent 判定而不是单节点文本。
    const dataIdLabels = await screen.findAllByText((_content, element) => /^dataId \(3\)$/.test((element?.textContent ?? "").trim()), {
      selector: "span",
    });
    expect(dataIdLabels).toHaveLength(2);
  });

  it("候选列表命中安全上限时显示截断提示并可复制", async () => {
    apiMocks.listAllConfigs.mockImplementation(async () => ({
      items: Array.from({ length: 5 }, (_, index) => ({
        dataId: `app-${index}.yaml`,
        group: "DEFAULT_GROUP",
        content: "",
        configType: "yaml",
      })),
      pagesAvailable: 40,
      loadedPages: 5,
      failedPages: [],
      truncated: true,
    }));

    renderDiff([nacosConn]);

    const warnings = await screen.findAllByText("命名空间条目超过扫描上限，仅取到前 5 条，结果可能不完整");
    expect(warnings).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "复制错误" }).length).toBeGreaterThanOrEqual(2);
  });

  it("批量对比任一侧列表不完整时在结果区提示", async () => {
    apiMocks.listAllConfigs.mockImplementation(async (conn: Connection) => ({
      items: [
        { dataId: "app.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
        { dataId: "pay.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
      ],
      pagesAvailable: conn.id === "left-nacos" ? 20 : 12,
      loadedPages: 10,
      failedPages: conn.id === "left-nacos" ? [] : [7],
      truncated: conn.id === "left-nacos",
    }));
    apiMocks.getConfig.mockImplementation(async () => "server.port=8080");
    localStorage.setItem("locale", "zh-CN");

    render(
      <I18nProvider>
        <DiffView
          connections={[leftApplyConn, rightApplyConn]}
          initialParams={{
            leftConnId: "left-nacos",
            rightConnId: "right-nacos",
            left: { tenant: "shared", group: "DEFAULT_GROUP", dataId: "" },
            right: { tenant: "shared", group: "DEFAULT_GROUP", dataId: "" },
            autoCompare: true,
          }}
        />
      </I18nProvider>
    );

    const warnings = await screen.findAllByText(/结果可能不完整|结果不完整/);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("来源（左）: 命名空间条目超过扫描上限，仅取到前 2 条，结果可能不完整")).toBeInTheDocument();
    expect(screen.getByText("目标（右）: 配置列表第 7 页加载失败，仅取到 2 条，结果不完整")).toBeInTheDocument();
  });

  it("restores the last compared sources and mode from localStorage", async () => {
    localStorage.setItem(
      "cs.diffViewPreferences",
      JSON.stringify({
        selectedProject: "订单系统",
        left: { connId: "prod-nacos", tenant: "prod-tenant", dataId: "app.yaml", group: "DEFAULT_GROUP", usesDefaultNamespace: false },
        right: { connId: "dev-nacos", tenant: "dev-tenant", dataId: "app.yaml", group: "DEFAULT_GROUP", usesDefaultNamespace: false },
        mode: "key",
      })
    );

    renderDiff([nacosConn, prodConn]);

    await waitFor(() => {
      expect(apiMocks.listConfigs).toHaveBeenCalledWith(prodConn, "prod-tenant", "", "", 1, 1000);
      expect(apiMocks.listConfigs).toHaveBeenCalledWith(nacosConn, "dev-tenant", "", "", 1, 1000);
    });
    expect(screen.getAllByDisplayValue("app.yaml").length).toBeGreaterThanOrEqual(2);
  });

  it("uses the connection default namespace when loading config candidates", async () => {
    renderDiff([nacosConn]);

    await waitFor(() => {
      expect(apiMocks.listConfigs).toHaveBeenCalledWith(nacosConn, "dev-tenant", "", "", 1, 1000);
    });
  });

  it("persists the changed compare sources back to localStorage", async () => {
    renderDiff([nacosConn, prodConn]);

    await screen.findAllByText("开发");
    const environmentButtons = screen.getAllByRole("button").filter((button) => button.textContent?.includes("开发"));
    fireEvent.pointerDown(environmentButtons[0]);
    fireEvent.mouseDown(await screen.findByText("生产"));

    await waitFor(() => {
      const preferences = JSON.parse(localStorage.getItem("cs.diffViewPreferences") || "{}");
      expect(preferences.selectedProject).toBe("订单系统");
      expect(preferences.left.connId).toBe("prod-nacos");
      expect(preferences.left.tenant).toBe("prod-tenant");
    });
  });

  it("filters smart-compare source choices by the selected project and highlights environments", async () => {
    renderDiff([nacosConn, prodConn, otherProjectConn]);

    await screen.findAllByText("开发");
    expect(screen.getAllByText("订单系统").length).toBeGreaterThan(0);
    expect(screen.queryByText("支付内网")).not.toBeInTheDocument();
    expect(screen.getAllByText("开发").length).toBeGreaterThan(0);

    const environmentButtons = screen.getAllByRole("button").filter((button) => button.textContent?.includes("开发"));
    fireEvent.pointerDown(environmentButtons[0]);
    fireEvent.mouseDown(await screen.findByText("生产"));

    expect(await screen.findAllByText("生产")).not.toHaveLength(0);
    expect(screen.getAllByText((text) => text.includes("云上公网")).length).toBeGreaterThan(0);
    expect(document.querySelector(".env-prod")).toBeInTheDocument();

    const projectButtons = screen.getAllByRole("button").filter((button) => button.textContent?.includes("订单系统"));
    fireEvent.pointerDown(projectButtons[0]);
    fireEvent.mouseDown(await screen.findByText("支付系统"));

    await waitFor(() => {
      expect(apiMocks.listConfigs).toHaveBeenCalledWith(otherProjectConn, "dev-tenant", "", "", 1, 1000);
    });
    expect(screen.getAllByText((text) => text.includes("支付内网")).length).toBeGreaterThan(0);
    expect(screen.queryByText((text) => text.includes("云上公网"))).not.toBeInTheDocument();
  });

  it("syncs the default namespace when the connection config changes", async () => {
    const initialConn = { ...nacosConn, defaultNamespace: "" };
    const nextConn = { ...nacosConn, defaultNamespace: "dev-tenant" };
    const view = renderDiff([initialConn]);

    await waitFor(() => {
      expect(apiMocks.listConfigs).toHaveBeenCalledWith(initialConn, "", "", "", 1, 1000);
    });

    view.rerender(
      <I18nProvider>
        <DiffView connections={[nextConn]} />
      </I18nProvider>
    );

    await waitFor(() => {
      expect(apiMocks.listConfigs).toHaveBeenCalledWith(nextConn, "dev-tenant", "", "", 1, 1000);
    });
  });

  it("keeps a manually selected namespace when the connection default changes", async () => {
    apiMocks.listNamespaces.mockResolvedValue([
      { namespace: "dev-tenant", namespaceShowName: "开发命名空间", configCount: 1, kind: 0 },
      { namespace: "prod-tenant", namespaceShowName: "生产命名空间", configCount: 1, kind: 0 },
    ]);

    const view = renderDiff([nacosConn]);

    await screen.findAllByText("开发命名空间");
    const namespaceButtons = screen.getAllByRole("button").filter((button) => button.textContent?.includes("开发命名空间"));
    fireEvent.pointerDown(namespaceButtons[0]);
    fireEvent.mouseDown(await screen.findByText("生产命名空间"));

    await waitFor(() => {
      expect(apiMocks.listConfigs).toHaveBeenCalledWith(nacosConn, "prod-tenant", "", "", 1, 1000);
    });

    const nextConn = { ...nacosConn, defaultNamespace: "qa-tenant" };
    view.rerender(
      <I18nProvider>
        <DiffView connections={[nextConn]} />
      </I18nProvider>
    );

    await waitFor(() => {
      expect(apiMocks.listConfigs).toHaveBeenCalledWith(nextConn, "prod-tenant", "", "", 1, 1000);
    });
  });

  it("sets the selected namespace as the connection default from smart compare", async () => {
    apiMocks.listNamespaces.mockResolvedValue([
      { namespace: "dev-tenant", namespaceShowName: "开发命名空间", configCount: 1, kind: 0 },
      { namespace: "prod-tenant", namespaceShowName: "生产命名空间", configCount: 1, kind: 0 },
    ]);
    localStorage.setItem("cs.connections", JSON.stringify([nacosConn]));
    const onConnectionsChange = vi.fn();

    renderDiff([nacosConn], onConnectionsChange);

    await screen.findAllByText("开发命名空间");
    const namespaceButtons = screen.getAllByRole("button").filter((button) => button.textContent?.includes("开发命名空间"));
    fireEvent.pointerDown(namespaceButtons[0]);
    fireEvent.mouseDown(await screen.findByText("生产命名空间"));

    await waitFor(() => {
      expect(apiMocks.listConfigs).toHaveBeenCalledWith(nacosConn, "prod-tenant", "", "", 1, 1000);
    });

    fireEvent.click(screen.getAllByRole("button", { name: "设为默认" })[0]);

    expect(await screen.findByText("已设为默认命名空间")).toBeInTheDocument();
    expect(onConnectionsChange).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "dev-nacos",
        defaultNamespace: "prod-tenant",
      }),
    ]);
  });

  it("shows namespace load failures instead of silently clearing the selector", async () => {
    apiMocks.listNamespaces.mockRejectedValue(new Error("connect timeout"));

    renderDiff([nacosConn]);

    await waitFor(() => {
      expect(screen.getAllByText(/命名空间加载失败: connect timeout/)).toHaveLength(2);
    });
  });

  it("keeps the selected source and retries config-list loading in place", async () => {
    apiMocks.listConfigs
      .mockRejectedValueOnce(new Error("EOF"))
      .mockRejectedValueOnce(new Error("EOF"))
      .mockResolvedValue({
        totalCount: 1,
        pageNumber: 1,
        pagesAvailable: 1,
        pageItems: [{ dataId: "retry.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" }],
      });

    renderDiff([nacosConn]);

    await waitFor(() => {
      expect(screen.getAllByText(/配置列表加载失败: EOF/)).toHaveLength(2);
    });

    fireEvent.click(screen.getAllByRole("button", { name: "重试配置列表" })[0]);

    await waitFor(() => {
      expect(apiMocks.listConfigs).toHaveBeenCalledTimes(3);
    });
    expect(screen.getAllByText(/配置列表加载失败: EOF/)).toHaveLength(1);
    expect(screen.getAllByRole("button").some((button) => button.textContent?.includes("云上内网"))).toBe(true);
  });

  it("collapses compare sources after matching and allows expanding them again", async () => {
    apiMocks.listConfigs.mockResolvedValue({
      totalCount: 2,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [
        { dataId: "app.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
        { dataId: "gateway.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
      ],
    });

    renderDiff([nacosConn]);

    fireEvent.click(await screen.findByRole("button", { name: "加载并对比" }));

    expect(await screen.findByText("找到 2 个 dataId，已选 2 个")).toBeInTheDocument();
    expect(document.querySelector(".diff-sources")).toHaveAttribute("aria-hidden", "true");
    expect(document.querySelector(".diff-sources")).not.toHaveAttribute("hidden");
    const expandToggle = document.querySelector(".diff-source-panel .diff-source-toggle-edge");
    expect(expandToggle).toBeInTheDocument();
    expect(expandToggle).toHaveAccessibleName("展开来源");
    expect(expandToggle).not.toHaveTextContent("展开来源");

    fireEvent.click(screen.getByRole("button", { name: "展开来源" }));

    expect(document.querySelector(".diff-sources")).toHaveAttribute("aria-hidden", "false");
    const collapseToggle = document.querySelector(".diff-source-panel .diff-source-toggle-edge");
    expect(collapseToggle).toHaveAccessibleName("收起来源");
    expect(collapseToggle).not.toHaveTextContent("收起来源");
  });

  it("lists disjoint dataIds instead of hiding them", async () => {
    apiMocks.listNamespaces.mockResolvedValue([
      { namespace: "dev-tenant", namespaceShowName: "开发命名空间", configCount: 1, kind: 0 },
      { namespace: "prod-tenant", namespaceShowName: "生产命名空间", configCount: 1, kind: 0 },
    ]);
    apiMocks.listConfigs
      .mockResolvedValueOnce({ totalCount: 1, pageNumber: 1, pagesAvailable: 1, pageItems: [] })
      .mockResolvedValueOnce({ totalCount: 1, pageNumber: 1, pagesAvailable: 1, pageItems: [] })
      .mockResolvedValueOnce({
        totalCount: 1,
        pageNumber: 1,
        pagesAvailable: 1,
        pageItems: [{ dataId: "left.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" }],
      })
      .mockResolvedValueOnce({
        totalCount: 1,
        pageNumber: 1,
        pagesAvailable: 1,
        pageItems: [{ dataId: "right.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" }],
      });

    renderDiff([nacosConn]);

    const compareButton = await screen.findByRole("button", { name: "加载并对比" });
    fireEvent.click(compareButton);

    expect(await screen.findByText("找到 2 个 dataId，已选 2 个")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "对比选中（2）" })).not.toBeDisabled();
  });

  it("lists left-only and right-only files when batch matching configs", async () => {
    localStorage.setItem(
      "cs.diffViewPreferences",
      JSON.stringify({
        selectedProject: "Order",
        left: { connId: "left-nacos", tenant: "shared", dataId: "", group: "DEFAULT_GROUP", usesDefaultNamespace: false },
        right: { connId: "right-nacos", tenant: "shared", dataId: "", group: "DEFAULT_GROUP", usesDefaultNamespace: false },
        mode: "text",
      })
    );
    apiMocks.listConfigs.mockImplementation(async (conn: Connection) => ({
      totalCount: 2,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems:
        conn.id === "left-nacos"
          ? [
              { dataId: "same.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
              { dataId: "left-only.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
            ]
          : [
              { dataId: "same.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
              { dataId: "right-only.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
            ],
    }));
    apiMocks.getConfig.mockImplementation(async (conn: Connection, _tenant: string, dataId: string) => `${conn.id}:${dataId}`);

    renderDiff([leftApplyConn, rightApplyConn]);

    fireEvent.click(await screen.findByRole("button", { name: "加载并对比" }));

    expect(await screen.findByText("找到 3 个 dataId，已选 3 个")).toBeInTheDocument();
    expect(screen.getAllByText("same.yaml")).toHaveLength(2);
    expect(screen.getByText("left-only.yaml")).toBeInTheDocument();
    expect(screen.getByText("right-only.yaml")).toBeInTheDocument();
    expect(screen.getAllByText("仅左侧存在").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("仅右侧存在").length).toBeGreaterThanOrEqual(1);

    fireEvent.click(await screen.findByRole("button", { name: "对比选中（3）" }));

    await waitFor(() => expect(apiMocks.getConfig).toHaveBeenCalledTimes(4));
    expect(apiMocks.getConfig).toHaveBeenCalledWith(leftApplyConn, "shared", "same.yaml", "DEFAULT_GROUP");
    expect(apiMocks.getConfig).toHaveBeenCalledWith(rightApplyConn, "shared", "same.yaml", "DEFAULT_GROUP");
    expect(apiMocks.getConfig).toHaveBeenCalledWith(leftApplyConn, "shared", "left-only.yaml", "DEFAULT_GROUP");
    expect(apiMocks.getConfig).toHaveBeenCalledWith(rightApplyConn, "shared", "right-only.yaml", "DEFAULT_GROUP");
    expect(apiMocks.getConfig).not.toHaveBeenCalledWith(rightApplyConn, "shared", "left-only.yaml", "DEFAULT_GROUP");
    expect(apiMocks.getConfig).not.toHaveBeenCalledWith(leftApplyConn, "shared", "right-only.yaml", "DEFAULT_GROUP");
    expect(await screen.findByText("已生成 3 个文件对比")).toBeInTheDocument();
    expect(screen.getAllByText("仅左侧存在").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("仅右侧存在").length).toBeGreaterThanOrEqual(1);
  });

  it("only exposes left-to-right merge actions for one-sided files", async () => {
    const onStartApply = vi.fn();
    localStorage.setItem("locale", "en-US");
    apiMocks.listConfigs.mockImplementation(async (conn: Connection) => ({
      totalCount: 1,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems:
        conn.id === "left-nacos"
          ? [{ dataId: "left-only.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" }]
          : [{ dataId: "right-only.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" }],
    }));
    apiMocks.getConfig.mockImplementation(async (conn: Connection, _tenant: string, dataId: string) =>
      conn.id === "left-nacos" ? `left: ${dataId}` : `right: ${dataId}`
    );

    render(
      <I18nProvider>
        <DiffView
          connections={[leftApplyConn, rightApplyConn]}
          initialParams={{
            leftConnId: "left-nacos",
            rightConnId: "right-nacos",
            left: { tenant: "shared", group: "DEFAULT_GROUP", dataId: "" },
            right: { tenant: "shared", group: "DEFAULT_GROUP", dataId: "" },
            autoCompare: true,
          }}
          onStartApply={onStartApply}
        />
      </I18nProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "Compare Selected (2)" }));
    expect(await screen.findByText("Generated 2 file comparisons")).toBeInTheDocument();

    expect(screen.getByRole("button", { name: /left-only\.yaml/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /right-only\.yaml/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /left-only\.yaml/ }));
    expect(screen.getByRole("button", { name: "Take left to right preview" })).not.toBeDisabled();
    expect(screen.queryByRole("button", { name: "Take right to left preview" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Take left to right preview" }));

    fireEvent.click(screen.getByRole("button", { name: /right-only\.yaml/ }));
    // 加不进去的箭头（轮27 F-9）：不能用原生 disabled——Blink 在 disabled 控件上整段跳过 title，
    // 而这颗箭头是 icon-only，「为什么点不动」没有第二个可见渠道。口径 = aria-disabled + 点击早退。
    const blockedArrow = screen.getByRole("button", { name: "Take left to right preview" });
    expect(blockedArrow).toHaveAttribute("aria-disabled", "true");
    expect(blockedArrow).not.toHaveAttribute("disabled");
    expect(blockedArrow).toHaveAttribute("title", "The left side has no such line, so there is nothing to take");
    // 点它不许真的产生合并草稿：计划入口仍然只带着刚才 left-only 那 1 个文件
    fireEvent.click(blockedArrow);
    expect(screen.getByRole("button", { name: "Enter Configuration Change Plan (1 files)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Take right to left preview" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Enter Configuration Change Plan (1 files)" }));
    expect(onStartApply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ connectionId: "left-nacos" }),
        target: expect.objectContaining({ connectionId: "right-nacos" }),
        items: [
          expect.objectContaining({
            connectionId: "right-nacos",
            dataId: "left-only.yaml",
            sourceValueOverride: expect.objectContaining({ content: "left: left-only.yaml" }),
          }),
        ],
      })
    );

    expect(onStartApply).toHaveBeenCalledTimes(1);
  });

  it("shows smart-match files as left and right side lists", async () => {
    localStorage.setItem(
      "cs.diffViewPreferences",
      JSON.stringify({
        selectedProject: "Order",
        left: { connId: "left-nacos", tenant: "shared", dataId: "", group: "DEFAULT_GROUP", usesDefaultNamespace: false },
        right: { connId: "right-nacos", tenant: "shared", dataId: "", group: "DEFAULT_GROUP", usesDefaultNamespace: false },
        mode: "text",
      })
    );
    apiMocks.listConfigs.mockImplementation(async (conn: Connection) => ({
      totalCount: 2,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems:
        conn.id === "left-nacos"
          ? [
              { dataId: "same.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
              { dataId: "left-only.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
            ]
          : [
              { dataId: "same.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
              { dataId: "right-only.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
            ],
    }));

    renderDiff([leftApplyConn, rightApplyConn]);

    fireEvent.click(await screen.findByRole("button", { name: "加载并对比" }));

    expect(await screen.findByText("找到 3 个 dataId，已选 3 个")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "仅对比同名存在的文件" }));
    expect(screen.getByText("找到 3 个 dataId，已选 1 个")).toBeInTheDocument();
    const leftList = document.querySelector(".match-side-list.left");
    const rightList = document.querySelector(".match-side-list.right");
    const leftScroll = leftList?.querySelector(".match-side-scroll");
    const rightScroll = rightList?.querySelector(".match-side-scroll");
    expect(leftList).toBeInTheDocument();
    expect(rightList).toBeInTheDocument();
    expect(leftScroll).toBeInTheDocument();
    expect(rightScroll).toBeInTheDocument();
    expect(within(leftList as HTMLElement).getByText("same.yaml")).toBeInTheDocument();
    expect(within(leftList as HTMLElement).getByText("left-only.yaml")).toBeInTheDocument();
    expect(within(leftList as HTMLElement).getByText("缺失配置")).toBeInTheDocument();
    expect(within(rightList as HTMLElement).getByText("same.yaml")).toBeInTheDocument();
    expect(within(rightList as HTMLElement).getByText("right-only.yaml")).toBeInTheDocument();
    expect(within(rightList as HTMLElement).getByText("缺失配置")).toBeInTheDocument();
  });

  it("returns from batch line diff to the previous file selection range", async () => {
    apiMocks.listConfigs.mockResolvedValue({
      totalCount: 2,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [
        { dataId: "app.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
        { dataId: "gateway.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
      ],
    });
    apiMocks.getConfig.mockImplementation(async (_conn: Connection, _tenant: string, dataId: string) => `${dataId}: content`);

    renderDiff([nacosConn]);

    fireEvent.click(await screen.findByRole("button", { name: "加载并对比" }));
    expect(await screen.findByText("找到 2 个 dataId，已选 2 个")).toBeInTheDocument();
    fireEvent.click(document.querySelectorAll<HTMLInputElement>(".match-item input")[1]);
    expect(screen.getByText("找到 2 个 dataId，已选 1 个")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "对比选中（1）" }));

    expect(await screen.findByText("已生成 1 个文件对比")).toBeInTheDocument();
    const resultActions = document.querySelector(".diff-loadbar");
    expect(resultActions).toBeInTheDocument();
    expect(resultActions).toHaveTextContent("已生成 1 个文件对比");
    expect(resultActions).toHaveTextContent("返回文件选择");
    expect(resultActions).not.toHaveTextContent("对比模式");
    expect(resultActions?.querySelector(".result-action-back")).toBeInTheDocument();
    expect(resultActions?.querySelector(".result-action-filter")).toBeInTheDocument();
    expect(resultActions?.querySelector(".result-action-export")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "对比选中（1）" })).not.toBeInTheDocument();
    expect(document.querySelector(".batch-diff-toolbar")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "返回文件选择" }));

    expect(screen.getByText("找到 2 个 dataId，已选 1 个")).toBeInTheDocument();
    expect(screen.getByText("对比模式")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "对比选中（1）" })).toBeInTheDocument();
    expect(screen.queryByText("已生成 1 个文件对比")).not.toBeInTheDocument();
  });

  it("applies the only-changes toggle to all batch diff files", async () => {
    apiMocks.listConfigs.mockResolvedValue({
      totalCount: 2,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [
        { dataId: "app.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
        { dataId: "gateway.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
      ],
    });
    const loadCount = new Map<string, number>();
    apiMocks.getConfig.mockImplementation(async (_conn: Connection, _tenant: string, dataId: string) => {
      const count = loadCount.get(dataId) ?? 0;
      loadCount.set(dataId, count + 1);
      if (dataId === "app.yaml") return count === 0 ? "same-app\nleft-app" : "same-app\nright-app";
      return count === 0 ? "same-gateway\nleft-gateway" : "same-gateway\nright-gateway";
    });

    renderDiff([nacosConn]);

    fireEvent.click(await screen.findByRole("button", { name: "加载并对比" }));
    fireEvent.click(await screen.findByRole("button", { name: "对比选中（2）" }));

    await waitFor(() => expect(apiMocks.getConfig).toHaveBeenCalledTimes(4));
    expect(await screen.findByText("已生成 2 个文件对比")).toBeInTheDocument();
    const resultPane = document.querySelector(".diff-result");
    expect(resultPane).toHaveClass("diff-result-batch");
    const nav = resultPane?.querySelector(".batch-diff-nav");
    const main = resultPane?.querySelector(".batch-diff-main");
    expect(nav).toBeInTheDocument();
    expect(main).toBeInTheDocument();
    expect(nav?.querySelectorAll(".batch-diff-nav-item")).toHaveLength(2);
    expect(nav?.querySelectorAll(".diff-stats.batch-diff-nav-stats")).toHaveLength(2);
    expect(screen.getAllByText("app.yaml").length).toBeGreaterThan(0);
    expect(screen.getAllByText("gateway.yaml").length).toBeGreaterThan(0);
    expect(screen.getAllByText("same-app")).toHaveLength(2);
    expect(screen.queryByText("same-gateway")).not.toBeInTheDocument();
    expect(screen.getAllByLabelText("仅显示变更")).toHaveLength(1);

    fireEvent.click(screen.getByLabelText("全部仅显示变更"));

    expect(screen.queryByText("same-app")).not.toBeInTheDocument();
    expect(screen.queryByText("same-gateway")).not.toBeInTheDocument();
    expect(screen.getByText("left-app")).toBeInTheDocument();
    expect(screen.getByText("right-app")).toBeInTheDocument();
    expect(screen.queryByText("left-gateway")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /gateway\.yaml/ }));
    expect(screen.queryByText("same-gateway")).not.toBeInTheDocument();
    expect(screen.getByText("left-gateway")).toBeInTheDocument();
    expect(screen.getByText("right-gateway")).toBeInTheDocument();
  });

  it("marks local snapshot sources and shows the snapshot directory", async () => {
    renderDiff([snapshotConn]);

    // 展开区 SourcePicker 各 1 + 收起区 sourceSummary 各 1 = 4
    expect(await screen.findAllByText("本地快照目录")).toHaveLength(4);
    expect(screen.getAllByText("读取本地快照目录")).toHaveLength(2);
    expect(screen.getAllByText("C:\\backup\\dev")).toHaveLength(2);
  });

  it("auto loads and compares when initial params request auto compare", async () => {
    apiMocks.getConfig.mockImplementation(async (conn: Connection) =>
      conn.id === "dev-snapshot" ? "server:\n  port: 8080" : "server:\n  port: 9090"
    );
    const onInitialParamsConsumed = vi.fn();

    localStorage.setItem("locale", "zh-CN");
    render(
      <I18nProvider>
        <DiffView
          connections={[snapshotConn, nacosConn]}
          initialParams={{
            leftConnId: "dev-snapshot",
            rightConnId: "dev-nacos",
            left: { tenant: "", group: "DEFAULT_GROUP", dataId: "app.yaml" },
            right: { tenant: "", group: "DEFAULT_GROUP", dataId: "app.yaml" },
            autoCompare: true,
          }}
          onInitialParamsConsumed={onInitialParamsConsumed}
        />
      </I18nProvider>
    );

    await waitFor(() => {
      expect(apiMocks.getConfig).toHaveBeenCalledWith(snapshotConn, "", "app.yaml", "DEFAULT_GROUP");
      expect(apiMocks.getConfig).toHaveBeenCalledWith(nacosConn, "", "app.yaml", "DEFAULT_GROUP");
    });
    expect(await screen.findByText("8080")).toBeInTheDocument();
    expect(await screen.findByText("9090")).toBeInTheDocument();
    expect(onInitialParamsConsumed).toHaveBeenCalledTimes(1);
  });

  it("shows a copyable inline error when auto compare fails from initial params", async () => {
    apiMocks.getConfig.mockImplementation(async (conn: Connection) => {
      if (conn.id === "dev-nacos") throw new Error("cloud EOF");
      return "server:\n  port: 8080";
    });

    localStorage.setItem("locale", "zh-CN");
    render(
      <I18nProvider>
        <DiffView
          connections={[snapshotConn, nacosConn]}
          initialParams={{
            leftConnId: "dev-snapshot",
            rightConnId: "dev-nacos",
            left: { tenant: "", group: "DEFAULT_GROUP", dataId: "app.yaml" },
            right: { tenant: "", group: "DEFAULT_GROUP", dataId: "app.yaml" },
            autoCompare: true,
          }}
        />
      </I18nProvider>
    );

    await waitFor(() => {
      expect(apiMocks.getConfig).toHaveBeenCalledWith(snapshotConn, "", "app.yaml", "DEFAULT_GROUP");
      expect(apiMocks.getConfig).toHaveBeenCalledWith(nacosConn, "", "app.yaml", "DEFAULT_GROUP");
    });
    expect(await screen.findByText("目标（右）: cloud EOF")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制错误" })).toBeInTheDocument();
  });

  it("shows localized copyable errors when batch diff has partial failures", async () => {
    apiMocks.listConfigs.mockResolvedValue({
      totalCount: 3,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [
        { dataId: "app.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
        { dataId: "gateway.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
        { dataId: "db.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
      ],
    });
    apiMocks.getConfig.mockImplementation(async (_conn: Connection, _tenant: string, dataId: string) => {
      if (dataId === "gateway.yaml") throw new Error("connect timeout");
      return `${dataId}-content`;
    });

    localStorage.setItem("locale", "en-US");
    render(
      <I18nProvider>
        <DiffView connections={[nacosConn]} />
      </I18nProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "Load & Compare" }));
    fireEvent.click(await screen.findByRole("button", { name: "Compare Selected (3)" }));

    await waitFor(() => expect(apiMocks.getConfig).toHaveBeenCalledTimes(6));
    expect(await screen.findByText("Generated 2 file comparisons")).toBeInTheDocument();
    expect(screen.getByText("Load failed (1)")).toBeInTheDocument();
    expect(screen.getByText(/gateway\.yaml/)).toBeInTheDocument();
    expect(screen.getByText("connect timeout")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy Error" })).toBeInTheDocument();
  });

  it("starts a single-config apply plan after compare succeeds", async () => {
    const onStartApply = vi.fn();
    apiMocks.getConfig.mockImplementation(async (conn: Connection) =>
      conn.id === "left-nacos" ? "server:\n  port: 8080" : "server:\n  port: 9090"
    );

    localStorage.setItem("locale", "en-US");
    render(
      <I18nProvider>
        <DiffView
          connections={[leftApplyConn, rightApplyConn]}
          initialParams={{
            leftConnId: "left-nacos",
            rightConnId: "right-nacos",
            left: { tenant: "shared", group: "DEFAULT_GROUP", dataId: "app.yaml" },
            right: { tenant: "shared", group: "DEFAULT_GROUP", dataId: "app.yaml" },
            autoCompare: true,
          }}
          onStartApply={onStartApply}
        />
      </I18nProvider>
    );

    expect(await screen.findByText("8080")).toBeInTheDocument();
    expect(await screen.findByText("9090")).toBeInTheDocument();
    const currentWorkflowStep = document.querySelector(".diff-workflow-step.current");
    expect(currentWorkflowStep).toHaveAttribute("aria-current", "step");
    expect(currentWorkflowStep).toHaveTextContent("Select changes");

    fireEvent.click(screen.getByRole("button", { name: "Enter Configuration Change Plan" }));

    expect(onStartApply).toHaveBeenCalledWith({
      sourceType: "diff",
      scope: "config",
      source: {
        provider: "nacos",
        connectionId: "left-nacos",
        connectionName: "dev",
        namespace: "shared",
        label: "Order / Development / LAN / shared",
      },
      target: {
        provider: "nacos",
        connectionId: "right-nacos",
        connectionName: "prod",
        namespace: "shared",
        label: "Order / Production / Cloud / shared",
      },
      items: [
        {
          provider: "nacos",
          connectionId: "right-nacos",
          namespace: "shared",
          group: "DEFAULT_GROUP",
          dataId: "app.yaml",
          key: "__document",
          sourceRef: {
            provider: "nacos",
            connectionId: "left-nacos",
            namespace: "shared",
            group: "DEFAULT_GROUP",
            dataId: "app.yaml",
            key: "__document",
          },
          targetRef: {
            provider: "nacos",
            connectionId: "right-nacos",
            namespace: "shared",
            group: "DEFAULT_GROUP",
            dataId: "app.yaml",
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
      origin: {
        mode: "diff",
        returnMode: "diff",
      },
    });
  });

  it("keeps default Nacos namespace empty inside apply entries while labeling it as public", async () => {
    const onStartApply = vi.fn();
    const leftDefaultConn = { ...leftApplyConn, defaultNamespace: "" };
    const rightDefaultConn = { ...rightApplyConn, defaultNamespace: "" };
    apiMocks.getConfig.mockImplementation(async (conn: Connection) =>
      conn.id === "left-nacos" ? "server:\n  port: 8080" : "server:\n  port: 9090"
    );

    localStorage.setItem("locale", "en-US");
    render(
      <I18nProvider>
        <DiffView
          connections={[leftDefaultConn, rightDefaultConn]}
          initialParams={{
            leftConnId: "left-nacos",
            rightConnId: "right-nacos",
            left: { tenant: "", group: "DEFAULT_GROUP", dataId: "app.yaml" },
            right: { tenant: "", group: "DEFAULT_GROUP", dataId: "app.yaml" },
            autoCompare: true,
          }}
          onStartApply={onStartApply}
        />
      </I18nProvider>
    );

    expect(await screen.findByText("8080")).toBeInTheDocument();
    expect(await screen.findByText("9090")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Enter Configuration Change Plan" }));

    expect(onStartApply).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          namespace: "",
          label: "Order / Development / LAN / public",
        }),
        target: expect.objectContaining({
          namespace: "",
          label: "Order / Production / Cloud / public",
        }),
        items: [
          expect.objectContaining({
            namespace: "",
            sourceRef: expect.objectContaining({ namespace: "" }),
            targetRef: expect.objectContaining({ namespace: "" }),
          }),
        ],
      })
    );
  });

  it("starts a batch apply plan for selected smart-match results", async () => {
    const onStartApply = vi.fn();
    apiMocks.listConfigs.mockResolvedValue({
      totalCount: 2,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [
        { dataId: "app.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
        { dataId: "gateway.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
      ],
    });
    apiMocks.getConfig.mockImplementation(async (conn: Connection, _tenant: string, dataId: string) => `${conn.id}:${dataId}`);

    localStorage.setItem("locale", "en-US");
    render(
      <I18nProvider>
        <DiffView
          connections={[leftApplyConn, rightApplyConn]}
          initialParams={{
            leftConnId: "left-nacos",
            rightConnId: "right-nacos",
            left: { tenant: "shared", group: "DEFAULT_GROUP", dataId: "" },
            right: { tenant: "shared", group: "DEFAULT_GROUP", dataId: "" },
            autoCompare: true,
          }}
          onStartApply={onStartApply}
        />
      </I18nProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "Compare Selected (2)" }));

    await waitFor(() => expect(apiMocks.getConfig).toHaveBeenCalledTimes(4));
    expect(await screen.findByText("Generated 2 file comparisons")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Enter Configuration Change Plan (2 files)" }));

    expect(onStartApply).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: "diff",
        scope: "batch",
        source: expect.objectContaining({ connectionId: "left-nacos", namespace: "shared" }),
        target: expect.objectContaining({ connectionId: "right-nacos", namespace: "shared" }),
        items: [
          {
            provider: "nacos",
            connectionId: "right-nacos",
            namespace: "shared",
            group: "DEFAULT_GROUP",
            dataId: "app.yaml",
            key: "__document",
            sourceRef: {
              provider: "nacos",
              connectionId: "left-nacos",
              namespace: "shared",
              group: "DEFAULT_GROUP",
              dataId: "app.yaml",
              key: "__document",
            },
            targetRef: {
              provider: "nacos",
              connectionId: "right-nacos",
              namespace: "shared",
              group: "DEFAULT_GROUP",
              dataId: "app.yaml",
              key: "__document",
            },
          },
          {
            provider: "nacos",
            connectionId: "right-nacos",
            namespace: "shared",
            group: "DEFAULT_GROUP",
            dataId: "gateway.yaml",
            key: "__document",
            sourceRef: {
              provider: "nacos",
              connectionId: "left-nacos",
              namespace: "shared",
              group: "DEFAULT_GROUP",
              dataId: "gateway.yaml",
              key: "__document",
            },
            targetRef: {
              provider: "nacos",
              connectionId: "right-nacos",
              namespace: "shared",
              group: "DEFAULT_GROUP",
              dataId: "gateway.yaml",
              key: "__document",
            },
          },
        ],
        rangeSummary: {
          count: 2,
          skippedCount: 0,
          riskLevel: "medium",
          riskReasons: ["batch_apply"],
        },
        origin: {
          mode: "diff",
          returnMode: "diff",
        },
      })
    );
  });

  it("lets users mark batch diff rows as a left-to-right merge draft without starting apply", async () => {
    const onStartApply = vi.fn();
    apiMocks.listConfigs.mockResolvedValue({
      totalCount: 1,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [{ dataId: "app.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" }],
    });
    apiMocks.getConfig.mockImplementation(async (conn: Connection) =>
      conn.id === "left-nacos" ? "feature.enabled=false\nserver.port=8080" : "feature.enabled=true\nserver.port=8080"
    );

    localStorage.setItem("locale", "en-US");
    render(
      <I18nProvider>
        <DiffView
          connections={[leftApplyConn, rightApplyConn]}
          initialParams={{
            leftConnId: "left-nacos",
            rightConnId: "right-nacos",
            left: { tenant: "shared", group: "DEFAULT_GROUP", dataId: "" },
            right: { tenant: "shared", group: "DEFAULT_GROUP", dataId: "" },
            autoCompare: true,
          }}
          onStartApply={onStartApply}
        />
      </I18nProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "Compare Selected (1)" }));

    expect(await screen.findByText("Generated 1 file comparisons")).toBeInTheDocument();
    expect(screen.getByText("Merge preview")).toBeInTheDocument();
    expect(screen.getByText("No merge preview changes yet")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Take left to right preview" }));
    expect(screen.getByText("1 files queued for the right target")).toBeInTheDocument();
    expect(screen.getAllByText("feature.enabled=false").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("feature.enabled=true")).not.toBeInTheDocument();
    expect(onStartApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Reset preview" }));
    expect(screen.getByText("No merge preview changes yet")).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: "Take right to left preview" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reset preview" }));
    expect(screen.getByText("No merge preview changes yet")).toBeInTheDocument();
  });

  it("generates one-way materialized merge plans from selected arrows", async () => {
    const onStartApply = vi.fn();
    apiMocks.listConfigs.mockResolvedValue({
      totalCount: 1,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [{ dataId: "app.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" }],
    });
    apiMocks.getConfig.mockImplementation(async (conn: Connection) =>
      conn.id === "left-nacos" ? "server:\n  port: 8080\nfeature:\n  enabled: true" : "server:\n  port: 9090\nfeature:\n  enabled: true"
    );

    localStorage.setItem("locale", "en-US");
    render(
      <I18nProvider>
        <DiffView
          connections={[leftApplyConn, rightApplyConn]}
          initialParams={{
            leftConnId: "left-nacos",
            rightConnId: "right-nacos",
            left: { tenant: "shared", group: "DEFAULT_GROUP", dataId: "" },
            right: { tenant: "shared", group: "DEFAULT_GROUP", dataId: "" },
            autoCompare: true,
          }}
          onStartApply={onStartApply}
        />
      </I18nProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "Compare Selected (1)" }));
    expect(await screen.findByText("Generated 1 file comparisons")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enter Configuration Change Plan (1 files)" })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Take left to right preview" }));
    fireEvent.click(screen.getByRole("button", { name: "Enter Configuration Change Plan (1 files)" }));

    expect(onStartApply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ connectionId: "left-nacos" }),
        target: expect.objectContaining({ connectionId: "right-nacos" }),
        items: [
          expect.objectContaining({
            connectionId: "right-nacos",
            dataId: "app.yaml",
            key: "__document",
            sourceRef: expect.objectContaining({ connectionId: "left-nacos", dataId: "app.yaml" }),
            targetRef: expect.objectContaining({ connectionId: "right-nacos", dataId: "app.yaml" }),
            sourceValueOverride: expect.objectContaining({
              exists: true,
              valueType: "text",
              format: "YAML",
              content: "server:\n  port: 8080\nfeature:\n  enabled: true",
            }),
          }),
        ],
      })
    );

    expect(onStartApply).toHaveBeenCalledTimes(1);
  });

  it("supports row and block scopes for left-to-right merge arrows", async () => {
    apiMocks.listConfigs.mockResolvedValue({
      totalCount: 1,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [{ dataId: "app.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" }],
    });
    apiMocks.getConfig.mockImplementation(async (conn: Connection) =>
      conn.id === "left-nacos"
        ? "feature.enabled=false\nserver.port=8080\nunchanged=true"
        : "feature.enabled=true\nserver.port=9090\nunchanged=true"
    );

    localStorage.setItem("locale", "en-US");
    render(
      <I18nProvider>
        <DiffView
          connections={[leftApplyConn, rightApplyConn]}
          initialParams={{
            leftConnId: "left-nacos",
            rightConnId: "right-nacos",
            left: { tenant: "shared", group: "DEFAULT_GROUP", dataId: "" },
            right: { tenant: "shared", group: "DEFAULT_GROUP", dataId: "" },
            autoCompare: true,
          }}
        />
      </I18nProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "Compare Selected (1)" }));
    expect(await screen.findByText("No merge preview changes yet")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Take left to right preview" })[0]);
    expect(screen.getByText("1 files queued for the right target")).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: "Take right to left preview" })).not.toBeInTheDocument();
  });

  it("does not show apply entry points before compare output exists", () => {
    localStorage.setItem("locale", "en-US");
    render(
      <I18nProvider>
        <DiffView connections={[leftApplyConn, rightApplyConn]} onStartApply={vi.fn()} />
      </I18nProvider>
    );

    expect(screen.queryByRole("button", { name: "Enter Configuration Change Plan" })).toBeNull();
  });

  it("shows inline error when all batch diff configs fail to load", async () => {
    apiMocks.listConfigs.mockResolvedValue({
      totalCount: 2,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [
        { dataId: "app.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
        { dataId: "gateway.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
      ],
    });
    apiMocks.getConfig.mockRejectedValue(new Error("EOF"));

    renderDiff([nacosConn]);

    fireEvent.click(await screen.findByRole("button", { name: "加载并对比" }));
    fireEvent.click(await screen.findByRole("button", { name: "对比选中（2）" }));

    await waitFor(() => expect(apiMocks.getConfig).toHaveBeenCalledTimes(4));
    expect(await screen.findByText("全部配置加载失败")).toBeInTheDocument();
  }, 15000);
});

/**
 * 轮33 F-34：差异对比页的 chrome 条上的滚轮必须滚「指针所在那一列的正文」。
 *
 * 两态的矩形与落点全部照抄真机取证 research/p3_batch_match_chrome.txt（宽栏 1440×900）：
 *   M1 批量对比  batch-diff-nav-scroll @200,297,250,587（余 3968）｜diff-body @462,362,962,522（余 7078）
 *   M3 同名匹配  match-side-scroll @198,297,608,258（余 2477）｜右列同尺寸 x 818..1426
 * 轮33 实测这两态共 9 块 chrome 一动不动（页内死区 28.3%–29.6% 视口），窄栏 900×700 反而全 OK，
 * 差别只在 chrome 的祖先链里有没有可滚容器 ⇒ 守卫钉的是「闸门 + 按几何选列」，不是按 class 打补丁。
 * 尤其 `.diff-stats` 在批量态被复用进左列列表项（`.batch-diff-nav-stats`），按类名挂处理器必然抢错。
 *
 * 注意取证口径：p3 的坐标来自手写 fixture `research/f_diff3.html`，不是真页面。fixture 里那行
 * `.batch-diff-toolbar` 在真实组件中根本不存在（只剩 styles.css 里的死样式），所以这里不钉它，
 * 改成钉批量态真实存在的通栏条 `.batch-diff-failures-head`。真机复核（PRD 待办）必须按真实 DOM 重跑一遍。
 */
describe("DiffView 滚轮兜底：chrome 条滚同一列正文（轮33 F-34）", () => {
  const NAV = { left: 200, right: 450, top: 297, bottom: 884 };
  const NAV_ROOM = 3968;
  const BODY = { left: 462, right: 1424, top: 362, bottom: 884 };
  const BODY_ROOM = 7078;
  const MATCH_LEFT = { left: 198, right: 806, top: 297, bottom: 555 };
  const MATCH_RIGHT = { left: 818, right: 1426, top: 297, bottom: 555 };
  const MATCH_ROOM = 2477;

  beforeEach(() => {
    localStorage.clear();
    __clearWheelSurfacesForTest();
    apiMocks.listNamespaces.mockReset();
    apiMocks.listConfigs.mockReset();
    apiMocks.listAllConfigs.mockReset();
    apiMocks.getConfig.mockReset();
    apiMocks.listAllConfigs.mockImplementation(listAllConfigsBridge(apiMocks.listConfigs));
    apiMocks.listNamespaces.mockResolvedValue([{ namespace: "dev-tenant", namespaceShowName: "开发命名空间", configCount: 1, kind: 0 }]);
    Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
  });

  /** jsdom 没布局：闸门要的 overflow/两个高度与选列要的矩形按取证数字装。 */
  function makeScrollable(el: HTMLElement, rect: { left: number; right: number; top: number; bottom: number }, room: number) {
    el.style.overflowY = "auto";
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => rect.bottom - rect.top });
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => rect.bottom - rect.top + room });
    el.getBoundingClientRect = () =>
      ({
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
        x: rect.left,
        y: rect.top,
        toJSON: () => ({}),
      }) as DOMRect;
    el.scrollTop = 0;
  }

  function wheelOn(target: Element, x: number, y: number, deltaY = 120): WheelEvent {
    const event = new WheelEvent("wheel", { cancelable: true, bubbles: true, clientX: x, clientY: y, deltaY });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  async function renderBatchDiff(opts: { failing?: boolean } = {}) {
    apiMocks.listConfigs.mockResolvedValue({
      totalCount: 2,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [
        { dataId: "app.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
        { dataId: "gateway.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
      ],
    });
    apiMocks.getConfig.mockImplementation(async (_conn: Connection, _tenant: string, dataId: string) => {
      if (opts.failing && dataId === "gateway.yaml") throw new Error("EOF");
      return `${dataId}: content-${dataId}`;
    });
    renderDiff([nacosConn]);
    fireEvent.click(await screen.findByRole("button", { name: "加载并对比" }));
    // 「对比选中（N）」要等 loadConfigs 把 dataId 列表填回来才出现，同步 getBy 抢不到。
    await screen.findByText(/找到 2 个 dataId/);
    fireEvent.click(await screen.findByRole("button", { name: "对比选中（2）" }));
    await screen.findByText(opts.failing ? "已生成 1 个文件对比" : "已生成 2 个文件对比");
    const nav = document.querySelector<HTMLElement>(".batch-diff-nav-scroll")!;
    const body = document.querySelector<HTMLElement>(".diff-body")!;
    expect(nav, "批量态的左列没渲染出来").not.toBeNull();
    expect(body, "批量态的主区正文没渲染出来").not.toBeNull();
    makeScrollable(nav, NAV, NAV_ROOM);
    makeScrollable(body, BODY, BODY_ROOM);
    return { nav, body };
  }

  async function renderMatchLists() {
    localStorage.setItem(
      "cs.diffViewPreferences",
      JSON.stringify({
        selectedProject: "Order",
        left: { connId: "left-nacos", tenant: "shared", dataId: "", group: "DEFAULT_GROUP", usesDefaultNamespace: false },
        right: { connId: "right-nacos", tenant: "shared", dataId: "", group: "DEFAULT_GROUP", usesDefaultNamespace: false },
        mode: "text",
      })
    );
    apiMocks.listConfigs.mockImplementation(async (conn: Connection) => ({
      totalCount: 2,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems:
        conn.id === "left-nacos"
          ? [
              { dataId: "same.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
              { dataId: "left-only.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
            ]
          : [
              { dataId: "same.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
              { dataId: "right-only.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
            ],
    }));
    renderDiff([leftApplyConn, rightApplyConn]);
    fireEvent.click(await screen.findByRole("button", { name: "加载并对比" }));
    await screen.findByText("找到 3 个 dataId，已选 3 个");
    fireEvent.click(screen.getByRole("button", { name: "仅对比同名存在的文件" }));
    await screen.findByText("找到 3 个 dataId，已选 1 个");
    const left = document.querySelector<HTMLElement>(".match-side-list.left .match-side-scroll")!;
    const right = document.querySelector<HTMLElement>(".match-side-list.right .match-side-scroll")!;
    expect(left, "匹配态左列表没渲染出来").not.toBeNull();
    expect(right, "匹配态右列表没渲染出来").not.toBeNull();
    makeScrollable(left, MATCH_LEFT, MATCH_ROOM);
    makeScrollable(right, MATCH_RIGHT, MATCH_ROOM);
    return { left, right };
  }

  const BATCH_CHROME: [string, number, number, "nav" | "body"][] = [
    [".diff-loadbar", 592, 180, "body"],
    [".batch-diff-nav-head", 325, 280, "nav"],
    [".batch-diff-main-head", 943, 283, "body"],
    [".diff-panel .diff-stats", 1063, 320, "body"],
    [".diff-panel .diff-head", 943, 350, "body"],
  ];

  for (const [sel, x, y, column] of BATCH_CHROME) {
    it(`批量态：滚轮落在 ${sel} 的 (${x},${y}) ⇒ 滚${column === "nav" ? "左列文件列表" : "主区正文"}，另一列一动不动`, async () => {
      const { nav, body } = await renderBatchDiff();
      const chrome = document.querySelector(sel);
      expect(chrome, `${sel} 没渲染出来，这条守卫就成了空转`).not.toBeNull();

      const event = wheelOn(chrome!, x, y);

      const moved = column === "nav" ? nav : body;
      const still = column === "nav" ? body : nav;
      expect(moved.scrollTop, "M1 实测这块是纯死区：兜底要把这一格投给本列正文").toBe(120);
      expect(still.scrollTop, "串列了：滚轮落在哪一列就只滚哪一列").toBe(0);
      expect(event.defaultPrevented, "不取消默认动作：外层面板会跟着一起滚").toBe(true);
    });
  }

  it("批量态：左列列表项里的 .diff-stats 不被抢走（按 class 挂处理器必错的正是这一块）", async () => {
    const { nav, body } = await renderBatchDiff();
    const reused = document.querySelector(".batch-diff-nav-scroll .diff-stats");
    expect(reused, "列表项里没有复用的 .diff-stats，这条守卫是空转").not.toBeNull();

    const event = wheelOn(reused!, 325, 500);

    expect(event.defaultPrevented, "它就在可滚的左列里 ⇒ 归原生，兜底一格都不许接").toBe(false);
    expect(nav.scrollTop, "抢过来自己写偏移就等于把左列的原生滚动接管了一遍").toBe(0);
    expect(body.scrollTop, "同类名的另一块在主区，按类名选目标会滚错列").toBe(0);
  });

  it("批量态：正文与左列自身（落点在可滚容器内）保持原生语义，不被兜底改写", async () => {
    const { nav, body } = await renderBatchDiff();
    const bodyItem = document.querySelector(".diff-body .diff-row") ?? document.querySelector(".diff-body");
    const navItem = document.querySelector(".batch-diff-nav-item");
    expect(bodyItem).not.toBeNull();
    expect(navItem, "批量态列表项没渲染出来").not.toBeNull();

    expect(wheelOn(bodyItem!, 943, 623).defaultPrevented, "正文上的滚轮归原生").toBe(false);
    expect(wheelOn(navItem!, 325, 591).defaultPrevented, "列表项上的滚轮归原生").toBe(false);
    expect(body.scrollTop).toBe(0);
    expect(nav.scrollTop).toBe(0);
  });

  /**
   * 批量态真正横跨两列的 chrome 条只有失败汇总的头部（有失败项才出现）：它不在任何可滚容器里，
   * 兜底要按 x 把它投给所在列的正文；紧挨着它的 .batch-diff-failures-list 自己就是可滚容器（max-height 170），
   * 那一格归原生。y=229 沿用 p3 的取证带，x 取两列各自的中线——真实 DOM 里这条是通栏的，两半都钉才站得住。
   */
  const BATCH_FULLWIDTH_CHROME: [string, number, number, "nav" | "body"][] = [
    [".batch-diff-failures-head", 325, 229, "nav"],
    [".batch-diff-failures-head", 943, 229, "body"],
  ];

  for (const [sel, x, y, column] of BATCH_FULLWIDTH_CHROME) {
    it(`批量态：通栏的 ${sel} 在 x=${x} ⇒ 滚${column === "nav" ? "左列文件列表" : "主区正文"}`, async () => {
      const { nav, body } = await renderBatchDiff({ failing: true });
      const chrome = document.querySelector(sel);
      expect(chrome, `${sel} 没渲染出来，这条守卫就成了空转`).not.toBeNull();
      expect(document.querySelector(".batch-diff-failures-list"), "失败列表没渲染出来").not.toBeNull();

      const event = wheelOn(chrome!, x, y);

      const moved = column === "nav" ? nav : body;
      const still = column === "nav" ? body : nav;
      expect(moved.scrollTop, "通栏 chrome 条也要按 x 分列，不能整条投给同一块").toBe(120);
      expect(still.scrollTop, "串列了").toBe(0);
      expect(event.defaultPrevented).toBe(true);
    });
  }

  it("批量态：失败列表自己可滚 ⇒ 里面的落点归原生，兜底不许抢", async () => {
    const { nav, body } = await renderBatchDiff({ failing: true });
    const item = document.querySelector(".batch-diff-failures-item");
    expect(item, "失败条目没渲染出来，这条守卫是空转").not.toBeNull();
    const list = document.querySelector<HTMLElement>(".batch-diff-failures-list")!;
    makeScrollable(list, { left: 200, right: 1424, top: 236, bottom: 400 }, 300);

    const event = wheelOn(item!, 943, 300);

    expect(event.defaultPrevented, "祖先链里有可滚容器 ⇒ 闸门必须放手").toBe(false);
    expect(body.scrollTop, "抢过来就是二次改写原生滚动").toBe(0);
    expect(nav.scrollTop).toBe(0);
    expect(list.scrollTop, "失败列表自己的滚动不该被动到").toBe(0);
  });

  const MATCH_CHROME: [string, number, number, "left" | "right"][] = [
    [".diff-loadbar", 592, 180, "left"],
    [".match-list-head", 652, 231, "left"],
    [".match-side-list.left .match-side-title", 502, 282, "left"],
    [".match-side-list.right .match-side-title", 1122, 282, "right"],
  ];

  for (const [sel, x, y, column] of MATCH_CHROME) {
    it(`匹配态：滚轮落在 ${sel} 的 (${x},${y}) ⇒ 滚${column}侧列表`, async () => {
      const { left, right } = await renderMatchLists();
      const chrome = document.querySelector(sel);
      expect(chrome, `${sel} 没渲染出来，这条守卫就成了空转`).not.toBeNull();

      const event = wheelOn(chrome!, x, y);

      const moved = column === "left" ? left : right;
      const still = column === "left" ? right : left;
      expect(moved.scrollTop, "M3 实测这三块是纯死区").toBe(120);
      expect(still.scrollTop, "两条列表上下不分开、只靠 x 分列，串了就说明选的不是指针那一列").toBe(0);
      expect(event.defaultPrevented).toBe(true);
    });
  }
});

// ── 轮43 / 写后失效：本页保活，计划执行改的是服务端 ─────────────────────────
// 对比是重操作，也不该被后台通知打断，所以这里只标记过期 + 给一键重比。
// 断言锁的是「提示在不在、点重比之后清没清」，不锁可改的用户文案。
describe("DiffView 写后失效", () => {
  beforeEach(() => {
    localStorage.clear();
    apiMocks.listNamespaces.mockReset();
    apiMocks.listConfigs.mockReset();
    apiMocks.listAllConfigs.mockReset();
    apiMocks.getConfig.mockReset();
    apiMocks.listAllConfigs.mockImplementation(listAllConfigsBridge(apiMocks.listConfigs));
    apiMocks.listNamespaces.mockResolvedValue([]);
    apiMocks.listConfigs.mockResolvedValue({
      totalCount: 1,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [{ dataId: "app.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" }],
    });
    apiMocks.getConfig.mockImplementation(async (conn: Connection) =>
      conn.id === "left-nacos" ? "server:\n  port: 8080" : "server:\n  port: 9090"
    );
  });

  function renderSingleFileCompare() {
    localStorage.setItem("locale", "zh-CN");
    return render(
      <I18nProvider>
        <DiffView
          connections={[leftApplyConn, rightApplyConn]}
          initialParams={{
            leftConnId: "left-nacos",
            rightConnId: "right-nacos",
            left: { tenant: "shared", group: "DEFAULT_GROUP", dataId: "app.yaml" },
            right: { tenant: "shared", group: "DEFAULT_GROUP", dataId: "app.yaml" },
          }}
        />
      </I18nProvider>
    );
  }

  const staleBanner = () => document.querySelector(".diff-result-stale");

  it("加载并对比后先立住基线：没有过期提示", async () => {
    renderSingleFileCompare();
    fireEvent.click(await screen.findByRole("button", { name: "加载并对比" }));
    await waitFor(() => expect(document.querySelector(".diff-stats")).toBeInTheDocument());
    expect(staleBanner()).toBeNull();
  });

  it("改动落在任一侧后出现过期的可见提示，一键重比即清除", async () => {
    renderSingleFileCompare();
    fireEvent.click(await screen.findByRole("button", { name: "加载并对比" }));
    await waitFor(() => expect(document.querySelector(".diff-stats")).toBeInTheDocument());

    await act(async () => {
      publishConfigChange({ connectionId: "right-nacos", namespace: "shared", refs: [{ dataId: "app.yaml", group: "DEFAULT_GROUP" }] });
    });
    await waitFor(() => expect(staleBanner()).not.toBeNull());

    apiMocks.getConfig.mockImplementation(async () => "server:\n  port: 9090");
    fireEvent.click(within(staleBanner() as HTMLElement).getByRole("button", { name: "重新对比" }));
    await waitFor(() => expect(staleBanner()).toBeNull());
    expect(apiMocks.getConfig).toHaveBeenCalled();
  });

  it("与本页两侧无关的写入不产生提示", async () => {
    renderSingleFileCompare();
    fireEvent.click(await screen.findByRole("button", { name: "加载并对比" }));
    await waitFor(() => expect(document.querySelector(".diff-stats")).toBeInTheDocument());

    await act(async () => {
      publishConfigChange({ connectionId: "unrelated-conn", namespace: "shared", refs: [{ dataId: "app.yaml", group: "DEFAULT_GROUP" }] });
      publishConfigChange({ connectionId: "left-nacos", namespace: "other-tenant", refs: [{ dataId: "app.yaml", group: "DEFAULT_GROUP" }] });
    });
    expect(staleBanner()).toBeNull();
  });
});
