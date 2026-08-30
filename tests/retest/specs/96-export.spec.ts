import { test, expect } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { dismissStartupDialog } from "./ui";
import { loadRetestState } from "../state";

const state = loadRetestState();

/** 标准启动：装桥 + 播种 + 进首页关启动弹窗。 */
async function boot(page: import("@playwright/test").Page) {
  await installRetestBridge(page, state);
  await republishRetestData();
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
}

async function nav(page: import("@playwright/test").Page, label: string) {
  await page.locator(".side-nav-item", { hasText: label }).first().click();
}

/** 打开消息中心面板（侧边栏底部按钮悬停）。 */
async function openMessageCenter(page: import("@playwright/test").Page) {
  const btn = page.locator(".message-center-btn").first();
  await btn.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
  await btn.hover();
  await expect(page.locator(".message-panel").first()).toBeVisible({ timeout: 10_000 });
}

/**
 * 在页面内打桩 URL.createObjectURL：导出时 downloadFile 会创建 blob 并挂到 a[download] 上，
 * 打桩后把 blob 的 dataId 列表回传到 window，便于断言下载内容与当前列表一致。
 */
async function hookBlobCapture(page: import("@playwright/test").Page, itemCount: number) {
  await page.evaluate((n) => {
    const w = window as unknown as { __captured?: string[] };
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob: Blob) => {
      const url = orig(blob as unknown as object as typeof URL);
      void (async () => {
        const text = await (blob as unknown as Blob).text();
        try {
          const parsed = JSON.parse(text) as { metadata?: { total: number }; items?: Array<{ dataId?: string }> };
          const items = parsed?.items ?? (Array.isArray(parsed) ? (parsed as Array<{ dataId?: string }>) : null);
          if (!items) throw new Error("no items");
          w.__captured = items.map((x) => x.dataId);
          (window as unknown as { __capturedTotal?: number }).__capturedTotal = parsed?.metadata?.total ?? n;
        } catch {
          w.__captured = [text.slice(0, 60)];
        }
      })();
      return url as string;
    };
  }, itemCount);
}

async function readCapturedDataIds(page: import("@playwright/test").Page): Promise<string[]> {
  return page.waitForFunction(
    () => {
      const w = window as unknown as { __captured?: string[] };
      return w.__captured ?? null;
    },
    undefined,
    { timeout: 15_000 }
  );
  // waitForFunction 返回 JSHandle，取 jsonValue
}

// A10-a: 浏览页「导出当前列表」→ 真实 download 事件（configs_*.json）
//       + 下载内容与当前列表 dataId 一致 + toast 成功 + 任务中心 export 任务成功终态
test("A10 导出当前列表: 产生真实 json 下载且任务中心出现成功任务", async ({ page }) => {
  await boot(page);
  await nav(page, "配置浏览");
  await expect(page.locator(".browser-item-id").first()).toBeVisible({ timeout: 30_000 });
  const itemCount = await page.locator(".browser-item-id").count();
  expect(itemCount).toBeGreaterThan(0);

  const visibleDataIds = await page
    .locator(".browser-item-id")
    .evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? ""));

  await hookBlobCapture(page, itemCount);

  const downloadPromise = page.waitForEvent("download", { timeout: 20_000 });
  await page.getByRole("button", { name: "导出当前列表" }).click();

  // 真实下载事件，文件名 configs_<ts>.json
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^configs_\d+\.json$/);

  // 下载内容（blob）为合法 JSON，dataId 集合与当前列表一致
  const handle = await page.waitForFunction(
    () => {
      const w = window as unknown as { __captured?: string[] };
      return w.__captured ?? null;
    },
    undefined,
    { timeout: 15_000 }
  );
  const captured = (await handle.jsonValue()) as string[];
  expect(Array.isArray(captured)).toBeTruthy();
  expect(captured.length).toBe(itemCount);
  for (const id of visibleDataIds) {
    if (id) expect(captured).toContain(id);
  }

  // 成功 toast：已导出配置列表
  await expect(page.locator(".toaster .toast-success", { hasText: "已导出配置列表" }).first()).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: "results/a10-export-list-toast.png", fullPage: true });

  // 任务中心出现 export 任务且为成功终态
  await nav(page, "任务中心");
  await expect(page.locator(".task-center .task-item", { hasText: "导出当前列表：" }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".task-center .task-item .task-status-success").first()).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: "results/a10-export-task.png", fullPage: true });
});

// A10-b: 浏览页「导出源文件到目录」→ 目录选择器为桌面端能力，浏览器环境不可用：
//       预期优雅报错（toast 含「导出源文件到目录」+ 消息中心 error 条目），不崩溃、无下载
test("A10 导出源文件到目录: 浏览器环境优雅报错并记录消息中心", async ({ page }) => {
  await boot(page);
  await nav(page, "配置浏览");
  await expect(page.locator(".browser-item-id").first()).toBeVisible({ timeout: 30_000 });

  const downloadSeen = page.waitForEvent("download", { timeout: 15_000 }).then(
    () => true,
    () => false
  );

  await page.getByRole("button", { name: "导出源文件到目录" }).click();

  // 优雅报错 toast（文案含来源标题「导出源文件到目录」）
  await expect(
    page.locator(".toaster .toast", { hasText: /导出源文件到目录/ }).first()
  ).toBeVisible({ timeout: 10_000 });

  // 消息中心出现对应错误条目
  await openMessageCenter(page);
  await expect(
    page.locator(".message-item").filter({ hasText: "导出源文件到目录" }).first()
  ).toBeVisible({ timeout: 10_000 });

  // 未产生下载
  expect(await downloadSeen).toBe(false);

  // 页面未崩溃：浏览列表仍在
  await expect(page.locator(".browser-item-id").first()).toBeVisible({ timeout: 5_000 });
  await page.screenshot({ path: "results/a10-export-dir-graceful.png", fullPage: true });
});
