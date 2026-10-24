/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor, within } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { formatDateTime } from "../lib/formatDateTime";
import { clearViewState, readViewState, writeViewState } from "../lib/viewState";
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

/*
 * 轮72B 新增的三个出口（都在被测组件的下游）：
 * - toast：设置页原先没有任何一条轻提示，「清空跳过版本」这种屏幕上不挪的动作点完没人应答；
 * - clipboard：CopyButton 的复制动作要能断言（jsdom 没有剪贴板权限，走不到兜底那条路）；
 * - getAppDataDocInfo：jsdom 里 appBindings() 为空 ⇒ 真实实现恒返回 null ⇒ 备份节那一行根本不渲染，
 *   想钉「主数据文件路径可复制」必须先把这份信息喂进来。
 */
const toastMocks = vi.hoisted(() => ({ toast: vi.fn() }));

vi.mock("../lib/toast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/toast")>();
  return { ...actual, toast: toastMocks.toast };
});

const clipboardMocks = vi.hoisted(() => ({ copyText: vi.fn(async () => true) }));

vi.mock("../lib/clipboard", () => ({ copyText: clipboardMocks.copyText }));

const docInfoMocks = vi.hoisted(() => ({ getAppDataDocInfo: vi.fn() }));

vi.mock("../lib/appDataDoc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/appDataDoc")>();
  return { ...actual, getAppDataDocInfo: docInfoMocks.getAppDataDocInfo };
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
  // 轮67 R57-WP14：本机版本历史的体量与清除
  GetConfigRevisionFacts: vi.fn(),
  ClearConfigRevisions: vi.fn(),
}));

// 清除本机版本历史必须连前端那份 md5 记忆一起清（否则清完再也攒不起历史）。
// 这里把出口换成可断言的替身，其余导出保持真实实现。
const revisionOutletMocks = vi.hoisted(() => ({ resetConfigRevisionAccelerator: vi.fn() }));

vi.mock("../lib/configRevisions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/configRevisions")>();
  return { ...actual, resetConfigRevisionAccelerator: revisionOutletMocks.resetConfigRevisionAccelerator };
});

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
    GetConfigRevisionFacts: dataLocMocks.GetConfigRevisionFacts,
    ClearConfigRevisions: dataLocMocks.ClearConfigRevisions,
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

// 轮67 R57-WP14：版本历史那条位置与它的体量替身。
const testRevisionEntry = {
  key: "revisions",
  path: "/tmp/confscope-retest/data/app-data/config-revisions.jsonl",
  isFile: true,
  exists: true,
};
const testRevisionFacts = {
  path: testRevisionEntry.path,
  exists: true,
  records: 12,
  sizeBytes: 20480,
  keys: 3,
  keepPerKey: 50,
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

// 轮72B：备份节那一行的数据来源（真实实现在 jsdom 里恒空，见上面的 mock 说明）。
const testDocInfo = {
  path: "/tmp/confscope-retest/data/app-data/confscope-data.json",
  savedAt: "2026-10-22T01:02:03.000Z",
  corruptFile: "",
  sizeBytes: 2048,
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

/**
 * jsdom 没有布局引擎：原生 scrollTop 赋值是空操作，测不出「滚→卸载→重挂→恢复」。
 * 换成 WeakMap 记账探针（与 lib/viewState.test.tsx 同口径），用例只在这次运行里装着，
 * 结束后还原，免得影响本文件其余用例对 DOM 的假设。
 */
function installScrollTopProbe(): () => void {
  const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  expect(original, "jsdom 应在 Element.prototype 上定义 scrollTop").toBeTruthy();
  const store = new WeakMap<Element, number>();
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get(this: Element) {
      return store.get(this) ?? 0;
    },
    set(this: Element, value: number) {
      store.set(this, Math.max(0, value));
    },
  });
  return () => Object.defineProperty(Element.prototype, "scrollTop", original!);
}

/** 「去关于页检查更新」的回调替身：设置页不自己检查更新，只负责把人送到那一页。 */
const onOpenAbout = vi.fn();

