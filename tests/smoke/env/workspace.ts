import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SmokeNacosEndpoint {
  role: "dev" | "sandbox" | "prod";
  containerName: string;
  hostPort: number;
  baseUrl: string;
}

export interface SmokeWorkspace {
  runId: string;
  projectRoot: string;
  rootDir: string;
  homeDir: string;
  localSnapshotsDir: string;
  reportsDir: string;
  screenshotsDir: string;
  statePath: string;
  nacos: {
    dev: SmokeNacosEndpoint;
    sandbox: SmokeNacosEndpoint;
    prod: SmokeNacosEndpoint;
  };
}

export interface SmokeState extends SmokeWorkspace {
  fixtures: {
    strictPublic: string;
    legacyPublic: string;
    invalidEmpty: string;
  };
}

export interface CreateSmokeWorkspaceOptions {
  projectRoot?: string;
  runId?: string;
}

export function createRunId(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

export function createSmokeWorkspace(options: CreateSmokeWorkspaceOptions = {}): SmokeWorkspace {
  const projectRoot = options.projectRoot ?? process.cwd();
  const runId = options.runId ?? process.env.CONFSCOPE_SMOKE_RUN_ID ?? createRunId();
  const rootDir = join(projectRoot, ".tmp", `full-smoke-${runId}`);
  const homeDir = join(rootDir, "home");
  const localSnapshotsDir = join(rootDir, "local-snapshots");
  const reportsDir = join(rootDir, "reports");
  const screenshotsDir = join(reportsDir, "screenshots");
  const statePath = join(rootDir, "state.json");

  return {
    runId,
    projectRoot,
    rootDir,
    homeDir,
    localSnapshotsDir,
    reportsDir,
    screenshotsDir,
    statePath,
    nacos: {
      dev: nacosEndpoint("dev", 18858),
      sandbox: nacosEndpoint("sandbox", 18859),
      prod: nacosEndpoint("prod", 18860),
    },
  };
}

export function ensureSmokeWorkspace(workspace: SmokeWorkspace): SmokeWorkspace {
  mkdirSync(workspace.homeDir, { recursive: true });
  mkdirSync(workspace.localSnapshotsDir, { recursive: true });
  mkdirSync(workspace.screenshotsDir, { recursive: true });
  return workspace;
}

export function writeSmokeState(workspace: SmokeWorkspace): void {
  ensureSmokeWorkspace(workspace);
  writeFileSync(workspace.statePath, JSON.stringify(workspace, null, 2), "utf8");
  writeFileSync(join(workspace.projectRoot, ".tmp", "full-smoke-current.json"), JSON.stringify(workspace, null, 2), "utf8");
}

export function writeSmokeStateFile(state: SmokeState): void {
  ensureSmokeWorkspace(state);
  writeFileSync(state.statePath, JSON.stringify(state, null, 2), "utf8");
  writeFileSync(join(state.projectRoot, ".tmp", "full-smoke-current.json"), JSON.stringify(state, null, 2), "utf8");
}

export function loadSmokeState(projectRoot = process.cwd()): SmokeState {
  const path = process.env.CONFSCOPE_SMOKE_STATE || join(projectRoot, ".tmp", "full-smoke-current.json");
  return JSON.parse(readFileSync(path, "utf8")) as SmokeState;
}

function nacosEndpoint(role: SmokeNacosEndpoint["role"], hostPort: number): SmokeNacosEndpoint {
  return {
    role,
    containerName: `confscope-smoke-nacos-${role}`,
    hostPort,
    baseUrl: `http://127.0.0.1:${hostPort}/nacos`,
  };
}
