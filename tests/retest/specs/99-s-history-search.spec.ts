// 轮40 真机永久回归：配置浏览的页面级正文搜索词必须跟随到「历史变更」tab 的原始内容视图。
//
// 缺陷长什么样（改前真机读数见 .trellis/tasks/10-19-ui-ux-40/prd.md 取证表）：同一个配置的三个内容视图里，
// 浏览 tab 与编辑 tab 都把词传给了代码视图，唯独 HistoryView 的 Props 里没有 searchTerm ——
// 内容搜索点开配置后切到「历史变更」看原始内容，标红 / 命中行底色 / 行号命中态 / 缩略图红条 /
// Ctrl+F 预填一起消失（正文 mark 从 1 掉到 0、预填从 `cycle` 掉成空串），而那块正文的 textContent
// 里确实含该词 ⇒ 不是「这版内容没这个词」，是词根本没传进去。
//
// 计数口径（本轮踩过的坑，别再犯）：必须只数 `.code-area` **内部**的 mark.search-hit。
// 全局 querySelectorAll 会把左侧列表项摘要里的高亮一起算进来（实测恒为 1），
// 用它断言「正文有标红」会假绿。
import { test, expect } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog } from "./ui";

const TERM = "enabled"; // svc-billing.yaml 里多处出现（mock / alipay / wechat 各自的 enabled）
const DATA_ID = "svc-billing.yaml";

/** 只数正文容器内部的命中：标红数、命中行数、当前命中数，以及正文里到底有没有这个词。 */
async function codeState(page: import("@playwright/test").Page) {
  return page.evaluate((term: string) => {
    const areas = Array.from(document.querySelectorAll(".code-area"));
    const inAreas = areas.reduce((acc, el) => acc + el.querySelectorAll("mark.search-hit").length, 0);
    const text = areas.map((el) => el.textContent ?? "").join("\n");
    return {
      areas: areas.length,
      marksInCode: inAreas,
      hitLines: document.querySelectorAll(".code-lines .code-line.is-hit").length,
      hitLineNos: document.querySelectorAll(".code-gutter .code-ln.is-hit").length,
      findInput: !!document.querySelector(".code-find-input"),
      findValue: (document.querySelector(".code-find-input") as HTMLInputElement | null)?.value ?? null,
      owner: document.querySelectorAll("[data-find-key-owner]").length,
      minimap: document.querySelectorAll(".code-minimap").length,
      textHasTerm: text.includes(term),
      textLen: text.length,
    };
  }, TERM);
}

/** 内容搜索模式 + 输入词 + 等列表摘要出现命中高亮。 */
async function searchByContent(page: import("@playwright/test").Page, term: string) {
  await page.locator(".browser-search-mode .btn", { hasText: "内容" }).first().click({ timeout: 15_000 });
  await page.locator(".browser-search .search-input").first().fill(term);
  await expect(page.locator(".browser-item-summary mark.search-hit").first()).toBeVisible({ timeout: 30_000 });
}

/** 打开配置 → 切「历史变更」→ 选版本 → 看原始内容。 */
async function openHistoryRawView(page: import("@playwright/test").Page) {
  await page.locator(".browser-item", { hasText: DATA_ID }).first().click({ timeout: 15_000 });
  await expect(page.locator(".browser-detail .detail-dataid")).toHaveText(DATA_ID, { timeout: 15_000 });
  await expect(page.locator(".content-box .code-area").first()).toBeVisible({ timeout: 30_000 });

  await page.locator(".detail-tabs .tab-btn", { hasText: "历史变更" }).first().click({ timeout: 15_000 });
  const items = page.locator(".history-item");
  await expect(items.first()).toBeVisible({ timeout: 30_000 });
  expect(await items.count()).toBeGreaterThanOrEqual(1);
  await items.first().locator(".history-item-main").click({ timeout: 15_000 });
  await page.getByRole("button", { name: "原始内容" }).first().click({ timeout: 15_000 });
  await expect(page.locator(".content-box .code-area").first()).toBeVisible({ timeout: 30_000 });
}

test("轮40-R1 内容搜索词跟随到「历史变更」的原始内容：标红、命中行、Ctrl+F 预填", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await page.setViewportSize({ width: 1280, height: 820 });

  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item").first()).toBeVisible({ timeout: 30_000 });
  await searchByContent(page, TERM);
  await openHistoryRawView(page);

  // 正文里确实有这个词（否则下面的断言会因为「没命中」而假红/假绿都说不清）
  const hist = await codeState(page);
  expect(hist.areas, "原始内容没渲染出正文容器").toBe(1);
  expect(hist.textHasTerm, "历史版本正文里没有搜索词，取证前提不成立").toBe(true);
  expect(hist.marksInCode, "「历史变更」的原始内容必须跟随页面搜索词标红").toBeGreaterThan(0);
  expect(hist.hitLines, "命中行底色层必须一起到位").toBeGreaterThan(0);
  expect(hist.hitLineNos, "行号命中态必须一起到位").toBeGreaterThan(0);
  expect(hist.minimap, "缩略图必须还在（同一份 CodeView 能力）").toBeGreaterThan(0);
  expect(hist.owner, "查找快捷键注册表恒为一个 owner（轮39 口径）").toBe(1);

  // Ctrl+F 在这块视图里预填页面搜索词，而不是空串
  await page.locator(".content-box .code-area").first().click({ timeout: 15_000 });
  await page.keyboard.press("Control+f");
  await expect(page.locator(".code-find-input")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".code-find-input")).toHaveValue(TERM, { timeout: 10_000 });
  await page.screenshot({ path: "results/v40-history-search-prefilled.png", fullPage: true });
  await page.keyboard.press("Escape");
  await expect(page.locator(".code-find-input")).toHaveCount(0, { timeout: 10_000 });

  // AC2：切回详情区的「内容」tab 行为不回退（词与标红都还在）。
  // 文案真值：tab 是 t("config.content") = 「内容」，搜索方式切换按钮是 t("config.searchByContent")
  // = 同一个「内容」⇒ 必须限定在 .detail-tabs 内选，否则 strict mode 直接歧义。
  await page.locator(".detail-tabs .tab-btn", { hasText: "内容" }).first().click({ timeout: 15_000 });
  await expect(page.locator(".content-box .code-area").first()).toBeVisible({ timeout: 30_000 });
  const browse = await codeState(page);
  expect(browse.marksInCode, "切回来以后浏览 tab 的标红不能丢").toBeGreaterThan(0);
});

test("轮40-R3 按 dataId 搜索时，「历史变更」的原始内容一处都不标", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await page.setViewportSize({ width: 1280, height: 820 });

  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item").first()).toBeVisible({ timeout: 30_000 });
  // 默认「按 dataId」模式：输入的是 dataId 串，绝不能当成正文词去标
  await page.locator(".browser-search .search-input").first().fill(DATA_ID);
  await expect(page.locator(".browser-item", { hasText: DATA_ID }).first()).toBeVisible({ timeout: 30_000 });
  await openHistoryRawView(page);

  const state = await codeState(page);
  expect(state.areas).toBe(1);
  expect(state.textHasTerm, "正文里有该词（说明不是标不出来，而是根本不该标）").toBe(true);
  expect(state.marksInCode, "没有正文搜索词时一处都不许标（防把 dataId 串误当正文词）").toBe(0);
  expect(state.hitLines).toBe(0);
});
