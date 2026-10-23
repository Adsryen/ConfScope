/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "../test/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { clearErrors, subscribeErrors, type AppErrorItem } from "../lib/errorCenter";
import About from "./About";

const apiMocks = vi.hoisted(() => ({
  getAppInfo: vi.fn(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  getDownloadProgress: vi.fn(),
  getUpdateInstallCommand: vi.fn(),
  launchUpdateInstaller: vi.fn(),
  listActiveSSHTunnels: vi.fn(),
  quitApplication: vi.fn(),
  revealDownloadedArtifact: vi.fn(),
  attachUpdateImage: vi.fn(),
}));

vi.mock("../api/app", () => apiMocks);

// 交接闸门要看「本地数据是否已落盘」，真实现会在 jsdom 里因为拿不到绑定而恒返回 false，
// 那样每个用例都被判成忙碌，测的就不是闸门而是环境了。
const docMocks = vi.hoisted(() => ({ pushAppDataDocument: vi.fn() }));
vi.mock("../lib/appDataDoc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/appDataDoc")>();
  return { ...actual, pushAppDataDocument: docMocks.pushAppDataDocument };
});

const taskMocks = vi.hoisted(() => ({ listTasks: vi.fn() }));
vi.mock("../lib/taskmanager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/taskmanager")>();
  return {
    ...actual,
    getTaskManager: () => ({ ...actual.getTaskManager(), listTasks: taskMocks.listTasks }),
  };
});

const PROXY = { httpProxy: "http://127.0.0.1:7890", httpsProxy: "http://127.0.0.1:7890", noProxy: "localhost,127.0.0.1" };

function writeSettings(lastCheckAt: string, skipVersion = "") {
  localStorage.setItem(
    "cs.settings",
    JSON.stringify({
      proxy: PROXY,
      update: { skipVersion, lastCheckAt },
      compare: { sortConnections: true, sortNamespaces: true },
    })
  );
}

/** 上次检查时间写「刚刚」：进页面时的被动自动检查不会跑，用例自己点。 */
function disableAutoUpdateCheck() {
  writeSettings(new Date().toISOString());
}

/** 上次检查时间写 7 小时前：触发「距上次检查 > 6 小时」的被动自动检查。 */
function enableAutoUpdateCheck() {
  writeSettings(new Date(Date.now() - 7 * 3600000).toISOString());
}

function baseAppInfo(version = "1.0.0") {
  return {
    name: "ConfScope",
    version,
    updateSources: [
      { name: "GitHub 官方", url: "https://github.example/update.json" },
      { name: "国内加速 1", url: "https://mirror.example/update.json" },
    ],
  };
}

/**
 * 更新清单的基线条目：platformKey/handoff/fileName/downgraded 是轮62 起前端唯一的分流依据，
 * 用例只改自己关心的那一个字段，其余保持「Windows 便携版」这一档。
 */
function checkResult(overrides: Record<string, unknown> = {}) {
  return {
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    hasUpdate: true,
    sourceName: "国内加速 1",
    sourceUrl: "https://mirror.example/update.json",
    downloadUrl: "https://download.example/ConfScope.exe",
    releaseNotes: "支持检查更新",
    publishedAt: "2026-06-28T00:00:00Z",
    sha256: "abc",
    mandatory: false,
    checkedAt: "2026-06-28T00:00:00Z",
    error: "",
    platformKey: "windows-amd64",
    fileName: "ConfScope.exe",
    handoff: "reveal",
    downgraded: false,
    reason: "",
    ...overrides,
  };
}

function latestError(): AppErrorItem | undefined {
  let errors: AppErrorItem[] = [];
  const unsubscribe = subscribeErrors((items) => {
    errors = items;
  });
  unsubscribe();
  return errors[errors.length - 1];
}

function renderAbout(locale = "zh-CN") {
  localStorage.setItem("locale", locale);
  return render(
    <I18nProvider>
      <About onClose={vi.fn()} />
    </I18nProvider>
  );
}

/** Wails 事件桥：About 优先用 EventsOn，测试用它把进度事件按剧本推进，不必等 300ms 轮询。 */
let progressHandler: ((progress: unknown) => void) | undefined;
function stubWailsRuntime() {
  (window as unknown as { runtime: Record<string, unknown> }).runtime = {
    EventsOn: (_name: string, cb: (progress: unknown) => void) => {
      progressHandler = cb;
    },
    EventsOff: () => {},
  };
}

