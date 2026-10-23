/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor, within } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { formatDateTime } from "../lib/formatDateTime";
import SettingsView from "./SettingsView";

const credentialMocks = vi.hoisted(() => ({
  countMigratableStoredCredentials: vi.fn(() => 0),
  migrateStoredCredentials: vi.fn(),
}));

vi.mock("../lib/credentialSecrets", async () => {
  const actual = await vi.importActual<typeof import("../lib/credentialSecrets")>("../lib/credentialSecrets");
  return {
    ...actual,
    countMigratableStoredCredentials: credentialMocks.countMigratableStoredCredentials,
    migrateStoredCredentials: credentialMocks.migrateStoredCredentials,
  };
});

const cacheMocks = vi.hoisted(() => ({
  clearAppCache: vi.fn(),
}));

vi.mock("../lib/cacheCleanup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cacheCleanup")>();
  return {
    ...actual,
    clearAppCache: cacheMocks.clearAppCache,
  };
});

const historyMocks = vi.hoisted(() => ({
  clearOperationHistory: vi.fn(),
}));

vi.mock("../store/operationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store/operationHistory")>();
  return {
    ...actual,
    clearOperationHistory: historyMocks.clearOperationHistory,
  };
});

const dataLocMocks = vi.hoisted(() => ({
  GetDataLocations: vi.fn(),
  OpenDataFolder: vi.fn(),
  // 轮62：数据根运行形态与换根迁移
  GetRuntimeLayout: vi.fn(),
  SelectDataRootDirectory: vi.fn(),
  PlanDataRootMigration: vi.fn(),
  MigrateDataRoot: vi.fn(),
  CheckDataRootRollback: vi.fn(),
  RollbackDataRoot: vi.fn(),
}));

vi.mock("../../wailsjs/go/app/App", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../wailsjs/go/app/App")>();
  return {
    ...actual,
    GetDataLocations: dataLocMocks.GetDataLocations,
    OpenDataFolder: dataLocMocks.OpenDataFolder,
    GetRuntimeLayout: dataLocMocks.GetRuntimeLayout,
    SelectDataRootDirectory: dataLocMocks.SelectDataRootDirectory,
    PlanDataRootMigration: dataLocMocks.PlanDataRootMigration,
    MigrateDataRoot: dataLocMocks.MigrateDataRoot,
    CheckDataRootRollback: dataLocMocks.CheckDataRootRollback,
    RollbackDataRoot: dataLocMocks.RollbackDataRoot,
  };
});

const testDataLocations = {
  dataRoot: "/tmp/confscope-retest/data",
  entries: [
    { key: "dataRoot", path: "/tmp/confscope-retest/data", isFile: false, exists: true },
    { key: "appDataFile", path: "/tmp/confscope-retest/data/app-data/confscope-data.json", isFile: true, exists: true },
    { key: "webview", path: "/tmp/confscope-retest/data/webview", isFile: false, exists: true },
    { key: "snapshots", path: "/tmp/confscope-retest/data/snapshots", isFile: false, exists: false },
    { key: "recoveryPoints", path: "/tmp/confscope-retest/data/app-data-recovery-points", isFile: false, exists: false },
    { key: "audit", path: "/tmp/confscope-retest/data/audit-trail.jsonl", isFile: true, exists: true },
  ],
};

// 轮62：运行形态替身。installed + os-user-data 是最常出问题的组合（deb/rpm 装完写不出主数据文件），
// 所以默认让它命中「系统用户数据目录」这一档，界面必须把判定依据讲清楚。
const testRuntimeLayout = {
  mode: "installed",
  dataRoot: "/home/ryen/.local/share/confscope",
  source: "os-user-data",
  exeDir: "/usr/bin",
  exeDirWritable: false,
  pointerPath: "",
  previousRoot: "",
  osDataDir: "/home/ryen/.local/share/confscope",
  notes: [],
  error: "",
};

