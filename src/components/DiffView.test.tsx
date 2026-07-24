/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor, within } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import type { Connection } from "../store/connections";
import DiffView from "./DiffView";

const apiMocks = vi.hoisted(() => ({
  listNamespaces: vi.fn(),
  listConfigs: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock("../api/nacos", async () => {
  const actual = await vi.importActual<typeof import("../api/nacos")>("../api/nacos");
  return {
    ...actual,
    listNamespaces: apiMocks.listNamespaces,
    listConfigs: apiMocks.listConfigs,
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
    apiMocks.getConfig.mockReset();
    apiMocks.listNamespaces.mockResolvedValue([{ namespace: "dev-tenant", namespaceShowName: "开发命名空间", configCount: 1, kind: 0 }]);
    apiMocks.listConfigs.mockResolvedValue({
      totalCount: 1,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [{ dataId: "app.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" }],
    });
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
      expect(apiMocks.listConfigs).toHaveBeenCalledWith(prodConn, "prod-tenant", "", "", 1, 500);
      expect(apiMocks.listConfigs).toHaveBeenCalledWith(nacosConn, "dev-tenant", "", "", 1, 500);
    });
    expect(screen.getAllByDisplayValue("app.yaml").length).toBeGreaterThanOrEqual(2);

  });

  it("uses the connection default namespace when loading config candidates", async () => {
    renderDiff([nacosConn]);

    await waitFor(() => {
      expect(apiMocks.listConfigs).toHaveBeenCalledWith(nacosConn, "dev-tenant", "", "", 1, 500);
    });
  });


  it("persists the changed compare sources back to localStorage", async () => {
    renderDiff([nacosConn, prodConn]);

    await screen.findAllByText("开发");
    const environmentButtons = screen.getAllByRole("button").filter((button) => button.textContent?.includes("开发"));
    fireEvent.click(environmentButtons[0]);
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
    fireEvent.click(environmentButtons[0]);
    fireEvent.mouseDown(await screen.findByText("生产"));

    expect(await screen.findAllByText("生产")).not.toHaveLength(0);
    expect(screen.getAllByText((text) => text.includes("云上公网")).length).toBeGreaterThan(0);
    expect(document.querySelector(".env-prod")).toBeInTheDocument();

    const projectButtons = screen.getAllByRole("button").filter((button) => button.textContent?.includes("订单系统"));
    fireEvent.click(projectButtons[0]);
    fireEvent.mouseDown(await screen.findByText("支付系统"));

    await waitFor(() => {
      expect(apiMocks.listConfigs).toHaveBeenCalledWith(otherProjectConn, "dev-tenant", "", "", 1, 500);
    });
    expect(screen.getAllByText((text) => text.includes("支付内网")).length).toBeGreaterThan(0);
    expect(screen.queryByText((text) => text.includes("云上公网"))).not.toBeInTheDocument();
  });

  it("syncs the default namespace when the connection config changes", async () => {
    const initialConn = { ...nacosConn, defaultNamespace: "" };
    const nextConn = { ...nacosConn, defaultNamespace: "dev-tenant" };
    const view = renderDiff([initialConn]);

    await waitFor(() => {
      expect(apiMocks.listConfigs).toHaveBeenCalledWith(initialConn, "", "", "", 1, 500);
    });

    view.rerender(
      <I18nProvider>
        <DiffView connections={[nextConn]} />
      </I18nProvider>
    );

    await waitFor(() => {
      expect(apiMocks.listConfigs).toHaveBeenCalledWith(nextConn, "dev-tenant", "", "", 1, 500);
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
    fireEvent.click(namespaceButtons[0]);
    fireEvent.mouseDown(await screen.findByText("生产命名空间"));

    await waitFor(() => {
      expect(apiMocks.listConfigs).toHaveBeenCalledWith(nacosConn, "prod-tenant", "", "", 1, 500);
    });

    const nextConn = { ...nacosConn, defaultNamespace: "qa-tenant" };
    view.rerender(
      <I18nProvider>
        <DiffView connections={[nextConn]} />
      </I18nProvider>
    );

    await waitFor(() => {
      expect(apiMocks.listConfigs).toHaveBeenCalledWith(nextConn, "prod-tenant", "", "", 1, 500);
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
    fireEvent.click(namespaceButtons[0]);
    fireEvent.mouseDown(await screen.findByText("生产命名空间"));

    await waitFor(() => {
      expect(apiMocks.listConfigs).toHaveBeenCalledWith(nacosConn, "prod-tenant", "", "", 1, 500);
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
    expect(screen.getByRole("button", { name: "展开来源" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开来源" }));

    expect(document.querySelector(".diff-sources")).toHaveAttribute("aria-hidden", "false");
    expect(screen.getByRole("button", { name: "收起来源" })).toBeInTheDocument();
  });


  it("lists disjoint dataIds instead of hiding them", async () => {
    apiMocks.listNamespaces.mockResolvedValue([
      { namespace: "dev-tenant", namespaceShowName: "开发命名空间", configCount: 1, kind: 0 },
      { namespace: "prod-tenant", namespaceShowName: "生产命名空间", configCount: 1, kind: 0 },
    ]);
    apiMocks.listConfigs
      .mockResolvedValueOnce({ totalCount: 1, pageNumber: 1, pagesAvailable: 1, pageItems: [] })
      .mockResolvedValueOnce({ totalCount: 1, pageNumber: 1, pagesAvailable: 1, pageItems: [] })
      .mockResolvedValueOnce({ totalCount: 1, pageNumber: 1, pagesAvailable: 1, pageItems: [{ dataId: "left.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" }] })
      .mockResolvedValueOnce({ totalCount: 1, pageNumber: 1, pagesAvailable: 1, pageItems: [{ dataId: "right.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" }] });

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
    const leftList = document.querySelector(".match-side-list.left");
    const rightList = document.querySelector(".match-side-list.right");
    expect(leftList).toBeInTheDocument();
    expect(rightList).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "返回文件选择" }));

    expect(screen.getByText("找到 2 个 dataId，已选 1 个")).toBeInTheDocument();
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
    expect(await screen.findByText("app.yaml")).toBeInTheDocument();
    expect(await screen.findByText("gateway.yaml")).toBeInTheDocument();
    expect(screen.getAllByText("same-app")).toHaveLength(2);
    expect(screen.getAllByText("same-gateway")).toHaveLength(2);
    expect(screen.getAllByLabelText("仅显示变更")).toHaveLength(2);

    fireEvent.click(screen.getByLabelText("全部仅显示变更"));

    expect(screen.queryByText("same-app")).not.toBeInTheDocument();
    expect(screen.queryByText("same-gateway")).not.toBeInTheDocument();
    expect(screen.getByText("left-app")).toBeInTheDocument();
    expect(screen.getByText("right-app")).toBeInTheDocument();
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
            namespace: "",
            group: "DEFAULT_GROUP",
            dataId: "app.yaml",
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
            namespace: "",
            group: "DEFAULT_GROUP",
            dataId: "app.yaml",
            autoCompare: true,
          }}
        />
      </I18nProvider>
    );

    await waitFor(() => {
      expect(apiMocks.getConfig).toHaveBeenCalledWith(snapshotConn, "", "app.yaml", "DEFAULT_GROUP");
      expect(apiMocks.getConfig).toHaveBeenCalledWith(nacosConn, "", "app.yaml", "DEFAULT_GROUP");
    });
    expect(await screen.findByText("来源 B（右）: cloud EOF")).toBeInTheDocument();
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
            namespace: "shared",
            group: "DEFAULT_GROUP",
            dataId: "app.yaml",
            autoCompare: true,
          }}
          onStartApply={onStartApply}
        />
      </I18nProvider>
    );

    expect(await screen.findByText("8080")).toBeInTheDocument();
    expect(await screen.findByText("9090")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Generate Apply Plan" }));

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
            namespace: "",
            group: "DEFAULT_GROUP",
            dataId: "app.yaml",
            autoCompare: true,
          }}
          onStartApply={onStartApply}
        />
      </I18nProvider>
    );

    expect(await screen.findByText("8080")).toBeInTheDocument();
    expect(await screen.findByText("9090")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Generate Apply Plan" }));

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
            namespace: "shared",
            group: "DEFAULT_GROUP",
            dataId: "",
            autoCompare: true,
          }}
          onStartApply={onStartApply}
        />
      </I18nProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "Compare Selected (2)" }));

    await waitFor(() => expect(apiMocks.getConfig).toHaveBeenCalledTimes(4));
    expect(await screen.findByText("Generated 2 file comparisons")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Generate Batch Apply Plan" }));

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

  it("does not show apply entry points before compare output exists", () => {
    localStorage.setItem("locale", "en-US");
    render(
      <I18nProvider>
        <DiffView connections={[leftApplyConn, rightApplyConn]} onStartApply={vi.fn()} />
      </I18nProvider>
    );

    expect(screen.queryByRole("button", { name: "Generate Apply Plan" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Generate Batch Apply Plan" })).toBeNull();
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
  });
});
