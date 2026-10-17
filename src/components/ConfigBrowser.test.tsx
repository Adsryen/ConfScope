/**
 * @vitest-environment jsdom
 */
import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { clearErrors, subscribeErrors, type AppErrorItem } from "../lib/errorCenter";
import type { ConfigItem } from "../api/nacos";
import type { Connection } from "../store/connections";
import { loadOperationHistory } from "../store/operationHistory";
import { EscapePriority, useEscape } from "../lib/useEscape";
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

function renderBrowser(
  locale = "zh-CN",
  browserConn: Connection = conn,
  tenant = "public",
  options: { connections?: Connection[]; onStartApply?: (payload: import("../lib/applyEntry").ApplyEntryPayload) => void } = {}
) {
  localStorage.setItem("locale", locale);
  return render(
    <I18nProvider>
      <ConfigBrowser conn={browserConn} tenant={tenant} connections={options.connections} onStartApply={options.onStartApply} />
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

/**
 * 其他模式（应用计划/设置等）里一个低优先级的 Esc 响应者，
 * 用来验证被保活隐藏的配置浏览不会替它吃掉按键。
 */
function OtherModeDropdown({ onClose }: { onClose: () => void }) {
  useEscape(true, onClose, EscapePriority.dropdown);
  return <div data-testid="other-mode-dropdown" />;
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

    fireEvent.pointerDown(within(screen.getByTitle("分组")).getByRole("button"));
    fireEvent.mouseDown(await screen.findByText("DEV_GROUP"));

    await waitFor(() => {
      expect(apiMocks.listConfigs).toHaveBeenLastCalledWith(conn, "public", "", "DEV_GROUP", 1, 50);
    });
    expect(await screen.findByText("gateway.yaml")).toBeInTheDocument();
    expect(screen.queryByText("app.json")).not.toBeInTheDocument();

    fireEvent.pointerDown(within(screen.getByTitle("分组")).getByRole("button"));
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

  it("searches all config content and creates a manual batch plan for a sandbox target", async () => {
    const sandboxConn: Connection = {
      ...conn,
      id: "sandbox",
      name: "sandbox",
      projectName: "订单",
      environmentName: "Sandbox",
      sourceName: "云上",
      baseUrl: "http://sandbox.example.com/nacos",
    };
    const sourceConn: Connection = { ...conn, projectName: "订单", environmentName: "Development", sourceName: "云上" };
    const onStartApply = vi.fn();
    apiMocks.listConfigs.mockResolvedValue(
      configPage([{ dataId: "gateway.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" }])
    );
    apiMocks.getConfigDocument.mockResolvedValue({
      content: "gateway:\n  host: dev.internal\n",
      format: "yaml",
      version: "v1",
      source: "nacos",
      updateTime: "2026-08-11T00:00:00Z",
    });

    renderBrowser("zh-CN", sourceConn, "public", { connections: [sourceConn, sandboxConn], onStartApply });

    fireEvent.click(screen.getByRole("button", { name: "内容" }));
    const searchInput = document.querySelector(".browser-search input") as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: "dev.internal" } });
    // 输入即搜：400ms 防抖后自动发起内容搜索（无需 Enter）
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    expect(apiMocks.getConfigDocument).toHaveBeenCalledWith(sourceConn, "public", "gateway.yaml", "DEFAULT_GROUP");

    // 摘要与正文命中词高亮
    await waitFor(() => {
      const marks = document.querySelectorAll(".browser-item-summary .search-hit, .code-area .search-hit");
      expect(marks.length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByRole("button", { name: "批量替换" }));
    fireEvent.change(screen.getByLabelText("替换为"), { target: { value: "sandbox.internal" } });
    expect(screen.getByText("将影响 1 个配置，共 1 处替换")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "选择应用目标" }));

    expect(await screen.findByText("当前来源")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "生成变更计划（1 项）" }));

    expect(onStartApply).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: "manual",
        scope: "batch",
        target: expect.objectContaining({ connectionId: "sandbox", namespace: "public" }),
        items: [
          expect.objectContaining({
            sourceValueOverride: expect.objectContaining({ content: "gateway:\n  host: sandbox.internal\n" }),
          }),
        ],
      })
    );
    expect(apiMocks.publishConfig).not.toHaveBeenCalled();
  });

  it("allows the source connection itself as an apply target (in-place batch replace)", async () => {
    const sourceConn: Connection = { ...conn, projectName: "订单", environmentName: "Development", sourceName: "云上" };
    const onStartApply = vi.fn();
    apiMocks.listConfigs.mockResolvedValue(
      configPage([{ dataId: "gateway.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" }])
    );
    apiMocks.getConfigDocument.mockResolvedValue({
      content: "gateway:\n  host: dev.internal\n",
      format: "yaml",
      version: "v1",
      source: "nacos",
      updateTime: "2026-08-11T00:00:00Z",
    });

    renderBrowser("zh-CN", sourceConn, "public", { connections: [sourceConn], onStartApply });

    fireEvent.click(screen.getByRole("button", { name: "内容" }));
    const searchInput = document.querySelector(".browser-search input") as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: "dev.internal" } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });

    fireEvent.click(screen.getByRole("button", { name: "批量替换" }));
    fireEvent.change(screen.getByLabelText("替换为"), { target: { value: "local.internal" } });
    expect(screen.getByText("将影响 1 个配置，共 1 处替换")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "选择应用目标" }));

    // 目标下拉里应出现来源连接本身，并带"来源"标记
    await screen.findByText("当前来源");
    const field = screen.getByText("目标来源").closest(".field") as HTMLElement;
    fireEvent.click(field.querySelector("button") as HTMLButtonElement);
    const option = await screen.findAllByText(/订单 \/ Development \/ 云上 · 来源/);
    expect(option.some((el) => el.classList.contains("sel-option"))).toBe(true);

    // 默认选中唯一候选（来源连接）即可生成计划：target.connectionId === 来源
    fireEvent.click(screen.getByRole("button", { name: "生成变更计划（1 项）" }));
    expect(onStartApply).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: "manual",
        scope: "batch",
        source: expect.objectContaining({ connectionId: "dev" }),
        target: expect.objectContaining({ connectionId: "dev", namespace: "public" }),
        items: [
          expect.objectContaining({
            sourceValueOverride: expect.objectContaining({ content: "gateway:\n  host: local.internal\n" }),
          }),
        ],
      })
    );
    expect(apiMocks.publishConfig).not.toHaveBeenCalled();
  });

  it("searches content across every config-list page", async () => {
    apiMocks.listConfigs.mockImplementation(async (_conn: Connection, _tenant: string, _dataId: string, _group: string, page: number) => ({
      totalCount: 2,
      pageNumber: page,
      pagesAvailable: 2,
      pageItems:
        page === 1
          ? [{ dataId: "first.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" }]
          : [{ dataId: "second.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" }],
    }));
    apiMocks.getConfigDocument.mockImplementation(async (_conn: Connection, _tenant: string, dataId: string) => ({
      content: dataId === "second.yaml" ? "service: remembered-value" : "service: other",
      format: "yaml",
      version: "v1",
      source: "nacos",
      updateTime: "2026-08-11T00:00:00Z",
    }));

    renderBrowser();
    fireEvent.click(screen.getByRole("button", { name: "内容" }));
    const searchInput = document.querySelector(".browser-search input") as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: "remembered-value" } });
    fireEvent.keyDown(searchInput, { key: "Enter" });

    expect(await screen.findByText("second.yaml")).toBeInTheDocument();
    expect(apiMocks.listConfigs).toHaveBeenCalledWith(conn, "public", "", "", 2, 50);
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

    expect(
      await screen.findByText("Direct config writes are disabled. Generate and execute a configuration change plan instead.")
    ).toBeInTheDocument();
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

    expect(
      await screen.findByText("Direct config writes are disabled. Generate and execute a configuration change plan instead.")
    ).toBeInTheDocument();
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

    expect(
      await within(dialog).findByText("Direct config writes are disabled. Generate and execute a configuration change plan instead.")
    ).toBeInTheDocument();
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
        error: "download denied",
      });
      expect(latestError()).toMatchObject({
        title: "导出当前列表",
        message: "download denied",
        detail: "download denied",
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
      error: "download denied",
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
    expect(copyText).toHaveBeenCalledWith("Nacos returned 403: Invalid signature");

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

    expect(await screen.findByText("list denied")).toBeInTheDocument();
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
    expect(copyText).toHaveBeenCalledWith("read config failed: EOF");
  });

  it("reports content loading errors with localized message-center actions", async () => {
    apiMocks.getConfigDocument.mockRejectedValueOnce(new Error("content denied"));

    renderBrowser("en-US");
    fireEvent.click(await screen.findByText("app.json"));

    expect(await screen.findByText("content denied")).toBeInTheDocument();
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

    expect(
      await screen.findByText("Direct config writes are disabled. Generate and execute a configuration change plan instead.")
    ).toBeInTheDocument();
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

  // ── 未保存改动守卫与弹层 Esc 分层（2026-10-17 扫描 R2 / R7）──

  async function enterEditMode(editedValue = '{"server":{"port":9090}}') {
    renderBrowser();
    fireEvent.click(await screen.findByText("app.json"));
    await expectCodeContains('"server"', '"port"', "8080");
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    await waitFor(() => expect(document.querySelector("textarea")).toBeInTheDocument());
    if (editedValue) fireEvent.change(document.querySelector("textarea")!, { target: { value: editedValue } });
  }

  async function openReplaceFlow() {
    const sandboxConn: Connection = {
      ...conn,
      id: "sandbox",
      name: "sandbox",
      projectName: "订单",
      environmentName: "Sandbox",
      sourceName: "云上",
      baseUrl: "http://sandbox.example.com/nacos",
    };
    const sourceConn: Connection = { ...conn, projectName: "订单", environmentName: "Development", sourceName: "云上" };
    apiMocks.listConfigs.mockResolvedValue(
      configPage([{ dataId: "gateway.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" }])
    );
    apiMocks.getConfigDocument.mockResolvedValue({
      content: "gateway:\n  host: dev.internal\n",
      format: "yaml",
      version: "v1",
      source: "nacos",
      updateTime: "2026-08-11T00:00:00Z",
    });
    renderBrowser("zh-CN", sourceConn, "public", { connections: [sourceConn, sandboxConn], onStartApply: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: "内容" }));
    const searchInput = document.querySelector(".browser-search input") as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: "dev.internal" } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    fireEvent.click(await screen.findByRole("button", { name: "批量替换" }));
    await waitFor(() => expect(document.querySelector(".browser-replace-modal")).toBeInTheDocument());
  }

  it("asks before discarding unsaved edits when Escape is pressed", async () => {
    await enterEditMode();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(await screen.findByText("放弃未保存的修改？")).toBeInTheDocument();

    // 留在当前 → 仍是编辑态，草稿不丢
    fireEvent.click(screen.getByRole("button", { name: "留在当前" }));
    await waitFor(() => expect(screen.queryByText("放弃未保存的修改？")).not.toBeInTheDocument());
    expect(document.querySelector("textarea")).toHaveValue('{"server":{"port":9090}}');

    // 放弃并切换 → 退出编辑态
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(await screen.findByRole("button", { name: "放弃并切换" }));
    await waitFor(() => expect(document.querySelector("textarea")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "编辑" })).toBeInTheDocument();
  });

  it("asks before discarding unsaved edits when the cancel button is clicked", async () => {
    await enterEditMode();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(await screen.findByText("放弃未保存的修改？")).toBeInTheDocument();
    expect(document.querySelector("textarea")).toHaveValue('{"server":{"port":9090}}');

    fireEvent.click(screen.getByRole("button", { name: "放弃并切换" }));
    await waitFor(() => expect(document.querySelector("textarea")).not.toBeInTheDocument());
  });

  it("leaves editing on Escape without confirmation when nothing changed", async () => {
    await enterEditMode("");

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(document.querySelector("textarea")).not.toBeInTheDocument());
    expect(screen.queryByText("放弃未保存的修改？")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑" })).toBeInTheDocument();
  });

  it("keeps the validation alert above the editing guard when Escape is pressed", async () => {
    await enterEditMode('{"server":');
    fireEvent.click(screen.getByRole("button", { name: "保存发布" }));
    expect(await screen.findByText("格式校验未通过")).toBeInTheDocument();

    // 校验提示打开时 Esc 只关提示，不应连带退出编辑态
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("格式校验未通过")).not.toBeInTheDocument());
    expect(document.querySelector("textarea")).toHaveValue('{"server":');

    // 提示关闭后 Esc 才回到编辑守卫
    fireEvent.keyDown(window, { key: "Escape" });
    expect(await screen.findByText("放弃未保存的修改？")).toBeInTheDocument();
  });

  it("校验错误带「跳到第 N 行」：点一下就把选区落到出错行（R28）", async () => {
    const broken = '{\n  "a": 1\n  "b": 2\n}';
    await enterEditMode(broken);
    fireEvent.click(screen.getByRole("button", { name: "保存发布" }));

    const jump = await screen.findByRole("button", { name: /跳到第 \d+ 行/ });
    fireEvent.click(jump);

    await waitFor(() => expect(screen.queryByText("格式校验未通过")).not.toBeInTheDocument());
    const ta = document.querySelector("textarea") as HTMLTextAreaElement;
    // 跳转只动选区与滚动，草稿内容一个字符都不能变
    expect(ta.value).toBe(broken);
    const line = Number.parseInt(/跳到第 (\d+) 行/.exec(jump.textContent ?? "")?.[1] ?? "", 10);
    const rows = broken.split("\n");
    const start = rows.slice(0, line - 1).reduce((acc, row) => acc + row.length + 1, 0);
    expect(ta.selectionStart).toBe(start);
    expect(ta.value.slice(ta.selectionStart, ta.selectionEnd)).toBe(rows[line - 1]);
  });

  // ── 保活隐藏（R8 / D3）：整页只是 hidden，不卸载 ──

  /** 受控外壳：rerender 切 active，模拟 App 把配置浏览整页隐藏 / 显示。 */
  function renderBrowserShell(extra?: ReactNode) {
    localStorage.setItem("locale", "zh-CN");
    const tree = (active: boolean) => (
      <I18nProvider>
        <ConfigBrowser conn={conn} tenant="public" active={active} />
        {extra}
        <MessageCenter />
        <ErrorDialog />
      </I18nProvider>
    );
    const view = render(tree(true));
    return {
      setActive: (active: boolean) => view.rerender(tree(active)),
      openEditorWithDraft: async (draft = '{"server":{"port":9090}}') => {
        fireEvent.click(screen.getByRole("button", { name: "编辑" }));
        await waitFor(() => expect(document.querySelector("textarea")).toBeInTheDocument());
        fireEvent.change(document.querySelector("textarea")!, { target: { value: draft } });
      },
    };
  }

  it("隐藏时不吃掉 Esc，编辑草稿留到切回来（改造前整页卸载会直接丢草稿）", async () => {
    const shell = renderBrowserShell();
    fireEvent.click(await screen.findByText("app.json"));
    await expectCodeContains('"server"', '"port"', "8080");
    await shell.openEditorWithDraft();

    shell.setActive(false);

    // 已交还键盘职责：既不弹「放弃未保存的修改？」，也不退出编辑态
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("放弃未保存的修改？")).not.toBeInTheDocument();
    expect(document.querySelector("textarea")).toHaveValue('{"server":{"port":9090}}');

    shell.setActive(true);
    expect(document.querySelector("textarea")).toHaveValue('{"server":{"port":9090}}');
  });

  it("隐藏时收起待确认的跳转，切回来不补执行也不重弹", async () => {
    const shell = renderBrowserShell();
    fireEvent.click(await screen.findByText("app.json"));
    await expectCodeContains('"server"', '"port"', "8080");
    await shell.openEditorWithDraft();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(await screen.findByText("放弃未保存的修改？")).toBeInTheDocument();

    shell.setActive(false);
    await waitFor(() => expect(screen.queryByText("放弃未保存的修改？")).not.toBeInTheDocument());

    // pending 是一次性闭包：切回来编辑态与草稿还在，但那次「取消」不会被补执行
    shell.setActive(true);
    expect(screen.queryByText("放弃未保存的修改？")).not.toBeInTheDocument();
    expect(document.querySelector("textarea")).toHaveValue('{"server":{"port":9090}}');
  });

  it("隐藏时收起删除确认框，切回来不复活", async () => {
    const shell = renderBrowserShell();
    fireEvent.click(await screen.findByText("app.json"));
    await expectCodeContains('"server"', '"port"', "8080");

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(await screen.findByText("删除配置")).toBeInTheDocument();

    shell.setActive(false);
    await waitFor(() => expect(screen.queryByText("删除配置")).not.toBeInTheDocument());

    shell.setActive(true);
    expect(screen.queryByText("删除配置")).not.toBeInTheDocument();
    expect(apiMocks.deleteConfig).not.toHaveBeenCalled();
  });

  it("隐藏期间的选中变化不白跑对齐，切回前台补一次滚入可视区", async () => {
    // 真机（Chromium）实测：容器 display:none 时 scrollIntoView 被直接丢弃，
    // 而 scrollTop 本身是保活的。jsdom 没有布局，只能验「该调 / 不该调」的调用次数。
    apiMocks.listConfigs.mockResolvedValue(
      configPage([
        { dataId: "app.json", group: "DEFAULT_GROUP", content: "", configType: "json" },
        { dataId: "db.json", group: "DEFAULT_GROUP", content: "", configType: "json" },
      ])
    );
    const shell = renderBrowserShell();
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      fireEvent.click(await screen.findByText("app.json"));
      await expectCodeContains('"server"');
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1)); // 前台选中时已对齐

      shell.setActive(false);
      fireEvent.click(screen.getByText("db.json"));
      expect(scrollIntoView).toHaveBeenCalledTimes(1); // 隐藏期间的变化不白跑

      scrollIntoView.mockClear();
      shell.setActive(true);
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1)); // 切回来补对齐
      expect(document.querySelector(".browser-item.active")).toHaveTextContent("db.json");
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it("隐藏时交出键盘职责：看不见的校验提示不替其他模式吃掉 Esc，也不响应 Enter", async () => {
    const otherModeClose = vi.fn();
    const shell = renderBrowserShell(<OtherModeDropdown onClose={otherModeClose} />);
    fireEvent.click(await screen.findByText("app.json"));
    await expectCodeContains('"server"', '"port"', "8080");
    await shell.openEditorWithDraft('{"server":');

    fireEvent.click(screen.getByRole("button", { name: "保存发布" }));
    expect(await screen.findByText("格式校验未通过")).toBeInTheDocument();

    shell.setActive(false);

    // 提示框连同草稿一起留在隐藏子树里，但高位注册已撤销：Esc 归其他模式的弹层
    fireEvent.keyDown(window, { key: "Escape" });
    expect(otherModeClose).toHaveBeenCalledTimes(1);
    expect(screen.getByText("格式校验未通过")).toBeInTheDocument();
    expect(document.querySelector("textarea")).toHaveValue('{"server":');

    // Enter 也交还：弹框不再挂全局 Enter，隐藏时焦点陷阱同样撤销，看不见的那层不会被一键关掉
    fireEvent.keyDown(window, { key: "Enter" });
    expect(screen.getByText("格式校验未通过")).toBeInTheDocument();

    shell.setActive(true);
    expect(screen.getByText("格式校验未通过")).toBeInTheDocument();
  });

  it("隐藏时不吃掉 Esc，新建配置草稿留到切回来；切回前台才交还键盘", async () => {
    const shell = renderBrowserShell();
    fireEvent.click(screen.getByRole("button", { name: "新建配置" }));
    const dataIdInput = screen.getByText("Data ID").closest("label")!.querySelector("input")!;
    fireEvent.change(dataIdInput, { target: { value: "app.yaml" } });
    fireEvent.change(document.querySelector(".modal textarea")!, { target: { value: "server:\n  port: 8080\n" } });

    shell.setActive(false);

    // 隐藏的新建弹层不该被其他模式的 Esc 关掉，草稿留着
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByText("Data ID")).toBeInTheDocument();
    expect(dataIdInput).toHaveValue("app.yaml");

    // 切回前台：Esc 重新由新建弹层负责；草稿在手，先问一句才关（轮5 R36 / 波13）
    shell.setActive(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByText("放弃未发布的内容？")).toBeInTheDocument();
    expect(screen.getByText("Data ID")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "放弃内容" }));
    await waitFor(() => expect(screen.queryByText("Data ID")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "新建配置" })).toBeInTheDocument();
  });

  it("closes the batch replace modal on Escape", async () => {
    await openReplaceFlow();

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(document.querySelector(".browser-replace-modal")).not.toBeInTheDocument());
  });

  it("closes the target picker on Escape without reopening the replace step", async () => {
    await openReplaceFlow();
    // 替换与目标选择是互斥流程：进入第二步时替换层已关闭
    fireEvent.click(screen.getByRole("button", { name: "选择应用目标" }));
    await waitFor(() => expect(document.querySelector(".browser-target-modal")).toBeInTheDocument());
    expect(document.querySelector(".browser-replace-modal")).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".browser-target-modal")).not.toBeInTheDocument());
    expect(document.querySelectorAll(".modal-overlay")).toHaveLength(0);
  });

  it("lets an open dropdown consume Escape before the overlay behind it", async () => {
    await openReplaceFlow();
    fireEvent.click(screen.getByRole("button", { name: "选择应用目标" }));
    await waitFor(() => expect(document.querySelector(".browser-target-modal")).toBeInTheDocument());

    const trigger = document.querySelector(".browser-target-modal .sel-trigger") as HTMLButtonElement;
    expect(trigger).toBeInTheDocument();
    fireEvent.pointerDown(trigger);
    await waitFor(() => expect(document.querySelector(".sel-menu-portal")).toBeInTheDocument());

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".sel-menu-portal")).not.toBeInTheDocument());
    expect(document.querySelector(".browser-target-modal")).toBeInTheDocument();
  });
  it("输入法组合态回车不提交搜索，候选词上屏后的回车照常提交", async () => {
    renderBrowser();
    await screen.findByText("app.json");
    vi.useFakeTimers();
    const searchInput = document.querySelector(".browser-search input") as HTMLInputElement;

    fireEvent.change(searchInput, { target: { value: "gate" } });
    const callsBefore = apiMocks.listConfigs.mock.calls.length;

    // 组合态里 Enter/Esc/方向键都属于输入法：回车是上屏候选词，不是「提交搜索」
    fireEvent.keyDown(searchInput, { key: "Enter", isComposing: true });
    fireEvent.keyDown(searchInput, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(searchInput, { key: "ArrowDown", isComposing: true });
    fireEvent.keyDown(searchInput, { key: "ArrowUp", isComposing: true });
    expect(apiMocks.listConfigs.mock.calls.length).toBe(callsBefore);

    // 负控：上屏之后的那一次回车才真的搜索（不走 debounce）
    fireEvent.keyDown(searchInput, { key: "Enter" });
    expect(apiMocks.listConfigs).toHaveBeenLastCalledWith(conn, "public", "*gate*", "", 1, 50);
  });
  it("放弃未保存修改：确认框存续时编辑器里按回车不会误确认，草稿仍在", async () => {
    await enterEditMode();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(await screen.findByText("放弃未保存的修改？")).toBeInTheDocument();

    // 危险动作的默认焦点落在「留在当前」，不在执行侧
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "留在当前" }));

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    textarea.focus();
    fireEvent.keyDown(textarea, { key: "Enter" });

    // 弹框不再挂 window 级 Enter：回车归聚焦的那个元素，确认框与草稿都原样留着
    expect(screen.getByText("放弃未保存的修改？")).toBeInTheDocument();
    expect(document.querySelector("textarea")).toHaveValue('{"server":{"port":9090}}');

    // 焦点回到弹框后 Tab 成环，不会跑到被遮住的编辑器上
    const confirm = screen.getByRole("button", { name: "放弃并切换" });
    confirm.focus();
    fireEvent.keyDown(confirm, { key: "Tab" });
    expect(document.activeElement?.closest(".modal")).not.toBeNull();
    expect(document.activeElement).not.toBe(textarea);
  });

  it("搜索无命中时说清是「没搜到」而非「没有配置」，并可一键回到全量列表", async () => {
    apiMocks.listConfigs.mockImplementation(async (_conn: Connection, _tenant: string, dataId: string) =>
      configPage(dataId.includes("gateway") ? [] : [{ dataId: "app.json", group: "DEFAULT_GROUP", content: "", configType: "json" }])
    );

    renderBrowser();
    await screen.findByText("app.json");

    fireEvent.change(document.querySelector(".browser-search input")!, { target: { value: "gateway" } });
    // 输入即搜：等 400ms 防抖落地（用真实时钟，避免假定时器饿死后面的 waitFor）
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });

    expect(await screen.findByText("没有匹配「gateway」的配置")).toBeInTheDocument();
    expect(screen.queryByText("没有配置")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "清除搜索条件" }));
    await waitFor(() => {
      expect(apiMocks.listConfigs).toHaveBeenLastCalledWith(conn, "public", "", "", 1, 50);
    });
    expect(await screen.findByText("app.json")).toBeInTheDocument();
    expect(screen.queryByText("清除搜索条件")).not.toBeInTheDocument();
  });

  it("内容搜索 0 命中走独立文案，且扫描过程中不许提前断言「没有命中」", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    apiMocks.getConfigDocument.mockImplementation(async () => {
      await gate;
      return { content: '{"server":{"port":8080}}', format: "json", version: "v1", source: "nacos", updateTime: "" };
    });

    renderBrowser();
    await screen.findByText("app.json");

    fireEvent.click(screen.getByRole("button", { name: "内容" }));
    fireEvent.change(document.querySelector(".browser-search input")!, { target: { value: "nomatch" } });
    await waitFor(() => expect(apiMocks.getConfigDocument).toHaveBeenCalled());

    // 扫描还没跑完，空态不许抢话说「没有命中」
    expect(screen.queryByText(/内容搜索没有命中/)).not.toBeInTheDocument();

    await act(async () => {
      release();
      await gate;
    });
    expect(await screen.findByText("内容搜索没有命中「nomatch」")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清除搜索条件" })).toBeInTheDocument();
  });

  it("分组确实为空时仍是「没有配置」，不塞多余的清除搜索按钮", async () => {
    apiMocks.listConfigs.mockResolvedValue(configPage([]));

    renderBrowser();

    expect(await screen.findByText("没有配置")).toBeInTheDocument();
    expect(screen.queryByText(/没有匹配|内容搜索没有命中/)).not.toBeInTheDocument();
    expect(screen.queryByText("清除搜索条件")).not.toBeInTheDocument();
  });

  it("列表项能被 Tab 到达：整列只有一个 roving tabIndex=0", async () => {
    apiMocks.listConfigs.mockResolvedValue(
      configPage([
        { dataId: "app.json", group: "DEFAULT_GROUP", content: "", configType: "json" },
        { dataId: "gateway.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
      ])
    );

    renderBrowser();
    await screen.findByText("app.json");

    const list = document.querySelector('[role="listbox"]');
    expect(list).toBeInTheDocument();
    expect(list).toHaveAttribute("aria-label", "配置列表");
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.browser-item[role="option"]'));
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.getAttribute("tabindex") === "0")).toHaveLength(1);
    // 没人主动聚焦时，Tab 的落点是首行；读屏能念出「未选中」
    expect(rows[0].getAttribute("tabindex")).toBe("0");
    expect(rows[1].getAttribute("tabindex")).toBe("-1");
    expect(rows[0]).toHaveAttribute("aria-selected", "false");
  });

  it("焦点在列表项上：上下键换行、焦点随行、回车不再重复拉正文", async () => {
    apiMocks.listConfigs.mockResolvedValue(
      configPage([
        { dataId: "app.json", group: "DEFAULT_GROUP", content: "", configType: "json" },
        { dataId: "gateway.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
      ])
    );

    renderBrowser();
    const rows = await screen.findAllByRole("option");
    fireEvent.click(rows[0]);
    await waitFor(() => expect(apiMocks.getConfigDocument).toHaveBeenCalledWith(conn, "public", "app.json", "DEFAULT_GROUP"));

    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: "ArrowDown" });
    await waitFor(() => expect(apiMocks.getConfigDocument).toHaveBeenCalledWith(conn, "public", "gateway.yaml", "DEFAULT_GROUP"));
    expect(document.activeElement).toBe(rows[1]);
    expect(rows[1]).toHaveAttribute("aria-selected", "true");
    expect(rows[0]).toHaveAttribute("aria-selected", "false");

    // 焦点行已是选中行：回车不该再发一次同样的请求
    apiMocks.getConfigDocument.mockClear();
    fireEvent.keyDown(rows[1], { key: "Enter" });
    expect(apiMocks.getConfigDocument).not.toHaveBeenCalled();

    // Home/End 跳首末（在列表里，不靠搜索框焦点）
    fireEvent.keyDown(rows[1], { key: "Home" });
    await waitFor(() => expect(document.activeElement).toBe(rows[0]));
    fireEvent.keyDown(rows[0], { key: "End" });
    await waitFor(() => expect(document.activeElement).toBe(rows[1]));
  });

  it("从搜索框按上下键只预览、不把焦点从输入框抢走", async () => {
    apiMocks.listConfigs.mockResolvedValue(
      configPage([
        { dataId: "app.json", group: "DEFAULT_GROUP", content: "", configType: "json" },
        { dataId: "gateway.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
      ])
    );

    renderBrowser();
    const rows = await screen.findAllByRole("option");
    fireEvent.click(rows[0]);
    await waitFor(() => expect(apiMocks.getConfigDocument).toHaveBeenCalledWith(conn, "public", "app.json", "DEFAULT_GROUP"));

    const input = document.querySelector(".browser-search input") as HTMLInputElement;
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowDown" });

    await waitFor(() => expect(apiMocks.getConfigDocument).toHaveBeenCalledWith(conn, "public", "gateway.yaml", "DEFAULT_GROUP"));
    expect(document.activeElement).toBe(input);
  });

  it("内容搜索态下方向键走的是屏幕上的命中项，不是后台那份完整列表", async () => {
    apiMocks.listConfigs.mockResolvedValue(
      configPage([
        { dataId: "a.json", group: "DEFAULT_GROUP", content: "", configType: "json" },
        { dataId: "b.json", group: "DEFAULT_GROUP", content: "", configType: "json" },
        { dataId: "c.json", group: "DEFAULT_GROUP", content: "", configType: "json" },
      ])
    );
    apiMocks.getConfigDocument.mockImplementation(async (_conn: Connection, _tenant: string, dataId: string) => ({
      content: dataId === "b.json" ? "unrelated" : "token: hit",
      format: "json",
      version: "",
      source: "nacos",
      updateTime: "",
    }));

    renderBrowser();
    await screen.findByText("a.json");
    fireEvent.click(screen.getByRole("button", { name: "内容" }));
    fireEvent.change(document.querySelector(".browser-search input")!, { target: { value: "token" } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });

    const rows = await screen.findAllByRole("option");
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining("a.json"), expect.stringContaining("c.json")]);

    fireEvent.click(rows[0]);
    await waitFor(() => expect(apiMocks.getConfigDocument).toHaveBeenCalledWith(conn, "public", "a.json", "DEFAULT_GROUP"));
    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: "ArrowDown" });

    // 旧实现按 items（含未显示的 b.json）移动：屏幕上不会有任何一行亮起来
    await waitFor(() => expect(rows[1].getAttribute("aria-selected")).toBe("true"));
    expect(document.querySelector(".browser-item.active .browser-item-id")?.textContent).toBe("c.json");
  });

  describe("导出重入护栏", () => {
    function deferredPicker() {
      let resolvePicker: (value: string) => void = () => {};
      const promise = new Promise<string>((resolve) => {
        resolvePicker = resolve;
      });
      appApiMocks.selectConfigSourceExportDirectory.mockImplementation(() => promise);
      return { promise, resolvePicker };
    }

    it("ignores repeated clicks while the native directory dialog is still open", async () => {
      const { resolvePicker } = deferredPicker();
      renderBrowser();
      await screen.findByText("app.json");

      const sourceBtn = screen.getByTitle("导出源文件到目录");
      const listBtn = screen.getByTitle("导出当前列表");
      fireEvent.click(sourceBtn);
      await waitFor(() => expect(appApiMocks.selectConfigSourceExportDirectory).toHaveBeenCalledTimes(1));

      // 原生对话框还悬在半空，这段时间里两个导出按钮都得锁住并说明原因
      expect(sourceBtn).toBeDisabled();
      expect(listBtn).toBeDisabled();
      expect(sourceBtn.getAttribute("title")).toBe("导出进行中…");
      expect(listBtn.getAttribute("title")).toBe("导出进行中…");
      expect(sourceBtn.getAttribute("aria-label")).toBe("导出进行中…");

      fireEvent.click(sourceBtn);
      fireEvent.click(sourceBtn);
      expect(appApiMocks.selectConfigSourceExportDirectory).toHaveBeenCalledTimes(1);
      expect(getTaskManager().listTasks()).toHaveLength(0);

      await act(async () => {
        resolvePicker("C:\\exports\\nacos");
      });
      await waitFor(() => expect(appApiMocks.exportConfigSourceFiles).toHaveBeenCalledTimes(1));
      expect(getTaskManager().listTasks()).toHaveLength(1);
      expect(sourceBtn.getAttribute("title")).toBe("导出源文件到目录");
    });

    it("releases the export lock when the user cancels the directory dialog", async () => {
      appApiMocks.selectConfigSourceExportDirectory.mockResolvedValue("");
      renderBrowser();
      await screen.findByText("app.json");

      const sourceBtn = screen.getByTitle("导出源文件到目录");
      fireEvent.click(sourceBtn);
      await waitFor(() => expect(appApiMocks.selectConfigSourceExportDirectory).toHaveBeenCalledTimes(1));

      // 取消不是失败，锁必须放开，否则这个按钮就永久废了
      await waitFor(() => expect(sourceBtn).toBeEnabled());
      expect(sourceBtn.getAttribute("title")).toBe("导出源文件到目录");
      fireEvent.click(sourceBtn);
      await waitFor(() => expect(appApiMocks.selectConfigSourceExportDirectory).toHaveBeenCalledTimes(2));
      expect(appApiMocks.exportConfigSourceFiles).not.toHaveBeenCalled();
      expect(getTaskManager().listTasks()).toHaveLength(0);
    });

    it("re-enables the export buttons after a failed source-file export", async () => {
      appApiMocks.exportConfigSourceFiles.mockRejectedValue(new Error("disk full"));
      renderBrowser();
      await screen.findByText("app.json");

      const sourceBtn = screen.getByTitle("导出源文件到目录");
      const listBtn = screen.getByTitle("导出当前列表");
      fireEvent.click(sourceBtn);
      await waitFor(() => expect(latestError()).toMatchObject({ title: "导出源文件到目录", message: "disk full" }));

      await waitFor(() => expect(sourceBtn).toBeEnabled());
      expect(listBtn).toBeEnabled();
      expect(getTaskManager().listTasks()).toMatchObject([{ name: "导出源文件目录：dev / public", status: "failed" }]);
    });

    it("skips the synchronous list export while a source-file export is in flight", async () => {
      const { resolvePicker } = deferredPicker();
      renderBrowser();
      await screen.findByText("app.json");

      const sourceBtn = screen.getByTitle("导出源文件到目录");
      const listBtn = screen.getByTitle("导出当前列表");
      fireEvent.click(sourceBtn);
      await waitFor(() => expect(appApiMocks.selectConfigSourceExportDirectory).toHaveBeenCalledTimes(1));

      // 异步导出在途时点同步导出：不能交错写同一批配置，也不能多出一条任务
      fireEvent.click(listBtn);
      expect(URL.createObjectURL).not.toHaveBeenCalled();
      expect(getTaskManager().listTasks()).toHaveLength(0);

      await act(async () => {
        resolvePicker("C:\\exports\\nacos");
      });
      await waitFor(() => expect(appApiMocks.exportConfigSourceFiles).toHaveBeenCalledTimes(1));

      // 在途结束后同步导出照常可用
      fireEvent.click(listBtn);
      expect(URL.createObjectURL).toHaveBeenCalled();
      expect(getTaskManager().listTasks()).toHaveLength(2);
    });
  });

});
