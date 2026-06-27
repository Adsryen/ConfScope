/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkForUpdates, getAppInfo } from "./app";

const goApp = {
  GetAppInfo: vi.fn(),
  CheckForUpdates: vi.fn(),
};

describe("app api", () => {
  beforeEach(() => {
    goApp.GetAppInfo.mockReset();
    goApp.CheckForUpdates.mockReset();
    vi.stubGlobal("go", {
      main: {
        App: goApp,
      },
    });
  });

  it("loads app info from the Wails binding", async () => {
    goApp.GetAppInfo.mockResolvedValue({
      name: "ConfScope",
      version: "1.0.0",
      updateSources: [{ name: "GitHub 官方", url: "https://example.com/update.json" }],
    });

    await expect(getAppInfo()).resolves.toEqual({
      name: "ConfScope",
      version: "1.0.0",
      updateSources: [{ name: "GitHub 官方", url: "https://example.com/update.json" }],
    });
  });

  it("passes current version, update sources, and global proxy settings when checking updates", async () => {
    goApp.CheckForUpdates.mockResolvedValue({
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      hasUpdate: true,
      sourceName: "国内加速",
      downloadUrl: "https://example.com/ConfScope.exe",
      error: "",
    });

    await checkForUpdates({
      currentVersion: "1.0.0",
      sources: [{ name: "国内加速", url: "https://mirror.example.com/update.json" }],
      proxy: {
        httpProxy: "http://127.0.0.1:7890",
        httpsProxy: "http://127.0.0.1:7890",
        noProxy: "localhost",
      },
    });

    expect(goApp.CheckForUpdates).toHaveBeenCalledWith({
      currentVersion: "1.0.0",
      sources: [{ name: "国内加速", url: "https://mirror.example.com/update.json" }],
      proxy: {
        httpProxy: "http://127.0.0.1:7890",
        httpsProxy: "http://127.0.0.1:7890",
        noProxy: "localhost",
      },
    });
  });
});
