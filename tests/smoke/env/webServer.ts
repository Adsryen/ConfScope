import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { SmokeWorkspace } from "./workspace";

const WEB_HOST = "127.0.0.1";
const WEB_PORT = 15174;
const WEB_URL = `http://${WEB_HOST}:${WEB_PORT}`;

export interface SmokeSpawnedProcess {
  readonly pid?: number;
  readonly stdout?: Readable | null;
  readonly stderr?: Readable | null;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export interface SmokeSpawnOptions {
  cwd: string;
  shell: boolean;
  windowsHide: boolean;
  env: NodeJS.ProcessEnv;
}

export type SmokeSpawn = (command: string, args: string[], options: SmokeSpawnOptions) => SmokeSpawnedProcess;
export type SmokeFetch = (url: string) => Promise<{ ok: boolean; status: number }>;
export type SmokeSleep = (ms: number) => Promise<void>;
export type SmokeKillTree = (pid: number) => void;

export interface StartSmokeWebServerOptions {
  fetchFn?: SmokeFetch;
  sleepFn?: SmokeSleep;
  spawnProcess?: SmokeSpawn;
  timeoutMs?: number;
  pollMs?: number;
}

export interface StopSmokeWebServerOptions {
  killTree?: SmokeKillTree;
}

class SmokePortInUseError extends Error {}

export function smokeWebServerUrl(): string {
  return WEB_URL;
}

export function smokeWebServerPidPath(workspace: SmokeWorkspace): string {
  return join(workspace.rootDir, "vite.pid");
}

export function smokeWebServerLogPath(workspace: SmokeWorkspace): string {
  return join(workspace.reportsDir, "vite.log");
}

export async function startSmokeWebServer(workspace: SmokeWorkspace, options: StartSmokeWebServerOptions = {}): Promise<void> {
  const fetchFn = options.fetchFn ?? fetch;
  const sleepFn = options.sleepFn ?? sleep;
  const spawnProcess = options.spawnProcess ?? defaultSpawn;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollMs = options.pollMs ?? 500;

  await assertPortIsFree(WEB_URL, fetchFn);
  mkdirSync(workspace.reportsDir, { recursive: true });
  const logPath = smokeWebServerLogPath(workspace);
  writeFileSync(logPath, `[${new Date().toISOString()}] starting smoke Vite server at ${WEB_URL}\n`, { encoding: "utf8", flag: "a" });
  const logStream = createWriteStream(logPath, { flags: "a" });
  const child = spawnProcess("pnpm", ["dev:web", "--host", WEB_HOST, "--port", String(WEB_PORT), "--strictPort"], {
    cwd: workspace.projectRoot,
    shell: true,
    windowsHide: true,
    env: { ...process.env, USERPROFILE: workspace.homeDir, HOME: workspace.homeDir },
  });
  if (!child.pid) {
    logStream.end();
    throw new Error("Smoke Vite server did not expose a process id");
  }
  writeFileSync(smokeWebServerPidPath(workspace), String(child.pid), "utf8");
  child.stdout?.pipe(logStream, { end: false });
  child.stderr?.pipe(logStream, { end: false });

  let exitError: Error | undefined;
  child.on("exit", (code, signal) => {
    logStream.write(`[${new Date().toISOString()}] smoke Vite server exited code=${code ?? ""} signal=${signal ?? ""}\n`);
    logStream.end();
    exitError = new Error(`Smoke Vite server exited before readiness: code=${code ?? "null"} signal=${signal ?? "null"}`);
  });
  child.on("error", (error) => {
    logStream.write(`[${new Date().toISOString()}] smoke Vite server error: ${String(error)}\n`);
    logStream.end();
    exitError = error;
  });

  try {
    await waitForWebServer(WEB_URL, { fetchFn, sleepFn, timeoutMs, pollMs, getExitError: () => exitError });
  } catch (error) {
    stopSmokeWebServer(workspace);
    throw error;
  }
}

export function stopSmokeWebServer(workspace: SmokeWorkspace, options: StopSmokeWebServerOptions = {}): void {
  const pidPath = smokeWebServerPidPath(workspace);
  if (!existsSync(pidPath)) return;
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  try {
    if (Number.isFinite(pid) && pid > 0) {
      (options.killTree ?? defaultKillTree)(pid);
    }
  } finally {
    rmSync(pidPath, { force: true });
  }
}

async function assertPortIsFree(url: string, fetchFn: SmokeFetch): Promise<void> {
  try {
    const response = await fetchFn(url);
    throw new SmokePortInUseError(`Smoke web server port already responds at ${url} with status ${response.status}`);
  } catch (error) {
    if (error instanceof SmokePortInUseError) throw error;
  }
}

async function waitForWebServer(
  url: string,
  options: {
    fetchFn: SmokeFetch;
    sleepFn: SmokeSleep;
    timeoutMs: number;
    pollMs: number;
    getExitError: () => Error | undefined;
  }
): Promise<void> {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < options.timeoutMs) {
    const exitError = options.getExitError();
    if (exitError) throw exitError;
    try {
      const response = await options.fetchFn(url);
      if (response.ok) return;
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = String(error);
    }
    await options.sleepFn(options.pollMs);
  }
  throw new Error(`Timed out waiting for smoke Vite server at ${url}: ${lastError}`);
}

const defaultSpawn: SmokeSpawn = (command, args, options) =>
  spawn(command, args, { cwd: options.cwd, shell: options.shell, windowsHide: options.windowsHide, env: options.env });

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
