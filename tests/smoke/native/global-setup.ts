import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalSnapshotFixtures } from "../env/snapshots";
import { cleanupSmokeContainers, createSmokeNetwork, dockerAvailable, startNacosContainer, startWebDAVContainer, waitForWebDAV } from "../env/docker";
import { cleanupNacosSeed, seedNacos, waitForNacos } from "../env/nacos";
import { initializeReports, recordCase } from "../env/report";
import { nativeSmokeBuildArgs, pnpmExecutable, resolveNativeSmokeExecutable } from "../env/nativeApp";
import { createSmokeWorkspace, ensureSmokeWorkspace, writeSmokeStateFile, type SmokeState } from "../env/workspace";

async function globalSetup(): Promise<void> {
  const workspace = ensureSmokeWorkspace(createSmokeWorkspace());
  const fixtures = createLocalSnapshotFixtures({ rootDir: workspace.localSnapshotsDir, runId: workspace.runId });
  const state: SmokeState = { ...workspace, fixtures };
  writeSmokeStateFile(state);
  process.env.CONFSCOPE_SMOKE_STATE = state.statePath;
  process.env.USERPROFILE = state.homeDir;
  process.env.HOME = state.homeDir;
  initializeReports(state);

  if (process.platform !== "win32") {
    recordCase(state, {
      id: "GAP-NATIVE-WINDOWS-ENV",
      area: "Native Desktop",
      status: "NOT_RUN_ENV_MISSING",
      evidence: `process.platform=${process.platform}`,
      notes: "First native Wails WebView smoke is Windows WebView2 only.",
    });
    return;
  }

  if (!dockerAvailable()) {
    recordCase(state, {
      id: "ENV-DOCKER",
      area: "Environment",
      status: "FAIL_TEST_SETUP",
      evidence: "docker version failed",
      notes: "Docker is required for native real-environment smoke.",
    });
    throw new Error("Docker is not available");
  }

  cleanupSmokeContainers();
  createSmokeNetwork();
  for (const endpoint of [state.nacos.dev, state.nacos.sandbox, state.nacos.prod]) {
    startNacosContainer(endpoint);
  }
  startWebDAVContainer(state.webdav, state.webdavDir);
  for (const endpoint of [state.nacos.dev, state.nacos.sandbox, state.nacos.prod]) {
    await waitForNacos(endpoint);
    await cleanupNacosSeed(endpoint);
    await seedNacos(endpoint);
  }
  await waitForWebDAV(state.webdav);
  recordCase(state, {
    id: "ENV-NACOS-01",
    area: "Environment",
    status: "PASS",
    evidence: "Docker Nacos dev/sandbox/prod started and seeded",
    notes: `${state.nacos.dev.baseUrl}, ${state.nacos.sandbox.baseUrl}, ${state.nacos.prod.baseUrl}`,
  });
  recordCase(state, {
    id: "ENV-WEBDAV-01",
    area: "Environment",
    status: "PASS",
    evidence: `Docker WebDAV started at ${state.webdav.baseUrl}`,
    notes: `Storage mounted at ${state.webdavDir}`,
  });

  buildNativeWailsApp(state);
}

function buildNativeWailsApp(state: SmokeState): void {
  const buildLogPath = join(state.reportsDir, "native-build.log");
  mkdirSync(state.reportsDir, { recursive: true });
  writeFileSync(buildLogPath, `[${new Date().toISOString()}] pnpm ${nativeSmokeBuildArgs().join(" ")}\n`, {
    encoding: "utf8",
    flag: "a",
  });
  const output = execFileSync(pnpmExecutable(), nativeSmokeBuildArgs(), {
    cwd: state.projectRoot,
    env: { ...process.env, USERPROFILE: state.homeDir, HOME: state.homeDir },
    encoding: "utf8",
    shell: true,
  });
  writeFileSync(buildLogPath, output, { encoding: "utf8", flag: "a" });
  const executablePath = resolveNativeSmokeExecutable(state.projectRoot);
  recordCase(state, {
    id: "ENV-NATIVE-BUILD-01",
    area: "Environment",
    status: "PASS",
    evidence: executablePath,
    notes: "Built with pnpm wails build -clean -debug -devtools -o ConfScope-smoke-native.",
  });
}

export default globalSetup;