const testRollbackUnavailable = {
  available: false,
  currentRoot: testRuntimeLayout.dataRoot,
  previousRoot: "",
  currentDoc: { exists: true, path: `${testRuntimeLayout.dataRoot}/app-data/confscope-data.json`, savedAt: "", sizeBytes: 0, sha256: "" },
  previousDoc: { exists: false, path: "", savedAt: "", sizeBytes: 0, sha256: "" },
  reason: "no previous root",
};

const testRollbackAvailable = {
  ...testRollbackUnavailable,
  available: true,
  previousRoot: "/opt/confscope/ConfScopeData",
  currentDoc: { exists: true, path: `${testRuntimeLayout.dataRoot}/app-data/confscope-data.json`, savedAt: "2026-10-22T01:02:03.000Z", sizeBytes: 2048, sha256: "a" },
  previousDoc: { exists: true, path: "/opt/confscope/ConfScopeData/app-data/confscope-data.json", savedAt: "2026-10-01T08:00:00.000Z", sizeBytes: 4096, sha256: "b" },
  reason: "",
};

const testMigrationPlan = {
  source: testRuntimeLayout.dataRoot,
  target: "/mnt/bigdisk/confscope-data",
  mode: "installed",
  itemCount: 5,
  totalBytes: 1572864,
  hasSourceData: true,
  resumable: false,
  reusedItems: 0,
  warnings: [],
  requiresRestart: true,
  valid: true,
  error: "",
};

const testMigrationResult = {
  source: testMigrationPlan.source,
  target: testMigrationPlan.target,
  itemsCopied: 5,
  itemsReused: 0,
  pointerPath: "/home/ryen/.config/ConfScope/data-root.json",
  migratedMarker: `${testMigrationPlan.source}/MIGRATED-20261022T010203.marker`,
  requiresRestart: true,
  restartReason: "Data location moved. Restart to apply it.",
  notes: [],
  error: "",
};

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

function renderSettings(locale: "zh-CN" | "en-US" = "en-US") {
  vi.stubGlobal("localStorage", new MemoryStorage());
  localStorage.setItem("locale", locale);
  return render(
    <I18nProvider>
      <SettingsView />
    </I18nProvider>
  );
}

