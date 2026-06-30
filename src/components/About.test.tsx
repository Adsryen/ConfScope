/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import About from "./About";

const apiMocks = vi.hoisted(() => ({
  getAppInfo: vi.fn(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  getDownloadProgress: vi.fn(),
  installAndRestart: vi.fn(),
}));

vi.mock("../api/app", () => apiMocks);

function renderAbout() {
  localStorage.setItem("locale", "zh-CN");
  return render(
    <I18nProvider>
      <About onClose={vi.fn()} />
    </I18nProvider>
  );
}

describe("About", () => {
  beforeEach(() => {
    localStorage.clear();
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
    localStorage.setItem("cs.settings", JSON.stringify({
      proxy: {
        httpProxy: "http://127.0.0.1:7890",
        httpsProxy: "http://127.0.0.1:7890",
        noProxy: "localhost,127.0.0.1",
      },
      update: { skipVersion: "", lastCheckAt: "", proxyOnlyForUpdate: true },
      compare: { sortConnections: true, sortNamespaces: true },
    }));

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
      expect(apiMocks.downloadUpdate).toHaveBeenCalledWith(
        "https://download.example/ConfScope.exe",
        "abc"
      );
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
});