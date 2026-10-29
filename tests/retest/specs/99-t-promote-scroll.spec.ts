/**
 * 变更计划第5步整列可滚性判定（r113）。
 *
 * 用户真机报障：执行完成后第5步整列滚不动——面板与确认块被列底裁掉，看不全也滚不到。
 * r113 之后 .apply-main-column 是整列唯一滚动面（overflow-y: auto），
 * 本用例把流程走到「执行完成」再判读数：
 * ① 晋级入口缺席：.apply-promote-panel count 0、.apply-view 无「晋级」文案；
 * ② 整列的 overflowY 必须是 auto/scroll，scrollH/clientH 读数打进日志；
 * ③ 溢出时：在列上滚轮输入必须真的把 scrollTop 推起来，滚到底后
 *    最后一块（.apply-confirmation）的底边必须落进列底边以内；
 * ④ 不溢出时：最后一块直接可见（同一底边判据）。
 * 读数与截图落 results/，作为真机验证证据。
 */
import { test, expect } from "./retestTest";
import type { Page } from "@playwright/test";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import type { RetestState } from "../state";
import { navigate, dismissStartupDialog, setDiffSource } from "./ui";

const NS_A = "retest-dev";
const NS_B = "retest-qa";
const GROUP = "RETEST-PROD";

async function runToExecuted(page: Page, retest: RetestState, tag: string, width: number, height: number): Promise<void> {
  await installRetestBridge(page, retest);
  await page.setViewportSize({ width, height });
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置对比");
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP, dataId: "svc-gateway.yaml" });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP, dataId: "svc-gateway.yaml" });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".diff-panel")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "进入配置变更计划" }).last().click();
  await expect(page.locator(".apply-ledger, .apply-item-list").first()).toBeVisible({ timeout: 30_000 });
  const selectAllBtn = page.getByRole("button", { name: "全选" }).first();
  if (await selectAllBtn.count()) await selectAllBtn.click();
  await page.waitForTimeout(300);
  const dryRunBtn = page.locator("button", { hasText: "Dry-run 检查" }).last();
  await dryRunBtn.click({ force: true, timeout: 10_000 }).catch(() => undefined);
  if ((await page.locator(".apply-execution-notice").count()) === 0) {
    await dryRunBtn.evaluate((el) => (el as HTMLElement).click());
  }
  await expect(page.locator(".apply-execution-notice").filter({ hasText: "Dry-run 检查通过" })).toBeVisible({ timeout: 60_000 });
  await page.locator(".apply-confirm-check input").check();
  await page.waitForTimeout(300);
  const execBtn = page.locator("button", { hasText: "执行变更" }).last();
  await execBtn.click({ force: true, timeout: 10_000 }).catch(() => undefined);
  if ((await page.locator(".apply-task-progress").count()) === 0) {
    await execBtn.evaluate((el) => (el as HTMLElement).click());
  }
  await expect(page.locator(".apply-task-progress, .inline-error").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".apply-task-progress .task-status-success, .apply-task-progress .task-status-failed").first()).toBeVisible({
    timeout: 60_000,
  });
  await page.waitForTimeout(600);

  // 先按用户看到的原样拍一张（后面会滚动，拍晚了就不是现场了）
  await page.screenshot({ path: `results/step5-scroll-${tag}-asshown.png`, fullPage: false });

  // ① 晋级入口已撤：容器与文案都不许有
  expect(await page.locator(".apply-promote-panel").count(), "晋级面板已撤，画面不许再有这个容器").toBe(0);
  expect(await page.locator(".apply-view").getByText("晋级").count(), "第5步还留着晋级文案").toBe(0);

  // ② 整列是滚动面：overflowY 必须是 auto/scroll，读数打进日志
  const reading = await page.evaluate(() => {
    const column = document.querySelector(".apply-main-column") as HTMLElement | null;
    const confirm = document.querySelector(".apply-confirmation") as HTMLElement | null;
    if (!column) return null;
    const cs = getComputedStyle(column);
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      column: {
        overflowY: cs.overflowY,
        scrollH: column.scrollHeight,
        clientH: column.clientHeight,
        rectBottom: Math.round(column.getBoundingClientRect().bottom),
        scrollTop: column.scrollTop,
        overflowing: column.scrollHeight > column.clientHeight + 1,
      },
      lastBlock: confirm ? { bottom: Math.round(confirm.getBoundingClientRect().bottom) } : null,
    };
  });
  expect(reading, "读不到 .apply-main-column：计划页没在画面里").not.toBeNull();
  const column = reading!.column;
  console.log(`[STEP5-SCROLL][${tag}] ${JSON.stringify(reading)}`);
  expect(column.overflowY, "整列必须是滚动面：overflowY 得是 auto/scroll").toMatch(/^(auto|scroll)$/);

  if (column.overflowing) {
    // ③ 溢出：滚轮输入必须真的推得动这一列
    const box = await page.locator(".apply-main-column").boundingBox();
    expect(box, "读不到列的几何").not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(300);
    const moved = await page.evaluate(() => (document.querySelector(".apply-main-column") as HTMLElement).scrollTop);
    expect(moved, "滚轮输入后 scrollTop 没动：整列还是滚不动的").toBeGreaterThan(0);

    // 滚到底：最后一块的底边必须落进列底边以内（+1 容差是取整）
    await page.evaluate(() => {
      const col = document.querySelector(".apply-main-column") as HTMLElement;
      col.scrollTop = col.scrollHeight;
    });
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => {
      const col = document.querySelector(".apply-main-column") as HTMLElement;
      const confirm = document.querySelector(".apply-confirmation") as HTMLElement | null;
      return {
        confirmBottom: confirm ? Math.round(confirm.getBoundingClientRect().bottom) : null,
        columnBottom: Math.round(col.getBoundingClientRect().bottom),
      };
    });
    expect(after.confirmBottom, "读不到确认块的底边").not.toBeNull();
    expect(after.confirmBottom, "滚到底后确认块底部仍被列裁掉").toBeLessThanOrEqual(after.columnBottom + 1);
    console.log(`[STEP5-SCROLL][${tag}] 滚到底后 ${JSON.stringify(after)}`);
  } else {
    // ④ 不溢出：最后一块直接可见（同一底边判据）
    expect(reading!.lastBlock, "读不到确认块的底边").not.toBeNull();
    expect(reading!.lastBlock!.bottom, "不溢出时确认块本就该在视野里").toBeLessThanOrEqual(column.rectBottom + 1);
  }

  await page.screenshot({ path: `results/step5-scroll-${tag}.png`, fullPage: false });
}

test("T-STEP5-SCROLL-A 小窗 1280x720：第5步整列可滚、晋级入口缺席", async ({ page, retest }) => {
  await republishRetestData();
  await runToExecuted(page, retest, "1280x720", 1280, 720);
});

test("T-STEP5-SCROLL-B 放大窗 1680x1050：第5步整列可滚、晋级入口缺席", async ({ page, retest }) => {
  await republishRetestData();
  try {
    await runToExecuted(page, retest, "1680x1050", 1680, 1050);
  } finally {
    await republishRetestData();
  }
});
