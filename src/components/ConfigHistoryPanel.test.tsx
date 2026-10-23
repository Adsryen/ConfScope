/**
 * @vitest-environment jsdom
 *
 * 「历史变更」的来源分段宿主（轮67 R57-WP15）。
 *
 * 这里只钉分段这一层独有的两件事：
 * 1. 哪一档可达就只出现哪些档：两个源都可达才出分段（只有一个选项的分段是噪音）；
 * 2. 按下态与在屏内容同向，且服务端不可达时绝不把 HistoryView 放上屏——
 *    那正是轮55 钉过的「点进 tab 只看到一句与历史无关的报错」。
 * 静态形状由 tests/ux/configHistorySourceSegmentTellsTruth 守，这里跑真实挂载与切换。
 */
import { fireEvent, render, screen, waitFor } from "../test/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import type { Connection } from "../store/connections";
import ConfigHistoryPanel from "./ConfigHistoryPanel";

const apiMocks = vi.hoisted(() => ({
  listHistory: vi.fn(),
  getHistoryDetail: vi.fn(),
}));
const revisionMocks = vi.hoisted(() => ({
  listRevisionsForKey: vi.fn(),
}));

vi.mock("../api/nacos", async () => {
  const actual = await vi.importActual<typeof import("../api/nacos")>("../api/nacos");
  return {
    ...actual,
    listHistory: apiMocks.listHistory,
    getHistoryDetail: apiMocks.getHistoryDetail,
  };
});

vi.mock("../lib/configRevisions", async () => {
  const actual = await vi.importActual<typeof import("../lib/configRevisions")>("../lib/configRevisions");
  return { ...actual, listRevisionsForKey: revisionMocks.listRevisionsForKey };
});

const conn = (patch: Partial<Connection> = {}): Connection => ({
  id: "dev",
  name: "dev",
  baseUrl: "http://localhost:8848/nacos",
  username: "nacos",
  password: "nacos",
  defaultNamespace: "",
  ...patch,
});

/** 让 localRevisionStoreAvailable() 说真话：只造 ReadConfigRevisionsForKey 这颗存在性判据。 */
function withDesktopRuntime(on: boolean) {
  if (!on) {
    vi.unstubAllGlobals();
    return;
  }
  vi.stubGlobal("go", { app: { App: { ReadConfigRevisionsForKey: vi.fn() } } });
}

function renderPanel(connection = conn()) {
  localStorage.setItem("locale", "zh-CN");
  return render(
    <I18nProvider>
      <ConfigHistoryPanel
        conn={connection}
        tenant="public"
        dataId="app.yaml"
        group="DEFAULT_GROUP"
        currentContent="server:\n  port: 1000"
        format="YAML"
        searchTerm="port"
      />
    </I18nProvider>
  );
}

describe("ConfigHistoryPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    apiMocks.listHistory.mockReset();
    apiMocks.getHistoryDetail.mockReset();
    revisionMocks.listRevisionsForKey.mockReset();
    apiMocks.listHistory.mockResolvedValue({ totalCount: 0, pageNumber: 1, pagesAvailable: 1, pageItems: [] });
    apiMocks.getHistoryDetail.mockResolvedValue({ id: "1", dataId: "app.yaml", group: "DEFAULT_GROUP", content: "" });
    revisionMocks.listRevisionsForKey.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("两个源都可达时才出分段，默认落「配置中心」", async () => {
    withDesktopRuntime(true);
    renderPanel();

    const server = await screen.findByRole("button", { name: "配置中心" });
    expect(screen.getByRole("button", { name: "本机" })).toBeInTheDocument();
    expect(server).toHaveAttribute("aria-pressed", "true");
    expect(server).toHaveClass("active");
    expect(screen.getByRole("button", { name: "本机" })).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(apiMocks.listHistory).toHaveBeenCalled());
    expect(screen.getByText(/历史版本（/)).toBeInTheDocument();
    expect(screen.queryByText(/本机历史（/)).not.toBeInTheDocument();
  });

  it("按到「本机」时在屏换成本机那一列，按下态跟着走", async () => {
    withDesktopRuntime(true);
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "本机" }));

    await waitFor(() => expect(screen.getByText(/本机历史（0）/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "本机" })).toHaveClass("active");
    expect(screen.getByRole("button", { name: "配置中心" })).not.toHaveClass("active");
    // 切到本机那一档之后不会再补发服务端历史请求（轮55 起钉的那件事）
    apiMocks.listHistory.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "配置中心" }));
    await waitFor(() => expect(screen.getByText(/历史版本（/)).toBeInTheDocument());
  });

  it("纯浏览器 / web 模式下本机那一档整个不出现，只剩服务端且不挂分段", async () => {
    withDesktopRuntime(false);
    renderPanel();

    expect(screen.queryByRole("group", { name: "历史来源" })).toBeNull();
    await waitFor(() => expect(apiMocks.listHistory).toHaveBeenCalled());
    expect(screen.getByText(/历史版本（/)).toBeInTheDocument();
  });

  it("Apollo 没有服务端历史：不出现只有一个选项的分段，也不发那次必然失败的请求", async () => {
    withDesktopRuntime(true);
    renderPanel(conn({ provider: "apollo" }));

    expect(screen.queryByRole("group", { name: "历史来源" })).toBeNull();
    await waitFor(() => expect(revisionMocks.listRevisionsForKey).toHaveBeenCalled());
    expect(apiMocks.listHistory).not.toHaveBeenCalled();
    expect(screen.getByText(/本机历史（0）/)).toBeInTheDocument();
  });

  it("连接被改成不支持历史的服务端后退回本机那一档，不让空面板占屏", async () => {
    withDesktopRuntime(true);
    const { rerender } = renderPanel(conn());
    await waitFor(() => expect(apiMocks.listHistory).toHaveBeenCalled());

    rerender(
      <I18nProvider>
        <ConfigHistoryPanel
          conn={conn({ provider: "consul" })}
          tenant="public"
          dataId="app.yaml"
          group="DEFAULT_GROUP"
          currentContent="server:\n  port: 1000"
          format="YAML"
        />
      </I18nProvider>
    );

    await waitFor(() => expect(screen.getByText(/本机历史（0）/)).toBeInTheDocument());
    expect(screen.queryByText(/历史版本（/)).not.toBeInTheDocument();
  });
});
