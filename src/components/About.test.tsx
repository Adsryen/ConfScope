/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { clearErrors, subscribeErrors, type AppErrorItem } from "../lib/errorCenter";
import About from "./About";

const apiMocks = vi.hoisted(() => ({
  getAppInfo: vi.fn(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  getDownloadProgress: vi.fn(),
  installAndRestart: vi.fn(),
}));

vi.mock("../api/app", () => apiMocks);

function renderAbout(locale = "zh-CN") {
  localStorage.setItem("locale", locale);
  return render(
    <I18nProvider>
      <About onClose={vi.fn()} />
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

function disableAutoUpdateCheck() {
  localStorage.setItem(
    "cs.settings",
    JSON.stringify({
      proxy: { httpProxy: "", httpsProxy: "", noProxy: "" },
      update: { skipVersion: "", lastCheckAt: new Date().toISOString() },
      compare: { sortConnections: true, sortNamespaces: true },
    })
  );
}

describe("About", () => {
  beforeEach(() => {
    localStorage.clear();
    clearErrors();
    apiMocks.getAppInfo.mockReset();
    apiMocks.checkForUpdates.mockReset();
    apiMocks.downloadUpdate.mockReset();
    apiMocks.getDownloadProgress.mockReset();
    apiMocks.installAndRestart.mockReset();
    apiMocks.getAppInfo.mockResolvedValue({
      name: "ConfScope",
      version: "1.0.0",
      updateSources: [
        { name: "GitHub 官方", url: "https://github.example/update.json" },
        { name: "国内加速 1", url: "https://mirror.example/update.json" },
      ],
    });
    apiMocks.checkForUpdates.mockResolvedValue({
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
    });
    apiMocks.getDownloadProgress.mockResolvedValue({
      downloaded: 0,
      total: 0,
      percent: 0,
      done: false,
      error: "",
    });
  });

  it("checks updates with built-in sources and global proxy settings", async () => {
    localStorage.setItem(
      "cs.settings",
      JSON.stringify({
        proxy: {
          httpProxy: "http://127.0.0.1:7890",
          httpsProxy: "http://127.0.0.1:7890",
          noProxy: "localhost,127.0.0.1",
        },
        update: { skipVersion: "", lastCheckAt: "" },
        compare: { sortConnections: true, sortNamespaces: true },
      })
    );

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
        proxy: {
          httpProxy: "http://127.0.0.1:7890",
          httpsProxy: "http://127.0.0.1:7890",
          noProxy: "localhost,127.0.0.1",
        },
      });
    });
    expect(await screen.findByText("发现新版本 v1.1.0")).toBeInTheDocument();
    expect(screen.getByText("命中线路：国内加速 1")).toBeInTheDocument();

    // 点击下载更新
    fireEvent.click(screen.getByRole("button", { name: "下载更新" }));

    await waitFor(() => {
      expect(apiMocks.downloadUpdate).toHaveBeenCalledWith("https://download.example/ConfScope.exe", "abc");
    });
  });

  it("shows the latest-state message when no update exists", async () => {
    apiMocks.checkForUpdates.mockResolvedValue({
      currentVersion: "1.0.0",
      latestVersion: "1.0.0",
      hasUpdate: false,
      sourceName: "GitHub 官方",
      sourceUrl: "https://github.example/update.json",
      downloadUrl: "",
      releaseNotes: "",
      publishedAt: "",
      sha256: "",
      mandatory: false,
      checkedAt: "2026-06-28T00:00:00Z",
      error: "",
    });
    renderAbout();

    await screen.findByText("v1.0.0");
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));

    expect(await screen.findByText("当前已是最新版本")).toBeInTheDocument();
  });

  it("uses loaded app version for automatic update checks", async () => {
    localStorage.setItem(
      "cs.settings",
      JSON.stringify({
        proxy: { httpProxy: "", httpsProxy: "", noProxy: "" },
        update: { skipVersion: "", lastCheckAt: "" },
        compare: { sortConnections: true, sortNamespaces: true },
      })
    );
    apiMocks.getAppInfo.mockResolvedValue({
      name: "ConfScope",
      version: "1.3.0",
      updateSources: [{ name: "GitHub 官方", url: "https://github.example/update.json" }],
    });
    apiMocks.checkForUpdates.mockResolvedValue({
      currentVersion: "1.3.0",
      latestVersion: "1.3.0",
      hasUpdate: false,
      sourceName: "GitHub 官方",
      sourceUrl: "https://github.example/update.json",
      downloadUrl: "",
      releaseNotes: "",
      publishedAt: "",
      sha256: "",
      mandatory: false,
      checkedAt: "2026-06-28T00:00:00Z",
      error: "",
    });

    renderAbout();

    expect(await screen.findByText("v1.3.0")).toBeInTheDocument();
    await waitFor(() => {
      expect(apiMocks.checkForUpdates).toHaveBeenCalledWith(expect.objectContaining({ currentVersion: "1.3.0" }));
    });
    expect(apiMocks.checkForUpdates).not.toHaveBeenCalledWith(expect.objectContaining({ currentVersion: "1.0.0" }));
    expect(await screen.findByText("当前已是最新版本")).toBeInTheDocument();
  });

  it("opens the download link after downloading instead of invoking restart installation", async () => {
    disableAutoUpdateCheck();
    apiMocks.downloadUpdate.mockResolvedValueOnce("C:\\Temp\\ConfScope.exe");
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    renderAbout("en-US");
    await screen.findByText("v1.0.0");
    fireEvent.click(screen.getByRole("button", { name: "Check for Updates" }));
    expect(await screen.findByText("New version v1.1.0 available")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Download Update" }));

    expect(await screen.findByText("Download complete, verification passed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restart to Install" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Download Page" }));

    expect(apiMocks.installAndRestart).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith("https://download.example/ConfScope.exe", "_blank", "noopener,noreferrer");
  });

  it("reports update result errors with localized message-center titles", async () => {
    disableAutoUpdateCheck();
    apiMocks.checkForUpdates.mockResolvedValue({
      currentVersion: "1.0.0",
      latestVersion: "",
      hasUpdate: false,
      sourceName: "",
      sourceUrl: "",
      downloadUrl: "",
      releaseNotes: "",
      publishedAt: "",
      sha256: "",
      mandatory: false,
      checkedAt: "2026-06-28T00:00:00Z",
      error: "registry timeout",
    });

    renderAbout("en-US");
    await screen.findByText("v1.0.0");
    fireEvent.click(screen.getByRole("button", { name: "Check for Updates" }));

    expect(await screen.findByText("registry timeout")).toBeInTheDocument();
    expect(latestError()).toMatchObject({
      title: "Update check failed",
      source: "App Updates",
    });
  });

  it("reports thrown update check errors with localized message-center titles", async () => {
    disableAutoUpdateCheck();
    apiMocks.checkForUpdates.mockRejectedValueOnce(new Error("network offline"));

    renderAbout("en-US");
    await screen.findByText("v1.0.0");
    fireEvent.click(screen.getByRole("button", { name: "Check for Updates" }));

    expect(await screen.findByText("Error: network offline")).toBeInTheDocument();
    expect(latestError()).toMatchObject({
      title: "Update check error",
      source: "App Updates",
    });
  });

  it("reports update download errors with localized message-center titles", async () => {
    disableAutoUpdateCheck();
    apiMocks.downloadUpdate.mockRejectedValueOnce(new Error("download timeout"));

    renderAbout("en-US");
    await screen.findByText("v1.0.0");
    fireEvent.click(screen.getByRole("button", { name: "Check for Updates" }));
    expect(await screen.findByText("New version v1.1.0 available")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Download Update" }));

    expect(await screen.findByText("Error: download timeout")).toBeInTheDocument();
    expect(latestError()).toMatchObject({
      title: "Update download failed",
      source: "App Updates",
    });
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
});