function renderSettings(locale: "zh-CN" | "en-US" = "en-US") {
  vi.stubGlobal("localStorage", new MemoryStorage());
  localStorage.setItem("locale", locale);
  return render(
    <I18nProvider>
      <SettingsView onOpenAbout={onOpenAbout} />
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
    dataLocMocks.GetConfigRevisionFacts.mockReset();
    dataLocMocks.GetConfigRevisionFacts.mockResolvedValue(testRevisionFacts);
    dataLocMocks.ClearConfigRevisions.mockReset();
    dataLocMocks.ClearConfigRevisions.mockResolvedValue(undefined);
    revisionOutletMocks.resetConfigRevisionAccelerator.mockReset();
    historyMocks.clearOperationHistory.mockReset();
    cacheMocks.clearAppCache.mockReset();
    cacheMocks.clearAppCache.mockResolvedValue(0);
    onOpenAbout.mockReset();
    toastMocks.toast.mockReset();
    clipboardMocks.copyText.mockReset();
    docInfoMocks.getAppDataDocInfo.mockReset();
    docInfoMocks.getAppDataDocInfo.mockResolvedValue(testDocInfo);
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

  // ── 轮67 R67-WP7：忙态文案与提示落点 ──

  it("清理缓存的忙态是完整文案，不塌成一个省略号", async () => {
    renderSettings("zh-CN");
    let release!: () => void;
    cacheMocks.clearAppCache.mockReturnValue(
      new Promise<number>((resolve) => {
        release = () => resolve(0);
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "清理缓存" }));
    fireEvent.click(await screen.findByText(/确定清理缓存吗/));
    fireEvent.click(within(confirmModal()).getByRole("button", { name: "确定" }));

    // 忙态字样来自 locale：真机量过，硬编码「…」只有 3px，按钮从 82 塌成一条缝，
    // 用户分不清是「在忙」还是「点坏了」。
    const busy = await screen.findByRole("button", { name: "清理中..." });
    expect(busy).toBeDisabled();
    expect(busy.textContent).toBe("清理中...");
    expect(screen.queryByRole("button", { name: "…" })).not.toBeInTheDocument();

    release();
    await waitFor(() => expect(screen.getByRole("button", { name: "清理缓存" })).not.toBeDisabled());
  });

  it("需重启提示出现就滚进可视区，且能被自己的关闭键收掉", async () => {
    dataLocMocks.SelectDataRootDirectory.mockResolvedValue(testMigrationPlan.target);
    const scrolled: Element[] = [];
    const spy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      scrolled.push(this);
    });
    try {
      renderSettings("en-US");
      fireEvent.click(await screen.findByRole("button", { name: "Change location..." }));
      fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));

      const text = await screen.findByText(testMigrationResult.restartReason);
      const notice = text.closest(".test-msg") as HTMLElement;
      expect(notice, "提示不在 .test-msg 容器里（形态被改过？）").toBeTruthy();
      // tone 一个字没动：琥珀 info 的播报语义还在，关闭键只是多一条「我看完了」的出口
      expect(notice).toHaveAttribute("role", "status");
      // 真机量过：面板滚到本节底部时提示顶边落在可视区外 86px，所以这里必须看到它被滚过
      expect(scrolled, "提示出现了却没把自己滚进可视区").toContain(notice);

      fireEvent.click(within(notice).getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByText(testMigrationResult.restartReason)).not.toBeInTheDocument());
    } finally {
      spy.mockRestore();
    }
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
    // 代理的落库时机是「提交那一刻」（失焦 / Enter）：轮72 R-B2 之前是逐键写盘，
    // 半成品（空格没 trim、协议都敢乱填）直接进 cs.settings，Go 侧静默用不上代理。
    const httpInputs = screen.getByLabelText("HTTP Proxy");
    fireEvent.change(httpInputs, { target: { value: " http://127.0.0.1:7890 " } });
    fireEvent.blur(httpInputs);

    expect(screen.getByRole("button", { name: "Clear Local History" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("cs.settings") || "{}")).toEqual(
      expect.objectContaining({
        compare: expect.objectContaining({ sortConnections: false }),
        proxy: expect.objectContaining({ httpProxy: "http://127.0.0.1:7890" }),
      })
    );
  });

  // ── 轮72B R-B2：代理只在提交那一刻写盘，且写的是 Go 侧认得的那串 ──

  it("代理失焦或 Enter 才落库，落库的是归一后的串", () => {
    renderSettings("en-US");

    const http = screen.getByLabelText("HTTP Proxy");
    fireEvent.change(http, { target: { value: "  HTTP://127.0.0.1:7890  " } });
    expect(localStorage.getItem("cs.settings"), "打字即落库的老路子被改回来了").toBeNull();

    fireEvent.keyDown(http, { key: "Enter" });
    expect(JSON.parse(localStorage.getItem("cs.settings") || "{}").proxy.httpProxy).toBe("http://127.0.0.1:7890");
    // 回显与盘上是同一串：用户看到的不是自己刚打的那串半成品，而是真正生效的那串
    expect(http).toHaveValue("http://127.0.0.1:7890");

    const https = screen.getByLabelText("HTTPS Proxy");
    fireEvent.change(https, { target: { value: "http://proxy.example.com:3128" } });
    fireEvent.blur(https);
    expect(JSON.parse(localStorage.getItem("cs.settings") || "{}").proxy.httpsProxy).toBe("http://proxy.example.com:3128");
  });

  it("三框各给各的示例，照着示例填的值一定生效", () => {
    renderSettings("en-US");

    expect(screen.getByLabelText("HTTP Proxy")).toHaveAttribute("placeholder", "http://127.0.0.1:7890");
    expect(screen.getByLabelText("HTTPS Proxy")).toHaveAttribute("placeholder", "http://proxy.example.com:3128");
    expect(screen.getByLabelText("No Proxy")).toHaveAttribute("placeholder", "localhost,127.0.0.1,.internal");
    // 「只管更新」这句原先是躺着的死键（真机整屏截出来根本没有它），现在必须落在网络上
    expect(screen.getByText(/proxy covers update checks and downloads only/i)).toBeInTheDocument();
    expect(screen.getByText(/Separate no-proxy entries with commas/)).toBeInTheDocument();
  });

  it("代理填了 Go 侧认不得的值就不落库，并在这框下面点名问题", () => {
    renderSettings("en-US");

    const https = screen.getByLabelText("HTTPS Proxy");
    fireEvent.change(https, { target: { value: "socks5://127.0.0.1:1080" } });
    fireEvent.blur(https);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Only http / https proxies are supported");
    // 非法值留在框里让用户改，不许被悄悄清掉（清掉就成了「我刚才写的东西没了」）
    expect(https).toHaveValue("socks5://127.0.0.1:1080");
    expect(localStorage.getItem("cs.settings"), "非法代理值又被写进盘上").toBeNull();

    fireEvent.change(https, { target: { value: "http://127.0.0.1:7891" } });
    fireEvent.blur(https);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("cs.settings") || "{}").proxy.httpsProxy).toBe("http://127.0.0.1:7891");
  });

  it("「不走代理」逐项归一，出错那一项被点名而不是整框静默作废", () => {
    renderSettings("zh-CN");

    const noProxy = screen.getByLabelText("不走代理");
    fireEvent.change(noProxy, { target: { value: " *.corp.example.com , localhost , http://x " } });
    fireEvent.blur(noProxy);

    expect(screen.getByRole("alert")).toHaveTextContent("http://x 不能当「不走代理」的条目");
    expect(localStorage.getItem("cs.settings"), "有一项非法时整框都不该落库").toBeNull();

    fireEvent.change(noProxy, { target: { value: " *.corp.example.com , localhost " } });
    fireEvent.blur(noProxy);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // *.x 在 Go 的 noProxyMatch 里永远匹配不上，归一成 .x 才是同一个意思的有效写法
    expect(JSON.parse(localStorage.getItem("cs.settings") || "{}").proxy.noProxy).toBe(".corp.example.com,localhost");
    expect(noProxy).toHaveValue(".corp.example.com,localhost");
  });

  it("输入法组词期间的 Enter 是「选这个词」，不能当提交", () => {
    renderSettings("en-US");

    const http = screen.getByLabelText("HTTP Proxy");
    fireEvent.change(http, { target: { value: "http://127.0.0.1:7890" } });
    fireEvent.keyDown(http, { key: "Enter", isComposing: true });

    expect(localStorage.getItem("cs.settings"), "组词中的 Enter 被当成提交，把还没选完的词写上了盘").toBeNull();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // ── 轮72B R-B3/R-B4/R-B5/R-B6：危险行一种长相、整行可点、路径可抄、更新有出口 ──

  it("三颗不可逆删除共用同一种危险行长相", async () => {
    renderSettings("zh-CN");

    // 版本历史那一行等的是 GetConfigRevisionFacts：没有体量数字时这一行根本不渲染
    expect(await screen.findByRole("button", { name: "清除本机版本历史" })).toBeInTheDocument();
    const rows = Array.from(document.querySelectorAll<HTMLDivElement>(".settings-setting-row.settings-danger-zone"));
    expect(rows.map((row) => row.querySelector("button")?.textContent)).toEqual(["清空本地历史", "清除本机版本历史", "清理缓存"]);
    for (const row of rows) {
      const button = row.querySelector("button");
      expect(button, "危险行右侧没有那颗键").toBeTruthy();
      expect(button!.className).toContain("btn-ghost");
      expect(button!.className).toContain("btn-danger");
    }
  });

  it("对比偏好整行可点，说明文字不进复选框的可访问名", () => {
    renderSettings("en-US");

    const connections = screen.getByLabelText("Sort connection dropdowns by name");
    const namespaces = screen.getByLabelText("Sort namespace dropdowns by name");
    for (const box of [connections, namespaces]) {
      const row = box.closest("label") as HTMLElement;
      expect(row).toHaveClass("settings-setting-row-clickable");
      // 说明塞进 label 就等于每按一次复选框，读屏把整句说明书念一遍（可访问名被撑成一句话）
      expect(within(row).queryByText(/sorted by name/), "说明文字被包进了 label").not.toBeInTheDocument();
    }
    expect(screen.getByText(/both connection dropdowns in the compare view are sorted by name/)).toBeInTheDocument();
    expect(screen.getByText(/^When on, namespace dropdowns are sorted by name/)).toBeInTheDocument();
  });

  it("应用更新一节把人送去关于页检查，不在这里复制第二份检查逻辑", () => {
    renderSettings("en-US");

    expect(screen.getByText("Check, download and install updates")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check for Updates" }));

    expect(onOpenAbout).toHaveBeenCalledTimes(1);
    // 检查 / 下载 / 校验 / 交接那套只在关于页有一份实现：设置页不该冒出它的容器
    expect(document.querySelector(".update-handoff")).toBeNull();
    expect(document.querySelector(".update-progress")).toBeNull();
  });

  it("备份节的主数据文件路径带复制键", async () => {
    renderSettings("en-US");

    const copy = await screen.findByRole("button", { name: "Copy Local Data File path" });
    // 数据位置那一节里也有同一个路径，所以这里按「复制键所在的那一行」取证：
    // 键必须贴着主数据文件路径，而不是挂在别的位置行上。
    const pathRow = copy.closest(".settings-data-file-path") as HTMLElement;
    expect(pathRow, "复制键不在主数据文件路径那一行里").toBeTruthy();
    expect(pathRow.textContent).toContain(testDocInfo.path);
    fireEvent.click(copy);

    const { copyText } = await import("../lib/clipboard");
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(testDocInfo.path));
  });

  it("主数据文件还没生成时不摆空复制键", async () => {
    docInfoMocks.getAppDataDocInfo.mockResolvedValue({ ...testDocInfo, path: "", savedAt: "" });
    renderSettings("en-US");

    expect(await screen.findByText("Not created yet (auto-created on first data change)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy Local Data File path" })).not.toBeInTheDocument();
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

  // 轮73 R73-I2：徽章原先只画在页头右上角。真机量过，点「智能对比」里那颗开关时，反馈出现在被点控件
  // 上方约 340px 处、1.2s 就消失——用户读不到「保存」与「我刚点的东西」的因果，于是再点一次
  // （轮72 的实测记录里被投诉过）。现在它钉在被改动那一节的右上角，改动换节就跟着搬家。
  it("「设置已保存」落在被改动的那一节，换节时不留残影", () => {
    renderSettings("en-US");

    fireEvent.click(screen.getByLabelText("Sort connection dropdowns by name"));

    const compare = document.getElementById("settings-compare") as HTMLElement;
    const flag = within(compare).getByText("Settings saved");
    expect(flag).toHaveClass("test-msg", "ok", "settings-panel-flag");
    expect(document.querySelectorAll(".settings-panel-flag")).toHaveLength(1);
    expect(document.querySelector(".settings-saved-flag"), "点名了所在节就不该再落工作区兜底位").toBeNull();

    // 代理框失焦提交落在「网络」节：旧的节不许留着上一句「已保存」
    const http = screen.getByLabelText("HTTP Proxy");
    fireEvent.change(http, { target: { value: "http://127.0.0.1:7890" } });
    fireEvent.blur(http);

    expect(document.querySelectorAll(".settings-panel-flag"), "两处徽章同时亮 = 说不清是哪一次改动存了盘").toHaveLength(1);
    expect(within(document.getElementById("settings-network") as HTMLElement).getByText("Settings saved")).toBeInTheDocument();
    expect(within(compare).queryByText("Settings saved")).not.toBeInTheDocument();
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
    const openButtons = screen.getAllByRole("button", { name: /Open .* folder/ });
    expect(openButtons).toHaveLength(6);
    expect(openButtons[3]).toBeDisabled(); // snapshots
    expect(openButtons[0]).toBeEnabled(); // dataRoot
    // 点击「打开」调用 Go 绑定（按 key）
    fireEvent.click(openButtons[1]); // appDataFile
    await waitFor(() => expect(dataLocMocks.OpenDataFolder).toHaveBeenCalledWith("appDataFile"));
  });

  // 轮67 R67-WP5：真机量到 7 行 14 颗按钮的可访问名全是「复制」「打开」各刷 7 遍（aria-label 全 null），
  // 键盘走到第 34 颗听不出这是日志目录还是备份快照。这里钉「名字唯一 + 点名行 + 可见文字不动」。
  it("names each data-location action with the row it belongs to", async () => {
    renderSettings("en-US");
    await screen.findByRole("heading", { name: "Data Locations" });

    // 第一行是「运行形态与数据根」，只有一个动作按钮，不是同名动作的来源
    const rows = Array.from(document.querySelectorAll<HTMLElement>("#settings-data-locations .settings-setting-row")).filter((row) =>
      Boolean(row.querySelector(".settings-data-location-path"))
    );
    expect(rows, "替身给了 6 个位置，渲染出来的行数对不上").toHaveLength(6);

    const names: string[] = [];
    for (const row of rows) {
      const buttons = within(row).getAllByRole("button");
      expect(buttons).toHaveLength(2);
      expect(buttons.map((button) => (button.textContent ?? "").trim())).toEqual(["Copy", "Open"]);
      const rowName = (row.querySelector("strong")?.firstChild?.textContent ?? "").trim();
      for (const button of buttons) {
        const label = button.getAttribute("aria-label");
        expect(label, `${rowName} 这行的动作没有可访问名`).not.toBeNull();
        // WCAG 2.5.3：可见文字必须含在可访问名里，否则键盘念到的和看到的不是一回事
        expect(label).toContain((button.textContent ?? "").trim());
        names.push(label as string);
      }
      expect(names[names.length - 2], "名字里点的行和屏幕上那行不是同一行").toBe(`Copy ${rowName} path`);
      expect(names[names.length - 1]).toBe(`Open ${rowName} folder`);
    }

    expect(new Set(names).size, `${names.length} 颗按钮只念得出 ${new Set(names).size} 个名字`).toBe(names.length);
  });

  // 中文档也得点名：静态守卫只查「模板含可见文字」，M4 那种「zh 模板把「复制」两个字丢了」
  // 只有这条真渲染能抓住（en 档的组件用例挡不住 zh 的措辞漂移）。
  it("中文界面的数据位置动作同样按行点名", async () => {
    renderSettings("zh-CN");
    await screen.findByRole("heading", { name: "数据位置" });

    expect(screen.getByRole("button", { name: "复制备份快照的路径" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开审计日志所在目录" })).toBeInTheDocument();

    // 只数带路径的行：第一行「运行形态与数据根」共用同一个动作容器类名，
    // 它那两颗按钮的可见文字本身就唯一（更改位置…/回退…），不下发 aria-label
    const names = Array.from(document.querySelectorAll<HTMLElement>("#settings-data-locations .settings-setting-row"))
      .filter((row) => Boolean(row.querySelector(".settings-data-location-path")))
      .flatMap((row) => Array.from(row.querySelectorAll<HTMLElement>(".settings-data-location-actions button")))
      .map((button) => button.getAttribute("aria-label"));
    expect(names.every((name) => Boolean(name)), "又有按钮没名字了").toBe(true);
    expect(new Set(names).size, `${names.length} 颗按钮只念得出 ${new Set(names).size} 个名字`).toBe(names.length);
  });

  it("shows an error message when opening a data location fails", async () => {
    dataLocMocks.OpenDataFolder.mockRejectedValueOnce(new Error("no file manager"));
    renderSettings("en-US");

    const openButtons = await screen.findAllByRole("button", { name: /Open .* folder/ });
    fireEvent.click(openButtons[0]);

    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to open: no file manager");
  });

  it("falls back to an unavailable note when the binding is missing", async () => {
    dataLocMocks.GetDataLocations.mockRejectedValueOnce(new Error("binding missing"));
    renderSettings("en-US");

    expect(await screen.findByText("Data locations are not available in this environment.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open .* folder/ })).not.toBeInTheDocument();
  });

  it("falls back to an unavailable note when the binding method throws synchronously", async () => {
    // 模拟桥方法表缺失该方法（前后端版本错配）：调用本身同步抛错，需同样降级
    dataLocMocks.GetDataLocations.mockImplementation(() => {
      throw new Error("GetDataLocations is not a function");
    });
    renderSettings("en-US");

    expect(await screen.findByText("Data locations are not available in this environment.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open .* folder/ })).not.toBeInTheDocument();
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
        <SettingsView onOpenAbout={onOpenAbout} />
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
        <SettingsView onOpenAbout={onOpenAbout} />
      </I18nProvider>
    );

    const restore = screen.getByRole("button", { name: "Restore reminders" });
    expect(restore).toBeEnabled();
    fireEvent.click(restore);

    expect(JSON.parse(localStorage.getItem("cs.settings") || "{}").update.skipVersion).toBe("");
    // 这一行的清空是「点完屏幕上什么都不挪」的动作（只有 1.2s 的已保存徽章），补一条轻提示说明后果
    expect(toastMocks.toast).toHaveBeenCalledWith("Reminders restored. The next check will mention that version again.", "success");
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

  // ── 轮67 R67-WP3a：左栏要回答「现在在哪一节」 ──

  it("点索引把当前节指示移到点的那一项", () => {
    renderSettings("en-US");
    const backup = screen.getByRole("button", { name: "Backup" });
    const developer = screen.getByRole("button", { name: "Developer" });
    // jsdom 没有布局，挂载时量到的偏移全为 0 ⇒ 按位置判会给最后一节（真机上量的是真实矩形）
    expect(developer).toHaveAttribute("aria-current", "true");

    fireEvent.click(backup);

    expect(backup).toHaveAttribute("aria-current", "true");
    expect(backup).toHaveClass("settings-rail-item", "active");
    expect(developer).not.toHaveAttribute("aria-current");
    expect(developer).not.toHaveClass("active");
  });

  it("用户自己滚了就交还位置判定，指示不许赖在点过的那一节", () => {
    renderSettings("en-US");
    const updates = screen.getByRole("button", { name: "App Updates" });
    fireEvent.click(updates);
    expect(updates).toHaveAttribute("aria-current", "true");

    // 滚轮 = 用户表态「我自己在看」，此后按位置判；jsdom 里位置判给最后一节
    fireEvent.wheel(document.querySelector(".settings-panels") as HTMLElement);

    expect(updates).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("button", { name: "Developer" })).toHaveAttribute("aria-current", "true");
  });

  it("输入框里的方向键不算用户滚动，容器上的才算", () => {
    renderSettings("en-US");
    const updates = screen.getByRole("button", { name: "App Updates" });
    fireEvent.click(updates);

    // 索引点完焦点在章节上，容器里的方向键是真滚页面；但代理输入框里的同一个键只动光标
    const proxy = document.querySelector(".settings-proxy-grid input") as HTMLElement;
    fireEvent.keyDown(proxy, { key: "ArrowDown" });
    expect(updates).toHaveAttribute("aria-current", "true");
    fireEvent.keyDown(proxy, { key: "Home" });
    expect(updates).toHaveAttribute("aria-current", "true");

    fireEvent.keyDown(document.querySelector(".settings-panels") as HTMLElement, { key: "End" });
    expect(updates).not.toHaveAttribute("aria-current");
  });

  // 轮73 R73-P1：真机量过，焦点停在「基础信息」上按 ↓ 时焦点原地不动（railKeys.json：
  // railFocusBefore/After 是同一项），而浏览器默认行为会去滚最近的滚动祖先——八项索引原先只能
  // 一颗一颗 Tab 过去。上下键在列表里的直觉就是「挪一格」，这里照做，但只挪焦点不跳章节。
  it("左栏方向键挪焦点、首尾回环、Home/End 到端点，且全程不跳章节", () => {
    renderSettings("en-US");
    const rail = screen.getByRole("complementary", { name: "Settings sections" });
    const items = within(rail).getAllByRole("button");
    expect(items).toHaveLength(8);

    const panels = document.querySelector(".settings-panels") as HTMLElement;
    const scrollTo = vi.fn();
    panels.scrollTo = scrollTo;

    items[0].focus();
    // fireEvent 返回 false 表示 preventDefault 生效：方向键不能顺带把页面滚走
    expect(fireEvent.keyDown(items[0], { key: "ArrowDown" })).toBe(false);
    expect(items[1]).toHaveFocus();
    expect(fireEvent.keyDown(items[1], { key: "ArrowUp" })).toBe(false);
    expect(items[0]).toHaveFocus();

    // 首尾回环：到顶再往上就是最后一项，反过来同理
    expect(fireEvent.keyDown(items[0], { key: "ArrowUp" })).toBe(false);
    expect(items[7]).toHaveFocus();
    expect(fireEvent.keyDown(items[7], { key: "ArrowDown" })).toBe(false);
    expect(items[0]).toHaveFocus();

    expect(fireEvent.keyDown(items[0], { key: "End" })).toBe(false);
    expect(items[7]).toHaveFocus();
    expect(fireEvent.keyDown(items[7], { key: "Home" })).toBe(false);
    expect(items[0]).toHaveFocus();

    // 只挪焦点不跳章节：跳章节是 Enter/Space 的事（原生按钮自带），与全站列表口径一致
    expect(scrollTo, "方向键把内容区滚走了：用户只是在挑选项就被搬了位置").not.toHaveBeenCalled();
    expect(items[7]).toHaveAttribute("aria-current", "true");
    expect(items[1]).not.toHaveAttribute("aria-current");

    // 焦点不在索引上时不接管，别截走内容区的方向键
    items[0].blur();
    expect(fireEvent.keyDown(items[3], { key: "ArrowDown" })).toBe(true);
    expect(items[3]).not.toHaveFocus();
  });

  // ── 轮67 R67-WP3c：切走再回来不丢阅读位置 ──

  it("滚到中途切走再回来，位置还在原处", () => {
    clearViewState();
    const restoreProbe = installScrollTopProbe();
    try {
      const first = renderSettings("en-US");
      const panels = first.container.querySelector(".settings-panels") as HTMLElement;
      panels.scrollTop = 800;
      fireEvent.scroll(panels);
      expect(readViewState<number>("settings.scroll.panels"), "滚动没记进唯一实现的账本").toBe(800);

      first.unmount();
      const again = renderSettings("en-US");
      expect((again.container.querySelector(".settings-panels") as HTMLElement).scrollTop).toBe(800);
    } finally {
      restoreProbe();
      clearViewState();
    }
  });

  it("账本里没有记住的位置时不动用户：新会话打开就在顶部", () => {
    clearViewState();
    const restoreProbe = installScrollTopProbe();
    try {
      writeViewState("audit.scroll.matrix", 640);
      const { container } = renderSettings("en-US");
      expect((container.querySelector(".settings-panels") as HTMLElement).scrollTop).toBe(0);
    } finally {
      restoreProbe();
      clearViewState();
    }
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

  // 轮67 R57-WP14：本机版本历史在设置页的落点（体量 + 独立清除入口，R11 不与清理缓存混）

  describe("本机版本历史的体量与清除入口", () => {
    // 这一组要看到「本机版本历史」那条文件位置，所以只在本组里把它打进清单；
    // 公共 fixture 保持 6 条，否则「复制与打开」那几例的索引会被连带推移。
    beforeEach(() => {
      dataLocMocks.GetDataLocations.mockResolvedValue({
        ...testDataLocations,
        entries: [...testDataLocations.entries, testRevisionEntry],
      });
    });

    it("把体量说清楚：记了多少版、几个配置、多大、每键留几版", async () => {
      renderSettings("zh-CN");

      const row = (await screen.findByRole("button", { name: "清除本机版本历史" })).closest(".settings-setting-row") as HTMLElement;
      expect(row).toHaveTextContent("已记录 12 版");
      expect(row).toHaveTextContent("涉及 3 个配置");
      expect(row).toHaveTextContent("每个配置最多留 50 版");
      // 文件位置那一行也在清单里（用户要能复制路径、在文件管理器里定位它）
      expect(screen.getByText(testRevisionEntry.path)).toBeInTheDocument();
    });

    it("清除前先在应用内确认，取消就一个字节都不动", async () => {
      renderSettings("zh-CN");

      fireEvent.click(await screen.findByRole("button", { name: "清除本机版本历史" }));
      expect(await screen.findByText(/确定清除本机版本历史吗/)).toBeInTheDocument();
      expect(dataLocMocks.ClearConfigRevisions).not.toHaveBeenCalled();

      fireEvent.click(within(confirmModal()).getByRole("button", { name: "取消" }));
      await waitFor(() => expect(screen.queryByText(/确定清除本机版本历史吗/)).not.toBeInTheDocument());
      expect(dataLocMocks.ClearConfigRevisions).not.toHaveBeenCalled();
      expect(revisionOutletMocks.resetConfigRevisionAccelerator).not.toHaveBeenCalled();
    });

    it("确认后清文件、清前端 md5 记忆，并刷新清单", async () => {
      renderSettings("zh-CN");

      const before = dataLocMocks.GetDataLocations.mock.calls.length;
      fireEvent.click(await screen.findByRole("button", { name: "清除本机版本历史" }));
      fireEvent.click(within(confirmModal()).getByRole("button", { name: "确定" }));

      await waitFor(() => expect(dataLocMocks.ClearConfigRevisions).toHaveBeenCalledTimes(1));
      // md5 记忆不清掉，同样的正文再读到会被跳过，本机历史从此攒不起来
      expect(revisionOutletMocks.resetConfigRevisionAccelerator).toHaveBeenCalledTimes(1);
      expect(await screen.findByText("本机版本历史已清除")).toBeInTheDocument();
      expect(dataLocMocks.GetDataLocations.mock.calls.length).toBeGreaterThan(before);
    });

    it("忙态是完整文案，失败把原因摊开还能抄走", async () => {
      renderSettings("zh-CN");
      let release!: (error: unknown) => void;
      dataLocMocks.ClearConfigRevisions.mockReturnValue(
        new Promise<void>((_resolve, reject) => {
          release = reject;
        })
      );

      fireEvent.click(await screen.findByRole("button", { name: "清除本机版本历史" }));
      fireEvent.click(within(confirmModal()).getByRole("button", { name: "确定" }));

      const busy = await screen.findByRole("button", { name: "清除中..." });
      expect(busy).toBeDisabled();

      release(new Error("attempted to write a read-only file"));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("清除本机版本历史失败");
      expect(alert).toHaveTextContent("attempted to write a read-only file");
      expect(within(alert).getByRole("button", { name: /复制/ })).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole("button", { name: "清除本机版本历史" })).not.toBeDisabled());
    });

    it("旧 Go 二进制没有这颗绑定时不摆死按钮，只说一句不支持", async () => {
      dataLocMocks.GetConfigRevisionFacts.mockImplementation(() => {
        throw new Error("GetConfigRevisionFacts is not a function");
      });
      renderSettings("zh-CN");

      expect(await screen.findByText("当前版本还不支持查看或清除本机版本历史。")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "清除本机版本历史" })).not.toBeInTheDocument();
      // 清单里那条文件位置照旧列出：路径仍是事实
      expect(screen.getByText(testRevisionEntry.path)).toBeInTheDocument();
    });
  });

});
