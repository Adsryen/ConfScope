/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { clearErrors } from "../lib/errorCenter";
import type { Connection } from "../store/connections";
import ConfigBrowser from "./ConfigBrowser";
import ErrorDialog from "./ErrorDialog";
import MessageCenter from "./MessageCenter";
import { getTaskManager } from "../lib/taskmanager";

const apiMocks = vi.hoisted(() => ({
  listConfigs: vi.fn(),
  getConfig: vi.fn(),
  publishConfig: vi.fn(),
  deleteConfig: vi.fn(),
}));

const snapshotMocks = vi.hoisted(() => ({
  createSnapshotFromConfigs: vi.fn(),
}));

vi.mock("../api/nacos", async () => {
  const actual = await vi.importActual<typeof import("../api/nacos")>("../api/nacos");
  return {
    ...actual,
    listConfigs: apiMocks.listConfigs,
    getConfig: apiMocks.getConfig,
    publishConfig: apiMocks.publishConfig,
    deleteConfig: apiMocks.deleteConfig,
  };
});

vi.mock("../api/snapshot", async () => {
  const actual = await vi.importActual<typeof import("../api/snapshot")>("../api/snapshot");
  return {
    ...actual,
    createSnapshotFromConfigs: snapshotMocks.createSnapshotFromConfigs,
  };
});

vi.mock("../lib/clipboard", () => ({
  copyText: vi.fn(),
}));

const conn: Connection = {
  id: "dev",
  name: "dev",
  baseUrl: "http://localhost:8848/nacos",
  username: "nacos",
  password: "nacos",
  defaultNamespace: "",
};

function configPage(items = [{ dataId: "app.json", group: "DEFAULT_GROUP", content: "", configType: "json" }]) {
  return {
    totalCount: items.length,
    pageNumber: 1,
    pagesAvailable: 1,
    pageItems: items,
  };
}

function renderBrowser() {
  localStorage.setItem("locale", "zh-CN");
  return render(
    <I18nProvider>
      <ConfigBrowser conn={conn} tenant="public" />
      <MessageCenter />
      <ErrorDialog />
    </I18nProvider>
  );
}

function clearTasks() {
  const manager = getTaskManager();
  for (const task of manager.listTasks()) {
    if (task.status === "running" || task.status === "pending") {
      manager.cancelTask(task.id);
    }
    manager.deleteTask(task.id);
  }
}

async function expectCodeContains(...parts: string[]) {
  await waitFor(() => {
    const code = document.querySelector(".code-area");
    expect(code).toBeInTheDocument();
    const text = code?.textContent ?? "";
    for (const part of parts) {
      expect(text).toContain(part);
    }
  });
}

