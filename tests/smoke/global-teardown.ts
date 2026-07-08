import { cleanupSmokeContainers } from "./env/docker";
import { cleanupConsulSeed } from "./env/consul";
import { cleanupNacosSeed } from "./env/nacos";
import { recordCase, writeFinalReport } from "./env/report";
import { stopSmokeWebServer } from "./env/webServer";
import { loadSmokeState } from "./env/workspace";

async function globalTeardown(): Promise<void> {
  const state = loadSmokeState();
  stopSmokeWebServer(state);
  for (const endpoint of [state.nacos.dev, state.nacos.sandbox, state.nacos.prod]) {
    await cleanupNacosSeed(endpoint);
  }
  await cleanupConsulSeed(state.consul);
  if (process.env.CONFSCOPE_SMOKE_KEEP !== "1") {
    cleanupSmokeContainers();
    recordCase(state, {
      id: "ENV-CLEANUP-01",
      area: "Environment",
      status: "PASS",
      evidence: "Smoke containers removed",
      notes: "Set CONFSCOPE_SMOKE_KEEP=1 to retain containers for debugging.",
    });
  } else {
    recordCase(state, {
      id: "ENV-CLEANUP-01",
      area: "Environment",
      status: "NOT_RUN_RISK_ACCEPTANCE",
      evidence: "CONFSCOPE_SMOKE_KEEP=1",
      notes: "Containers retained for debugging.",
    });
  }
  recordKnownGaps(state);
  writeFinalReport(state);
}

export function recordKnownGaps(_state: ReturnType<typeof loadSmokeState>): void {}

export default globalTeardown;
