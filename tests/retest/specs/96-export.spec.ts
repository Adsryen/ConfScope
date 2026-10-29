import { test, expect } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { dismissStartupDialog } from "./ui";
import { setRetestConfigSourceExportDir, setRetestConfigSourceExportFailure } from "../bridge/retestBinding";
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
      // orig 就是 URL.createObjectURL.bind(URL)，签名收 Blob|MediaSource：
      // 上一版那串 `blob as unknown as object as typeof URL` 是把形参当成了构造器类型，编译器第一次进来就判红。
      const url = orig(blob);
      void (async () => {
        const text = await (blob as unknown as Blob).text();
        try {
          const parsed = JSON.parse(text) as { metadata?: { total: number }; items?: Array<{ dataId?: string }> };
          const items = parsed?.items ?? (Array.isArray(parsed) ? (parsed as Array<{ dataId?: string }>) : null);
          if (!items) throw new Error("no items");
          // 保留缺 dataId 的槽位（空串），否则条数与列表对不上，下面的长度断言会假绿
          w.__captured = items.map((x) => x.dataId ?? "");
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
  const handle = await page.waitForFunction(
    () => {
      const w = window as unknown as { __captured?: string[] };
      return w.__captured ?? null;
    },
    undefined,
    { timeout: 15_000 }
  );
  // waitForFunction 给的是 JSHandle，必须 jsonValue 才是页面里的值
  return (await handle.jsonValue()) as string[];
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
  const captured = await readCapturedDataIds(page);
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

// A10-b「导出源文件到目录」拆成两条真实分支（上一版把它写成「浏览器环境不可用 ⇒ 优雅报错」，
// 但 retest 桥早就替身了目录选择与写盘，那个前提在真机批里不成立，于是永远走成功分支、断不到错误）。
// 现在钉的是产品自己的两条承诺：
//   ① 用户在原生目录选择器里取消 → 全程静默（不报错、不建任务、不写操作历史、不产生下载）；
//   ② 目录选好了但写盘失败 → 优雅报错并四处留痕（toast + 消息中心 error + 任务中心失败终态 + 操作历史 failure）。
test("A10-b 导出源文件到目录: 取消目录选择全程静默", async ({ page }) => {
  await boot(page);
  await nav(page, "配置浏览");
  await expect(page.locator(".browser-item-id").first()).toBeVisible({ timeout: 30_000 });

  setRetestConfigSourceExportDir(""); // 目录选择器返回空串 = 用户取消
  const downloadSeen = page.waitForEvent("download", { timeout: 8_000 }).then(
    () => true,
    () => false
  );

  await openMessageCenter(page);
  const msgCountBefore = await page.locator(".message-panel .message-item").count();
  await page.mouse.move(4, 4); // 收起浮层
  await page.waitForTimeout(200);

  await page.getByRole("button", { name: "导出源文件到目录" }).click();
  await page.waitForTimeout(1_500);

  // 一条提示都不该有（含错误提示）
  await expect(page.locator(".toaster .toast")).toHaveCount(0);
  // 消息中心一条都不多
  await openMessageCenter(page);
  expect(await page.locator(".message-panel .message-item").count(), "取消导出不该产生任何消息").toBe(msgCountBefore);
  await page.mouse.move(4, 4);
  await page.waitForTimeout(200);
  // 任务中心没有导出任务
  await nav(page, "任务中心");
  await expect(page.locator(".task-center .task-item").filter({ hasText: "导出源文件目录" })).toHaveCount(0);
  // 操作历史没有这次导出（取消不算一次操作）
  await nav(page, "操作历史");
  await expect(page.locator(".op-history-item").filter({ has: page.locator(".history-type.export") })).toHaveCount(0);
  // 没有下载，页面也没崩
  expect(await downloadSeen).toBe(false);
  await nav(page, "配置浏览");
  await expect(page.locator(".browser-item-id").first()).toBeVisible({ timeout: 5_000 });
  await page.screenshot({ path: "results/a10-export-dir-cancel.png", fullPage: true });
});

test("A10-b2 导出源文件到目录: 写盘失败优雅报错并四处留痕", async ({ page }) => {
  await boot(page);
  await nav(page, "配置浏览");
  await expect(page.locator(".browser-item-id").first()).toBeVisible({ timeout: 30_000 });

  const DISK_FULL = "写入文件失败: no space left on device";
  setRetestConfigSourceExportDir("/tmp/confscope-retest-exports");
  setRetestConfigSourceExportFailure(DISK_FULL);

  await page.getByRole("button", { name: "导出源文件到目录" }).click();

  // 优雅报错：toast 是 error 档、点名这次操作（产品口径把完整原因收进消息中心，不塞进浮层）
  const errToast = page.locator(".toaster .toast-error", { hasText: /导出源文件到目录/ }).first();
  await expect(errToast).toBeVisible({ timeout: 10_000 });

  // 消息中心出现 error 条目
  await openMessageCenter(page);
  const msg = page.locator(".message-item.message-error").filter({ hasText: "导出源文件到目录" }).first();
  await expect(msg).toBeVisible({ timeout: 10_000 });
  expect(await msg.locator(".message-text").innerText(), "消息中心必须把失败原因如实转出来").toContain(DISK_FULL);
  await page.mouse.move(4, 4);

  // 任务中心：这条导出任务以失败终态收场
  await nav(page, "任务中心");
  const failedTask = page.locator(".task-center .task-item").filter({ hasText: "导出源文件目录" }).first();
  await expect(failedTask).toBeVisible({ timeout: 20_000 });
  await expect(failedTask.locator(".task-status-failed")).toBeVisible({ timeout: 10_000 });

  // 操作历史：失败也要留痕，且明确标为失败（回滚类入口对它不该出现）
  await nav(page, "操作历史");
  const failedRecord = page
    .locator(".op-history-item")
    .filter({ has: page.locator(".history-type.export") })
    .filter({ has: page.locator(".history-result.failure") })
    .first();
  await expect(failedRecord).toBeVisible({ timeout: 15_000 });

  // 页面未崩溃：回到浏览页列表仍在
  await nav(page, "配置浏览");
  await expect(page.locator(".browser-item-id").first()).toBeVisible({ timeout: 5_000 });
  await page.screenshot({ path: "results/a10-export-dir-failure.png", fullPage: true });
});
