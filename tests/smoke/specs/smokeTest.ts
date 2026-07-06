import { test as base } from "@playwright/test";
import { installWailsBridge } from "../bridge/installWailsBridge";
import { recordCase } from "../env/report";
import { loadSmokeState, type SmokeState } from "../env/workspace";

interface SmokeFixtures {
  smoke: SmokeState;
}

export const test = base.extend<SmokeFixtures>({
  smoke: async ({ page }, use) => {
    const state = loadSmokeState();
    await installWailsBridge(page, state);
    await use(state);
  },
});

export { expect } from "@playwright/test";

export function pass(smoke: SmokeState, id: string, area: string, evidence: string, notes = ""): void {
  recordCase(smoke, { id, area, status: "PASS", evidence, notes });
}
