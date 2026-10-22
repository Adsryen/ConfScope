/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from "./test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { I18nProvider } from "./i18n";
import type { Connection } from "./store/connections";
import type { BackupDiffJumpParams } from "./components/BackupView";
import type { DiffJumpParams } from "./components/AuditView";
import type { ApplyEntryPayload } from "./lib/applyEntry";
import App from "./App";
import { reportError, reportMessage } from "./lib/errorCenter";
import { toast } from "./lib/toast";
import { loadSettings } from "./store/settings";
import { loadOperationHistory } from "./store/operationHistory";

const apiMocks = vi.hoisted(() => ({
  listNamespaces: vi.fn(),
  checkForUpdates: vi.fn(),
  getAppInfo: vi.fn(),
}));

const viewMocks = vi.hoisted(() => ({
  // 连接管理页删来源走的就是这条通道（先落盘再把剩余列表交给 App），测试用它复现真实顺序
  connectionManagerOnChange: null as ((conns: Connection[]) => void) | null,
  diffProps: [] as Array<{
    connections: Connection[];
    initialParams: DiffJumpParams | null;
    autoCompareOnRestore?: boolean;
  }>,
  applyProps: [] as Array<{
    entry: ApplyEntryPayload | null;
    connections: Connection[];
  }>,
  browserProps: [] as Array<{
    conn: Connection;
    tenant: string;
    active: boolean;
  }>,
  // 每挂载一次自增一次：用来判断保活有没有真的把配置浏览页留在内存里
  browserSeq: 0,
  makeApplyPayload: (mode: "audit" | "diff" | "backup"): ApplyEntryPayload => ({
    sourceType: mode,
    scope: mode === "audit" ? "key" : "config",
    source: {
      provider: mode === "backup" ? "local" : "nacos",
      connectionId: `${mode}-source`,
      connectionName: `${mode}-source`,
      namespace: "",
      label: "entry-source / public",
    },
    target: {
      provider: "nacos",
      connectionId: `${mode}-target`,
      connectionName: `${mode}-target`,
      namespace: "",
      label: "entry-target / public",
    },
    items: [
      {
        provider: "nacos",
        connectionId: `${mode}-target`,
        namespace: "",
        group: "DEFAULT_GROUP",
        dataId: `${mode}.yaml`,
        key: mode === "audit" ? "server.port" : "__document",
      },
    ],
    rangeSummary: {
      count: 1,
      skippedCount: 0,
      riskLevel: "low",
      riskReasons: [],
    },
    origin: {
      mode,
      returnMode: mode,
    },
  }),
}));

vi.mock("./api/nacos", async () => {
  const actual = await vi.importActual<typeof import("./api/nacos")>("./api/nacos");
  return {
    ...actual,
    listNamespaces: apiMocks.listNamespaces,
  };
});

vi.mock("./api/app", () => ({
  checkForUpdates: apiMocks.checkForUpdates,
  getAppInfo: apiMocks.getAppInfo,
}));

vi.mock("./lib/errorCenter", () => ({
  reportError: vi.fn(),
  reportMessage: vi.fn(),
}));

vi.mock("./lib/toast", () => ({
  toast: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}));

vi.mock("./components/ConnectionManager", () => ({
  default: function MockConnectionManager({ onChange }: { onChange?: (conns: Connection[]) => void }) {
    viewMocks.connectionManagerOnChange = onChange ?? null;
    return <div data-testid="connection-manager" />;
  },
}));
vi.mock("./components/ConfigBrowser", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  return {
    default: ({ conn, tenant, active = true }: { conn: Connection; tenant: string; active?: boolean }) => {
      viewMocks.browserProps.push({ conn, tenant, active });
      // 实例号只在挂载时分配：号没变 = 没被卸载重挂 = 保活生效，列表请求也不会重发
      const [instance] = react.useState(() => `browser-${(viewMocks.browserSeq += 1)}`);
      return <div data-testid="config-browser" data-instance={instance} data-active={String(active)} />;
    },
  };
});
vi.mock("./components/About", () => ({ default: () => <div data-testid="about" /> }));
vi.mock("./components/SettingsView", () => ({ default: () => <div data-testid="settings" /> }));
vi.mock("./components/SSHManagerView", () => ({ default: () => <div data-testid="ssh" /> }));
vi.mock("./components/ErrorDialog", () => ({ default: () => <div data-testid="error-dialog" /> }));
vi.mock("./components/MessageCenter", () => ({ default: () => <div data-testid="message-center" /> }));
vi.mock("./components/TaskCenter", () => ({ default: () => <div data-testid="tasks" /> }));
vi.mock("./components/AuditView", () => ({
  default: ({ onStartApply }: { onStartApply?: (payload: ApplyEntryPayload) => void }) => (
    <div data-testid="audit">
      <button type="button" onClick={() => onStartApply?.(viewMocks.makeApplyPayload("audit"))}>
        Mock audit apply
      </button>
    </div>
  ),
}));
vi.mock("./components/OperationHistoryView", () => ({
  default: ({ onStartApply }: { onStartApply?: (payload: ApplyEntryPayload) => void }) => (
    <div data-testid="history">
      <button
        type="button"
        onClick={() =>
          onStartApply?.({
            ...viewMocks.makeApplyPayload("backup"),
            sourceType: "rollback",
            origin: { mode: "rollback", returnMode: "history" },
          })
        }
      >
        Mock history apply
      </button>
    </div>
  ),
}));
vi.mock("./components/ApplyPlanView", () => ({
  default: ({ entry, connections, onBack }: { entry: ApplyEntryPayload | null; connections: Connection[]; onBack: () => void }) => {
    viewMocks.applyProps.push({ entry, connections });
    return (
      <section aria-label="apply-plan-workbench">
        <h3>Apply Plan Workbench</h3>
        <div>{entry?.source.label}</div>
        <div>{entry?.target.label}</div>
        <button type="button" onClick={onBack}>
          Mock ApplyPlanView back
        </button>
      </section>
    );
  },
}));