describe("ConfigBrowser", () => {
  beforeEach(() => {
    localStorage.clear();
    clearErrors();
    apiMocks.listConfigs.mockReset();
    apiMocks.getConfig.mockReset();
    apiMocks.publishConfig.mockReset();
    apiMocks.deleteConfig.mockReset();
    snapshotMocks.createSnapshotFromConfigs.mockReset();
    clearTasks();
    apiMocks.listConfigs.mockResolvedValue(configPage());
    apiMocks.getConfig.mockResolvedValue('{"server":{"port":8080}}');
    apiMocks.publishConfig.mockResolvedValue(undefined);
    apiMocks.deleteConfig.mockResolvedValue(undefined);
    snapshotMocks.createSnapshotFromConfigs.mockResolvedValue({
      id: "snap-1",
      path: "C:\\Users\\tester\\.confscope\\backups\\snap-1",
      name: "dev_public_20260101",
      description: "",
      createdAt: "2026-01-01T10:00:00Z",
      updatedAt: "2026-01-01T10:00:00Z",
      source: {
        connectionId: "dev",
        connectionName: "dev",
        namespace: "public",
        namespaceId: "public",
      },
      configs: [],
    });
  });

  it("loads the config list and opens a selected config", async () => {
    renderBrowser();

    expect(await screen.findByText("app.json")).toBeInTheDocument();

    expect(apiMocks.listConfigs).toHaveBeenCalledWith(conn, "public", "", "", 1, 50);

    fireEvent.click(screen.getByText("app.json"));

    await expectCodeContains('"server"', '"port"', "8080");
    expect(apiMocks.getConfig).toHaveBeenCalledWith(conn, "public", "app.json", "DEFAULT_GROUP");
  });

  it("debounces search input and uses wildcard dataId query", async () => {
    renderBrowser();
    await screen.findByText("app.json");
    vi.useFakeTimers();

    fireEvent.change(document.querySelector(".browser-search input")!, { target: { value: "gateway" } });

    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    expect(apiMocks.listConfigs).toHaveBeenLastCalledWith(conn, "public", "*gateway*", "", 1, 50);
  });

  it("blocks publishing when edited content does not match the selected format", async () => {
    renderBrowser();
    fireEvent.click(await screen.findByText("app.json"));
    await expectCodeContains('"server"', '"port"', "8080");

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(document.querySelector("textarea")!, { target: { value: '{"server":' } });
    fireEvent.click(screen.getByRole("button", { name: "保存发布" }));

    expect(await screen.findByText("格式校验未通过")).toBeInTheDocument();
    expect(apiMocks.publishConfig).not.toHaveBeenCalled();
  });

  it("publishes edited content and reloads the selected config", async () => {
    apiMocks.getConfig.mockResolvedValueOnce('{"server":{"port":8080}}').mockResolvedValueOnce('{"server":{"port":9090}}');
    renderBrowser();
    fireEvent.click(await screen.findByText("app.json"));
    await expectCodeContains('"server"', '"port"', "8080");

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(document.querySelector("textarea")!, {
      target: { value: '{"server":{"port":9090}}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存发布" }));

    await waitFor(() => {
      expect(apiMocks.publishConfig).toHaveBeenCalledWith(conn, "public", "app.json", "DEFAULT_GROUP", '{"server":{"port":9090}}', "json");
    });
    await expectCodeContains('"server"', '"port"', "9090");
  });

  it("opens and cancels the delete confirmation", async () => {
    renderBrowser();
    fireEvent.click(await screen.findByText("app.json"));
    await expectCodeContains('"server"', '"port"', "8080");

    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    const dialog = screen.getByText("删除配置").closest(".modal")!;
    expect(dialog).toHaveTextContent("app.json");

    fireEvent.click(within(dialog as HTMLElement).getByRole("button", { name: "取消" }));

    expect(apiMocks.deleteConfig).not.toHaveBeenCalled();
    expect(screen.queryByText("删除配置")).not.toBeInTheDocument();
  });

  it("shows list loading failures inline and records them in the message center", async () => {
    const { copyText } = await import("../lib/clipboard");
    vi.mocked(copyText).mockResolvedValue(true);
    apiMocks.listConfigs.mockRejectedValueOnce(new Error("Nacos returned 403: Invalid signature"));

    renderBrowser();

    const inlineError = await screen.findByRole("alert");
    expect(inlineError).toHaveTextContent("操作失败");
    expect(inlineError).toHaveTextContent("Nacos returned 403: Invalid signature");

    await act(async () => {
      fireEvent.click(within(inlineError).getByRole("button", { name: "复制错误" }));
    });
    expect(copyText).toHaveBeenCalledWith("Error: Nacos returned 403: Invalid signature");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByTitle("消息中心"));

    const panel = document.querySelector(".message-panel") as HTMLElement;
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveTextContent("Nacos returned 403: Invalid signature");
    expect(panel).toHaveTextContent("dev / public");
  });

  it("shows config content loading failures inline with copy action", async () => {
    const { copyText } = await import("../lib/clipboard");
    vi.mocked(copyText).mockResolvedValue(true);
    apiMocks.getConfig.mockRejectedValueOnce(new Error("read config failed: EOF"));

    renderBrowser();
    fireEvent.click(await screen.findByText("app.json"));

    const inlineError = await screen.findByRole("alert");
    expect(inlineError).toHaveTextContent("read config failed: EOF");

    await act(async () => {
      fireEvent.click(within(inlineError).getByRole("button", { name: "复制错误" }));
    });
    expect(copyText).toHaveBeenCalledWith("Error: read config failed: EOF");
  });

  it("creates a snapshot from the current config page and records a backup task", async () => {
    const items = [
      { dataId: "app.json", group: "DEFAULT_GROUP", content: "", configType: "json" },
      { dataId: "db.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
    ];
    apiMocks.listConfigs.mockResolvedValue(configPage(items));
    apiMocks.getConfig.mockImplementation(async (_conn: Connection, _tenant: string, dataId: string) =>
      dataId === "app.json" ? '{"port":8080}' : "url: jdbc"
    );

    renderBrowser();
    await screen.findByText("app.json");

    fireEvent.click(screen.getByRole("button", { name: "创建快照" }));

    await waitFor(() => {
      expect(snapshotMocks.createSnapshotFromConfigs).toHaveBeenCalledWith("dev", "dev", "public", "public", [
        {
          dataId: "app.json",
          group: "DEFAULT_GROUP",
          content: '{"port":8080}',
          configType: "json",
          updateTime: "",
        },
        {
          dataId: "db.yaml",
          group: "DEFAULT_GROUP",
          content: "url: jdbc",
          configType: "yaml",
          updateTime: "",
        },
      ]);
    });

    const tasks = getTaskManager().listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      name: "创建快照：dev / public",
      type: "backup",
      status: "success",
      completed: 2,
      failed: 0,
      progress: 100,
      total: 2,
    });
  });
});
