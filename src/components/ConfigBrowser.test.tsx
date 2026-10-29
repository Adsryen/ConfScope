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
import type { ApplyEntryPayload } from "../lib/applyEntry";
import { EscapePriority, useEscape } from "../lib/useEscape";
import ConfigBrowser from "./ConfigBrowser";
import ErrorDialog from "./ErrorDialog";
import MessageCenter from "./MessageCenter";
import { getTaskManager } from "../lib/taskmanager";
import { __clearWheelSurfacesForTest } from "../lib/wheelScroll";
import { publishConfigChange, type ConfigChangeNotice } from "../lib/configChangeBus";

const apiMocks = vi.hoisted(() => ({
  listConfigs: vi.fn(),
  getConfig: vi.fn(),
  getConfigDocument: vi.fn(),
  publishConfig: vi.fn(),
  deleteConfig: vi.fn(),
  listHistory: vi.fn(),
  getHistoryDetail: vi.fn(),
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
    listHistory: apiMocks.listHistory,
    getHistoryDetail: apiMocks.getHistoryDetail,
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
  options: {
    connections?: Connection[];
    onStartApply?: (payload: import("../lib/applyEntry").ApplyEntryPayload) => void;
    active?: boolean;
  } = {}
) {
  localStorage.setItem("locale", locale);
  return render(
    <I18nProvider>
      <ConfigBrowser
        conn={browserConn}
        tenant={tenant}
        connections={options.connections}
        onStartApply={options.onStartApply}
        active={options.active}
      />
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
    apiMocks.listHistory.mockReset();
    apiMocks.getHistoryDetail.mockReset();
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

  async function openTargetPicker() {
    fireEvent.click(screen.getByRole("button", { name: "内容" }));
    const searchInput = document.querySelector(".browser-search input") as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: "8080" } });
    // 输入即搜：400ms 防抖后自动发起内容搜索（无需 Enter）
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    // 搜索结果回来后「批量替换」才会出现
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "批量替换" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "批量替换" }));
    fireEvent.change(screen.getByLabelText("替换为"), { target: { value: "8081" } });
    fireEvent.click(screen.getByRole("button", { name: "选择应用目标" }));
  }

  function appliedTargetLabel(): string {
    const scope = screen.getAllByText("目标环境")[0].closest(".browser-target-scope") as HTMLElement;
    return scope.querySelector("strong")!.textContent ?? "";
  }

  it("prefers an explicitly declared development target over the sandbox heuristic", async () => {
    const explicitDev: Connection = {
      ...conn,
      id: "explicit-dev",
      name: "order-core-01",
      sourceName: "公司内网",
      envRole: "development",
    };
    const sandboxConn: Connection = {
      ...conn,
      id: "sandbox",
      name: "sandbox",
      environmentName: "Sandbox",
      sourceName: "云上",
    };
    const prodLikeConn: Connection = {
      ...conn,
      id: "prod-like",
      name: "prod-core-01",
      sourceName: "云上公网",
    };
    renderBrowser("zh-CN", explicitDev, "public", { connections: [explicitDev, sandboxConn, prodLikeConn], onStartApply: vi.fn() });

    await openTargetPicker();
    // 默认目标必须是显式声明开发的那条，而不是名称带 sandbox 的
    expect(appliedTargetLabel()).toBe("默认项目 / 未分组 / 公司内网");
  });

  it("keeps today's default target (sandbox name, then first) when no role is declared", async () => {
    const sourceConn: Connection = { ...conn, id: "plain-src", name: "plain-src", sourceName: "公司内网" };
    const sandboxConn: Connection = {
      ...conn,
      id: "sandbox",
      name: "sandbox",
      environmentName: "Sandbox",
      sourceName: "云上",
    };
    renderBrowser("zh-CN", sourceConn, "public", { connections: [sourceConn, sandboxConn], onStartApply: vi.fn() });

    await openTargetPicker();
    // 都没声明角色：行为与改前一致（沙箱名称正则命中）
    expect(appliedTargetLabel()).toBe("默认项目 / Sandbox / 云上");
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
    fireEvent.click(screen.getByRole("button", { name: "生成变更计划" }));

    expect(await screen.findByText("格式校验未通过")).toBeInTheDocument();
    expect(apiMocks.publishConfig).not.toHaveBeenCalled();
  });

  // ── 轮42 / 方案 D：编辑态「保存」的真实动作是生成变更计划 ──────────────────
  // 改前真机取证（任务线 PRD）：点「保存发布」必定拿到一句「直接配置写入已禁用…」，
  // 同时往操作历史里记一条 result:"failure"。用户没做错任何事却被渲染成「你失败了」，
  // 而且四处入口没有任何出路。现在按钮说的就是它做的事。
  it("把改过的正文交给变更计划，而不是记一条必然失败的假记录", async () => {
    const onStartApply = vi.fn();
    renderBrowser("zh-CN", conn, "public", { onStartApply });
    fireEvent.click(await screen.findByText("app.json"));
    await expectCodeContains('"server"', '"port"', "8080");

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(document.querySelector("textarea")!, { target: { value: '{"server":{"port":9090}}' } });
    fireEvent.click(screen.getByRole("button", { name: "生成变更计划" }));

    await waitFor(() => expect(onStartApply).toHaveBeenCalledTimes(1));
    const payload = onStartApply.mock.calls[0][0] as ApplyEntryPayload;
    expect(payload).toMatchObject({ sourceType: "manual", scope: "config" });
    expect(payload.origin?.returnMode).toBe("browse");
    expect(payload.items[0]).toMatchObject({ dataId: "app.json", group: "DEFAULT_GROUP", key: "__document" });
    expect(payload.items[0].sourceValueOverride?.content).toBe('{"server":{"port":9090}}');
    // 同一位置：来源=期望正文、目标=线上现值，freshness 基线仍由计划页实时读取
    expect(payload.items[0].sourceRef).toEqual(payload.items[0].targetRef);

    expect(apiMocks.publishConfig).not.toHaveBeenCalled();
    expect(loadOperationHistory()).toEqual([]);
    expect(latestError()).toBeUndefined();
    // 编辑态不丢：从计划页返回时草稿还在原地
    expect(document.querySelector("textarea")).toHaveValue('{"server":{"port":9090}}');
  });

  it("正文与线上一致时不给一个空跑的计划，并如实说明原因", async () => {
    await enterEditMode('{"server":{"port":8080}}'); // 与线上一字不差

    fireEvent.click(screen.getByRole("button", { name: "生成变更计划" }));

    expect(await screen.findByText("正文与线上版本一致，无需生成变更计划")).toBeInTheDocument();
    expect(apiMocks.publishConfig).not.toHaveBeenCalled();
    expect(loadOperationHistory()).toEqual([]);
  });

  it("宿主没给计划出路时如实告知，不再伪装成发布失败", async () => {
    await enterEditMode(); // renderBrowser 默认不传 onStartApply

    fireEvent.click(screen.getByRole("button", { name: "生成变更计划" }));

    expect(await screen.findByText("当前页面无法打开变更计划")).toBeInTheDocument();
    expect(apiMocks.publishConfig).not.toHaveBeenCalled();
    expect(loadOperationHistory()).toEqual([]);
    expect(latestError()).toBeUndefined();
  });

  it("禁用理由写在看得见的文案上，而不是 disabled 按钮的 title 里", async () => {
    renderBrowser("en-US");
    fireEvent.click(await screen.findByText("app.json"));
    await expectCodeContains('"server"', '"port"', "8080");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(
      await screen.findByText("Direct writes are disabled: saving generates a change plan that must be confirmed before it runs.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate change plan" })).toBeInTheDocument();
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

  it("删除确认交出删除计划：期望内容是「不存在」，不写操作历史", async () => {
    const onStartApply = vi.fn();
    renderBrowser("zh-CN", conn, "public", { onStartApply });
    fireEvent.click(await screen.findByText("app.json"));
    await expectCodeContains('"server"', '"port"', "8080");

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const dialog = screen.getByText("删除配置").closest(".modal") as HTMLElement;
    // 按钮文案跟着 onConfirm 的真实动作走：这里生成的是计划，不是删除
    expect(within(dialog).getByRole("button", { name: "生成删除计划" })).toBeInTheDocument();
    fireEvent.change(within(dialog).getByPlaceholderText("app.json"), { target: { value: "app.json" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "生成删除计划" }));

    await waitFor(() => expect(onStartApply).toHaveBeenCalledTimes(1));
    const payload = onStartApply.mock.calls[0][0] as ApplyEntryPayload;
    expect(payload).toMatchObject({ sourceType: "manual", scope: "config" });
    expect(payload.items[0].sourceValueOverride?.exists).toBe(false);

    expect(apiMocks.deleteConfig).not.toHaveBeenCalled();
    expect(loadOperationHistory()).toEqual([]);
    expect(screen.queryByText("删除配置")).not.toBeInTheDocument();
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

  // R42-8：只读/快照连接挂着「点了永远不可能成功」的写入口，比少一个按钮更糟。
  it("只读连接不再提供编辑、删除与新建入口，历史仍可读", async () => {
    renderBrowser("zh-CN", { ...conn, readonly: true });
    fireEvent.click(await screen.findByText("app.json"));
    await expectCodeContains('"server"', '"port"', "8080");

    expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新建配置" })).not.toBeInTheDocument();
    // 读操作不受禁用影响
    expect(screen.getByRole("button", { name: "历史变更" })).toBeInTheDocument();
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
      ], "nacos");
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
    // Esc 只退出编辑态，不发生任何跳转：文案必须照实说「放弃」，不许说「切换」
    expect(document.querySelector(".modal")?.textContent).toContain("放弃后这些改动会丢失");
    expect(document.querySelector(".modal")?.textContent).not.toContain("切换");

    // 继续编辑 → 仍是编辑态，草稿不丢
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    await waitFor(() => expect(screen.queryByText("放弃未保存的修改？")).not.toBeInTheDocument());
    expect(document.querySelector("textarea")).toHaveValue('{"server":{"port":9090}}');

    // 放弃修改 → 退出编辑态
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(await screen.findByRole("button", { name: "放弃修改" }));
    await waitFor(() => expect(document.querySelector("textarea")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "编辑" })).toBeInTheDocument();
  });

  it("asks before discarding unsaved edits when the cancel button is clicked", async () => {
    await enterEditMode();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(await screen.findByText("放弃未保存的修改？")).toBeInTheDocument();
    expect(document.querySelector("textarea")).toHaveValue('{"server":{"port":9090}}');
    expect(document.querySelector(".modal")?.textContent).toContain("放弃后这些改动会丢失");

    fireEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    await waitFor(() => expect(document.querySelector("textarea")).not.toBeInTheDocument());
  });

  it("放弃确认的文案跟着动作走：切换配置才说「切换并留在当前」", async () => {
    // 两条动作共用同一个守卫（dirty 时先问再动），但用户按下去之前必须看清会发生什么：
    // 切换配置 ⇒「放弃并切换 / 留在当前」；退出编辑 ⇒「放弃修改 / 继续编辑」（见上面两条 Esc/取消用例）。
    apiMocks.listConfigs.mockResolvedValue(
      configPage([
        { dataId: "app.json", group: "DEFAULT_GROUP", content: "", configType: "json" },
        { dataId: "other.json", group: "DEFAULT_GROUP", content: "", configType: "json" },
      ])
    );
    await enterEditMode();

    fireEvent.click(screen.getByText("other.json"));
    expect(await screen.findByText("放弃未保存的修改？")).toBeInTheDocument();
    expect(document.querySelector(".modal")?.textContent).toContain("切换后将丢失这些改动");
    expect(screen.getByRole("button", { name: "放弃并切换" })).toBeInTheDocument();

    // 留在当前 ⇒ 不动选中项，草稿与编辑态原样
    fireEvent.click(screen.getByRole("button", { name: "留在当前" }));
    await waitFor(() => expect(screen.queryByText("放弃未保存的修改？")).not.toBeInTheDocument());
    expect(document.querySelector("textarea")).toHaveValue('{"server":{"port":9090}}');

    // 放弃并切换 ⇒ 真的换到另一份配置，草稿丢弃
    fireEvent.click(screen.getByText("other.json"));
    fireEvent.click(await screen.findByRole("button", { name: "放弃并切换" }));
    await waitFor(() => expect(document.querySelector("textarea")).not.toBeInTheDocument());
    await waitFor(() => expect(apiMocks.getConfigDocument).toHaveBeenLastCalledWith(conn, "public", "other.json", "DEFAULT_GROUP"));
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
    fireEvent.click(screen.getByRole("button", { name: "生成变更计划" }));
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
    fireEvent.click(screen.getByRole("button", { name: "生成变更计划" }));

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

  // ── 轮40 R40-1 / R40-5：页面级正文搜索词要跟随到「历史变更」的原文视图 ──
  // 缺陷长什么样（真机取证见 .trellis/tasks/10-19-ui-ux-40/prd.md）：同一个配置的三个内容视图里，
  // 浏览 tab（ConfigBrowser:1307）与编辑 tab（:1258）都传了 searchTerm，唯独 HistoryView 的 Props
  // 没有这个字段 —— 内容搜索点开配置后切到「历史变更」看原始内容，标红、命中行底色、行号命中态、
  // 缩略图红条、Ctrl+F 预填一起消失（真机读数：正文 mark.search-hit 从 1 掉到 0，预填从 cycle 掉到空串，
  // 而那块 .code-area 的 textContent 里确实含 cycle: ⇒ 不是「这版内容没这个词」）。
  // 这是**接线级**断言：HistoryView.test.tsx 那三条只钉「收到词就得标」，词传没传只能在这里钉。
  function mockHistoryForBrowser() {
    apiMocks.listHistory.mockResolvedValue({
      totalCount: 2,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [
        { id: "2", dataId: "app.yaml", group: "DEFAULT_GROUP", opType: "U", lastModifiedTime: "2026-06-27 10:00:00" },
        { id: "1", dataId: "app.yaml", group: "DEFAULT_GROUP", opType: "I", lastModifiedTime: "2026-06-26 10:00:00" },
      ],
    });
    apiMocks.getHistoryDetail.mockImplementation(
      async (_conn: Connection, _tenant: string, _dataId: string, _group: string, nid: string) => ({
        id: nid,
        dataId: "app.yaml",
        group: "DEFAULT_GROUP",
        content: nid === "2" ? "server:\n  port: 9090\n" : "server:\n  port: 8080\n",
        opType: nid === "1" ? "I" : "U",
        createdTime: "2026-06-27 10:00:00",
        lastModifiedTime: "2026-06-27 10:00:00",
      })
    );
  }

  /** 内容搜索态：切「按内容搜索」→ 输入词 → 防抖 → 打开配置。 */
  async function searchContentAndOpen(term: string) {
    fireEvent.click(screen.getByRole("button", { name: "内容" }));
    fireEvent.change(document.querySelector(".browser-search input") as HTMLInputElement, { target: { value: term } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    fireEvent.click(await screen.findByText("app.yaml"));
    await waitFor(() => expect(document.querySelector(".code-area")).toBeTruthy());
  }

  /** 切到「历史变更」→ 选一个版本 → 看原始内容。 */
  async function openHistoryRawView() {
    fireEvent.click(await screen.findByRole("button", { name: "历史变更" }));
    fireEvent.click(await screen.findByText("nid 2"));
    fireEvent.click(await screen.findByRole("button", { name: "原始内容" }));
    await waitFor(() => expect(document.querySelector(".code-area")).toBeTruthy());
  }

  it("内容搜索词跟随到「历史变更」的原始内容视图（轮40 R40-1）", async () => {
    apiMocks.listConfigs.mockResolvedValue(configPage([{ dataId: "app.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" }]));
    apiMocks.getConfigDocument.mockResolvedValue({
      content: "server:\n  port: 8080\n",
      format: "yaml",
      version: "v1",
      source: "nacos",
      updateTime: "2026-08-11T00:00:00Z",
    });
    mockHistoryForBrowser();
    renderBrowser("zh-CN");

    await searchContentAndOpen("port");
    // 浏览 tab 先确认词到位（基线），再切历史 tab
    expect(document.querySelectorAll(".code-area mark.search-hit").length).toBeGreaterThan(0);

    await openHistoryRawView();
    expect(document.querySelectorAll(".code-area mark.search-hit").length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".code-lines .code-line.is-hit").length).toBeGreaterThan(0);

    // 同一块视图的 Ctrl+F 预填该词，而不是空串
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    await waitFor(() => {
      const input = document.querySelector(".code-find-input") as HTMLInputElement | null;
      expect(input?.value).toBe("port");
    });
  });

  it("按 dataId 搜索时，「历史变更」的原始内容一处都不标（轮40 R40-3）", async () => {
    apiMocks.listConfigs.mockResolvedValue(configPage([{ dataId: "app.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" }]));
    apiMocks.getConfigDocument.mockResolvedValue({
      content: "server:\n  port: 8080\n",
      format: "yaml",
      version: "v1",
      source: "nacos",
      updateTime: "2026-08-11T00:00:00Z",
    });
    mockHistoryForBrowser();
    renderBrowser("zh-CN");

    // 默认就是「按 dataId」模式：输入的是 dataId 串，不是正文词
    fireEvent.change(document.querySelector(".browser-search input") as HTMLInputElement, { target: { value: "app" } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    fireEvent.click(await screen.findByText("app.yaml"));
    await waitFor(() => expect(document.querySelector(".code-area")).toBeTruthy());
    expect(document.querySelectorAll(".code-area mark.search-hit").length).toBe(0);

    await openHistoryRawView();
    // 版本内容里就有 "port"，没有正文词时一个命中都不许画
    expect((document.querySelector(".code-area") as HTMLElement).textContent).toContain("port");
    expect(document.querySelectorAll(".code-area mark.search-hit").length).toBe(0);
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

    fireEvent.click(screen.getByRole("button", { name: "生成变更计划" }));
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
  it("输入法没上屏时一次都不搜：候选词落地后按最终值只发一次请求", async () => {
    renderBrowser();
    await screen.findByText("app.json");
    vi.useFakeTimers();
    const searchInput = document.querySelector(".browser-search input") as HTMLInputElement;
    const callsBefore = apiMocks.listConfigs.mock.calls.length;

    // 组合期间每敲一个拼音字母都会派发 input，值就是半截拼音
    fireEvent.compositionStart(searchInput);
    for (const partial of ["b", "be", "bei", "beiw"]) {
      fireEvent.change(searchInput, { target: { value: partial } });
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
    }
    // 半截拼音一个都不许发出去：发出去只换来假的「没有结果」，列表闪一下空态
    expect(apiMocks.listConfigs.mock.calls.length).toBe(callsBefore);
    // 但回显必须即时——用户要看得见自己正在打什么
    expect(searchInput.value).toBe("beiw");

    // 上屏：先落最终值，再派 compositionend（引擎两种顺序都兜：谁在后谁定排期的值）
    fireEvent.change(searchInput, { target: { value: "备份" } });
    fireEvent.compositionEnd(searchInput, { data: "备份" });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(apiMocks.listConfigs).toHaveBeenLastCalledWith(conn, "public", "*备份*", "", 1, 50);
    expect(apiMocks.listConfigs.mock.calls.length).toBe(callsBefore + 1);
  });
  it("放弃未保存修改：确认框存续时编辑器里按回车不会误确认，草稿仍在", async () => {
    await enterEditMode();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(await screen.findByText("放弃未保存的修改？")).toBeInTheDocument();

    // 危险动作的默认焦点落在非执行侧（Esc 那条路径上是「继续编辑」）
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "继续编辑" }));

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    textarea.focus();
    fireEvent.keyDown(textarea, { key: "Enter" });

    // 弹框不再挂 window 级 Enter：回车归聚焦的那个元素，确认框与草稿都原样留着
    expect(screen.getByText("放弃未保存的修改？")).toBeInTheDocument();
    expect(document.querySelector("textarea")).toHaveValue('{"server":{"port":9090}}');

    // 焦点回到弹框后 Tab 成环，不会跑到被遮住的编辑器上
    const confirm = screen.getByRole("button", { name: "放弃修改" });
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

/**
 * 轮33 F-34：配置浏览页的 chrome 条上的滚轮必须滚「同一列的正文」，不是一动不动。
 *
 * 几何与落点坐标一律抄真机取证 research/p4_browse_chrome.txt 的 B1（1440×900），
 * 这样守卫钉的是**实测那一版布局**上的关系，而不是我们自己想象的矩形：
 *   可滚容器  browser-items @184,256,359,644（余 8956）｜code-area @544,179,896,682（余 7338）
 *   死区落点  .browser-search-mode(315,105) .browser-search(484,193) .browser-count(424,242)
 *             .detail-header(1112,109) .fmt-bar(1052,159)（轮33 实测这 5 块 + 分页条全部一格不动）
 * jsdom 没有布局引擎 ⇒ 闸门要的 overflow/两个高度、选列要的矩形都得按上面这组数字自己装。
 * `.page-header` 不在这个 DOM 里（它在 App 的 `.page-surface` 上、`.browser` 外面），
 * 所以「页头不接管」由接线处 `root = .browser` 这条静态守卫 + 真机探针钉，不在这里假造。
 */
describe("ConfigBrowser 滚轮兜底：chrome 条滚同一列正文（轮33 F-34）", () => {
  const ITEMS = { left: 184, right: 543, top: 256, bottom: 900 };
  const ITEMS_ROOM = 8956;
  const CODE = { left: 544, right: 1440, top: 179, bottom: 861 };
  const CODE_ROOM = 7338;

  beforeEach(() => {
    localStorage.clear();
    clearErrors();
    // 登记表是模块级的：上一条用例登记的节点不会因为这一条重新渲染而消失
    __clearWheelSurfacesForTest();
    apiMocks.listConfigs.mockReset();
    apiMocks.getConfig.mockReset();
    apiMocks.getConfigDocument.mockReset();
    apiMocks.listConfigs.mockResolvedValue(configPage());
    apiMocks.getConfig.mockResolvedValue('{"server":{"port":8080}}');
    apiMocks.getConfigDocument.mockResolvedValue({
      content: '{"server":{"port":8080}}',
      format: "json",
      version: "",
      source: "nacos",
      updateTime: "",
    });
    // 探针口径的视口：候选的可见面积按 window.innerWidth/innerHeight 裁
    Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
  });

  /** 装成「真的有得滚」：inline overflow-y + 两个高度差出一屏以上的余量。 */
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

  /** 打开一条配置，让右列的 `.code-area`（CodeView）挂出来，再把两列几何装好。 */
  async function renderTwoColumns(pages = 1) {
    if (pages > 1) {
      // 分页条只在多页时渲染（Pager: pages <= 1 直接 return null）
      apiMocks.listConfigs.mockResolvedValue({ ...configPage(), totalCount: 120, pagesAvailable: pages });
    }
    renderBrowser();
    fireEvent.click(await screen.findByText("app.json"));
    await waitFor(() => expect(document.querySelector(".code-area")).toBeInTheDocument());
    const items = document.querySelector<HTMLElement>(".browser-items")!;
    const code = document.querySelector<HTMLElement>(".code-area")!;
    makeScrollable(items, ITEMS, ITEMS_ROOM);
    makeScrollable(code, CODE, CODE_ROOM);
    return { items, code };
  }

  // 表格第 5 列是页夹具的分页数：`.pager` 只在多页时存在。B1 那行 `.pager` 量的是历史 tab 的分页条
  // （在 `.browser-detail` 里，按几何归右列），与这里的列表分页条是同一族形状的两侧，各自钉一条。
  const CHROME: [string, number, number, "left" | "right", number][] = [
    [".browser-search-mode", 315, 105, "left", 1],
    [".browser-search", 484, 193, "left", 1],
    [".browser-count", 424, 242, "left", 1],
    [".pager", 364, 910, "left", 2],
    [".detail-header", 1112, 109, "right", 1],
    [".fmt-bar", 1052, 159, "right", 1],
  ];

  for (const [sel, x, y, column, pages] of CHROME) {
    it(`滚轮落在 ${sel} 的 (${x},${y}) ⇒ 滚${column === "left" ? "左列文件列表" : "右列正文"}，另一列一动不动`, async () => {
      const { items, code } = await renderTwoColumns(pages);
      const chrome = document.querySelector(sel);
      expect(chrome, `${sel} 没渲染出来，这条守卫就成了空转`).not.toBeNull();

      const event = wheelOn(chrome!, x, y);

      const moved = column === "left" ? items : code;
      const still = column === "left" ? code : items;
      expect(moved.scrollTop, "chrome 条上还是一片死区：兜底没把这一格投给本列正文").toBe(120);
      expect(still.scrollTop, "滚轮落在哪一列就只滚哪一列，不许串列").toBe(0);
      expect(event.defaultPrevented, "不取消默认动作：外层面板会跟着一起滚").toBe(true);
    });
  }

  it("硬闸门：落点的祖先链里已经有可滚容器 ⇒ 整格交还原生，兜底不抢", async () => {
    const { items, code } = await renderTwoColumns();
    const row = document.querySelector(".browser-items .browser-item")!;
    expect(row, "列表没渲染出条目，这条守卫是空转").not.toBeNull();

    const event = wheelOn(row, 364, 578);

    expect(event.defaultPrevented, "闸门不满足还 preventDefault：把原生滚动抢过来自己算一遍").toBe(false);
    expect(items.scrollTop, "列表里的滚轮要由浏览器自己滚，兜底一律不碰").toBe(0);
    expect(code.scrollTop).toBe(0);
  });

  it("禁区：弹框子树一律不接（实测同一 .modal-overlay 换几何就有两种结果，不按 CSS 推断）", async () => {
    const { items, code } = await renderTwoColumns();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const overlay = document.querySelector<HTMLElement>(".modal-overlay");
    expect(overlay, "确认弹框没出来").not.toBeNull();
    // 弹框就挂在 .browser 子树里（不是 portal），闸门对它判的是「死区」——只有黑名单拦得住
    expect(overlay!.closest(".browser"), "弹框不在页面根子树里，这条守卫就证明不了黑名单在起作用").not.toBeNull();

    const event = wheelOn(overlay!, 364, 450);

    expect(event.defaultPrevented, "弹框暗区被接管：点遮罩关弹框的语义就跟着没了").toBe(false);
    expect(items.scrollTop).toBe(0);
    expect(code.scrollTop).toBe(0);
  });

  it("chrome 条上的 ctrl+wheel（捏合）与纯横向照样放手", async () => {
    const { items, code } = await renderTwoColumns();
    const count = document.querySelector(".browser-count")!;

    const pinch = new WheelEvent("wheel", { cancelable: true, bubbles: true, ctrlKey: true, clientX: 424, clientY: 242, deltaY: 120 });
    const sideways = new WheelEvent("wheel", { cancelable: true, bubbles: true, clientX: 424, clientY: 242, deltaX: 120 });
    act(() => {
      count.dispatchEvent(pinch);
      count.dispatchEvent(sideways);
    });

    expect(pinch.defaultPrevented, "ctrl+wheel 是捏合缩放：我们只接纵向").toBe(false);
    expect(sideways.defaultPrevented, "deltaY=0 是纯横向：正文没有横向滚动时这格归浏览器").toBe(false);
    expect(items.scrollTop, "放手就不能顺手写偏移").toBe(0);
    expect(code.scrollTop).toBe(0);

    // 同一块上的普通一格仍然要接管（否则「放手」就成了「不接」）
    expect(wheelOn(count, 424, 242).defaultPrevented).toBe(true);
    expect(items.scrollTop).toBe(120);
  });
});

// ── 轮43 / 写后失效 ─────────────────────────────────────────────────────────
// 配置浏览被 App.tsx 的 .browse-cache 保活：切走只是 display:none，不重新取数；
// 而全站唯一的写路径（变更计划执行器）在另一棵子树里改的是服务端。
// 这几条锁的是「什么时候发请求、什么时候不该发」，不锁用户文案字面量。
describe("ConfigBrowser 写后失效", () => {
  const change = (overrides: Partial<ConfigChangeNotice> = {}): ConfigChangeNotice => ({
    connectionId: "dev",
    namespace: "public",
    refs: [{ dataId: "app.json", group: "DEFAULT_GROUP" }],
    ...overrides,
  });

  // 本组挂在主 describe 外面，拿不到它那份统一的 mock 装配，这里自带一份最小 setup。
  beforeEach(() => {
    localStorage.clear();
    clearErrors();
    apiMocks.listConfigs.mockReset();
    apiMocks.getConfigDocument.mockReset();
    apiMocks.deleteConfig.mockReset();
    apiMocks.publishConfig.mockReset();
    clearTasks();
    apiMocks.listConfigs.mockResolvedValue(configPage());
    apiMocks.getConfigDocument.mockResolvedValue({
      content: '{"server":{"port":8080}}',
      format: "json",
      version: "",
      source: "nacos",
      updateTime: "",
    });
  });

  it("前台收到写入通知后重取列表，并把选中项的正文换成服务端真值", async () => {
    renderBrowser();
    fireEvent.click(await screen.findByText("app.json"));
    await expectCodeContains('"port"', "8080");

    apiMocks.listConfigs.mockClear();
    apiMocks.getConfigDocument.mockClear();
    apiMocks.getConfigDocument.mockResolvedValue({
      content: '{"server":{"port":9090}}',
      format: "json",
      version: "v2",
      source: "nacos",
      updateTime: "",
    });

    await act(async () => {
      publishConfigChange(change());
    });

    await waitFor(() => expect(apiMocks.listConfigs).toHaveBeenCalledTimes(1));
    expect(apiMocks.getConfigDocument).toHaveBeenCalledWith(conn, "public", "app.json", "DEFAULT_GROUP");
    await expectCodeContains("9090");
  });

  it("通知没碰上选中项时不重读正文，草稿与编辑态原样留着", async () => {
    renderBrowser();
    fireEvent.click(await screen.findByText("app.json"));
    await expectCodeContains("8080");
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(document.querySelector("textarea")!, { target: { value: "draft-here" } });
    apiMocks.getConfigDocument.mockClear();

    await act(async () => {
      publishConfigChange(change({ refs: [{ dataId: "other.yaml", group: "DEFAULT_GROUP" }] }));
    });

    await waitFor(() => expect(document.querySelector("textarea")).toHaveValue("draft-here"));
    expect(apiMocks.getConfigDocument).not.toHaveBeenCalled();
  });

  it("被保活隐藏时一次请求都不发，切回前台才补做", async () => {
    const view = render(
      <I18nProvider>
        <ConfigBrowser conn={conn} tenant="public" active={false} />
      </I18nProvider>
    );
    await waitFor(() => expect(apiMocks.listConfigs).toHaveBeenCalled());
    apiMocks.listConfigs.mockClear();

    await act(async () => {
      publishConfigChange(change());
    });
    expect(apiMocks.listConfigs).not.toHaveBeenCalled();

    view.rerender(
      <I18nProvider>
        <ConfigBrowser conn={conn} tenant="public" active />
      </I18nProvider>
    );
    await waitFor(() => expect(apiMocks.listConfigs).toHaveBeenCalledTimes(1));
  });

  it("选中项被计划删掉时清空选中并给出可见说明，不再挂着已删配置的操作", async () => {
    renderBrowser();
    fireEvent.click(await screen.findByText("app.json"));
    await expectCodeContains("8080");

    apiMocks.listConfigs.mockResolvedValue(configPage([]));

    await act(async () => {
      publishConfigChange(change());
    });

    await waitFor(() => expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument());
    const status = document.querySelector(".browser-detail [role='status']");
    expect(status?.textContent).toContain("app.json");
    expect(screen.queryByText("app.json")).not.toBeInTheDocument();
  });

  it("其他连接 / 其他命名空间的写入通知与本页无关，不多发一次请求", async () => {
    renderBrowser();
    await waitFor(() => expect(apiMocks.listConfigs).toHaveBeenCalledTimes(1));
    apiMocks.listConfigs.mockClear();

    await act(async () => {
      publishConfigChange(change({ connectionId: "other-conn" }));
      publishConfigChange(change({ namespace: "retest-qa" }));
    });

    expect(apiMocks.listConfigs).not.toHaveBeenCalled();
  });
});

// ── 轮96 K2：延迟动作与基线交换 ──
//
// 上面那条静态守卫只读源码文本，抓不到「运行起来是不是真的这样」。这一组按 errorCenter
// 台账里存的那份 onAction 真点一次：那正是报错弹框与消息中心两颗按钮实际调用的函数。
describe("ConfigBrowser 延迟重试与基线交换", () => {
  const qaConn: Connection = { ...conn, id: "qa", name: "qa", baseUrl: "http://localhost:8849/nacos" };

  beforeEach(() => {
    localStorage.clear();
    clearErrors();
    apiMocks.listConfigs.mockReset();
    apiMocks.getConfigDocument.mockReset();
    apiMocks.publishConfig.mockReset();
    apiMocks.deleteConfig.mockReset();
    clearTasks();
    apiMocks.listConfigs.mockResolvedValue(
      configPage([
        { dataId: "app.json", group: "DEFAULT_GROUP", content: "", configType: "json" },
        { dataId: "db.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
      ])
    );
    apiMocks.getConfigDocument.mockResolvedValue({
      content: '{"server":{"port":8080}}',
      format: "json",
      version: "",
      source: "nacos",
      updateTime: "",
    });
  });

  /** 受控外壳：换连接 / 换命名空间靠 rerender，模拟人在页面里把作用域切走。 */
  function renderScoped(browserConn: Connection = conn, tenant = "public") {
    localStorage.setItem("locale", "zh-CN");
    const tree = (nextConn: Connection, nextTenant: string) => (
      <I18nProvider>
        <ConfigBrowser conn={nextConn} tenant={nextTenant} />
        <MessageCenter />
        <ErrorDialog />
      </I18nProvider>
    );
    const view = render(tree(browserConn, tenant));
    return {
      setScope: (nextConn: Connection, nextTenant: string) => view.rerender(tree(nextConn, nextTenant)),
    };
  }

  /**
   * 换作用域的另一条路：App 给浏览页的 key 是 `${连接}:${命名空间}`，换作用域 = 整棵子树重挂载。
   *
   * 上面那个 renderScoped 换的是 props，实例不换 ⇒ 实例内的 ref 一直活着，
   * 「旧闭包读到的是冻结的旧作用域」这件事在 jsdom 里永远复现不了（轮97 K3 真机 CR-02 才抓到）。
   * 这里给 ConfigBrowser 挂上会变的 key，让 React 真的卸载旧的、挂载新的，
   * 顺带能演「浏览页整块不在界面里」（App 在无可用连接 / 连不上命名空间时换成提示）。
   */
  function renderKeyedScoped() {
    localStorage.setItem("locale", "zh-CN");
    const tree = (nextConn: Connection, nextTenant: string) => (
      <I18nProvider>
        <ConfigBrowser key={`${nextConn.id}:${nextTenant}`} conn={nextConn} tenant={nextTenant} />
        <MessageCenter />
        <ErrorDialog />
      </I18nProvider>
    );
    const view = render(tree(conn, "public"));
    return {
      remount: (nextConn: Connection, nextTenant: string) => view.rerender(tree(nextConn, nextTenant)),
      unmountPage: () =>
        view.rerender(
          <I18nProvider>
            <MessageCenter />
            <ErrorDialog />
          </I18nProvider>
        ),
    };
  }

  /** 台账里那条动作：报错时存进 errorCenter 的旧闭包，人可以很久之后再点它。 */
  function staleAction(): () => void {
    const item = latestError();
    expect(item?.onAction, "报错必须带上重试动作").toBeTypeOf("function");
    return item!.onAction!;
  }

  async function openEditorWithDraft(draft: string) {
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    await waitFor(() => expect(document.querySelector("textarea")).toBeInTheDocument());
    fireEvent.change(document.querySelector("textarea")!, { target: { value: draft } });
  }

  it("重取把基线换掉时草稿原样留着，并给出两个去向", async () => {
    renderScoped();
    fireEvent.click(await screen.findByText("app.json"));
    await expectCodeContains("8080");
    await openEditorWithDraft('{"server":{"port":9090}}');

    // 服务端在这期间被别的计划改掉了
    apiMocks.getConfigDocument.mockResolvedValue({
      content: '{"server":{"port":7070}}',
      format: "json",
      version: "v3",
      source: "nacos",
      updateTime: "",
    });

    await act(async () => {
      publishConfigChange({
        connectionId: "dev",
        namespace: "public",
        refs: [{ dataId: "app.json", group: "DEFAULT_GROUP" }],
      });
    });

    // 草稿不被顶掉，编辑态不退
    await waitFor(() => expect(document.querySelector("textarea")).toHaveValue('{"server":{"port":9090}}'));
    const banner = document.querySelector<HTMLElement>(".browser-remote-moved");
    expect(banner?.textContent).toContain("服务端已把 app.json");

    // 选「继续用我的改动」：只收起提示，草稿原样
    fireEvent.click(within(banner!).getByRole("button", { name: "继续用我的改动" }));
    await waitFor(() => expect(document.querySelector(".browser-remote-moved")).not.toBeInTheDocument());
    expect(document.querySelector("textarea")).toHaveValue('{"server":{"port":9090}}');

    // 服务端又改了一次，这次选「改用服务端最新内容」
    apiMocks.getConfigDocument.mockResolvedValue({
      content: '{"server":{"port":6060}}',
      format: "json",
      version: "v4",
      source: "nacos",
      updateTime: "",
    });
    await act(async () => {
      publishConfigChange({
        connectionId: "dev",
        namespace: "public",
        refs: [{ dataId: "app.json", group: "DEFAULT_GROUP" }],
      });
    });
    const banner2 = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".browser-remote-moved");
      expect(el).toBeInTheDocument();
      return el!;
    });
    fireEvent.click(within(banner2).getByRole("button", { name: "改用服务端最新内容" }));
    await waitFor(() => expect(document.querySelector("textarea")).toHaveValue('{"server":{"port":6060}}'));
    expect(document.querySelector(".browser-remote-moved")).not.toBeInTheDocument();

    // 落到真值后未保存态就该清掉：再切配置不该弹「切换后将丢失」，直接跳过去
    apiMocks.getConfigDocument.mockImplementation(async (_c: Connection, _t: string, dataId: string) => ({
      content: dataId === "db.yaml" ? "url: jdbc:mysql://retest/db" : '{"server":{"port":6060}}',
      format: dataId === "db.yaml" ? "yaml" : "json",
      version: "",
      source: "nacos",
      updateTime: "",
    }));
    fireEvent.click(screen.getByText("db.yaml"));
    await expectCodeContains("jdbc");
    expect(screen.queryByText("当前配置有未保存的编辑，切换后将丢失这些改动。")).not.toBeInTheDocument();
  });

  it("换了作用域后台账里的旧「重试」不再执行，只说明已过期", async () => {
    apiMocks.getConfigDocument.mockRejectedValueOnce(new Error("content denied"));
    const shell = renderScoped();
    fireEvent.click(await screen.findByText("app.json"));
    await waitFor(() => expect(latestError()?.title).toBe("配置内容加载失败"));
    const action = staleAction();

    // 人把弹框关掉，换到另一套连接 + 命名空间
    shell.setScope(qaConn, "qa-public");
    // 等新作用域真的接管页面（列表按 qa 连接重发过一次），镜像才算跟上
    await waitFor(() => expect(apiMocks.listConfigs.mock.calls.some((call) => call[0]?.id === "qa")).toBe(true));
    apiMocks.getConfigDocument.mockClear();

    await act(async () => {
      action();
    });

    expect(apiMocks.getConfigDocument, "过期重试不许再发请求").not.toHaveBeenCalled();
    const notice = latestError();
    expect(notice).toMatchObject({ level: "warning", title: "这次重试已过期" });
    expect(notice?.message).toContain("dev / public");
    expect(notice?.message).toContain("qa / qa-public");
    // 这条说明自己不许再挂一个重试动作，否则把人引回同一个不成立的动作
    expect(notice?.onAction).toBeUndefined();
  });

  it("换作用域是按 key 重挂载时，旧「重试」同样一次请求都不发（真机 CR-02 的等价物）", async () => {
    apiMocks.getConfigDocument.mockRejectedValueOnce(new Error("content denied"));
    const shell = renderKeyedScoped();
    fireEvent.click(await screen.findByText("app.json"));
    await waitFor(() => expect(latestError()?.title).toBe("配置内容加载失败"));
    const action = staleAction();

    shell.remount(qaConn, "qa-public");
    // 等新实例真的接管页面（列表按 qa 连接重发过一次），模块级作用域镜像才算跟上
    await waitFor(() => expect(apiMocks.listConfigs.mock.calls.some((call) => call[0]?.id === "qa")).toBe(true));
    apiMocks.getConfigDocument.mockClear();

    await act(async () => {
      action();
    });

    expect(apiMocks.getConfigDocument, "重挂载后旧闭包还是替已经离开的旧作用域取了一次正文").not.toHaveBeenCalled();
    const notice = latestError();
    expect(notice).toMatchObject({ level: "warning", title: "这次重试已过期" });
    expect(notice?.message).toContain("dev / public");
    expect(notice?.message).toContain("qa / qa-public");
    expect(notice?.onAction).toBeUndefined();
  });

  it("浏览页整块不在界面里时，旧「重试」不发请求，只说页面已不在", async () => {
    apiMocks.getConfigDocument.mockRejectedValueOnce(new Error("content denied"));
    const shell = renderKeyedScoped();
    fireEvent.click(await screen.findByText("app.json"));
    await waitFor(() => expect(latestError()?.title).toBe("配置内容加载失败"));
    const action = staleAction();

    shell.unmountPage();
    apiMocks.getConfigDocument.mockClear();

    await act(async () => {
      action();
    });

    // 旧形状在这里更坏：请求照发，结果写进一个已经不存在的视图，界面一个字都不动
    expect(apiMocks.getConfigDocument, "页面都不在了还发一次读取，取回来的东西没人看得见").not.toHaveBeenCalled();
    const notice = latestError();
    expect(notice).toMatchObject({ level: "warning", title: "这次重试已过期" });
    expect(notice?.message, "这条说明不能谎称「已经切到」别的作用域").toContain("配置浏览页已经不在当前界面里");
    expect(notice?.message).toContain("dev / public");
  });

  it("作用域没变时旧「重试」照常重取（守卫不能写成永远拦）", async () => {
    apiMocks.getConfigDocument.mockRejectedValueOnce(new Error("content denied"));
    renderScoped();
    fireEvent.click(await screen.findByText("app.json"));
    await waitFor(() => expect(latestError()?.title).toBe("配置内容加载失败"));
    const action = staleAction();

    apiMocks.getConfigDocument.mockResolvedValue({
      content: '{"server":{"port":8081}}',
      format: "json",
      version: "",
      source: "nacos",
      updateTime: "",
    });
    await act(async () => {
      action();
    });

    await expectCodeContains("8081");
    expect(latestError()?.title).not.toBe("这次重试已过期");
  });

  it("旧重试要跳到别的配置时，先按当前草稿确认，不当场顶掉", async () => {
    apiMocks.getConfigDocument.mockImplementation(async (_c: Connection, _t: string, dataId: string) => {
      if (dataId === "db.yaml") throw new Error("db read denied");
      return { content: '{"server":{"port":8080}}', format: "json", version: "", source: "nacos", updateTime: "" };
    });
    renderScoped();
    fireEvent.click(await screen.findByText("db.yaml"));
    await waitFor(() => expect(latestError()?.title).toBe("配置内容加载失败"));
    const action = staleAction();

    // 换到另一份配置打草稿（作用域没变，只是配置不同）
    apiMocks.getConfigDocument.mockResolvedValue({
      content: '{"server":{"port":8080}}',
      format: "json",
      version: "",
      source: "nacos",
      updateTime: "",
    });
    fireEvent.click(screen.getByText("app.json"));
    await expectCodeContains("8080");
    await openEditorWithDraft('{"server":{"port":9090}}');

    await act(async () => {
      action();
    });

    // 这是一次跨配置跳转：有草稿必须先确认，不能直接把草稿连带视图一起换掉
    expect(await screen.findByText("当前配置有未保存的编辑，切换后将丢失这些改动。")).toBeInTheDocument();
    expect(document.querySelector("textarea")).toHaveValue('{"server":{"port":9090}}');
    apiMocks.getConfigDocument.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "留在当前" }));
    await waitFor(() => expect(screen.queryByText("当前配置有未保存的编辑，切换后将丢失这些改动。")).not.toBeInTheDocument());
    expect(apiMocks.getConfigDocument, "取消跳转就不该去读另一份配置").not.toHaveBeenCalled();
    expect(document.querySelector("textarea")).toHaveValue('{"server":{"port":9090}}');
  });
});

// ── 轮97 K1：正文重取失败不许把编辑区连同未保存草稿一起吞掉 ──

describe("ConfigBrowser 正文重取失败时的编辑出口", () => {
  beforeEach(() => {
    localStorage.clear();
    clearErrors();
    apiMocks.listConfigs.mockReset();
    apiMocks.getConfigDocument.mockReset();
    apiMocks.publishConfig.mockReset();
    clearTasks();
    apiMocks.listConfigs.mockResolvedValue(
      configPage([
        { dataId: "app.json", group: "DEFAULT_GROUP", content: "", configType: "json" },
        { dataId: "db.yaml", group: "DEFAULT_GROUP", content: "", configType: "yaml" },
      ])
    );
    apiMocks.getConfigDocument.mockResolvedValue(docOf('{"server":{"port":8080}}'));
  });

  function docOf(content: string, format = "json") {
    return { content, format, version: "", source: "nacos", updateTime: "" };
  }

  /** 服务端那边发生了一次变化：走的是写后失效那条自动重取，与人点「重试」是同一条 openConfig。 */
  async function serverRewrites(next?: { content: string } | Error) {
    if (next instanceof Error) apiMocks.getConfigDocument.mockRejectedValueOnce(next);
    else if (next) apiMocks.getConfigDocument.mockResolvedValue(next);
    await act(async () => {
      publishConfigChange({ connectionId: "dev", namespace: "public", refs: [{ dataId: "app.json", group: "DEFAULT_GROUP" }] });
    });
  }

  async function waitForBanner(selector: string) {
    return waitFor(() => {
      const el = document.querySelector<HTMLElement>(selector);
      expect(el, `${selector} 应该渲染出来`).not.toBeNull();
      return el!;
    });
  }

  async function editDraft(draft: string) {
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    await waitFor(() => expect(document.querySelector("textarea")).toBeInTheDocument());
    fireEvent.change(document.querySelector("textarea")!, { target: { value: draft } });
  }

  it("编辑中重取失败：草稿还在、还能接着改，琥珀条把「基线未知」说清", async () => {
    const onStartApply = vi.fn();
    renderBrowser("zh-CN", conn, "public", { onStartApply });
    fireEvent.click(await screen.findByText("app.json"));
    await expectCodeContains("8080");
    await editDraft('{"server":{"port":9090}}');

    await serverRewrites(new Error("read denied"));

    const banner = await waitForBanner(".browser-baseline-unknown");
    expect(banner.textContent).toContain("还没保存的草稿");
    expect(banner.textContent).toContain("整份文件");
    // 草稿一字没丢，而且还在可编辑的那块里（不是只读回显）
    expect(document.querySelector("textarea")).toHaveValue('{"server":{"port":9090}}');
    fireEvent.change(document.querySelector("textarea")!, { target: { value: '{"server":{"port":9191}}' } });
    expect(document.querySelector("textarea")).toHaveValue('{"server":{"port":9191}}');
    // 两条出口同时在场：错误卡管重试，琥珀条管把草稿抄走
    expect(document.querySelector(".inline-error")).toBeInTheDocument();
    expect(within(banner).getByRole("button", { name: "复制草稿" })).toBeInTheDocument();
  });

  it("基线未知时生成计划这条路是死的，Ctrl+S 也只给一句看得见的理由", async () => {
    const onStartApply = vi.fn();
    renderBrowser("zh-CN", conn, "public", { onStartApply });
    fireEvent.click(await screen.findByText("app.json"));
    await expectCodeContains("8080");
    await editDraft('{"server":{"port":9090}}');
    await serverRewrites(new Error("read denied"));
    await waitForBanner(".browser-baseline-unknown");

    expect(screen.getByRole("button", { name: "生成变更计划" })).toBeDisabled();
    // 按钮点不动之外，快捷键那条路径也必须自己拦下来（disabled 不拦键盘）
    fireEvent.keyDown(document.querySelector("textarea")!, { key: "s", ctrlKey: true });
    expect(await screen.findByText("服务端正文还没取到，现在生成计划会把整份文件覆盖上去：请先重试载入。")).toBeInTheDocument();
    expect(onStartApply).not.toHaveBeenCalled();
    expect(apiMocks.publishConfig).not.toHaveBeenCalled();
    expect(loadOperationHistory()).toEqual([]);
  });

  it("重试成功后一切恢复：琥珀条收起、计划入口回来、基线交换那条判定照常生效", async () => {
    const onStartApply = vi.fn();
    renderBrowser("zh-CN", conn, "public", { onStartApply });
    fireEvent.click(await screen.findByText("app.json"));
    await expectCodeContains("8080");
    await editDraft('{"server":{"port":9090}}');
    await serverRewrites(new Error("read denied"));
    await waitForBanner(".browser-baseline-unknown");
    expect(screen.getByRole("button", { name: "生成变更计划" })).toBeDisabled();

    apiMocks.getConfigDocument.mockResolvedValue(docOf('{"server":{"port":7070}}'));
    fireEvent.click(within(document.querySelector(".inline-error")!).getByRole("button", { name: "重试" }));

    await waitFor(() => expect(document.querySelector(".browser-baseline-unknown")).not.toBeInTheDocument());
    // 服务端真值既不等于旧正文也不等于草稿：轮96 K2 那条基线交换说明必须接得上
    const moved = await waitForBanner(".browser-remote-moved");
    expect(moved.textContent).toContain("服务端已把 app.json");
    const plan = screen.getByRole("button", { name: "生成变更计划" });
    await waitFor(() => expect(plan).toBeEnabled());
    expect(document.querySelector("textarea")).toHaveValue('{"server":{"port":9090}}');

    fireEvent.click(plan);
    await waitFor(() => expect(onStartApply).toHaveBeenCalledTimes(1));
    const payload = onStartApply.mock.calls[0][0] as ApplyEntryPayload;
    expect(payload.items[0].sourceValueOverride?.content).toBe('{"server":{"port":9090}}');
  });

  it("先交换过基线、再重取失败时，那颗会把草稿换成空正文的按钮跟着收掉", async () => {
    renderBrowser("zh-CN", conn, "public", { onStartApply: vi.fn() });
    fireEvent.click(await screen.findByText("app.json"));
    await expectCodeContains("8080");
    await editDraft('{"server":{"port":9090}}');

    await serverRewrites(docOf('{"server":{"port":7070}}'));
    await waitForBanner(".browser-remote-moved");

    await serverRewrites(new Error("read denied"));
    await waitForBanner(".browser-baseline-unknown");

    // 「改用服务端内容」做的是 setDraft(content)，而此刻 content 是空串：留着它等于留一颗清空草稿的按钮
    expect(document.querySelector(".browser-remote-moved")).not.toBeInTheDocument();
    expect(document.querySelector("textarea")).toHaveValue('{"server":{"port":9090}}');
  });

  it("失败态的「复制草稿」抄走的就是编辑器里那份，不另造第二份真相", async () => {
    const { copyText } = await import("../lib/clipboard");
    vi.mocked(copyText).mockClear();
    vi.mocked(copyText).mockResolvedValue(true);
    renderBrowser("zh-CN", conn, "public", { onStartApply: vi.fn() });
    fireEvent.click(await screen.findByText("app.json"));
    await expectCodeContains("8080");
    await editDraft('{"server":{"port":9090}}');
    await serverRewrites(new Error("read denied"));
    const banner = await waitForBanner(".browser-baseline-unknown");

    // 抄的是「屏幕上这一份」：改了草稿再点，拿到的就是改完的那份
    fireEvent.change(document.querySelector("textarea")!, { target: { value: '{"server":{"port":9191}}' } });
    fireEvent.click(within(banner).getByRole("button", { name: "复制草稿" }));

    await waitFor(() => expect(copyText).toHaveBeenCalledTimes(1));
    expect(copyText).toHaveBeenCalledWith('{"server":{"port":9191}}');
  });

  // 轮102 D2：两颗导出按钮原先共用同一枚下载图标，光看图标分不出「导出当前列表」和
  // 「导出源文件到目录」——两者落点完全不同（一个出清单，一个把配置原文铺到本地目录）。
  // 这里钉的是画法必须不同；标签不同早就是绿的（getByTitle 两条各自命中）。
  it("两颗导出按钮的图标是两种画法，不是同一枚复用", async () => {
    renderBrowser();
    await screen.findByText("app.json");

    const pathOf = (btn: HTMLElement) =>
      Array.from(btn.querySelectorAll("path"))
        .map((p) => p.getAttribute("d"))
        .join("|");

    const listBtn = screen.getByTitle("导出当前列表");
    const sourceBtn = screen.getByTitle("导出源文件到目录");
    expect(pathOf(listBtn)).not.toBe("");
    expect(pathOf(sourceBtn)).not.toBe("");
    expect(pathOf(listBtn)).not.toBe(pathOf(sourceBtn));
  });

  it("只读态正文加载失败时，不拿一份空正文冒充「这份配置本来就是空的」", async () => {
    apiMocks.getConfigDocument.mockRejectedValue(new Error("read denied"));
    renderBrowser("zh-CN", conn, "public", { onStartApply: vi.fn() });
    fireEvent.click(await screen.findByText("app.json"));

    await waitFor(() => expect(latestError()?.title).toBe("配置内容加载失败"));
    expect(document.querySelector(".code-area"), "失败态不许渲染正文视图").toBeNull();
    const card = document.querySelector<HTMLElement>(".inline-error")!;
    expect(card.textContent).toContain("read denied");
    expect(within(card).getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});
