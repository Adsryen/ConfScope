/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { toast } from "../lib/toast";
import type { Connection } from "../store/connections";
import HistoryView from "./HistoryView";

const apiMocks = vi.hoisted(() => ({
  listHistory: vi.fn(),
  getHistoryDetail: vi.fn(),
  publishConfig: vi.fn(),
}));

vi.mock("../api/nacos", async () => {
  const actual = await vi.importActual<typeof import("../api/nacos")>("../api/nacos");
  return {
    ...actual,
    listHistory: apiMocks.listHistory,
    getHistoryDetail: apiMocks.getHistoryDetail,
    publishConfig: apiMocks.publishConfig,
  };
});

vi.mock("../lib/toast", () => ({
  toast: vi.fn(),
}));

const conn: Connection = {
  id: "dev",
  name: "dev",
  baseUrl: "http://localhost:8848/nacos",
  username: "nacos",
  password: "nacos",
  defaultNamespace: "",
};

const historyItems = [
  {
    id: "2",
    dataId: "app.yaml",
    group: "DEFAULT_GROUP",
    opType: "U",
    lastModifiedTime: "2026-06-27 10:00:00",
  },
  {
    id: "1",
    dataId: "app.yaml",
    group: "DEFAULT_GROUP",
    opType: "I",
    lastModifiedTime: "2026-06-26 10:00:00",
  },
];

function renderHistory(props: Partial<Parameters<typeof HistoryView>[0]> = {}) {
  const onRolledBack = vi.fn();
  localStorage.setItem("locale", "zh-CN");
  return {
    onRolledBack,
    ...render(
      <I18nProvider>
        <HistoryView
          conn={conn}
          tenant="public"
          dataId="app.yaml"
          group="DEFAULT_GROUP"
          currentContent="server:\n  port: 9090"
          format="YAML"
          onRolledBack={onRolledBack}
          {...props}
        />
      </I18nProvider>
    ),
  };
}

function historyPage(items = historyItems) {
  return {
    totalCount: items.length,
    pageNumber: 1,
    pagesAvailable: 1,
    pageItems: items,
  };
}

function detail(nid: string, content: string) {
  return {
    id: nid,
    dataId: "app.yaml",
    group: "DEFAULT_GROUP",
    content,
    opType: nid === "1" ? "I" : "U",
    createdTime: "2026-06-27 10:00:00",
    lastModifiedTime: "2026-06-27 10:00:00",
  };
}

function mockHistoryDetail() {
  apiMocks.getHistoryDetail.mockImplementation(
    async (_conn: Connection, _tenant: string, _dataId: string, _group: string, nid: string) => {
      if (nid === "1") return detail("1", "server:\n  port: 8080");
      if (nid === "2") return detail("2", "server:\n  port: 9090");
      throw new Error(`missing nid ${nid}`);
    }
  );
}

describe("HistoryView", () => {
  beforeEach(() => {
    localStorage.clear();
    apiMocks.listHistory.mockReset();
    apiMocks.getHistoryDetail.mockReset();
    apiMocks.publishConfig.mockReset();
    vi.mocked(toast).mockReset();
    apiMocks.listHistory.mockResolvedValue(historyPage());
    apiMocks.publishConfig.mockResolvedValue(undefined);
    mockHistoryDetail();
  });

  it("loads history and shows the empty hint before a version is selected", async () => {
    renderHistory();

    expect(await screen.findByText("nid 2")).toBeInTheDocument();
    expect(screen.getByText("nid 1")).toBeInTheDocument();
    expect(screen.getByText("历史版本（2）")).toBeInTheDocument();
    expect(screen.getByText("点击左侧版本查看内容，或勾选版本进行对比")).toBeInTheDocument();
    expect(apiMocks.listHistory).toHaveBeenCalledWith(
      conn,
      "public",
      "app.yaml",
      "DEFAULT_GROUP",
      1,
      50
    );
  });

  it("opens a version and fetches its previous version for highlighted diff", async () => {
    renderHistory();

    fireEvent.click(await screen.findByText("nid 2"));

    expect(await screen.findByText(/相对上一版 nid 1 的变更/)).toBeInTheDocument();
    expect(apiMocks.getHistoryDetail).toHaveBeenCalledWith(
      conn,
      "public",
      "app.yaml",
      "DEFAULT_GROUP",
      "2"
    );
    expect(apiMocks.getHistoryDetail).toHaveBeenCalledWith(
      conn,
      "public",
      "app.yaml",
      "DEFAULT_GROUP",
      "1"
    );
    expect(await screen.findByText("~1 修改")).toBeInTheDocument();
  });

  it("compares a picked history version with current online content", async () => {
    renderHistory();

    const pickers = await screen.findAllByTitle("勾选用于对比");
    fireEvent.click(pickers[0]);

    expect(await screen.findByText(/nid 2/)).toBeInTheDocument();
    expect(screen.getByText("当前线上内容")).toBeInTheDocument();
    await waitFor(() => {
      expect(apiMocks.getHistoryDetail).toHaveBeenCalledWith(
        conn,
        "public",
        "app.yaml",
        "DEFAULT_GROUP",
        "2"
      );
    });
    expect(document.querySelector(".diff-panel")).toHaveTextContent("9090");
  });

  it("publishes the selected version again after rollback confirmation", async () => {
    const { onRolledBack } = renderHistory();

    fireEvent.click(await screen.findByText("nid 2"));
    await screen.findByText(/相对上一版 nid 1 的变更/);
    fireEvent.click(screen.getByRole("button", { name: "回滚" }));
    fireEvent.click(screen.getByRole("button", { name: "确认回滚?" }));

    await waitFor(() => {
      expect(apiMocks.publishConfig).toHaveBeenCalledWith(
        conn,
        "public",
        "app.yaml",
        "DEFAULT_GROUP",
        "server:\n  port: 9090",
        "yaml"
      );
    });
    expect(onRolledBack).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith("已回滚到版本 2");
    expect(apiMocks.listHistory).toHaveBeenCalledTimes(2);
  });
});
