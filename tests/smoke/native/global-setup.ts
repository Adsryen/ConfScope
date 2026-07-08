import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalSnapshotFixtures } from "../env/snapshots";
import {
  cleanupSmokeContainers,
  createSmokeNetwork,
  dockerAvailable,
  startApolloContainer,
  startConsulContainer,
  startNacosContainer,
  startSSHContainer,
  startWebDAVContainer,
  waitForSSH,
  waitForWebDAV,
} from "../env/docker";
import { waitForApollo } from "../env/apollo";
import { seedConsul, waitForConsul } from "../env/consul";
import { cleanupNacosSeed, seedNacos, waitForNacos } from "../env/nacos";
import { initializeReports, recordCase } from "../env/report";
import { nativeSmokeBuildArgs, pnpmExecutable, resolveNativeSmokeExecutable } from "../env/nativeApp";
import {
  createSmokeWorkspace,
  ensureSmokeWorkspace,
  writeSmokeStateFile,
  type SmokeApolloEndpoint,
  type SmokeConsulEndpoint,
  type SmokeNacosEndpoint,
  type SmokeSSHEndpoint,
  type SmokeState,
  type SmokeWebDAVEndpoint,
} from "../env/workspace";

export interface NativeDockerEnvironmentDeps {
  cleanupSmokeContainers: () => void;
  createSmokeNetwork: () => void;
  startNacosContainer: (endpoint: SmokeNacosEndpoint) => void;
  startApolloContainer: (endpoint: SmokeApolloEndpoint, serverFile: string) => void;
  startConsulContainer: (endpoint: SmokeConsulEndpoint) => void;
  startSSHContainer: (endpoint: SmokeSSHEndpoint, configFile: string) => void;
  startWebDAVContainer: (endpoint: SmokeWebDAVEndpoint, dataDir: string) => void;
  waitForNacos: (endpoint: SmokeNacosEndpoint) => Promise<void>;
  cleanupNacosSeed: (endpoint: SmokeNacosEndpoint) => Promise<void>;
  seedNacos: (endpoint: SmokeNacosEndpoint) => Promise<void>;
  waitForApollo: (endpoint: SmokeApolloEndpoint) => Promise<void>;
  seedConsul: (endpoint: SmokeConsulEndpoint) => Promise<void>;
  waitForConsul: (endpoint: SmokeConsulEndpoint) => Promise<void>;
  waitForSSH: (endpoint: SmokeSSHEndpoint) => Promise<void>;
  waitForWebDAV: (endpoint: SmokeWebDAVEndpoint) => Promise<void>;
}

const defaultDockerDeps: NativeDockerEnvironmentDeps = {
  cleanupSmokeContainers,
  createSmokeNetwork,
  startNacosContainer,
  startApolloContainer,
  startConsulContainer,
  startSSHContainer,
  startWebDAVContainer,
  waitForNacos,
  cleanupNacosSeed,
  seedNacos,
  waitForApollo,
  seedConsul,
  waitForConsul,
  waitForSSH,
  waitForWebDAV,
};

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

  await startNativeDockerEnvironment(state);

  buildNativeWailsApp(state);
}

export async function startNativeDockerEnvironment(state: SmokeState, deps: NativeDockerEnvironmentDeps = defaultDockerDeps): Promise<void> {
  deps.cleanupSmokeContainers();
  deps.createSmokeNetwork();
  for (const endpoint of [state.nacos.dev, state.nacos.sandbox, state.nacos.prod]) {
    deps.startNacosContainer(endpoint);
  }
  deps.startApolloContainer(state.apollo, join(state.projectRoot, "tests", "smoke", "fixtures", "apollo", "server.mjs"));
  deps.startConsulContainer(state.consul);
  deps.startSSHContainer(state.ssh, prepareSSHConfigFile(state));
  deps.startWebDAVContainer(state.webdav, state.webdavDir);
  for (const endpoint of [state.nacos.dev, state.nacos.sandbox, state.nacos.prod]) {
    await deps.waitForNacos(endpoint);
    await deps.cleanupNacosSeed(endpoint);
    await deps.seedNacos(endpoint);
  }
  await deps.waitForApollo(state.apollo);
  await deps.seedConsul(state.consul);
  await deps.waitForConsul(state.consul);
  await deps.waitForSSH(state.ssh);
  await deps.waitForWebDAV(state.webdav);
  recordCase(state, {
    id: "ENV-NACOS-01",
    area: "Environment",
    status: "PASS",
    evidence: "Docker Nacos dev/sandbox/prod started and seeded",
    notes: `${state.nacos.dev.baseUrl}, ${state.nacos.sandbox.baseUrl}, ${state.nacos.prod.baseUrl}`,
  });
  recordCase(state, {
    id: "ENV-APOLLO-01",
    area: "Environment",
    status: "PASS",
    evidence: "Docker Apollo-compatible OpenAPI fixture started and verified",
    notes: `${state.apollo.baseUrl} / ${state.apollo.env} / ${state.apollo.appId} / ${state.apollo.cluster} / ${state.apollo.namespaceName}`,
  });
  recordCase(state, {
    id: "ENV-CONSUL-01",
    area: "Environment",
    status: "PASS",
    evidence: "Docker Consul KV started and seeded",
    notes: `${state.consul.baseUrl} / ${state.consul.datacenter} / ${state.consul.keyPrefix}`,
  });
  recordCase(state, {
    id: "ENV-SSH-01",
    area: "Environment",
    status: "PASS",
    evidence: `Docker SSH server started at ${state.ssh.host}:${state.ssh.hostPort}`,
    notes: `${state.ssh.username}@${state.ssh.containerName}:2222`,
  });
  recordCase(state, {
    id: "ENV-WEBDAV-01",
    area: "Environment",
    status: "PASS",
    evidence: `Docker WebDAV started at ${state.webdav.baseUrl}`,
    notes: `Storage mounted at ${state.webdavDir}`,
  });
}

function prepareSSHConfigFile(state: SmokeState): string {
  const source = join(state.projectRoot, "tests", "smoke", "fixtures", "ssh", "sshd_config");
  const targetDir = join(state.rootDir, "ssh");
  mkdirSync(targetDir, { recursive: true });
  const target = join(targetDir, "sshd_config");
  copyFileSync(source, target);
  return target;
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