describe("SettingsView", () => {
  beforeEach(() => {
    credentialMocks.countMigratableStoredCredentials.mockReset();
    credentialMocks.countMigratableStoredCredentials.mockReturnValue(0);
    credentialMocks.migrateStoredCredentials.mockReset();
    dataLocMocks.GetDataLocations.mockReset();
    dataLocMocks.GetDataLocations.mockResolvedValue(testDataLocations);
    dataLocMocks.OpenDataFolder.mockReset();
    dataLocMocks.OpenDataFolder.mockResolvedValue(undefined);
    dataLocMocks.GetRuntimeLayout.mockReset();
    dataLocMocks.GetRuntimeLayout.mockResolvedValue(testRuntimeLayout);
    dataLocMocks.CheckDataRootRollback.mockReset();
    dataLocMocks.CheckDataRootRollback.mockResolvedValue(testRollbackUnavailable);
    dataLocMocks.SelectDataRootDirectory.mockReset();
    dataLocMocks.SelectDataRootDirectory.mockResolvedValue("");
    dataLocMocks.PlanDataRootMigration.mockReset();
    dataLocMocks.PlanDataRootMigration.mockResolvedValue(testMigrationPlan);
    dataLocMocks.MigrateDataRoot.mockReset();
    dataLocMocks.MigrateDataRoot.mockResolvedValue(testMigrationResult);
    dataLocMocks.RollbackDataRoot.mockReset();
    dataLocMocks.RollbackDataRoot.mockResolvedValue(testMigrationResult);
    historyMocks.clearOperationHistory.mockReset();
    cacheMocks.clearAppCache.mockReset();
    cacheMocks.clearAppCache.mockResolvedValue(0);
  });

  // ── 危险操作二次确认（2026-10-17 扫描 R3：不得用原生 confirm）──

  function confirmModal() {
    const overlay = document.querySelector(".modal-overlay") as HTMLElement;
    expect(overlay).toBeInTheDocument();
    return overlay;
  }

  it("asks in an app modal before clearing local operation history", async () => {
    const nativeConfirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderSettings("zh-CN");

    fireEvent.click(screen.getByRole("button", { name: "清空本地历史" }));

    expect(await screen.findByText("确定清空所有本地操作记录？")).toBeInTheDocument();
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(historyMocks.clearOperationHistory).not.toHaveBeenCalled();

    fireEvent.click(within(confirmModal()).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByText("确定清空所有本地操作记录？")).not.toBeInTheDocument());
    expect(historyMocks.clearOperationHistory).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "清空本地历史" }));
    fireEvent.click(await screen.findByText("确定清空所有本地操作记录？"));
    fireEvent.click(within(confirmModal()).getByRole("button", { name: "确定" }));
    await waitFor(() => expect(historyMocks.clearOperationHistory).toHaveBeenCalledTimes(1));
  });

  it("asks in an app modal before clearing the local cache", async () => {
    const nativeConfirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderSettings("zh-CN");

    fireEvent.click(screen.getByRole("button", { name: "清理缓存" }));

    expect(await screen.findByText(/确定清理缓存吗/)).toBeInTheDocument();
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(cacheMocks.clearAppCache).not.toHaveBeenCalled();

    fireEvent.click(within(confirmModal()).getByRole("button", { name: "确定" }));

    await waitFor(() => expect(cacheMocks.clearAppCache).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("缓存已清理")).toBeInTheDocument();
  });

  it("keeps dismissing the cache confirmation without any cleanup", async () => {
    renderSettings("zh-CN");

    fireEvent.click(screen.getByRole("button", { name: "清理缓存" }));
    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(screen.queryByText(/确定清理缓存吗/)).not.toBeInTheDocument());
    expect(cacheMocks.clearAppCache).not.toHaveBeenCalled();
  });

  it("renders a grouped settings workbench without empty standalone sections", () => {
    renderSettings("en-US");

    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "General" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Network" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Smart Compare" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Credentials" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Backup" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Local Data" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "App Data Backup" })).toBeInTheDocument();
    expect(
      screen.getByText("Connection-specific credentials, SSH tunnels, and security policies stay in Connection Manager.")
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Authentication" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Security" })).not.toBeInTheDocument();
  });

  it("runs credential migration and refreshes the migration summary", async () => {
    credentialMocks.countMigratableStoredCredentials.mockReturnValueOnce(3).mockReturnValue(0);
    credentialMocks.migrateStoredCredentials.mockResolvedValue({
      migrated: 2,
      skipped: 4,
      unsupported: 1,
      failed: 0,
      items: [],
    });

    renderSettings("en-US");

    expect(screen.getByText("3 credentials ready to migrate")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Migrate Credentials" }));

    await waitFor(() => expect(credentialMocks.migrateStoredCredentials).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Migrated 2 · Unsupported 1 · Failed 0")).toBeInTheDocument();
    expect(screen.getByText("No plaintext credentials to migrate")).toBeInTheDocument();
  });

  it("keeps language, proxy, compare, and local data controls working", () => {
    renderSettings("en-US");

    fireEvent.click(screen.getByLabelText("Sort connection dropdowns by name"));
    const httpInputs = screen.getAllByPlaceholderText("http://127.0.0.1:7890");
    fireEvent.change(httpInputs[0], {
      target: { value: "http://127.0.0.1:7890" },
    });

    expect(screen.getByRole("button", { name: "Clear Local History" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("cs.settings") || "{}")).toEqual(
      expect.objectContaining({
        compare: expect.objectContaining({ sortConnections: false }),
        proxy: expect.objectContaining({ httpProxy: "http://127.0.0.1:7890" }),
      })
    );
  });

  it("clears the saved indicator timeout when unmounted", () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    const { unmount } = renderSettings("en-US");

    fireEvent.click(screen.getByLabelText("Sort connection dropdowns by name"));
    expect(screen.getByText("Settings saved")).toBeInTheDocument();

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("scrolls the settings panel container from rail navigation", () => {
    renderSettings("en-US");
    const panels = document.querySelector(".settings-panels") as HTMLDivElement;
    const backupPanel = document.getElementById("settings-backup") as HTMLElement;
    const scrollTo = vi.fn();
    const scrollIntoView = vi.fn();
    panels.scrollTo = scrollTo;
    backupPanel.scrollIntoView = scrollIntoView;
    Object.defineProperty(panels, "scrollTop", { value: 120, configurable: true });
    panels.getBoundingClientRect = vi.fn(() => new DOMRect(0, 20, 0, 0));
    backupPanel.getBoundingClientRect = vi.fn(() => new DOMRect(0, 420, 0, 0));

    fireEvent.click(screen.getByRole("button", { name: "Backup" }));

    expect(scrollTo).toHaveBeenCalledWith({ top: 520, behavior: "smooth" });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("shows data locations with copy and open actions", async () => {
    renderSettings("en-US");

    expect(await screen.findByRole("heading", { name: "Data Locations" })).toBeInTheDocument();
    // 六个位置：根目录、主数据文件、WebView、快照、恢复点、审计
    expect(screen.getByText("Data root").closest(".settings-setting-row")).toHaveTextContent("/tmp/confscope-retest/data");
    expect(screen.getByText("Main data file (connections, plans, history, and all local data)")).toBeInTheDocument();
    expect(screen.getByText("Audit log")).toBeInTheDocument();
    // 未创建的位置标注“尚未创建”且打开按钮禁用
    const snapshotsRow = screen.getByText("Backup snapshots").closest(".settings-setting-row");
    expect(snapshotsRow).toHaveTextContent("(not created yet)");
    const openButtons = screen.getAllByRole("button", { name: "Open" });
    expect(openButtons).toHaveLength(6);
    expect(openButtons[3]).toBeDisabled(); // snapshots
    expect(openButtons[0]).toBeEnabled(); // dataRoot
    // 点击「打开」调用 Go 绑定（按 key）
    fireEvent.click(openButtons[1]); // appDataFile
    await waitFor(() => expect(dataLocMocks.OpenDataFolder).toHaveBeenCalledWith("appDataFile"));
  });

  it("shows an error message when opening a data location fails", async () => {
    dataLocMocks.OpenDataFolder.mockRejectedValueOnce(new Error("no file manager"));
    renderSettings("en-US");

    const openButtons = await screen.findAllByRole("button", { name: "Open" });
    fireEvent.click(openButtons[0]);

    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to open: no file manager");
  });

  it("falls back to an unavailable note when the binding is missing", async () => {
    dataLocMocks.GetDataLocations.mockRejectedValueOnce(new Error("binding missing"));
    renderSettings("en-US");

    expect(await screen.findByText("Data locations are not available in this environment.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
  });

  it("falls back to an unavailable note when the binding method throws synchronously", async () => {
    // 模拟桥方法表缺失该方法（前后端版本错配）：调用本身同步抛错，需同样降级
    dataLocMocks.GetDataLocations.mockImplementation(() => {
      throw new Error("GetDataLocations is not a function");
    });
    renderSettings("en-US");

    expect(await screen.findByText("Data locations are not available in this environment.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
  });
  // ── 轮62：数据根运行形态与换根迁移 ──
  it("shows runtime mode, decided source, and notes in the data locations panel", async () => {
    dataLocMocks.GetRuntimeLayout.mockResolvedValue({ ...testRuntimeLayout, notes: ["指针文件已损坏，已隔离为 data-root.json.corrupt-1"] });
    renderSettings("en-US");

    expect(await screen.findByText("Runtime Mode & Data Root")).toBeInTheDocument();
    expect(screen.getByText("Installed (data belongs to the current user)")).toBeInTheDocument();
    expect(screen.getByText("OS per-user data directory")).toBeInTheDocument();
    expect(screen.getByText(/指针文件已损坏/)).toBeInTheDocument();
    // 无旧位置时不提供回退入口（点了也没有东西可退）
    expect(screen.queryByRole("button", { name: "Back to previous location" })).not.toBeInTheDocument();
  });

  it("asks for a target, shows the plan, and only migrates after confirming", async () => {
    dataLocMocks.SelectDataRootDirectory.mockResolvedValue(testMigrationPlan.target);
    renderSettings("en-US");

    fireEvent.click(await screen.findByRole("button", { name: "Change location..." }));

    const dialog = await screen.findByRole("dialog");
    // 确认框必须把「从哪到哪、复制多少、旧位置留不留、要不要重启」摆出来
    expect(within(dialog).getByText(`From ${testMigrationPlan.source} to ${testMigrationPlan.target}`)).toBeInTheDocument();
    expect(within(dialog).getByText(/5 files to copy/)).toBeInTheDocument();
    expect(within(dialog).getByText(/The old location is kept/)).toBeInTheDocument();
    expect(within(dialog).getByText(/One restart is required/)).toBeInTheDocument();
    expect(dataLocMocks.MigrateDataRoot).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(dataLocMocks.MigrateDataRoot).toHaveBeenCalledWith(testMigrationPlan.target));
    expect(await screen.findByText("Data location moved. Restart to apply it.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does nothing when the directory picker is cancelled", async () => {
    dataLocMocks.SelectDataRootDirectory.mockResolvedValue("");
    renderSettings("en-US");

    fireEvent.click(await screen.findByRole("button", { name: "Change location..." }));

    await waitFor(() => expect(dataLocMocks.SelectDataRootDirectory).toHaveBeenCalled());
    expect(dataLocMocks.PlanDataRootMigration).not.toHaveBeenCalled();
    expect(dataLocMocks.MigrateDataRoot).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the plan rejection inline instead of opening a confirm dialog", async () => {
    dataLocMocks.SelectDataRootDirectory.mockResolvedValue("/home/ryen/.local/share");
    dataLocMocks.PlanDataRootMigration.mockResolvedValue({ ...testMigrationPlan, valid: false, error: "目标位置在当前数据位置内部，会造成递归嵌套" });
    renderSettings("en-US");

    fireEvent.click(await screen.findByRole("button", { name: "Change location..." }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Operation failed: 目标位置在当前数据位置内部，会造成递归嵌套");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(dataLocMocks.MigrateDataRoot).not.toHaveBeenCalled();
  });

  it("surfaces a failed migration without pretending the move succeeded", async () => {
    dataLocMocks.SelectDataRootDirectory.mockResolvedValue(testMigrationPlan.target);
    dataLocMocks.MigrateDataRoot.mockResolvedValue({ ...testMigrationResult, requiresRestart: false, restartReason: "", error: "目标位置已存在另一份主数据文件" });
    renderSettings("en-US");

    fireEvent.click(await screen.findByRole("button", { name: "Change location..." }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("目标位置已存在另一份主数据文件");
    expect(screen.queryByText(testMigrationResult.restartReason)).not.toBeInTheDocument();
  });

  it("rolls back to the previous root with both data file summaries shown", async () => {
    dataLocMocks.CheckDataRootRollback.mockResolvedValue(testRollbackAvailable);
    renderSettings("en-US");

    fireEvent.click(await screen.findByRole("button", { name: "Back to previous location" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Only points the data root back/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Main data file here/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Main data file there/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(dataLocMocks.RollbackDataRoot).toHaveBeenCalled());
    expect(await screen.findByText(/Restart to apply it|需要重启/)).toBeInTheDocument();
  });

  // ── 轮67 R67-WP2：被忽略的更新版本必须看得见、也能撤销 ──

  it("应用更新小节把检查读数与被忽略的版本摆出来", () => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    localStorage.setItem("locale", "en-US");
    localStorage.setItem(
      "cs.settings",
      JSON.stringify({ update: { skipVersion: "1.9.8", lastCheckAt: "2026-10-23T01:23:45.678Z", lastSeenVersion: "1.9.7" } })
    );
    render(
      <I18nProvider>
        <SettingsView />
      </I18nProvider>
    );

    expect(screen.getByRole("button", { name: "App Updates" })).toBeInTheDocument();
    expect(screen.getByText("1.9.8")).toBeInTheDocument();
    expect(screen.getByText("1.9.7")).toBeInTheDocument();
    expect(screen.getByText(formatDateTime("2026-10-23T01:23:45.678Z"))).toBeInTheDocument();
    // 裸 ISO 原文不许出现在界面上
    expect(screen.queryByText("2026-10-23T01:23:45.678Z")).not.toBeInTheDocument();
  });

  it("恢复提醒清空 skipVersion，界面当场上报并停用按钮", () => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    localStorage.setItem("locale", "en-US");
    localStorage.setItem("cs.settings", JSON.stringify({ update: { skipVersion: "1.9.8", lastCheckAt: "", lastSeenVersion: "" } }));
    render(
      <I18nProvider>
        <SettingsView />
      </I18nProvider>
    );

    const restore = screen.getByRole("button", { name: "Restore reminders" });
    expect(restore).toBeEnabled();
    fireEvent.click(restore);

    expect(JSON.parse(localStorage.getItem("cs.settings") || "{}").update.skipVersion).toBe("");
    expect(screen.queryByText("1.9.8")).not.toBeInTheDocument();
    expect(screen.getByText("None")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore reminders" })).toBeDisabled();
  });

  it("没有忽略过版本时恢复提醒是停用态，且不拿 title 当说明", () => {
    renderSettings("en-US");

    const restore = screen.getByRole("button", { name: "Restore reminders" });
    expect(restore).toBeDisabled();
    expect(restore).not.toHaveAttribute("title");
    expect(screen.getByText("None")).toBeInTheDocument();
    expect(screen.getByText("Never checked")).toBeInTheDocument();
  });

  // ── 轮67 R67-WP3b：点索引要把焦点交给目标章节 ──

  it("点索引把焦点交给目标章节，读屏念得出章节名", () => {
    renderSettings("en-US");
    const backup = document.getElementById("settings-backup") as HTMLElement;
    expect(backup).toHaveAttribute("tabindex", "-1");

    fireEvent.click(screen.getByRole("button", { name: "Backup" }));

    expect(document.activeElement).toBe(backup);
    expect(backup).toHaveAccessibleName("Backup");
  });

  it("每一节都有可聚焦目标与标题关联，索引点了不会把焦点丢在无名容器上", () => {
    renderSettings("en-US");
    const sections = Array.from(document.querySelectorAll<HTMLElement>(".settings-panels section[id^='settings-']"));
    expect(sections.length).toBe(8);
    sections.forEach((section) => {
      expect(section, `${section.id} 不能被设为焦点目标`).toHaveAttribute("tabindex", "-1");
      const labelId = section.getAttribute("aria-labelledby");
      expect(labelId, `${section.id} 没有标题关联`).toBeTruthy();
      const heading = document.getElementById(labelId as string);
      expect(heading, `${section.id} 指向的 ${labelId} 不存在`).not.toBeNull();
      expect(heading!.tagName).toBe("H4");
      expect(heading!.textContent?.trim()).not.toBe("");
    });
  });

  it("degrades without crashing when the runtime layout binding is absent", async () => {
    // 旧 Go 二进制没有新方法：调用同步抛错，界面仍要能列出数据位置
    dataLocMocks.GetRuntimeLayout.mockImplementation(() => {
      throw new Error("GetRuntimeLayout is not a function");
    });
    dataLocMocks.CheckDataRootRollback.mockImplementation(() => {
      throw new Error("CheckDataRootRollback is not a function");
    });
    renderSettings("en-US");

    expect(await screen.findByText("Data root")).toBeInTheDocument();
    expect(screen.queryByText("Runtime Mode & Data Root")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change location..." })).not.toBeInTheDocument();
  });

});
