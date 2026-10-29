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
  // 起批前先抢「同一套 nacos 只允许一批真机」的互斥锁，收尾释放（r129 事故后新增）。
  // 抢不到锁时 globalSetup 直接抛错，整批不跑——比跑完 26 分钟才发现数据被对面重播种好得多。
  globalSetup: "./globalSetup.ts",
  globalTeardown: "./globalTeardown.ts",
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
