/**
 * 第5步「晋级到生产」面板的可见性诊断（用户真机报障：窗口放大后底部冒出这个区块，
 * 而且滚不动、看不全）。本文件只测量不改产品代码：产出几何读数 + 截图，作为派工依据。
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

async function runToExecuted(page: Page, retest: RetestState, tag: string, width: number, height: number) {
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
  await expect(page.locator(".apply-promote-panel")).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(600);

  // 先按用户看到的原样拍一张（后面会程序化滚动，拍晚了就不是现场了）
  await page.screenshot({ path: `results/promote-scroll-${tag}-asshown.png`, fullPage: false });
  const asShownClipped = await page.evaluate(() => {
    const panel = document.querySelector(".apply-promote-panel") as HTMLElement | null;
    const column = document.querySelector(".apply-main-column") as HTMLElement | null;
    if (!panel || !column) return { error: "missing" };
    return { clippedBy: Math.round(panel.getBoundingClientRect().bottom - column.getBoundingClientRect().bottom) };
  });
  // 键盘可达性：浏览器原生 focus 会把 overflow:hidden 容器里的元素滚动进视野，鼠标滚轮不会。
  const promoteBtn = page.locator(".apply-promote-actions button", { hasText: "按本次验证晋级" }).first();
  await promoteBtn.focus().catch(() => undefined);
  await page.waitForTimeout(200);
  const afterFocus = await page.evaluate(() => {
    const panel = document.querySelector(".apply-promote-panel") as HTMLElement | null;
    const column = document.querySelector(".apply-main-column") as HTMLElement | null;
    if (!panel || !column) return { error: "missing" };
    return {
      clippedByAfterFocusScroll: Math.round(panel.getBoundingClientRect().bottom - column.getBoundingClientRect().bottom),
      columnScrollTop: column.scrollTop,
      wheelScrollsColumn: getComputedStyle(column).overflowY,
    };
  });
  console.log(`[PROMOTE-SCROLL][${tag}] 原样超出=${JSON.stringify(asShownClipped)} 键盘聚焦后=${JSON.stringify(afterFocus)}`);
  const reading = await page.evaluate(() => {
    const panel = document.querySelector(".apply-promote-panel") as HTMLElement | null;
    const column = document.querySelector(".apply-main-column") as HTMLElement | null;
    const confirm = document.querySelector(".apply-confirmation") as HTMLElement | null;
    if (!panel || !column) return { error: "panel/column missing" };
    const rectOf = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
    };
    const scrollables: Array<Record<string, unknown>> = [];
    let node: HTMLElement | null = panel;
    while (node && node !== document.documentElement) {
      const cs = getComputedStyle(node);
      const interesting = /(auto|scroll|hidden)/.test(cs.overflowY) || /(apply|page|main)/.test(node.className || "");
      if (interesting) {
        scrollables.push({
          cls: String(node.className).slice(0, 52),
          overflowY: cs.overflowY,
          scrollH: node.scrollHeight,
          clientH: node.clientHeight,
          overflowing: node.scrollHeight > node.clientHeight + 1,
        });
      }
      node = node.parentElement;
    }
    const clippedBy = () => Math.round(panel.getBoundingClientRect().bottom - column.getBoundingClientRect().bottom);
    const before = clippedBy();
    // 把这个祖先链上所有可能的滚动位都拉到底，看面板底部能否进入可视列
    const candidates = [column, confirm, panel, document.scrollingElement as HTMLElement, document.body].filter((el): el is HTMLElement =>
      Boolean(el)
    );
    for (const el of candidates) el.scrollTop = el.scrollHeight;
    const after = clippedBy();
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      panel: rectOf(panel),
      confirmation: confirm ? rectOf(confirm) : null,
      column: { ...rectOf(column), clientH: column.clientHeight, scrollH: column.scrollHeight },
      clippedBefore: before,
      clippedAfterScrollToBottom: after,
      reachable: after <= 0,
      scrollables,
    };
  });
  console.log(`[PROMOTE-SCROLL][${tag}] ${JSON.stringify(reading, null, 2)}`);
  await page.screenshot({ path: `results/promote-scroll-${tag}.png`, fullPage: false });
  return reading as Record<string, unknown>;
}

test("T-PROMOTE-SCROLL-A 小窗 1280x720：执行完成后晋级面板的几何", async ({ page, retest }) => {
  await republishRetestData();
  await runToExecuted(page, retest, "1280x720", 1280, 720);
});

test("T-PROMOTE-SCROLL-B 放大窗 1680x1050：执行完成后晋级面板的几何", async ({ page, retest }) => {
  await republishRetestData();
  try {
    await runToExecuted(page, retest, "1680x1050", 1680, 1050);
  } finally {
    await republishRetestData();
  }
});
