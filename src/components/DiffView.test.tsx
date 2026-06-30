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

function renderDiff(connections: Connection[]) {
  localStorage.setItem("locale", "zh-CN");
  return render(
    <I18nProvider>
      <DiffView connections={connections} />
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

  it("shows namespace load failures instead of silently clearing the selector", async () => {
    apiMocks.listNamespaces.mockRejectedValue(new Error("connect timeout"));

    renderDiff([nacosConn]);

    expect(await screen.findAllByText(/命名空间加载失败: connect timeout/)).toHaveLength(2);
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
  it("marks local snapshot sources and shows the snapshot directory", async () => {
    renderDiff([snapshotConn]);

    expect(await screen.findAllByText("本地快照目录")).toHaveLength(2);
    expect(screen.getAllByText("读取本地快照目录")).toHaveLength(2);
    expect(screen.getAllByText("C:\\backup\\dev")).toHaveLength(2);
  });
});