vi.mock("./components/BackupView", () => ({
  default: ({
    onNavigateToDiff,
    onStartApply,
  }: {
    onNavigateToDiff?: (params: BackupDiffJumpParams) => void;
    onStartApply?: (payload: ApplyEntryPayload) => void;
  }) => {
    const config = {
      dataId: "app.yaml",
      group: "DEFAULT_GROUP",
      content: "server:\n  port: 8080",
      configType: "yaml",
      updateTime: "2026-07-04T00:00:00Z",
    };
    const snapshot = {
      id: "snap-1",
      path: "C:\\backups\\snap-1",
      name: "dev_snapshot",
      description: "",
      createdAt: "2026-07-04T00:00:00Z",
      updatedAt: "2026-07-04T00:00:00Z",
      source: {
        connectionId: "conn-1",
        connectionName: "dev",
        namespace: "public",
        namespaceId: "public",
      },
      configs: [config],
    };
    const makeParams = (overrides: Partial<BackupDiffJumpParams> = {}): BackupDiffJumpParams => ({
      snapshot,
      config,
      sourceConnectionId: "conn-1",
      sourceConnectionName: "dev",
      snapshotPath: "C:\\backups\\snap-1",
      namespace: "",
      group: "DEFAULT_GROUP",
      dataId: "app.yaml",
      ...overrides,
    });

    return (
      <div>
        <button type="button" onClick={() => onNavigateToDiff?.(makeParams())}>
          Mock compare snapshot
        </button>
        <button
          type="button"
          onClick={() =>
            onNavigateToDiff?.(
              makeParams({
                snapshot: {
                  ...snapshot,
                  id: "snap-missing-source",
                  name: "missing_source_snapshot",
                  source: {
                    ...snapshot.source,
                    connectionId: "missing-conn",
                    connectionName: "missing-dev",
                  },
                },
                sourceConnectionId: "missing-conn",
                sourceConnectionName: "missing-dev",
              })
            )
          }
        >
          Mock compare missing source
        </button>
        <button
          type="button"
          onClick={() =>
            onNavigateToDiff?.(
              makeParams({
                snapshot: {
                  ...snapshot,
                  id: "snap-missing-path",
                  path: "",
                  name: "missing_path_snapshot",
                },
                snapshotPath: "",
              })
            )
          }
        >
          Mock compare missing path
        </button>
        <button type="button" onClick={() => onStartApply?.(viewMocks.makeApplyPayload("backup"))}>
          Mock backup apply
        </button>
      </div>
    );
  },
}));

vi.mock("./components/DiffView", () => ({
  default: function MockDiffView({
    connections,
    initialParams,
    onStartApply,
    onInitialParamsConsumed,
    autoCompareOnRestore,
  }: {
    connections: Connection[];
    initialParams: DiffJumpParams | null;
    onStartApply?: (payload: ApplyEntryPayload) => void;
    onInitialParamsConsumed?: () => void;
    autoCompareOnRestore?: boolean;
  }) {
    viewMocks.diffProps.push({ connections, initialParams, autoCompareOnRestore });
    const [compareCount, setCompareCount] = useState(0);
    return (
      <div data-testid="diff-view">
        Diff View
        <button type="button" onClick={() => setCompareCount((count) => count + 1)}>
          Mock diff compare
        </button>
        <button type="button" onClick={() => onInitialParamsConsumed?.()}>
          Mock consume jump params
        </button>
        <span data-testid="diff-state">{compareCount}</span>
        <button type="button" onClick={() => onStartApply?.(viewMocks.makeApplyPayload("diff"))}>
          Mock diff apply
        </button>
      </div>
    );
  },
}));

const sourceConnection: Connection = {
  id: "conn-1",
  name: "dev",
  projectName: "Order",
  environmentName: "Development",
  sourceName: "Cloud",
  sourceType: "nacos",
  provider: "nacos",
  distribution: "opensource",
  authType: "nacos-password",
  baseUrl: "http://dev.example.com/nacos",
  username: "nacos",
  password: "secret",
  defaultNamespace: "",
};

