import { defineConfig, devices } from "@playwright/test";
import { loadRetestState } from "./state";

const state = loadRetestState();

export default defineConfig({
  testDir: "./specs",
  timeout: 480_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: state.webServerUrl,
    // 动作/导航必须有显式上限。默认 actionTimeout=0 意味着「等不到可点」会一路等到 test 超时
    // 才红（轮43 实测：T-PG-02 的选择器命中了被保活隐藏的浏览页按钮，白烧 480s 才知道原因）。
    // 30s 足够覆盖真实的等待，又能把「看不见/被遮挡」这类问题变成快速可诊断的失败。
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
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