function emitProgress(progress: unknown) {
  progressHandler?.(progress);
}

/** 挂起的下载：让用例能停在「下完了但还没校验」这一档上。 */
function deferredDownload() {
  let resolve!: (path: string) => void;
  const promise = new Promise<string>((r) => {
    resolve = r;
  });
  apiMocks.downloadUpdate.mockReturnValue(promise);
  return { resolve };
}

describe("About", () => {
  beforeEach(() => {
    localStorage.clear();
    clearErrors();
    for (const fn of Object.values(apiMocks)) fn.mockReset();
    taskMocks.listTasks.mockReset();
    docMocks.pushAppDataDocument.mockReset();
    taskMocks.listTasks.mockReturnValue([]);
    docMocks.pushAppDataDocument.mockResolvedValue(true);

    apiMocks.getAppInfo.mockResolvedValue(baseAppInfo());
    apiMocks.checkForUpdates.mockResolvedValue(checkResult());
    apiMocks.downloadUpdate.mockResolvedValue("C:\\Temp\\ConfScope.exe");
    apiMocks.getDownloadProgress.mockResolvedValue({ downloaded: 0, total: 0, percent: 0, done: false, error: "" });
    apiMocks.getUpdateInstallCommand.mockResolvedValue('sudo apt install "/tmp/confscope.deb"');
    apiMocks.listActiveSSHTunnels.mockResolvedValue([]);
    apiMocks.launchUpdateInstaller.mockResolvedValue(undefined);
    apiMocks.quitApplication.mockResolvedValue(undefined);
    apiMocks.revealDownloadedArtifact.mockResolvedValue(undefined);
    apiMocks.attachUpdateImage.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete (window as unknown as { runtime?: Record<string, unknown> }).runtime;
    progressHandler = undefined;
    vi.restoreAllMocks();
  });

  it("点一次检查更新就走完检查下载校验，不再要求人工点第二下", async () => {
    writeSettings("");
    stubWailsRuntime();

    renderAbout();

    expect(await screen.findByText("v1.0.0")).toBeInTheDocument();
    expect(screen.getByText("GitHub 官方")).toBeInTheDocument();
    expect(screen.getByText("国内加速 1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));

    await waitFor(() => {
      expect(apiMocks.checkForUpdates).toHaveBeenCalledWith({
        currentVersion: "1.0.0",
        sources: [
          { name: "GitHub 官方", url: "https://github.example/update.json" },
          { name: "国内加速 1", url: "https://mirror.example/update.json" },
        ],
        proxy: PROXY,
      });
    });
    // 代理必须同时递给下载：检查通了、下载直连的人只会卡在最后一步
    await waitFor(() => {
      expect(apiMocks.downloadUpdate).toHaveBeenCalledWith("https://download.example/ConfScope.exe", "abc", PROXY);
    });
    expect(await screen.findByText("下载完成，校验通过")).toBeInTheDocument();
    // 交接面板已经出现，就不该再留一颗「下载并安装」让人重复触发
    expect(screen.queryByRole("button", { name: "下载并安装 v1.1.0" })).not.toBeInTheDocument();
    expect(screen.getByText(/ConfScope.exe/)).toBeInTheDocument();
  });

  it("校验中不是假状态：进度到 100% 而 done 未到就停在 verifying", async () => {
    disableAutoUpdateCheck();
    stubWailsRuntime();
    const { resolve } = deferredDownload();

    renderAbout();
    await screen.findByText("v1.0.0");
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));

    await waitFor(() => expect(screen.getByRole("progressbar", { name: "下载中…" })).toBeInTheDocument());
    emitProgress({ downloaded: 10, total: 10, percent: 100, done: false, error: "" });

    expect(await screen.findByRole("progressbar", { name: "校验中…" })).toBeInTheDocument();
    expect(screen.queryByText("下载完成，校验通过")).not.toBeInTheDocument();
    expect(apiMocks.revealDownloadedArtifact).not.toHaveBeenCalled();

    // done 只在校验通过后由 Go 发出：它到了才允许交接
    emitProgress({ downloaded: 10, total: 10, percent: 100, done: true, error: "" });
    expect(await screen.findByText("下载完成，校验通过")).toBeInTheDocument();
    resolve("C:\\Temp\\ConfScope.exe");
  });

  it("下载进度报错就落回错误态并给出重试", async () => {
    disableAutoUpdateCheck();
    stubWailsRuntime();
    const { resolve } = deferredDownload();

    renderAbout();
    await screen.findByText("v1.0.0");
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    await waitFor(() => expect(screen.getByRole("progressbar", { name: "下载中…" })).toBeInTheDocument());

    emitProgress({ downloaded: 3, total: 10, percent: 30, done: false, error: "connection reset" });

    expect(await screen.findByText("connection reset")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    resolve("C:\\Temp\\ConfScope.exe");
  });

  it("进页面被动自动检查只报有新版本，不偷跑下载流量", async () => {
    enableAutoUpdateCheck();

    renderAbout();

    await waitFor(() => {
      expect(apiMocks.checkForUpdates).toHaveBeenCalledWith(expect.objectContaining({ currentVersion: "1.0.0" }));
    });
    expect(await screen.findByText("发现新版本 v1.1.0")).toBeInTheDocument();
    expect(apiMocks.downloadUpdate).not.toHaveBeenCalled();
    // 一路走到底只属于显式按钮，被动检查时这一步交给用户
    expect(screen.getByRole("button", { name: "下载并安装 v1.1.0" })).toBeInTheDocument();
  });

  it("Linux 包管理器安装：交接面板摆出命令与复制，不给重启按钮", async () => {
    disableAutoUpdateCheck();
    apiMocks.checkForUpdates.mockResolvedValue(
      checkResult({
        platformKey: "linux-amd64-deb",
        handoff: "command",
        fileName: "confscope-amd64.deb",
        downloadUrl: "https://download.example/confscope-amd64.deb",
      })
    );
    apiMocks.downloadUpdate.mockResolvedValue("/tmp/confscope-amd64.deb");

    renderAbout();
    await screen.findByText("v1.0.0");
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));

    expect(await screen.findByText('sudo apt install "/tmp/confscope.deb"')).toBeInTheDocument();
    await waitFor(() => expect(apiMocks.getUpdateInstallCommand).toHaveBeenCalledWith("/tmp/confscope-amd64.deb"));
    expect(screen.getByRole("button", { name: "复制" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "退出并安装" })).not.toBeInTheDocument();
    expect(apiMocks.quitApplication).not.toHaveBeenCalled();
  });

  it("命令取不到时说明要人工安装，而不是摆一条空命令", async () => {
    disableAutoUpdateCheck();
    apiMocks.checkForUpdates.mockResolvedValue(checkResult({ platformKey: "linux-amd64-rpm", handoff: "command" }));
    apiMocks.getUpdateInstallCommand.mockResolvedValue("");

    renderAbout();
    await screen.findByText("v1.0.0");
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));

    expect(await screen.findByText("未能生成安装命令，请在终端手动安装该文件。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "复制" })).not.toBeInTheDocument();
  });

  it("Windows 安装版：忙碌闸门先拦住退出，三件事都空了才交给安装程序", async () => {
    disableAutoUpdateCheck();
    apiMocks.checkForUpdates.mockResolvedValue(
      checkResult({
        platformKey: "windows-amd64-installer",
        handoff: "installer",
        fileName: "confscope-windows-amd64-installer.exe",
        downloadUrl: "https://download.example/confscope-windows-amd64-installer.exe",
      })
    );
    apiMocks.downloadUpdate.mockResolvedValue("C:\\Temp\\confscope-installer.exe");

    renderAbout();
    await screen.findByText("v1.0.0");
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));

    const quitButton = await screen.findByRole("button", { name: "退出并安装" });

    // ① 还有任务在写远端配置：退出等于打断一次半截的变更
    taskMocks.listTasks.mockReturnValue([{ name: "批量写入配置", status: "running" }] as never);
    fireEvent.click(quitButton);
    expect(await screen.findByText("任务「批量写入配置」尚未结束")).toBeInTheDocument();
    expect(apiMocks.launchUpdateInstaller).not.toHaveBeenCalled();
    expect(apiMocks.quitApplication).not.toHaveBeenCalled();

    // ② 还有 SSH 隧道在线：连带断掉用户的端口转发
    taskMocks.listTasks.mockReturnValue([]);
    apiMocks.listActiveSSHTunnels.mockResolvedValue(["tunnel-a", "tunnel-b"]);
    fireEvent.click(quitButton);
    expect(await screen.findByText("仍有 2 条 SSH 隧道在线：tunnel-a, tunnel-b")).toBeInTheDocument();
    expect(apiMocks.launchUpdateInstaller).not.toHaveBeenCalled();

    // ③ 主数据还没落盘：带着未写的改动退出就是吃掉最后一次变更
    apiMocks.listActiveSSHTunnels.mockResolvedValue([]);
    docMocks.pushAppDataDocument.mockResolvedValue(false);
    fireEvent.click(quitButton);
    expect(await screen.findByText("本地数据尚未写入磁盘，现在退出会丢掉最后一次变更")).toBeInTheDocument();
    expect(apiMocks.launchUpdateInstaller).not.toHaveBeenCalled();
    expect(apiMocks.quitApplication).not.toHaveBeenCalled();

    // ④ 都空了才走：先交给安装程序，再退出自己
    docMocks.pushAppDataDocument.mockResolvedValue(true);
    fireEvent.click(quitButton);
    await waitFor(() => expect(apiMocks.launchUpdateInstaller).toHaveBeenCalledWith("C:\\Temp\\confscope-installer.exe"));
    expect(apiMocks.quitApplication).toHaveBeenCalled();
    expect(
      apiMocks.launchUpdateInstaller.mock.invocationCallOrder[0] < apiMocks.quitApplication.mock.invocationCallOrder[0]
    ).toBe(true);
  });

  it("退出失败时把人工出路说清楚，不留「点了没反应」", async () => {
    disableAutoUpdateCheck();
    apiMocks.checkForUpdates.mockResolvedValue(checkResult({ handoff: "installer", platformKey: "windows-amd64-installer" }));
    apiMocks.launchUpdateInstaller.mockRejectedValue(new Error("installer blocked by policy"));

    renderAbout();
    await screen.findByText("v1.0.0");
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));

    fireEvent.click(await screen.findByRole("button", { name: "退出并安装" }));

    expect(await screen.findByText(/installer blocked by policy/)).toBeInTheDocument();
    expect(screen.getByText(/也可以自行退出应用后双击运行该安装程序。/)).toBeInTheDocument();
    expect(apiMocks.quitApplication).not.toHaveBeenCalled();
  });

  it("读不到隧道表时不拿它当理由，该交接照样交接", async () => {
    disableAutoUpdateCheck();
    apiMocks.checkForUpdates.mockResolvedValue(checkResult({ handoff: "installer", platformKey: "windows-amd64-installer" }));
    apiMocks.listActiveSSHTunnels.mockRejectedValue(new Error("no runtime"));

    renderAbout();
    await screen.findByText("v1.0.0");
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    fireEvent.click(await screen.findByRole("button", { name: "退出并安装" }));

    await waitFor(() => expect(apiMocks.launchUpdateInstaller).toHaveBeenCalled());
    expect(apiMocks.quitApplication).toHaveBeenCalled();
  });

  it("便携版出路把文件交给人工覆盖，绝不自替换二进制", async () => {
    disableAutoUpdateCheck();
    apiMocks.checkForUpdates.mockResolvedValue(
      checkResult({ handoff: "reveal", platformKey: "windows-amd64", downgraded: true, reason: "preferred-entry-missing:windows-amd64-installer" })
    );

    renderAbout();
    await screen.findByText("v1.0.0");
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));

    const reveal = await screen.findByRole("button", { name: "打开所在文件夹" });
    expect(screen.getByText(/请在文件夹里替换当前程序后重新启动。/)).toBeInTheDocument();
    // 首选条目缺失（旧 tag 没有安装包）必须说人话，而不是让用户自己猜为什么下的是 exe
    expect(screen.getByText(/已退回通用产物/)).toBeInTheDocument();

    fireEvent.click(reveal);
    await waitFor(() => expect(apiMocks.revealDownloadedArtifact).toHaveBeenCalledWith("C:\\Temp\\ConfScope.exe"));
    expect(apiMocks.quitApplication).not.toHaveBeenCalled();
    expect(apiMocks.launchUpdateInstaller).not.toHaveBeenCalled();
  });

  it("mac 出路给挂载镜像，不给命令也不给安装程序", async () => {
    disableAutoUpdateCheck();
    apiMocks.checkForUpdates.mockResolvedValue(
      checkResult({ platformKey: "darwin-arm64", handoff: "image", fileName: "ConfScope.dmg" })
    );
    apiMocks.downloadUpdate.mockResolvedValue("/tmp/ConfScope.dmg");

    renderAbout();
    await screen.findByText("v1.0.0");
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));

    const mount = await screen.findByRole("button", { name: "挂载镜像" });
    expect(screen.getByText(/拖进「应用程序」覆盖旧版本。/)).toBeInTheDocument();
    fireEvent.click(mount);
    await waitFor(() => expect(apiMocks.attachUpdateImage).toHaveBeenCalledWith("/tmp/ConfScope.dmg"));
    expect(screen.queryByRole("button", { name: "退出并安装" })).not.toBeInTheDocument();
  });

  it("清单里没有可用条目时不摆假下载按钮，直接给 Release 页出路", async () => {
    disableAutoUpdateCheck();
    apiMocks.checkForUpdates.mockResolvedValue(
      checkResult({
        platformKey: "none",
        handoff: "page",
        fileName: "",
        downloadUrl: "",
        sourceUrl: "https://github.com/Adsryen/ConfScope/releases/download/v1.1.0/update.json",
        reason: "no-asset-for-platform",
      })
    );
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    renderAbout();
    await screen.findByText("v1.0.0");
    // 点了「检查更新」也变不出一个不存在的产物：必须停在有新版本可读，而不是转圈或报错
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));

    expect(await screen.findByText("发现新版本 v1.1.0")).toBeInTheDocument();
    expect(apiMocks.downloadUpdate).not.toHaveBeenCalled();
    expect(screen.getByText(/清单里没有适配当前平台的安装包/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "下载并安装 v1.1.0" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开下载页" }));

    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith("https://github.com/Adsryen/ConfScope/releases", "_blank", "noopener,noreferrer")
    );
    // Release 页才是人能看懂的落点，update.json 不是
    expect(openSpy).not.toHaveBeenCalledWith(
      "https://github.com/Adsryen/ConfScope/releases/download/v1.1.0/update.json",
      "_blank",
      "noopener,noreferrer"
    );
    expect(apiMocks.launchUpdateInstaller).not.toHaveBeenCalled();
  });

  it("shows the latest-state message when no update exists", async () => {
    disableAutoUpdateCheck();
    apiMocks.checkForUpdates.mockResolvedValue(
      checkResult({ latestVersion: "1.0.0", hasUpdate: false, downloadUrl: "", handoff: "", platformKey: "windows-amd64" })
    );

    renderAbout();
    await screen.findByText("v1.0.0");
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));

    expect(await screen.findByText("当前已是最新版本")).toBeInTheDocument();
    expect(apiMocks.downloadUpdate).not.toHaveBeenCalled();
  });

  // ── 轮67 R67-WP2：忽略不能是死胡同 ──

  it("忽略过版本时，「已是最新」要说清是被哪个版本挡住的", async () => {
    writeSettings(new Date().toISOString(), "1.1.0");
    apiMocks.checkForUpdates.mockResolvedValue(
      checkResult({ latestVersion: "1.1.0", hasUpdate: false, downloadUrl: "", handoff: "", platformKey: "windows-amd64" })
    );

    renderAbout();
    await screen.findByText("v1.0.0");
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));

    expect(await screen.findByText(/已忽略 v1\.1\.0/)).toBeInTheDocument();
    expect(screen.getByText(/设置 · 应用更新/)).toBeInTheDocument();
  });

  it("点「忽略此版本」后当场改口，不留下「本来就是最新」的假象", async () => {
    disableAutoUpdateCheck();
    apiMocks.checkForUpdates.mockResolvedValue(checkResult({ latestVersion: "1.1.0", hasUpdate: true, downloadUrl: "" }));

    renderAbout();
    await screen.findByText("v1.0.0");
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));

    fireEvent.click(await screen.findByRole("button", { name: "忽略此版本" }));

    expect(await screen.findByText(/已忽略 v1\.1\.0/)).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("cs.settings") || "{}").update.skipVersion).toBe("1.1.0");
  });

  it("没忽略过版本时仍说「当前已是最新版本」", async () => {
    disableAutoUpdateCheck();
    apiMocks.checkForUpdates.mockResolvedValue(
      checkResult({ latestVersion: "1.0.0", hasUpdate: false, downloadUrl: "", handoff: "", platformKey: "windows-amd64" })
    );

    renderAbout();
    await screen.findByText("v1.0.0");
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));

    expect(await screen.findByText("当前已是最新版本")).toBeInTheDocument();
    expect(screen.queryByText(/已忽略/)).not.toBeInTheDocument();
  });

  it("uses loaded app version for automatic update checks", async () => {
    enableAutoUpdateCheck();
    apiMocks.getAppInfo.mockResolvedValue(baseAppInfo("1.3.0"));
    apiMocks.checkForUpdates.mockResolvedValue(
      checkResult({ currentVersion: "1.3.0", latestVersion: "1.3.0", hasUpdate: false, downloadUrl: "", handoff: "" })
    );

    renderAbout();

    expect(await screen.findByText("v1.3.0")).toBeInTheDocument();
    await waitFor(() => {
      expect(apiMocks.checkForUpdates).toHaveBeenCalledWith(expect.objectContaining({ currentVersion: "1.3.0" }));
    });
    expect(apiMocks.checkForUpdates).not.toHaveBeenCalledWith(expect.objectContaining({ currentVersion: "1.0.0" }));
    expect(await screen.findByText("当前已是最新版本")).toBeInTheDocument();
  });

  it("reports update result errors with localized message-center titles", async () => {
    disableAutoUpdateCheck();
    apiMocks.checkForUpdates.mockResolvedValue(checkResult({ latestVersion: "", hasUpdate: false, error: "registry timeout" }));

    renderAbout("en-US");
    await screen.findByText("v1.0.0");
    fireEvent.click(screen.getByRole("button", { name: "Check for Updates" }));

    expect(await screen.findByText("registry timeout")).toBeInTheDocument();
    expect(latestError()).toMatchObject({ title: "Update check failed", source: "App Updates" });
  });

  it("reports thrown update check errors with localized message-center titles", async () => {
    disableAutoUpdateCheck();
    apiMocks.checkForUpdates.mockRejectedValueOnce(new Error("network offline"));

    renderAbout("en-US");
    await screen.findByText("v1.0.0");
    fireEvent.click(screen.getByRole("button", { name: "Check for Updates" }));

    expect(await screen.findByText("network offline")).toBeInTheDocument();
    expect(latestError()).toMatchObject({ title: "Update check error", source: "App Updates" });
  });

  it("reports update download errors with localized message-center titles", async () => {
    disableAutoUpdateCheck();
    apiMocks.downloadUpdate.mockRejectedValueOnce(new Error("download timeout"));

    renderAbout("en-US");
    await screen.findByText("v1.0.0");
    fireEvent.click(screen.getByRole("button", { name: "Check for Updates" }));

    expect(await screen.findByText("download timeout")).toBeInTheDocument();
    expect(latestError()).toMatchObject({ title: "Update download failed", source: "App Updates" });
    expect(screen.queryByText("Download complete, verification passed")).not.toBeInTheDocument();
  });

  it("shows Apollo and Consul as read-only supported instead of planned", async () => {
    disableAutoUpdateCheck();

    renderAbout("en-US");

    await screen.findByText("v1.0.0");
    expect(screen.getByText("Nacos")).toBeInTheDocument();
    expect(screen.getByText("Apollo Read-only")).toBeInTheDocument();
    expect(screen.getByText("Consul KV Read-only")).toBeInTheDocument();
    expect(screen.queryByText("Apollo 🔜")).not.toBeInTheDocument();
    expect(screen.queryByText("Consul Planned")).not.toBeInTheDocument();
  });

  it("关于弹层是真 dialog，Tab 走一圈留在框内（R38）", async () => {
    disableAutoUpdateCheck();
    renderAbout();
    await screen.findByText("v1.0.0");

    // 标题（<h2>ConfScope</h2>）通过 aria-labelledby 成为可播报名称，读屏进得来说得出这是什么
    const dialog = screen.getByRole("dialog", { name: "ConfScope" });
    expect(dialog).toHaveAttribute("aria-modal", "true");

    const items = [
      ...dialog.querySelectorAll<HTMLElement>(`a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])`),
    ];
    expect(items.length).toBeGreaterThan(0);
    items[items.length - 1].focus();
    fireEvent.keyDown(items[items.length - 1], { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
