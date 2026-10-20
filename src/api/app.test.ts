/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkForUpdates,
  getAppInfo,
  selectLocalSnapshotDirectory,
  validateLocalSnapshotDirectory,
} from "./app";

const goApp = {
  GetAppInfo: vi.fn(),
  CheckForUpdates: vi.fn(),
  SelectLocalSnapshotDirectory: vi.fn(),
  ValidateLocalSnapshotDirectory: vi.fn(),
};

describe("app api", () => {
  beforeEach(() => {
    goApp.GetAppInfo.mockReset();
    goApp.CheckForUpdates.mockReset();
    goApp.SelectLocalSnapshotDirectory.mockReset();
    goApp.ValidateLocalSnapshotDirectory.mockReset();
    // 绑定命名空间由 Go 包名决定：77fa451 起是 go.app.App（守卫
    // tests/ux/wailsBindingNamespaceIsSingleSource）。这里曾一直 stub 旧的 go.main.App，
    // 于是 wailsjs 生成物取 go.app.App 取到 undefined，用例集体红成「既有基线」。
    vi.stubGlobal("go", {
      app: {
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

  it("uses Wails bindings for local snapshot folder selection and validation", async () => {
    goApp.SelectLocalSnapshotDirectory.mockResolvedValue("C:\\backup\\prod");
    goApp.ValidateLocalSnapshotDirectory.mockResolvedValue({
      valid: true,
      path: "C:\\backup\\prod",
      code: "valid",
      configCount: 3,
      schemaVersion: 1,
      layout: "confscope-v1",
      legacy: false,
    });

    await expect(selectLocalSnapshotDirectory()).resolves.toBe("C:\\backup\\prod");
    await expect(validateLocalSnapshotDirectory("C:\\backup\\prod")).resolves.toMatchObject({
      valid: true,
      code: "valid",
      configCount: 3,
      schemaVersion: 1,
      layout: "confscope-v1",
      legacy: false,
    });

    expect(goApp.SelectLocalSnapshotDirectory).toHaveBeenCalledTimes(1);
    expect(goApp.ValidateLocalSnapshotDirectory).toHaveBeenCalledWith("C:\\backup\\prod");
  });
});
