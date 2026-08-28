import { defineConfig, devices } from "@playwright/test";
import { loadRetestState } from "./state";

const state = loadRetestState();

export default defineConfig({
  testDir: "./specs",
  timeout: 480_000,
  testTimeout: undefined,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: state.webServerUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    permissions: ["clipboard-read", "clipboard-write"],
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
