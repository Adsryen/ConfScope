/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "../test/react";
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

  it("uses the connection default namespace when loading config candidates", async () => {
    renderDiff([nacosConn]);

    await waitFor(() => {
      expect(apiMocks.listConfigs).toHaveBeenCalledWith(nacosConn, "dev-tenant", "", "", 1, 500);
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

    expect(await screen.findByText("找到 2 个同名 dataId，已选 2 个")).toBeInTheDocument();
    expect(document.querySelector(".diff-sources")).toHaveAttribute("aria-hidden", "true");
    expect(document.querySelector(".diff-sources")).not.toHaveAttribute("hidden");
    expect(screen.getByRole("button", { name: "展开来源" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开来源" }));

    expect(document.querySelector(".diff-sources")).toHaveAttribute("aria-hidden", "false");
    expect(screen.getByRole("button", { name: "收起来源" })).toBeInTheDocument();
  });


  it("allows retrying after no matching dataId when namespace changes", async () => {
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

    expect(await screen.findByText("两侧命名空间和 group 下没有找到同名 dataId")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "加载并对比" })).not.toBeDisabled();

    const namespaceButtons = screen.getAllByRole("button").filter((button) => button.textContent?.includes("开发命名空间"));
    fireEvent.click(namespaceButtons[0]);
    fireEvent.mouseDown(await screen.findByText("生产命名空间"));

    expect(screen.getByRole("button", { name: "加载并对比" })).not.toBeDisabled();
    await waitFor(() => {
      expect(apiMocks.listConfigs).toHaveBeenCalledWith(nacosConn, "prod-tenant", "", "", 1, 500);
    });
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

    expect(await screen.findAllByText("本地快照目录")).toHaveLength(2);
    expect(screen.getAllByText("读取本地快照目录")).toHaveLength(2);
    expect(screen.getAllByText("C:\\backup\\dev")).toHaveLength(2);
  });
});

