import { defineConfig } from "@playwright/test";

/**
 * README 截图取证（轮58 后补）。
 *
 * 与 specs/ 分开两个原因：
 * 1. 这里不产生断言、只产生图片，混进永久回归会让 retest 的用例数失去意义；
 * 2. 输出落在 shots/out/，人工看过再拷进 .github/assets/——脚本绝不直接覆盖仓库里的跟踪文件。
 *
 * 只在显式运行时收集：
 *   pnpm dev:web                                   # vite :1420
 *   npx playwright test -c tests/retest/shots/playwright.config.ts
 */
export default defineConfig({
  testDir: "./",
  timeout: 600_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:1420",
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
