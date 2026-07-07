import { join } from "node:path";
import { createLocalSnapshotFixtures } from "./env/snapshots";
import {
  cleanupSmokeContainers,
  createSmokeNetwork,
  dockerAvailable,
  startApolloContainer,
  startNacosContainer,
  startWebDAVContainer,
  waitForWebDAV,
} from "./env/docker";
import { waitForApollo } from "./env/apollo";
import { cleanupNacosSeed, seedNacos, waitForNacos } from "./env/nacos";
import { initializeReports, recordCase } from "./env/report";
import { smokeWebServerUrl, startSmokeWebServer } from "./env/webServer";
import { createSmokeWorkspace, ensureSmokeWorkspace, writeSmokeStateFile, type SmokeState } from "./env/workspace";

async function globalSetup(): Promise<void> {
  const workspace = ensureSmokeWorkspace(createSmokeWorkspace());
  const fixtures = createLocalSnapshotFixtures({ rootDir: workspace.localSnapshotsDir, runId: workspace.runId });
  const state: SmokeState = { ...workspace, fixtures };
  writeSmokeStateFile(state);
  process.env.CONFSCOPE_SMOKE_STATE = state.statePath;
  process.env.USERPROFILE = state.homeDir;
  process.env.HOME = state.homeDir;
  initializeReports(state);

  if (!dockerAvailable()) {
    recordCase(state, {
      id: "ENV-DOCKER",
      area: "Environment",
      status: "FAIL_TEST_SETUP",
      evidence: "docker version failed",
      notes: "Docker is required for real-environment smoke.",
    });
    throw new Error("Docker is not available");
  }

  cleanupSmokeContainers();
  createSmokeNetwork();
  for (const endpoint of [state.nacos.dev, state.nacos.sandbox, state.nacos.prod]) {
    startNacosContainer(endpoint);
  }
  startApolloContainer(state.apollo, join(state.projectRoot, "tests", "smoke", "fixtures", "apollo", "server.mjs"));
  startWebDAVContainer(state.webdav, state.webdavDir);
  for (const endpoint of [state.nacos.dev, state.nacos.sandbox, state.nacos.prod]) {
    await waitForNacos(endpoint);
    await cleanupNacosSeed(endpoint);
    await seedNacos(endpoint);
  }
  await waitForApollo(state.apollo);
  await waitForWebDAV(state.webdav);
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
    id: "ENV-WEBDAV-01",
    area: "Environment",
    status: "PASS",
    evidence: `Docker WebDAV started at ${state.webdav.baseUrl}`,
    notes: `Storage mounted at ${state.webdavDir}`,
  });
  await startSmokeWebServer(state);
  recordCase(state, {
    id: "ENV-WEB-01",
    area: "Environment",
    status: "PASS",
    evidence: `Vite smoke server started at ${smokeWebServerUrl()}`,
    notes: "Started by tests/smoke/global-setup.ts and stopped by global teardown.",
  });
}

export default globalSetup;
