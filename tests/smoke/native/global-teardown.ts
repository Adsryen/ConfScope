import { cleanupSmokeContainers } from "../env/docker";
import { cleanupNacosSeed } from "../env/nacos";
import { recordCase, writeFinalReport } from "../env/report";
import { stopRecordedNativeSmokeProcess } from "../env/nativeApp";
import { loadSmokeState, type SmokeState } from "../env/workspace";

async function globalTeardown(): Promise<void> {
  const state = loadSmokeState();
  stopRecordedNativeSmokeProcess(state);
  if (process.platform === "win32") {
    for (const endpoint of [state.nacos.dev, state.nacos.sandbox, state.nacos.prod]) {
      await cleanupNacosSeed(endpoint);
    }
  }
  if (process.env.CONFSCOPE_SMOKE_KEEP !== "1" && process.platform === "win32") {
    cleanupSmokeContainers();
    recordCase(state, {
      id: "ENV-CLEANUP-01",
      area: "Environment",
      status: "PASS",
      evidence: "Smoke containers removed",
      notes: "Set CONFSCOPE_SMOKE_KEEP=1 to retain containers for debugging.",
    });
  } else if (process.env.CONFSCOPE_SMOKE_KEEP === "1") {
    recordCase(state, {
      id: "ENV-CLEANUP-01",
      area: "Environment",
      status: "NOT_RUN_RISK_ACCEPTANCE",
      evidence: "CONFSCOPE_SMOKE_KEEP=1",
      notes: "Containers retained for debugging.",
    });
  }
  recordKnownNativeGaps(state);
  writeFinalReport(state);
}

export function recordKnownNativeGaps(state: SmokeState): void {
  for (const item of [
    ["GAP-NATIVE-MACOS", "Native Desktop", "macOS native automation is not covered by the Windows-first smoke."],
    ["GAP-NATIVE-LINUX", "Native Desktop", "Linux native automation is not covered by the Windows-first smoke."],
    [
      "GAP-NATIVE-APOLLO",
      "Apollo provider",
      "Apollo is covered by Vite + Docker OpenAPI smoke; native Wails form/browser/diff/audit automation is not covered yet.",
    ],
    [
      "GAP-NATIVE-APPDATA-WEBDAV-LIST",
      "App Data Backup",
      "Native smoke verifies WebDAV upload/download/restore through real Wails bindings; explicit refresh/list assertion remains covered outside native automation.",
    ],
  ] as const) {
    recordCase(state, {
      id: item[0],
      area: item[1],
      status: "NOT_RUN_AUTOMATION_GAP",
      evidence: "Windows-first native smoke scope",
      notes: item[2],
    });
  }
  recordCase(state, {
    id: "GAP-OS-DIALOGS",
    area: "Native Desktop",
    status: "NOT_RUN_RISK_ACCEPTANCE",
    evidence: "OS modal / destructive workflow",
    notes: "Directory picker, install/restart, and external-open workflows remain manual spot checks.",
  });
}

export default globalTeardown;
