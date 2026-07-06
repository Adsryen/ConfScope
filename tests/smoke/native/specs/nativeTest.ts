import { test as base, expect } from "@playwright/test";
import {
  findFreeLoopbackPort,
  killNativeSmokeProcess,
  launchNativeSmokeApp,
  resolveNativeSmokeExecutable,
  type NativeSmokeProcess,
} from "../../env/nativeApp";
import { recordCase } from "../../env/report";
import { loadSmokeState, type SmokeState } from "../../env/workspace";

interface NativeEvalResponse {
  ok: boolean;
  value: unknown;
}

export interface NativeControlClient {
  eval<T>(script: string, timeoutMs?: number): Promise<T>;
}

interface NativeFixtures {
  smoke: SmokeState;
  native: NativeControlClient;
}

export const test = base.extend<NativeFixtures>({
  smoke: async ({}, use) => {
    await use(loadSmokeState());
  },
  native: async ({ smoke }, use) => {
    if (process.platform !== "win32") {
      throw new Error("Native Wails WebView smoke is Windows-only.");
    }
    const controlPort = await findFreeLoopbackPort();
    const executablePath = resolveNativeSmokeExecutable(smoke.projectRoot);
    const nativeProcess = await launchNativeSmokeApp({ workspace: smoke, executablePath, controlPort });
    try {
      await waitForNativeControl(controlPort, nativeProcess);
      await use(createNativeControlClient(controlPort));
    } finally {
      killNativeSmokeProcess(nativeProcess);
    }
  },
});

export { expect };

export function pass(smoke: SmokeState, id: string, area: string, evidence: string, notes = ""): void {
  recordCase(smoke, { id, area, status: "PASS", evidence, notes });
}

function createNativeControlClient(controlPort: number): NativeControlClient {
  const baseURL = `http://127.0.0.1:${controlPort}`;
  return {
    async eval<T>(script: string, timeoutMs = 30_000): Promise<T> {
      const response = await fetch(`${baseURL}/eval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script, timeoutMs }),
      });
      if (!response.ok) {
        throw new Error(`Native WebView eval failed (${response.status}): ${await response.text()}`);
      }
      const payload = (await response.json()) as NativeEvalResponse;
      if (!payload.ok) {
        throw new Error("Native WebView eval returned ok=false");
      }
      return payload.value as T;
    },
  };
}

async function waitForNativeControl(controlPort: number, nativeProcess: NativeSmokeProcess): Promise<void> {
  const endpoint = `http://127.0.0.1:${controlPort}/health`;
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < 60_000) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = String(error);
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for native smoke control at ${endpoint}; pid=${nativeProcess.pid}; lastError=${lastError}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
