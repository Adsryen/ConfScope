/**
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNativeSmokeEnv,
  findFreeLoopbackPort,
  killNativeSmokeProcess,
  launchNativeSmokeApp,
  nativeSmokeBuildArgs,
  nativeSmokeLogPath,
  nativeSmokeOutputName,
  nativeSmokeOutputFilename,
  nativeSmokePidPath,
  pnpmExecutable,
  resolveNativeSmokeExecutable,
  type NativeSpawnedProcess,
} from "./nativeApp";
import { createSmokeWorkspace, ensureSmokeWorkspace } from "./workspace";

const roots: string[] = [];

class FakeChild extends EventEmitter implements NativeSpawnedProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  constructor(readonly pid: number) {
    super();
  }
}

describe("native smoke app helpers", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses a stable Wails debug build command", () => {
    expect(nativeSmokeOutputName).toBe("ConfScope-smoke-native");
    expect(nativeSmokeOutputFilename("win32")).toBe("ConfScope-smoke-native.exe");
    expect(nativeSmokeOutputFilename("linux")).toBe("ConfScope-smoke-native");
    expect(nativeSmokeBuildArgs("win32")).toEqual(["wails", "build", "-clean", "-debug", "-devtools", "-o", "ConfScope-smoke-native.exe"]);
    expect(nativeSmokeBuildArgs("linux")).toEqual(["wails", "build", "-clean", "-debug", "-devtools", "-o", "ConfScope-smoke-native"]);
  });

  it("resolves the pnpm executable name for Windows command lookup", () => {
    expect(pnpmExecutable("win32")).toBe("pnpm.cmd");
    expect(pnpmExecutable("linux")).toBe("pnpm");
  });

  it("resolves the native smoke executable under build/bin", () => {
    expect(resolveNativeSmokeExecutable("C:/repo/ConfScope", "ConfScope-smoke-native", "win32").replaceAll("\\", "/")).toBe(
      "C:/repo/ConfScope/build/bin/ConfScope-smoke-native.exe"
    );
    expect(resolveNativeSmokeExecutable("/repo/ConfScope", "ConfScope-smoke-native", "linux").replaceAll("\\", "/")).toBe(
      "/repo/ConfScope/build/bin/ConfScope-smoke-native"
    );
  });

  it("prefers the existing Wails output when Windows build omits .exe", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "confscope-native-output-"));
    roots.push(projectRoot);
    const binDir = join(projectRoot, "build", "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "ConfScope-smoke-native"), "", "utf8");

    expect(resolveNativeSmokeExecutable(projectRoot, "ConfScope-smoke-native", "win32").replaceAll("\\", "/")).toBe(
      `${projectRoot.replaceAll("\\", "/")}/build/bin/ConfScope-smoke-native`
    );
  });

  it("creates an isolated WebView2 environment under the smoke workspace", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "confscope-native-env-"));
    roots.push(projectRoot);
    const workspace = ensureSmokeWorkspace(createSmokeWorkspace({ projectRoot, runId: "20260707-120000" }));
    const userDataDir = join(workspace.rootDir, "webview2-user-data");

    const env = createNativeSmokeEnv(workspace, { controlPort: 19222, userDataDir });

    expect(env.USERPROFILE?.replaceAll("\\", "/")).toBe(`${workspace.homeDir.replaceAll("\\", "/")}`);
    expect(env.HOME?.replaceAll("\\", "/")).toBe(`${workspace.homeDir.replaceAll("\\", "/")}`);
    expect(env.APPDATA?.replaceAll("\\", "/")).toBe(`${workspace.homeDir.replaceAll("\\", "/")}/AppData/Roaming`);
    expect(env.LOCALAPPDATA?.replaceAll("\\", "/")).toBe(`${workspace.homeDir.replaceAll("\\", "/")}/AppData/Local`);
    expect(env.WEBVIEW2_USER_DATA_FOLDER?.replaceAll("\\", "/")).toBe(userDataDir.replaceAll("\\", "/"));
    expect(env.CONFSCOPE_NATIVE_SMOKE_CONTROL_PORT).toBe("19222");
    expect(env.CONFSCOPE_NATIVE_SMOKE_WEBVIEW_USER_DATA_DIR?.replaceAll("\\", "/")).toBe(userDataDir.replaceAll("\\", "/"));
  });

  it("launches the native executable with isolated env and records pid/log paths", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "confscope-native-launch-"));
    roots.push(projectRoot);
    const workspace = ensureSmokeWorkspace(createSmokeWorkspace({ projectRoot, runId: "20260707-120000" }));
    const child = new FakeChild(6868);
    const spawnProcess = vi.fn(() => child);
    const executablePath = resolveNativeSmokeExecutable(projectRoot, "ConfScope-smoke-native", "win32");

    const process = await launchNativeSmokeApp({
      workspace,
      executablePath,
      controlPort: 19333,
      spawnProcess,
    });

    try {
      expect(process.pid).toBe(6868);
      expect(process.logPath).toBe(nativeSmokeLogPath(workspace));
      expect(spawnProcess).toHaveBeenCalledWith(
        executablePath,
        [],
        expect.objectContaining({
          cwd: projectRoot,
          windowsHide: true,
        env: expect.objectContaining({
          CONFSCOPE_NATIVE_SMOKE_CONTROL_PORT: "19333",
        }),
      })
    );
      expect(readFileSync(nativeSmokePidPath(workspace), "utf8")).toBe("6868");
    } finally {
      child.emit("exit", 0, null);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

  it("kills the recorded native process tree", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "confscope-native-kill-"));
    roots.push(projectRoot);
    const workspace = ensureSmokeWorkspace(createSmokeWorkspace({ projectRoot, runId: "20260707-120000" }));
    const killTree = vi.fn();

    killNativeSmokeProcess({ workspace, pid: 6868, logPath: nativeSmokeLogPath(workspace), executablePath: "app.exe", controlPort: 19333 }, { killTree });

    expect(killTree).toHaveBeenCalledWith(6868);
  });

  it("allocates a loopback port for the native smoke control server", async () => {
    const port = await findFreeLoopbackPort();

    expect(port).toBeGreaterThan(0);
  });
});
