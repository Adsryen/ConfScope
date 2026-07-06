import { cleanupSmokeContainers } from "./env/docker";
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

function recordKnownGaps(state: ReturnType<typeof loadSmokeState>): void {
  for (const item of [
    ["GAP-APOLLO", "Apollo provider", "Apollo provider is documented as planned, not implemented."],
    ["GAP-CONSUL", "Consul provider", "Consul provider is documented as planned, not implemented."],
    ["GAP-WEBDAV", "WebDAV backup", "WebDAV backup/restore is documented as planned, not implemented."],
    ["GAP-NATIVE-WAILS", "Native desktop automation", "This first round uses Vite + Playwright + Wails bridge, not native WebView automation."],
  ] as const) {
    recordCase(state, { id: item[0], area: item[1], status: "NOT_RUN_UNIMPLEMENTED", evidence: "docs/todo and current code", notes: item[2] });
  }
}

export default globalTeardown;
