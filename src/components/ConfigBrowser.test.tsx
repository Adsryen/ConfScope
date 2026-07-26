/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { clearErrors, subscribeErrors, type AppErrorItem } from "../lib/errorCenter";
import type { ConfigItem } from "../api/nacos";
import type { Connection } from "../store/connections";
import { loadOperationHistory } from "../store/operationHistory";
import ConfigBrowser from "./ConfigBrowser";
import ErrorDialog from "./ErrorDialog";
import MessageCenter from "./MessageCenter";
import { getTaskManager } from "../lib/taskmanager";

const apiMocks = vi.hoisted(() => ({
  listConfigs: vi.fn(),
  getConfig: vi.fn(),
  getConfigDocument: vi.fn(),
  publishConfig: vi.fn(),
  deleteConfig: vi.fn(),
}));

const snapshotMocks = vi.hoisted(() => ({
  createSnapshotFromConfigs: vi.fn(),
}));

const appApiMocks = vi.hoisted(() => ({
  selectConfigSourceExportDirectory: vi.fn(),
  exportConfigSourceFiles: vi.fn(),
}));

vi.mock("../api/nacos", async () => {
  const actual = await vi.importActual<typeof import("../api/nacos")>("../api/nacos");
  return {
    ...actual,
    listConfigs: apiMocks.listConfigs,
    getConfig: apiMocks.getConfig,
    getConfigDocument: apiMocks.getConfigDocument,
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

vi.mock("../api/app", async () => {
  const actual = await vi.importActual<typeof import("../api/app")>("../api/app");
  return {
    ...actual,
    selectConfigSourceExportDirectory: appApiMocks.selectConfigSourceExportDirectory,
    exportConfigSourceFiles: appApiMocks.exportConfigSourceFiles,
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

const localConn: Connection = {
  ...conn,
  id: "local-prod",
  name: "local-prod",
  sourceName: "本地快照",
  sourceType: "local-snapshot",
  provider: "local",
  localPath: "C:\\backup\\prod",
  baseUrl: "C:\\backup\\prod",
  username: "",
  password: "",
};

function configPage(items: ConfigItem[] = [{ dataId: "app.json", group: "DEFAULT_GROUP", content: "", configType: "json" }]) {
  return {
    totalCount: items.length,
    pageNumber: 1,
    pagesAvailable: 1,
    pageItems: items,
  };
}

function renderBrowser(locale = "zh-CN", browserConn: Connection = conn, tenant = "public") {
  localStorage.setItem("locale", locale);
  return render(
    <I18nProvider>
      <ConfigBrowser conn={browserConn} tenant={tenant} />
      <MessageCenter />
      <ErrorDialog />
    </I18nProvider>
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
    apiMocks.getConfigDocument.mockReset();
    apiMocks.publishConfig.mockReset();
    apiMocks.deleteConfig.mockReset();
    snapshotMocks.createSnapshotFromConfigs.mockReset();
    appApiMocks.selectConfigSourceExportDirectory.mockReset();
    appApiMocks.exportConfigSourceFiles.mockReset();
    Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:confscope-test"), configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
    Object.defineProperty(HTMLAnchorElement.prototype, "click", { value: vi.fn(), configurable: true });
    clearTasks();
    apiMocks.listConfigs.mockResolvedValue(configPage());
    apiMocks.getConfig.mockResolvedValue('{"server":{"port":8080}}');
    apiMocks.getConfigDocument.mockResolvedValue({
      content: '{"server":{"port":8080}}',
      format: "json",
      version: "",
      source: "nacos",
      updateTime: "",
    });
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
    appApiMocks.selectConfigSourceExportDirectory.mockResolvedValue("C:\\exports\\nacos");
    appApiMocks.exportConfigSourceFiles.mockResolvedValue({ path: "C:\\exports\\nacos", configCount: 1 });
  });

  it("browses local snapshot configs as read-only and shows metadata", async () => {
    apiMocks.listConfigs.mockResolvedValue(
      configPage([
        {
          dataId: "app.yaml",
          group: "DEFAULT_GROUP",
          content: "",
          configType: "yaml",
          updateTime: "2026-07-06T10:00:00Z",
        },
      ])
    );
    apiMocks.getConfigDocument.mockResolvedValueOnce({
      content: "server:\n  port: 8080",
      format: "yaml",
      version: "snap_123",
      source: "C:\\backup\\prod\\configs\\public\\DEFAULT_GROUP\\app.yaml",
      updateTime: "2026-07-06T10:00:00Z",
    });

    renderBrowser("zh-CN", localConn, "");

    fireEvent.click(await screen.findByText("app.yaml"));

    await expectCodeContains("server", "port", "8080");
    expect(apiMocks.listConfigs).toHaveBeenCalledWith(localConn, "", "", "", 1, 50);
    expect(apiMocks.getConfigDocument).toHaveBeenCalledWith(localConn, "", "app.yaml", "DEFAULT_GROUP");

    expect(screen.queryByTitle("新建配置")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "历史变更" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "创建当前列表快照" })).not.toBeInTheDocument();
    expect(screen.getByTitle("导出当前列表")).toBeInTheDocument();

    expect(screen.getByText("更新时间")).toBeInTheDocument();
    expect(screen.getByText("2026-07-06T10:00:00Z")).toBeInTheDocument();
    expect(screen.getByText("版本")).toBeInTheDocument();
    expect(screen.getByText("snap_123")).toBeInTheDocument();
    expect(screen.getByText("来源")).toBeInTheDocument();
    expect(screen.getByText("C:\\backup\\prod\\configs\\public\\DEFAULT_GROUP\\app.yaml")).toBeInTheDocument();
  });

  it("loads the config list and opens a selected config", async () => {
    renderBrowser();

    expect(await screen.findByText("app.json")).toBeInTheDocument();

    expect(apiMocks.listConfigs).toHaveBeenCalledWith(conn, "public", "", "", 1, 50);

    fireEvent.click(screen.getByText("app.json"));

    await expectCodeContains('"server"', '"port"', "8080");
    expect(apiMocks.getConfigDocument).toHaveBeenCalledWith(conn, "public", "app.json", "DEFAULT_GROUP");
  });

  it("filters the config list by selected group", async () => {
    apiMocks.listConfigs.mockImplementation(async (_conn: Connection, _tenant: string, _dataId: string, group: string) => {
      const allItems = [
        { dataId: "app.json", group: "DEFAULT_GROUP", content: "", configType: "json" },
        { dataId: "gateway.yaml", group: "DEV_GROUP", content: "", configType: "yaml" },
      ];
      const items = group ? allItems.filter((item) => item.group === group) : allItems;
      return configPage(items);
    });

    renderBrowser();

    expect(await screen.findByText("app.json")).toBeInTheDocument();
    expect(await screen.findByText("gateway.yaml")).toBeInTheDocument();

    fireEvent.click(within(screen.getByTitle("分组")).getByRole("button"));
    fireEvent.mouseDown(await screen.findByText("DEV_GROUP"));

    await waitFor(() => {
      expect(apiMocks.listConfigs).toHaveBeenLastCalledWith(conn, "public", "", "DEV_GROUP", 1, 50);
    });
    expect(await screen.findByText("gateway.yaml")).toBeInTheDocument();
    expect(screen.queryByText("app.json")).not.toBeInTheDocument();

    fireEvent.click(within(screen.getByTitle("分组")).getByRole("button"));
    fireEvent.mouseDown(await screen.findByText("全部分组"));

    await waitFor(() => {
      expect(apiMocks.listConfigs).toHaveBeenLastCalledWith(conn, "public", "", "", 1, 50);
    });
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

  it("blocks edited content direct publish before it can reach the API", async () => {
    apiMocks.getConfigDocument
      .mockResolvedValueOnce({
        content: '{"server":{"port":8080}}',
        format: "json",
        version: "",
        source: "nacos",
        updateTime: "",
      })
      .mockResolvedValueOnce({
        content: '{"server":{"port":9090}}',
        format: "json",
        version: "",
        source: "nacos",
        updateTime: "",
      });
    renderBrowser("en-US");
    fireEvent.click(await screen.findByText("app.json"));
    await expectCodeContains('"server"', '"port"', "8080");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(document.querySelector("textarea")!, {
      target: { value: '{"server":{"port":9090}}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save & Publish" }));

    expect(await screen.findByText("Direct config writes are disabled. Generate and execute a configuration change plan instead.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy Error" })).toBeInTheDocument();
    expect(apiMocks.publishConfig).not.toHaveBeenCalled();
    expect(apiMocks.getConfigDocument).toHaveBeenCalledTimes(1);

    expect(loadOperationHistory()[0]).toMatchObject({
      type: "publish",
      result: "failure",
      dataId: "app.json",
      beforeContent: '{"server":{"port":8080}}',
      afterContent: '{"server":{"port":9090}}',
      rollbackable: false,
      rollbackReason: "operationHistory.rollbackOnlySuccess",
      error: "Direct config writes are disabled. Generate and execute a configuration change plan instead.",
    });
  });

  it("records direct publish blocks with the attempted content", async () => {
    renderBrowser("en-US");
    fireEvent.click(await screen.findByText("app.json"));
    await expectCodeContains('"server"', '"port"', "8080");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(document.querySelector("textarea")!, {
      target: { value: '{"server":{"port":9090}}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save & Publish" }));

    expect(await screen.findByText("Direct config writes are disabled. Generate and execute a configuration change plan instead.")).toBeInTheDocument();
    expect(apiMocks.publishConfig).not.toHaveBeenCalled();
    expect(loadOperationHistory()[0]).toMatchObject({
      type: "publish",
      result: "failure",
      dataId: "app.json",
      beforeContent: '{"server":{"port":8080}}',
      afterContent: '{"server":{"port":9090}}',
      rollbackable: false,
      error: "Direct config writes are disabled. Generate and execute a configuration change plan instead.",
    });
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

  it("blocks direct delete before it can reach the API", async () => {
    renderBrowser("en-US");
    fireEvent.click(await screen.findByText("app.json"));
    await expectCodeContains('"server"', '"port"', "8080");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByText("Delete Configuration").closest(".modal") as HTMLElement;
    fireEvent.change(within(dialog).getByPlaceholderText("app.json"), { target: { value: "app.json" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await within(dialog).findByText("Direct config writes are disabled. Generate and execute a configuration change plan instead.")).toBeInTheDocument();
    expect(apiMocks.deleteConfig).not.toHaveBeenCalled();
    expect(loadOperationHistory()[0]).toMatchObject({
      type: "delete",
      result: "failure",
      dataId: "app.json",
      beforeContent: '{"server":{"port":8080}}',
      rollbackable: false,
      rollbackReason: "operationHistory.rollbackOnlySuccess",
      error: "Direct config writes are disabled. Generate and execute a configuration change plan instead.",
    });
  });

  it("records current list export as not rollbackable", async () => {
    renderBrowser();
    await screen.findByText("app.json");

    fireEvent.click(screen.getByTitle("导出当前列表"));

    const tasks = getTaskManager().listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      name: "导出当前列表：dev / public",
      type: "export",
      status: "success",
      completed: 1,
      failed: 0,
      progress: 100,
      total: 1,
      scope: "dev / public / 1 项配置",
      cancellable: false,
    });
    expect(loadOperationHistory()[0]).toMatchObject({
      type: "export",
      result: "success",
      connectionId: "dev",
      namespace: "public",
      group: "*",
      dataId: "*",
      rollbackable: false,
      rollbackReason: "operationHistory.rollbackExportOnly",
    });
  });

  it("exports current list as source files to a selected directory", async () => {
    apiMocks.listConfigs.mockResolvedValue(
      configPage([{ dataId: "service/app.yaml", group: "DEFAULT_GROUP", content: "server:\n  port: 8080\n", configType: "yaml" }])
    );

    renderBrowser();
    await screen.findByText("service/app.yaml");

    fireEvent.click(screen.getByTitle("导出源文件到目录"));

    await waitFor(() => {
      expect(appApiMocks.selectConfigSourceExportDirectory).toHaveBeenCalled();
      expect(appApiMocks.exportConfigSourceFiles).toHaveBeenCalledWith(
        "C:\\exports\\nacos",
        expect.objectContaining({
          connectionId: "dev",
          connectionName: "dev",
          namespace: "public",
          namespaceId: "public",
        }),
        [
          expect.objectContaining({
            dataId: "service/app.yaml",
            group: "DEFAULT_GROUP",
            content: "server:\n  port: 8080\n",
            contentType: "yaml",
          }),
        ]
      );
    });
    expect(loadOperationHistory()[0]).toMatchObject({
      type: "export",
      result: "success",
      resourceName: "导出源文件到目录",
      rollbackable: false,
    });
  });

  it("records current list export failures with copyable error detail", async () => {
    vi.mocked(URL.createObjectURL).mockImplementationOnce(() => {
      throw new Error("download denied");
    });

    renderBrowser();
    await screen.findByText("app.json");

    fireEvent.click(screen.getByTitle("导出当前列表"));

    await waitFor(() => {
      expect(loadOperationHistory()[0]).toMatchObject({
        type: "export",
        result: "failure",
        connectionId: "dev",
        namespace: "public",
        group: "*",
        dataId: "*",
        rollbackable: false,
        error: "Error: download denied",
      });
      expect(latestError()).toMatchObject({
        title: "导出当前列表",
        message: "Error: download denied",
        detail: "Error: download denied",
      });
    });

    const tasks = getTaskManager().listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      name: "导出当前列表：dev / public",
      type: "export",
      status: "failed",
      failed: 1,
      total: 1,
      scope: "dev / public / 1 项配置",
      cancellable: false,
      error: "Error: download denied",
    });
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

  it("reports list loading errors with localized message-center actions", async () => {
    apiMocks.listConfigs.mockRejectedValueOnce(new Error("list denied"));

    renderBrowser("en-US");

    expect(await screen.findByText("Error: list denied")).toBeInTheDocument();
    expect(latestError()).toMatchObject({
      title: "Failed to load config list",
      actionLabel: "Retry",
    });
  });

  it("shows config content loading failures inline with copy action", async () => {
    const { copyText } = await import("../lib/clipboard");
    vi.mocked(copyText).mockResolvedValue(true);
    apiMocks.getConfigDocument.mockRejectedValueOnce(new Error("read config failed: EOF"));

    renderBrowser();
    fireEvent.click(await screen.findByText("app.json"));

    const inlineError = await screen.findByRole("alert");
    expect(inlineError).toHaveTextContent("read config failed: EOF");

    await act(async () => {
      fireEvent.click(within(inlineError).getByRole("button", { name: "复制错误" }));
    });
    expect(copyText).toHaveBeenCalledWith("Error: read config failed: EOF");
  });

  it("reports content loading errors with localized message-center actions", async () => {
    apiMocks.getConfigDocument.mockRejectedValueOnce(new Error("content denied"));

    renderBrowser("en-US");
    fireEvent.click(await screen.findByText("app.json"));

    expect(await screen.findByText("Error: content denied")).toBeInTheDocument();
    expect(latestError()).toMatchObject({
      title: "Failed to load config content",
      actionLabel: "Retry",
    });
  });

  it("reports direct publish blocks with localized message-center actions", async () => {
    renderBrowser("en-US");
    fireEvent.click(await screen.findByText("app.json"));
    await expectCodeContains('"server"', '"port"', "8080");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(document.querySelector("textarea")!, {
      target: { value: '{"server":{"port":9090}}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save & Publish" }));

    expect(await screen.findByText("Direct config writes are disabled. Generate and execute a configuration change plan instead.")).toBeInTheDocument();
    expect(apiMocks.publishConfig).not.toHaveBeenCalled();
    expect(latestError()).toMatchObject({
      title: "Failed to publish config",
      message: "Direct config writes are disabled. Generate and execute a configuration change plan instead.",
      actionLabel: "Retry Publish",
    });
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

    fireEvent.click(screen.getByRole("button", { name: "创建当前列表快照" }));

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
      name: "创建当前列表快照：dev / public",
      type: "backup",
      status: "success",
      completed: 2,
      failed: 0,
      progress: 100,
      total: 2,
      scope: "dev / public / 2 项配置",
      cancellable: false,
    });
    expect(loadOperationHistory()[0]).toMatchObject({
      type: "snapshot",
      result: "success",
      connectionId: "dev",
      namespace: "public",
      group: "*",
      dataId: "*",
      resourceId: "snap-1",
      resourceName: "dev_public_20260101",
      rollbackable: false,
      rollbackReason: "operationHistory.rollbackSnapshotOnly",
    });
  });
});
