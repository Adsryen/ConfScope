/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor, within } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
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
}));

vi.mock("../../wailsjs/go/app/App", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../wailsjs/go/app/App")>();
  return {
    ...actual,
    GetDataLocations: dataLocMocks.GetDataLocations,
    OpenDataFolder: dataLocMocks.OpenDataFolder,
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
});
