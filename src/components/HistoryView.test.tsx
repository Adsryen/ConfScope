/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { clearErrors, subscribeErrors, type AppErrorItem } from "../lib/errorCenter";
import { toast } from "../lib/toast";
import type { Connection } from "../store/connections";
import { loadOperationHistory } from "../store/operationHistory";
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

function renderHistory(props: Partial<Parameters<typeof HistoryView>[0]> = {}, locale = "zh-CN") {
  const onRolledBack = vi.fn();
  localStorage.setItem("locale", locale);
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

function latestError(): AppErrorItem | undefined {
  let errors: AppErrorItem[] = [];
  const unsubscribe = subscribeErrors((items) => {
    errors = items;
  });
  unsubscribe();
  return errors[errors.length - 1];
}

describe("HistoryView", () => {
  beforeEach(() => {
    localStorage.clear();
    clearErrors();
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

  it("localizes history operation type labels", async () => {
    apiMocks.listHistory.mockResolvedValueOnce(
      historyPage([
        { ...historyItems[0], opType: "U" },
        { ...historyItems[1], opType: "I" },
        { ...historyItems[1], id: "0", opType: "D" },
      ])
    );

    renderHistory({}, "en-US");

    expect(await screen.findByText("Updated")).toBeInTheDocument();
    expect(screen.getByText("Created")).toBeInTheDocument();
    expect(screen.getByText("Deleted")).toBeInTheDocument();
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

  it("blocks direct history rollback before it can reach the API", async () => {
    const { onRolledBack } = renderHistory({ currentContent: "server:\n  port: 1000" }, "en-US");

    fireEvent.click(await screen.findByText("nid 2"));
    await screen.findByText(/Changes vs previous nid 1/);
    fireEvent.click(screen.getByRole("button", { name: "Rollback" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm rollback?" }));

    expect(await screen.findByText("Direct config writes are disabled. Generate and execute a configuration change plan instead.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy Error" })).toBeInTheDocument();
    expect(apiMocks.publishConfig).not.toHaveBeenCalled();
    expect(onRolledBack).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalledWith("Rolled back to version 2");
    expect(apiMocks.listHistory).toHaveBeenCalledTimes(1);
    expect(loadOperationHistory()[0]).toMatchObject({
      type: "rollback",
      result: "failure",
      dataId: "app.yaml",
      beforeContent: "server:\n  port: 1000",
      afterContent: "server:\n  port: 9090",
      rollbackable: false,
      rollbackReason: "operationHistory.rollbackOnlySuccess",
      resourceId: "2",
      error: "Direct config writes are disabled. Generate and execute a configuration change plan instead.",
    });
  });

  it("records direct history rollback blocks", async () => {
    renderHistory({ currentContent: "server:\n  port: 1000" }, "en-US");

    fireEvent.click(await screen.findByText("nid 2"));
    await screen.findByText(/Changes vs previous nid 1/);
    fireEvent.click(screen.getByRole("button", { name: "Rollback" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm rollback?" }));

    expect(await screen.findByText("Direct config writes are disabled. Generate and execute a configuration change plan instead.")).toBeInTheDocument();
    expect(apiMocks.publishConfig).not.toHaveBeenCalled();
    expect(loadOperationHistory()[0]).toMatchObject({
      type: "rollback",
      result: "failure",
      dataId: "app.yaml",
      beforeContent: "server:\n  port: 1000",
      afterContent: "server:\n  port: 9090",
      rollbackable: false,
      error: "Direct config writes are disabled. Generate and execute a configuration change plan instead.",
    });
  });

  it("reports history list errors with localized message-center actions", async () => {
    apiMocks.listHistory.mockRejectedValueOnce(new Error("history denied"));
    renderHistory({}, "en-US");

    expect(await screen.findByText("Error: history denied")).toBeInTheDocument();
    expect(latestError()).toMatchObject({
      title: "Failed to load history versions",
      actionLabel: "Retry",
    });
  });

  it("reports history content errors with localized message-center titles", async () => {
    apiMocks.getHistoryDetail.mockRejectedValueOnce(new Error("detail denied"));
    renderHistory({}, "en-US");

    fireEvent.click(await screen.findByText("nid 2"));

    expect(await screen.findByText("Error: detail denied")).toBeInTheDocument();
    expect(latestError()).toMatchObject({
      title: "Failed to load history content",
    });
  });

  it("reports direct rollback blocks with localized message-center actions", async () => {
    renderHistory({ currentContent: "server:\n  port: 1000" }, "en-US");

    fireEvent.click(await screen.findByText("nid 2"));
    await screen.findByText(/Changes vs previous nid 1/);
    fireEvent.click(screen.getByRole("button", { name: "Rollback" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm rollback?" }));

    expect(await screen.findByText("Direct config writes are disabled. Generate and execute a configuration change plan instead.")).toBeInTheDocument();
    expect(apiMocks.publishConfig).not.toHaveBeenCalled();
    expect(latestError()).toMatchObject({
      title: "Failed to rollback config",
      message: "Direct config writes are disabled. Generate and execute a configuration change plan instead.",
      actionLabel: "Retry Rollback",
    });
  });
});
