import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Readable } from "node:stream";
import type { SmokeWorkspace } from "./workspace";

export const nativeSmokeOutputName = "ConfScope-smoke-native";

export interface NativeSpawnedProcess {
  readonly pid?: number;
  readonly stdout?: Readable | null;
  readonly stderr?: Readable | null;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export interface NativeSpawnOptions {
  cwd: string;
  windowsHide: boolean;
  env: NodeJS.ProcessEnv;
}

export type NativeSpawn = (command: string, args: string[], options: NativeSpawnOptions) => NativeSpawnedProcess;
export type NativeKillTree = (pid: number) => void;

export interface NativeSmokeProcess {
  workspace: SmokeWorkspace;
  executablePath: string;
  controlPort: number;
  pid: number;
  logPath: string;
}

export interface LaunchNativeSmokeAppOptions {
  workspace: SmokeWorkspace;
  executablePath: string;
  controlPort: number;
  userDataDir?: string;
  spawnProcess?: NativeSpawn;
}

export interface KillNativeSmokeProcessOptions {
  killTree?: NativeKillTree;
}

export function nativeSmokeOutputFilename(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `${nativeSmokeOutputName}.exe` : nativeSmokeOutputName;
}

export function nativeSmokeBuildArgs(platform: NodeJS.Platform = process.platform): string[] {
  return ["wails", "build", "-clean", "-debug", "-devtools", "-o", nativeSmokeOutputFilename(platform)];
}

export function pnpmExecutable(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "pnpm.cmd" : "pnpm";
}

export function resolveNativeSmokeExecutable(
  projectRoot: string,
  outputName = nativeSmokeOutputName,
  platform: NodeJS.Platform = process.platform
): string {
  const binDir = join(projectRoot, "build", "bin");
  const candidates = platform === "win32" ? [join(binDir, `${outputName}.exe`), join(binDir, outputName)] : [join(binDir, outputName)];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export function createNativeSmokeEnv(
  workspace: SmokeWorkspace,
  options: { controlPort: number; userDataDir: string }
): NodeJS.ProcessEnv {
  const roamingAppData = join(workspace.homeDir, "AppData", "Roaming");
  const localAppData = join(workspace.homeDir, "AppData", "Local");
  mkdirSync(roamingAppData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  mkdirSync(options.userDataDir, { recursive: true });

  return {
    ...process.env,
    USERPROFILE: workspace.homeDir,
    HOME: workspace.homeDir,
    APPDATA: roamingAppData,
    LOCALAPPDATA: localAppData,
    WEBVIEW2_USER_DATA_FOLDER: options.userDataDir,
    CONFSCOPE_NATIVE_SMOKE_CONTROL_PORT: String(options.controlPort),
    CONFSCOPE_NATIVE_SMOKE_WEBVIEW_USER_DATA_DIR: options.userDataDir,
  };
}

export function nativeSmokePidPath(workspace: SmokeWorkspace): string {
  return join(workspace.rootDir, "native.pid");
}

export function nativeSmokeLogPath(workspace: SmokeWorkspace): string {
  return join(workspace.reportsDir, "native-app.log");
}

export async function launchNativeSmokeApp(options: LaunchNativeSmokeAppOptions): Promise<NativeSmokeProcess> {
  const spawnProcess = options.spawnProcess ?? defaultSpawn;
  const userDataDir = options.userDataDir ?? join(options.workspace.rootDir, "webview2-user-data");
  const env = createNativeSmokeEnv(options.workspace, { controlPort: options.controlPort, userDataDir });
  mkdirSync(options.workspace.reportsDir, { recursive: true });

  const logPath = nativeSmokeLogPath(options.workspace);
  writeFileSync(logPath, `[${new Date().toISOString()}] starting native Wails app at ${options.executablePath}\n`, {
    encoding: "utf8",
    flag: "a",
  });
  const logStream = createWriteStream(logPath, { flags: "a" });
  const child = spawnProcess(options.executablePath, [], {
    cwd: options.workspace.projectRoot,
    windowsHide: true,
    env,
  });
  if (!child.pid) {
    logStream.end();
    throw new Error("Native Wails app did not expose a process id");
  }

  writeFileSync(nativeSmokePidPath(options.workspace), String(child.pid), "utf8");
  child.stdout?.pipe(logStream, { end: false });
  child.stderr?.pipe(logStream, { end: false });
  child.on("exit", (code, signal) => {
    logStream.write(`[${new Date().toISOString()}] native Wails app exited code=${code ?? ""} signal=${signal ?? ""}\n`);
    logStream.end();
  });
  child.on("error", (error) => {
    logStream.write(`[${new Date().toISOString()}] native Wails app error: ${String(error)}\n`);
    logStream.end();
  });

  return {
    workspace: options.workspace,
    executablePath: options.executablePath,
    controlPort: options.controlPort,
    pid: child.pid,
    logPath,
  };
}

export function killNativeSmokeProcess(process: NativeSmokeProcess, options: KillNativeSmokeProcessOptions = {}): void {
  try {
    if (Number.isFinite(process.pid) && process.pid > 0) {
      (options.killTree ?? defaultKillTree)(process.pid);
    }
  } finally {
    rmSync(nativeSmokePidPath(process.workspace), { force: true });
  }
}

export function stopRecordedNativeSmokeProcess(workspace: SmokeWorkspace, options: KillNativeSmokeProcessOptions = {}): void {
  const pidPath = nativeSmokePidPath(workspace);
  if (!existsSync(pidPath)) return;
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  killNativeSmokeProcess(
    {
      workspace,
      executablePath: resolveNativeSmokeExecutable(workspace.projectRoot),
      controlPort: 0,
      pid,
      logPath: nativeSmokeLogPath(workspace),
    },
    options
  );
}

export function findFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!isAddressInfo(address)) {
        server.close();
        reject(new Error("Unable to allocate a loopback port"));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

const defaultSpawn: NativeSpawn = (command, args, options) =>
  spawn(command, args, { cwd: options.cwd, windowsHide: options.windowsHide, env: options.env });

function defaultKillTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      return;
    }
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return;
    }
  }
}

function isAddressInfo(address: string | AddressInfo | null): address is AddressInfo {
  return typeof address === "object" && address !== null && typeof address.port === "number";
}