describe("App", () => {
  beforeEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    localStorage.setItem("locale", "en-US");
    localStorage.setItem("cs.connections", JSON.stringify([sourceConnection]));
    localStorage.setItem("cs.ui", JSON.stringify({ mode: "backup", connId: "conn-1" }));
    localStorage.setItem(
      "cs.settings",
      JSON.stringify({
        startup: { lastOpenedVersion: "1.3.0", lastShownWelcomeVersion: "", lastShownChangelogVersion: "1.3.0" },
      })
    );
    viewMocks.diffProps.length = 0;
    viewMocks.applyProps.length = 0;
    viewMocks.browserProps.length = 0;
    apiMocks.listNamespaces.mockResolvedValue([]);
    apiMocks.getAppInfo.mockResolvedValue({ name: "ConfScope", version: "1.3.0", updateSources: [] });
    apiMocks.checkForUpdates.mockResolvedValue({ hasUpdate: false, latestVersion: "", releaseNotes: "" });
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      fillStyle: "",
    } as unknown as CanvasRenderingContext2D);
    vi.mocked(reportError).mockClear();
    vi.mocked(reportMessage).mockClear();
    vi.mocked(toast).mockClear();
  });

  it("shows the fresh-install welcome dialog once and records dismissal", async () => {
    localStorage.clear();
    localStorage.setItem("locale", "en-US");

    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    expect(await screen.findByRole("dialog", { name: "Welcome to ConfScope" })).toBeInTheDocument();
    expect(screen.getByTestId("startup-fireworks")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Start using" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Welcome to ConfScope" })).not.toBeInTheDocument();
    });
    expect(loadSettings().startup).toEqual({
      lastOpenedVersion: "1.3.0",
      lastShownWelcomeVersion: "1.3.0",
      lastShownChangelogVersion: "",
    });
  });

  it("shows update notes once for an existing profile and records dismissal", async () => {
    localStorage.clear();
    localStorage.setItem("locale", "en-US");
    localStorage.setItem("cs.connections", JSON.stringify([sourceConnection]));
    apiMocks.getAppInfo.mockResolvedValueOnce({ name: "ConfScope", version: "1.3.1", updateSources: [] });

    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    expect(await screen.findByRole("dialog", { name: "Updated to v1.3.1" })).toBeInTheDocument();
    expect(screen.getByText("Fixed update checks and release metadata")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Updated to v1.3.1" })).not.toBeInTheDocument();
    });
    expect(loadSettings().startup).toEqual({
      lastOpenedVersion: "1.3.1",
      lastShownWelcomeVersion: "",
      lastShownChangelogVersion: "1.3.1",
    });
  });

  it("does not repeat a startup dialog already dismissed for the current version", async () => {
    localStorage.clear();
    localStorage.setItem("locale", "en-US");
    localStorage.setItem(
      "cs.settings",
      JSON.stringify({
        startup: { lastOpenedVersion: "1.3.0", lastShownWelcomeVersion: "1.3.0", lastShownChangelogVersion: "" },
      })
    );

    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitFor(() => {
      expect(apiMocks.getAppInfo).toHaveBeenCalled();
    });
    expect(screen.queryByRole("dialog", { name: "Welcome to ConfScope" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Updated to v1.3.0" })).not.toBeInTheDocument();
  });

  it("does not mark config navigation as planned when there are no connections", async () => {
    localStorage.clear();
    localStorage.setItem("locale", "en-US");
    localStorage.setItem(
      "cs.settings",
      JSON.stringify({
        startup: { lastOpenedVersion: "1.3.0", lastShownWelcomeVersion: "1.3.0", lastShownChangelogVersion: "" },
      })
    );

    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitFor(() => {
      expect(apiMocks.getAppInfo).toHaveBeenCalled();
    });
    expect(within(screen.getByRole("button", { name: /Config Browser/ })).queryByText("Planned")).not.toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /Config Compare/ })).queryByText("Planned")).not.toBeInTheDocument();
  });

  it("侧栏导航有地标名、当前页自报 aria-current、每一项都带全文 title", async () => {
    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    // 读屏进侧栏时先念得出这是「主导航」，而不是「一组按钮」
    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    const pages = () => within(nav).getAllByRole("button");
    const ariaCurrent = () => pages().filter((item) => item.getAttribute("aria-current") === "page");

    // cs.ui 里存的是 backup，当前页必须且只能是它——多个 aria-current 等于没有
    expect(ariaCurrent()).toHaveLength(1);
    expect(ariaCurrent()[0]).toHaveAccessibleName("Backups");

    fireEvent.click(within(nav).getByRole("button", { name: "Config Compare" }));

    await waitFor(() => {
      expect(ariaCurrent()).toHaveLength(1);
      expect(ariaCurrent()[0]).toHaveAccessibleName("Config Compare");
    });

    // title 不再只在折叠态给：窄窗口把 .side-label 截断时，鼠标悬停也要能读到全文（R35 收尾）
    pages().forEach((item) => {
      expect(item, "导航项缺 title，截断后没有任何补救入口").toHaveAttribute("title", String(item.textContent).trim());
    });
  });

  it("opens the about page even when there are no connections", async () => {
    localStorage.clear();
    localStorage.setItem("locale", "en-US");
    localStorage.setItem(
      "cs.settings",
      JSON.stringify({
        startup: { lastOpenedVersion: "1.3.0", lastShownWelcomeVersion: "1.3.0", lastShownChangelogVersion: "" },
      })
    );

    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitFor(() => {
      expect(apiMocks.getAppInfo).toHaveBeenCalled();
    });
    fireEvent.click(screen.getByRole("button", { name: /About/ }));

    expect(screen.getByTestId("about")).toBeInTheDocument();
    expect(screen.queryByText("No Nacos connections yet")).not.toBeInTheDocument();
  });

  it("restores the last used browse project environment and source", async () => {
    const connections: Connection[] = [
      sourceConnection,
      {
        ...sourceConnection,
        id: "conn-billing-prod-private",
        name: "billing-prod-private",
        projectName: "Billing",
        environmentName: "Production",
        sourceName: "Private",
        baseUrl: "http://billing.example.com/nacos",
      },
    ];
    localStorage.setItem("cs.connections", JSON.stringify(connections));
    localStorage.setItem(
      "cs.ui",
      JSON.stringify({
        mode: "browse",
        browseProject: "Billing",
        browseEnvironment: "Production",
        browseSourceId: "conn-billing-prod-private",
      })
    );

    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await screen.findByTestId("config-browser");

    expect(viewMocks.browserProps[viewMocks.browserProps.length - 1].conn.id).toBe("conn-billing-prod-private");
    expect(JSON.parse(localStorage.getItem("cs.ui") || "{}")).toMatchObject({
      browseProject: "Billing",
      browseEnvironment: "Production",
      browseSourceId: "conn-billing-prod-private",
    });
  });

  // 轮47 R47-01：删掉当前来源后必须停在用户此刻所在的项目/环境里。
  // 老写法在回落时 loadUI()，读回来的是持久化 effect 刚写的空串回声 ⇒ 三层判据全废，
  // 选中项跳到列表第 0 条，实测还会跨到另一个环境（开发 → Development）。
  it("删掉当前来源后落在同环境兄弟上，作用域不跨环境", async () => {
    const devCloud = sourceConnection; // Order / Development / Cloud
    const testCloud: Connection = {
      ...sourceConnection,
      id: "conn-order-test-cloud",
      name: "order-test-cloud",
      environmentName: "Test",
      sourceName: "Cloud",
      baseUrl: "http://order-test-cloud.example.com/nacos",
    };
    const devPrivate: Connection = {
      ...sourceConnection,
      id: "conn-order-dev-private",
      name: "order-dev-private",
      environmentName: "Development",
      sourceName: "Private",
      baseUrl: "http://order-dev-private.example.com/nacos",
    };
    // 列表第 0 条刻意放另一个环境的来源：跨环境回落只有这样才能暴露
    localStorage.setItem("cs.connections", JSON.stringify([devCloud, testCloud, devPrivate]));
    localStorage.setItem("cs.ui", JSON.stringify({ mode: "browse", connId: devCloud.id }));

    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await screen.findByTestId("config-browser");
    const lastBrowse = () => viewMocks.browserProps[viewMocks.browserProps.length - 1].conn;
    expect(lastBrowse().id).toBe(devCloud.id);

    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    fireEvent.click(within(nav).getByRole("button", { name: "Connections" }));
    fireEvent.click(within(nav).getByRole("button", { name: /Config Browser/ }));

    const remaining = [testCloud, devPrivate];
    localStorage.setItem("cs.connections", JSON.stringify(remaining));
    act(() => {
      const onChange = viewMocks.connectionManagerOnChange;
      if (!onChange) throw new Error("ConnectionManager 的 onChange 通道没接上");
      onChange(remaining);
    });

    await waitFor(() => {
      expect(lastBrowse().id).toBe(devPrivate.id);
    });
    expect(JSON.parse(localStorage.getItem("cs.ui") || "{}")).toMatchObject({
      connId: devPrivate.id,
      browseProject: "Order",
      browseEnvironment: "Development",
      browseSourceId: devPrivate.id,
    });
  });

  it("同项目同环境一条不剩时才回落到列表第 0 条", async () => {
    const devCloud = sourceConnection; // Order / Development / Cloud
    const testCloud: Connection = {
      ...sourceConnection,
      id: "conn-order-test-cloud",
      name: "order-test-cloud",
      environmentName: "Test",
      sourceName: "Cloud",
      baseUrl: "http://order-test-cloud.example.com/nacos",
    };
    const billingProd: Connection = {
      ...sourceConnection,
      id: "conn-billing-prod-private",
      name: "billing-prod-private",
      projectName: "Billing",
      environmentName: "Production",
      sourceName: "Private",
      baseUrl: "http://billing.example.com/nacos",
    };
    localStorage.setItem("cs.connections", JSON.stringify([devCloud, testCloud, billingProd]));
    localStorage.setItem("cs.ui", JSON.stringify({ mode: "browse", connId: devCloud.id }));

    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await screen.findByTestId("config-browser");
    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    fireEvent.click(within(nav).getByRole("button", { name: "Connections" }));

    const remaining = [testCloud, billingProd];
    localStorage.setItem("cs.connections", JSON.stringify(remaining));
    act(() => {
      const onChange = viewMocks.connectionManagerOnChange;
      if (!onChange) throw new Error("ConnectionManager 的 onChange 通道没接上");
      onChange(remaining);
    });

    await waitFor(() => {
      expect(viewMocks.browserProps[viewMocks.browserProps.length - 1].conn.id).toBe(testCloud.id);
    });
  });

  it("keeps the browse page mounted across mode switches and hands back keyboard duties", async () => {
    localStorage.setItem("cs.ui", JSON.stringify({ mode: "browse", connId: "conn-1" }));

    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    const browser = await screen.findByTestId("config-browser");
    const instance = browser.getAttribute("data-instance");
    expect(browser).toHaveAttribute("data-active", "true");
    expect(browser.closest(".browse-cache")).not.toHaveAttribute("hidden");

    // 切到配置矩阵：整页只是 hidden，不卸载
    fireEvent.click(screen.getByRole("button", { name: /Config Matrix/ }));
    await waitFor(() => expect(screen.getByTestId("audit")).toBeInTheDocument());
    const cached = screen.getByTestId("config-browser");
    expect(cached.getAttribute("data-instance")).toBe(instance);
    // 用 hidden 属性隐藏，Tab 顺序不会穿过隐藏内容
    expect(cached.closest(".browse-cache")).toHaveAttribute("hidden");
    // 同时把全局键盘职责交还（Esc / Ctrl+F 归当前模式）
    expect(cached).toHaveAttribute("data-active", "false");

    fireEvent.click(screen.getByRole("button", { name: /Settings/ }));
    await waitFor(() => expect(screen.getByTestId("settings")).toBeInTheDocument());
    expect(screen.getByTestId("config-browser").getAttribute("data-instance")).toBe(instance);

    fireEvent.click(screen.getByRole("button", { name: /Config Browser/ }));
    await waitFor(() => expect(screen.getByTestId("config-browser")).toHaveAttribute("data-active", "true"));
    expect(screen.getByTestId("config-browser").closest(".browse-cache")).not.toHaveAttribute("hidden");
    // 仍是同一个实例：选中项、正文、搜索词、列表滚动、查找态都留在内存里
    expect(screen.getByTestId("config-browser").getAttribute("data-instance")).toBe(instance);
  });

  it("remounts the kept-alive browse page when the namespace changes", async () => {
    apiMocks.listNamespaces.mockResolvedValue([{ namespace: "ns-gray", namespaceShowName: "", configCount: 1 }]);
    localStorage.setItem("cs.ui", JSON.stringify({ mode: "browse", connId: "conn-1" }));

    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    const first = (await screen.findByTestId("config-browser")).getAttribute("data-instance");
    const filterButtons = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".browse-scope-field .sel-trigger"));

    await waitFor(() => expect(filterButtons()[3]).not.toBeDisabled());
    fireEvent.pointerDown(filterButtons()[3]);
    const option = Array.from(document.querySelectorAll<HTMLElement>(".sel-option")).find((item) => item.textContent?.includes("ns-gray"));
    if (!option) throw new Error("Namespace option not found: ns-gray");
    fireEvent.mouseDown(option);

    await waitFor(() => {
      expect(viewMocks.browserProps[viewMocks.browserProps.length - 1].tenant).toBe("ns-gray");
    });
    // 保活不能保住旧连接的数据：命名空间变化仍靠 key 重挂载重拉列表
    const current = screen.getByTestId("config-browser");
    expect(current.getAttribute("data-instance")).not.toBe(first);
    expect(viewMocks.browserProps[viewMocks.browserProps.length - 1].active).toBe(true);
  });

  it("closes an open portaled dropdown when the mode switches", async () => {
    localStorage.setItem("cs.ui", JSON.stringify({ mode: "browse", connId: "conn-1" }));

    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await screen.findByTestId("config-browser");
    const triggers = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".browse-scope-field .sel-trigger"));
    await waitFor(() => expect(triggers().length).toBeGreaterThan(0));
    fireEvent.pointerDown(triggers()[0]);
    await waitFor(() => expect(document.querySelector(".sel-menu-portal")).toBeInTheDocument());

    // 菜单 portal 在 document.body 上，不在被保活隐藏的 browse 子树里：
    // 模式切换必须显式喊它收起，否则会浮到设置页上方并继续占着 Esc / window 监听
    fireEvent.click(screen.getByRole("button", { name: /Settings/ }));
    await waitFor(() => expect(screen.getByTestId("settings")).toBeInTheDocument());
    expect(document.querySelector(".sel-menu-portal")).not.toBeInTheDocument();
  });

  it("updates and remembers browse filters when switching environment and source", async () => {
    const connections: Connection[] = [
      sourceConnection,
      {
        ...sourceConnection,
        id: "conn-order-test-private",
        name: "order-test-private",
        environmentName: "Test",
        sourceName: "Private",
        isDefaultSource: true,
        baseUrl: "http://order-test-private.example.com/nacos",
      },
      {
        ...sourceConnection,
        id: "conn-order-test-cloud",
        name: "order-test-cloud",
        environmentName: "Test",
        sourceName: "Cloud",
        baseUrl: "http://order-test-cloud.example.com/nacos",
      },
    ];
    localStorage.setItem("cs.connections", JSON.stringify(connections));
    localStorage.setItem("cs.ui", JSON.stringify({ mode: "browse", connId: "conn-1" }));

    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await screen.findByTestId("config-browser");
    const filterButtons = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".browse-scope-field .sel-trigger"));
    const pickOption = (label: string) => {
      const option = Array.from(document.querySelectorAll<HTMLElement>(".sel-option")).find((item) => item.textContent === label);
      if (!option) throw new Error(`Option not found: ${label}`);
      fireEvent.mouseDown(option);
    };

    fireEvent.pointerDown(filterButtons()[1]);
    pickOption("Test");

    await waitFor(() => {
      expect(viewMocks.browserProps[viewMocks.browserProps.length - 1].conn.id).toBe("conn-order-test-private");
    });

    fireEvent.pointerDown(filterButtons()[2]);
    pickOption("Cloud");

    await waitFor(() => {
      expect(viewMocks.browserProps[viewMocks.browserProps.length - 1].conn.id).toBe("conn-order-test-cloud");
    });
    expect(JSON.parse(localStorage.getItem("cs.ui") || "{}")).toMatchObject({
      browseProject: "Order",
      browseEnvironment: "Test",
      browseSourceId: "conn-order-test-cloud",
    });
  });

  it("opens DiffView with a runtime local snapshot source from BackupView", async () => {
    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Mock compare snapshot" }));

    expect(await screen.findByTestId("diff-view")).toBeInTheDocument();

    await waitFor(() => {
      expect(viewMocks.diffProps.length).toBeGreaterThan(0);
    });
    const latestProps = viewMocks.diffProps[viewMocks.diffProps.length - 1];
    expect(latestProps.initialParams).toEqual({
      leftConnId: "snapshot:snap-1",
      rightConnId: "conn-1",
      // 两侧独立携带同一逻辑配置（快照对比，namespace/group/dataId 相同）
      left: { tenant: "", group: "DEFAULT_GROUP", dataId: "app.yaml" },
      right: { tenant: "", group: "DEFAULT_GROUP", dataId: "app.yaml" },
      autoCompare: true,
    });
    expect(latestProps.connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "snapshot:snap-1",
          provider: "local",
          sourceType: "local-snapshot",
          localPath: "C:\\backups\\snap-1",
          defaultNamespace: "",
        }),
      ])
    );
    expect(toast).toHaveBeenCalledWith("Snapshot source loaded for compare", "info");
    expect(loadOperationHistory()[0]).toMatchObject({
      type: "snapshot_compare",
      result: "success",
      connectionId: "conn-1",
      connectionName: "dev",
      namespace: "public",
      group: "DEFAULT_GROUP",
      dataId: "app.yaml",
      resourceId: "snap-1",
      resourceName: "dev_snapshot",
      content: "C:\\backups\\snap-1",
      rollbackable: false,
      rollbackReason: "operationHistory.rollbackSnapshotOnly",
    });
  });

  it.each([
    { mode: "backup", buttonName: "Mock backup apply" },
    { mode: "audit", buttonName: "Mock audit apply" },
    { mode: "diff", buttonName: "Mock diff apply" },
  ] as const)("enters ApplyPlanView from $mode", async ({ mode, buttonName }) => {
    localStorage.setItem("cs.ui", JSON.stringify({ mode, connId: "conn-1" }));

    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: buttonName }));

    expect(screen.getByRole("heading", { name: "Apply Plan Workbench" })).toBeInTheDocument();
    expect(screen.getByText("entry-source / public")).toBeInTheDocument();
    expect(screen.getByText("entry-target / public")).toBeInTheDocument();
    expect(screen.queryByText("Plan preview placeholder")).not.toBeInTheDocument();
    expect(viewMocks.applyProps[viewMocks.applyProps.length - 1]).toMatchObject({
      entry: expect.objectContaining({ sourceType: mode }),
      connections: expect.arrayContaining([expect.objectContaining({ id: "conn-1" })]),
    });
    expect(screen.queryByRole("button", { name: /Execute|Publish|Delete|Apply Now/i })).not.toBeInTheDocument();
  });

  it("returns from ApplyPlanView to the originating entry", async () => {
    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "Mock backup apply" }));
    fireEvent.click(screen.getByRole("button", { name: "Mock ApplyPlanView back" }));

    expect(screen.getByRole("button", { name: "Mock backup apply" })).toBeInTheDocument();
  });

  it("returns from a diff plan without resetting the previous diff state", async () => {
    localStorage.setItem("cs.ui", JSON.stringify({ mode: "diff", connId: "conn-1" }));

    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "Mock diff compare" }));
    expect(screen.getByTestId("diff-state")).toHaveTextContent("1");

    fireEvent.click(screen.getByRole("button", { name: "Mock diff apply" }));
    expect(screen.getByRole("heading", { name: "Apply Plan Workbench" })).toBeInTheDocument();
    expect(screen.getByTestId("diff-view").closest(".diff-apply-cache")).toHaveAttribute("hidden");

    fireEvent.click(screen.getByRole("button", { name: "Mock ApplyPlanView back" }));
    expect(screen.getByTestId("diff-state")).toHaveTextContent("1");
  });

  it("routes history follow-up entries to ApplyPlanView and returns to history without persisting apply mode", async () => {
    localStorage.setItem("cs.ui", JSON.stringify({ mode: "history", connId: "conn-1" }));

    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "Mock history apply" }));

    expect(screen.getByRole("heading", { name: "Apply Plan Workbench" })).toBeInTheDocument();
    expect(viewMocks.applyProps[viewMocks.applyProps.length - 1]).toMatchObject({
      entry: expect.objectContaining({ sourceType: "rollback", origin: { mode: "rollback", returnMode: "history" } }),
    });
    expect(JSON.parse(localStorage.getItem("cs.ui") || "{}").mode).not.toBe("apply");

    fireEvent.click(screen.getByRole("button", { name: "Mock ApplyPlanView back" }));

    expect(screen.getByRole("button", { name: "Mock history apply" })).toBeInTheDocument();
  });

  it("records a failed snapshot compare when the source connection is missing", async () => {
    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Mock compare missing source" }));

    expect(screen.queryByTestId("diff-view")).not.toBeInTheDocument();
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Cannot open snapshot compare",
        source: "missing-dev",
        message: "The source connection for this snapshot no longer exists. Restore or recreate it first.",
      })
    );
    expect(loadOperationHistory()[0]).toMatchObject({
      type: "snapshot_compare",
      result: "failure",
      connectionId: "missing-conn",
      connectionName: "missing-dev",
      namespace: "public",
      group: "DEFAULT_GROUP",
      dataId: "app.yaml",
      resourceId: "snap-missing-source",
      resourceName: "missing_source_snapshot",
      content: "C:\\backups\\snap-1",
      error: "The source connection for this snapshot no longer exists. Restore or recreate it first.",
      rollbackable: false,
      rollbackReason: "operationHistory.rollbackSnapshotOnly",
    });
  });

  it("records a failed snapshot compare when the snapshot path is missing", async () => {
    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Mock compare missing path" }));

    expect(screen.queryByTestId("diff-view")).not.toBeInTheDocument();
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Cannot open snapshot compare",
        source: "missing_path_snapshot",
        message: "Snapshot local path is missing, so it cannot be used as a local compare source.",
      })
    );
    expect(loadOperationHistory()[0]).toMatchObject({
      type: "snapshot_compare",
      result: "failure",
      connectionId: "conn-1",
      connectionName: "dev",
      namespace: "public",
      group: "DEFAULT_GROUP",
      dataId: "app.yaml",
      resourceId: "snap-missing-path",
      resourceName: "missing_path_snapshot",
      content: "",
      error: "Snapshot local path is missing, so it cannot be used as a local compare source.",
      rollbackable: false,
      rollbackReason: "operationHistory.rollbackSnapshotOnly",
    });
  });

  it("reports namespace loading errors with localized message-center actions", async () => {
    apiMocks.listNamespaces.mockRejectedValueOnce(new Error("namespace denied"));

    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitFor(() => {
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Failed to load namespaces",
          actionLabel: "Retry",
        })
      );
    });
  });

  it("reports background update notifications with localized message-center actions", async () => {
    vi.useFakeTimers();
    try {
      apiMocks.checkForUpdates.mockResolvedValueOnce({
        hasUpdate: true,
        latestVersion: "1.4.0",
        releaseNotes: "release notes",
        error: "",
        mandatory: false,
      });

      render(
        <I18nProvider>
          <App />
        </I18nProvider>
      );

      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
        await Promise.resolve();
      });

      expect(reportMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "New version v1.4.0 available",
          source: "App Updates",
          actionLabel: "Open Download Page",
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // 轮46 R01：「比的是哪一对」只有一个主人 —— cs.diffViewPreferences（DiffView 每次改动都写、
  // 挂载时自己恢复），cs.ui 不再存 diffLeft*/diffRight* 那份镜像。
  // 探针实测过双写的代价：镜像只在 App 跳转时更新，于是它常年是旧的；重启时旧的赢下界面，
  // 还会被 DiffView 的保存 effect 抄回 prefs —— 手工改出来那对 billing 比完后 prefs 记的确实是
  // billing，重启 656ms 后 DOM 回到种子对、prefs 自己也被回写成种子对，用户真正比过的那一对永久丢失。
  const diffKeysInUI = () => Object.keys(JSON.parse(localStorage.getItem("cs.ui") || "{}")).filter((key) => key.startsWith("diff"));

  it("启动停在对比页：挂载即比的意图交给 DiffView，cs.ui 里不再留任何 diff 键", async () => {
    localStorage.setItem("cs.connections", JSON.stringify([sourceConnection, { ...sourceConnection, id: "conn-2", name: "prod" }]));
    localStorage.setItem(
      "cs.ui",
      JSON.stringify({
        mode: "diff",
        connId: "conn-1",
        // 老用户数据里还留着这些键（它们跟着主数据文档走）：新口径下读侧直接忽略，
        // 不迁移、不报错，整对象回写时自然带走。
        diffLeftConnId: "conn-1",
        diffRightConnId: "conn-2",
        diffLeft: { tenant: "public", dataId: "a.yaml", group: "G" },
        diffRight: { tenant: "prod", dataId: "a.yaml", group: "G" },
        diffAutoCompare: true,
      })
    );

    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await screen.findByTestId("diff-view");
    const lastProps = viewMocks.diffProps[viewMocks.diffProps.length - 1];
    // 「上一轮退出时停在对比页」是一次性意图，只以 props 传给 DiffView；
    // 要不要真比由 DiffView 结合 prefs 里那一对齐不齐自己判定（轮46 R02）。
    expect(lastProps.autoCompareOnRestore).toBe(true);
    // 启动恢复不再走跳转参数那条路，所以这里不该有任何预填参数
    expect(lastProps.initialParams).toBeNull();
    await waitFor(() => expect(diffKeysInUI()).toEqual([]));
    expect(JSON.parse(localStorage.getItem("cs.ui") || "{}")).toMatchObject({ mode: "diff", connId: "conn-1" });
  });

  it("本会话中途点进对比页：不点亮挂载即比的意图（它只代表上一轮退出时停在哪个页面）", async () => {
    localStorage.setItem("cs.connections", JSON.stringify([sourceConnection, { ...sourceConnection, id: "conn-2", name: "prod" }]));
    localStorage.setItem(
      "cs.ui",
      JSON.stringify({
        mode: "browse",
        connId: "conn-1",
        // 齐全的来源照旧存着：中途点进对比页只是去查看，不该替用户重放上一轮的对比
        diffLeftConnId: "conn-1",
        diffRightConnId: "conn-2",
      })
    );

    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    fireEvent.click(within(nav).getByRole("button", { name: "Config Compare" }));
    await screen.findByTestId("diff-view");
    await waitFor(() => expect(JSON.parse(localStorage.getItem("cs.ui") || "{}").mode).toBe("diff"));

    // 轮45 的教训：ui0 = loadUI() 每次渲染都重读存储，意图若从「当前 mode」现取，
    // 本会话中途的每次挂载都会点亮它 ⇒ 对比页每次回来白比一轮（回声室）。
    expect(viewMocks.diffProps[viewMocks.diffProps.length - 1].autoCompareOnRestore).toBe(false);
    expect(diffKeysInUI()).toEqual([]);
  });

  it("跳转来源被消费后：意图随 props 一起消失，cs.ui 不再留一份会过期的镜像", async () => {
    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Mock compare snapshot" }));
    await screen.findByTestId("diff-view");
    const jumped = viewMocks.diffProps[viewMocks.diffProps.length - 1].initialParams;
    expect(jumped).not.toBeNull();
    expect(jumped?.leftConnId).toBeTruthy();
    expect(jumped?.rightConnId).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Mock consume jump params" }));
    await waitFor(() => expect(viewMocks.diffProps[viewMocks.diffProps.length - 1].initialParams).toBeNull());
    // 「这一次要比」消费完就没了，不会留在存储里等下次挂载复燃（轮45 R02 口径不变）
    expect(diffKeysInUI()).toEqual([]);
  });

  it("绕出对比页再回来：App 不碰 prefs，那一对来源由 prefs 自己保住", async () => {
    localStorage.setItem("cs.connections", JSON.stringify([sourceConnection, { ...sourceConnection, id: "conn-2", name: "prod" }]));
    const prefs = {
      selectedProject: "Order",
      left: { connId: "conn-1", tenant: "public", dataId: "a.yaml", group: "G", usesDefaultNamespace: false },
      right: { connId: "conn-2", tenant: "prod", dataId: "a.yaml", group: "G", usesDefaultNamespace: false },
      mode: "text",
    };
    localStorage.setItem("cs.diffViewPreferences", JSON.stringify(prefs));
    localStorage.setItem("cs.ui", JSON.stringify({ mode: "diff", connId: "conn-1" }));

    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await screen.findByTestId("diff-view");
    const prefsBefore = localStorage.getItem("cs.diffViewPreferences");
    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    fireEvent.click(within(nav).getByRole("button", { name: "Config Browser" }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("cs.ui") || "{}").mode).toBe("browse"));
    fireEvent.click(within(nav).getByRole("button", { name: "Config Compare" }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("cs.ui") || "{}").mode).toBe("diff"));

    // 轮45 的这条守卫测的是「切走那一次 spread 成 {} 把来源抹了」。轮46 把 App 这个写侧整个删掉后，
    // 判据变成两条：cs.ui 里根本没有可被抹掉的 diff 键，且 App 的任何导航都不许动 prefs 一个字节。
    expect(diffKeysInUI()).toEqual([]);
    expect(localStorage.getItem("cs.diffViewPreferences")).toBe(prefsBefore);
  });


  // 轮66 WP-3：内置默认名（默认项目 / 未分组 / 默认来源）既是存档值又是分组匹配键，
  // 不能改常量，只能在展示层判哨兵再翻译。这条是端到端的兜底：
  // 上面的静态守卫只看同行写法，变量传递（projectNames → Select 的 label）它看不见。
  it("keeps built-in default names out of the English UI", async () => {
    localStorage.setItem(
      "cs.connections",
      JSON.stringify([
        {
          id: "conn-default",
          name: "",
          // 三个归属字段整个缺席 = 老存档，读取时兜底成中文哨兵，正是最容易漏译的形态
          sourceType: "nacos",
          provider: "nacos",
          distribution: "opensource",
          authType: "none",
          baseUrl: "http://dev.example.com/nacos",
          defaultNamespace: "",
        },
      ])
    );
    localStorage.setItem("cs.ui", JSON.stringify({ mode: "browse", connId: "conn-default" }));

    const { container } = render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    expect(await screen.findByText("Default Project / Ungrouped / Default Source")).toBeInTheDocument();

    const rendered = container.textContent ?? "";
    for (const leak of ["默认项目", "未分组", "默认来源"]) {
      expect(rendered, `英文界面漏出中文默认名「${leak}」`).not.toContain(leak);
    }
  });

});
