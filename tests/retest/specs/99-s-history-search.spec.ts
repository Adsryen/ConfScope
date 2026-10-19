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
import { test, expect, fetchNacosContent } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { publishNacosContent, republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog } from "./ui";
import { loadRetestState } from "../state";

const state = loadRetestState();
const BASE_A = state.nacos.a.baseUrl;
const NS_A = state.nacos.a.namespace;
const GROUP = "RETEST-PROD";

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

/** 只数 diff 容器内部的命中：标红数 / 行号命中态 / 语义背景色是否还在（轮41 口径同 codeState）。 */
async function diffState(page: import("@playwright/test").Page) {
  return page.evaluate((term: string) => {
    const panel = document.querySelector(".diff-panel");
    const texts = Array.from(document.querySelectorAll(".diff-panel .udiff-text"));
    const root = getComputedStyle(document.documentElement);
    const rowBg = (sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      return el ? getComputedStyle(el).backgroundColor : null;
    };
    const markBg = (sel: string) => {
      const el = document.querySelector(`${sel} mark.search-hit`) as HTMLElement | null;
      return el ? getComputedStyle(el).backgroundColor : null;
    };
    return {
      panel: !!panel,
      rows: document.querySelectorAll(".diff-panel .udiff-row").length,
      addRows: document.querySelectorAll(".diff-panel .udiff-row.add").length,
      delRows: document.querySelectorAll(".diff-panel .udiff-row.del").length,
      ctxRows: document.querySelectorAll(".diff-panel .udiff-row.ctx").length,
      marksInDiff: texts.reduce((acc, el) => acc + el.querySelectorAll("mark.search-hit").length, 0),
      marksInAddRows: document.querySelectorAll(".diff-panel .udiff-row.add mark.search-hit").length,
      marksInDelRows: document.querySelectorAll(".diff-panel .udiff-row.del mark.search-hit").length,
      gutterIsHit: document.querySelectorAll(".diff-panel .udiff-gutter.is-hit").length,
      globalMarks: document.querySelectorAll("mark.search-hit").length,
      textHasTerm: texts.some((el) => (el.textContent ?? "").includes(term)),
      // R41-3：语义背景色（新增绿 / 删除红）必须还是那两个令牌，不能被搜索色盖掉
      addRowBg: rowBg(".diff-panel .udiff-row.add"),
      delRowBg: rowBg(".diff-panel .udiff-row.del"),
      addBgToken: root.getPropertyValue("--diff-add-bg").trim(),
      delBgToken: root.getPropertyValue("--diff-del-bg").trim(),
      markBgInAddRow: markBg(".diff-panel .udiff-row.add"),
      codeAreas: document.querySelectorAll(".code-area").length,
    };
  }, TERM);
}

/** 打开配置 → 切「历史变更」→ 选版本，**停在默认视图**（默认就是「高亮变更」的 diff）。 */
async function openHistoryDiffView(page: import("@playwright/test").Page) {
  await page.locator(".browser-item", { hasText: DATA_ID }).first().click({ timeout: 15_000 });
  await expect(page.locator(".browser-detail .detail-dataid")).toHaveText(DATA_ID, { timeout: 15_000 });
  await expect(page.locator(".content-box .code-area").first()).toBeVisible({ timeout: 30_000 });

  await page.locator(".detail-tabs .tab-btn", { hasText: "历史变更" }).first().click({ timeout: 15_000 });
  const items = page.locator(".history-item");
  await expect(items.first()).toBeVisible({ timeout: 30_000 });
  await items.first().locator(".history-item-main").click({ timeout: 15_000 });
  // rawView 初值 false ⇒ 这一屏就是 UnifiedDiff；点了「原始内容」才换成 CodeView
  await expect(page.locator(".diff-panel").first()).toBeVisible({ timeout: 30_000 });
}

/**
 * 造一个**与上一版真的有差异**的历史版本（R41-3 的取证样本）。
 *
 * 为什么单次发布不够（本轮实测踩到）：Nacos 的历史条目存的是「这次发布**之前**那份内容」，
 * 所以 republish 之后最新条目 = 上一轮的同一份 baseline，相邻两条逐字节相同 ⇒
 * UnifiedDiff 只剩 ctx 行，add/del 行（以及「语义背景色有没有被搜索色盖掉」这条断言）取不到样本。
 *
 * 于是发两次：先写 flipped（产生一条内容为 baseline 的历史条目），再写回 baseline
 * （产生的最新历史条目内容 = flipped，它的上一版 = baseline）⇒ 最新那条真的有 1 删 1 增。
 * 顺带把 A 侧当前内容复位成 baseline，不给后续 spec 留脏数据。
 */
async function publishOneSwitchFlip(): Promise<void> {
  const baseline = await fetchNacosContent(BASE_A, NS_A, DATA_ID, GROUP);
  expect(baseline).toContain("enabled: true");
  const flipped = baseline.replace("enabled: true", "enabled: false");
  expect(flipped).not.toBe(baseline);
  await publishNacosContent(BASE_A, NS_A, DATA_ID, GROUP, flipped);
  await publishNacosContent(BASE_A, NS_A, DATA_ID, GROUP, baseline);
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

test("轮41-R5 页面搜索词跟随到默认的「高亮变更」视图：add/del 行都标红，语义背景色不动", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await publishOneSwitchFlip();
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await page.setViewportSize({ width: 1280, height: 820 });

  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item").first()).toBeVisible({ timeout: 30_000 });
  await searchByContent(page, TERM);
  await openHistoryDiffView(page);

  const diff = await diffState(page);
  expect(diff.panel, "默认视图必须是 diff 面板（没点「原始内容」）").toBe(true);
  expect(diff.codeAreas, "默认视图不该有 .code-area，计数口径不能借用原文视图").toBe(0);
  expect(diff.addRows, "取证前提：这一版必须真的有新增行").toBeGreaterThan(0);
  expect(diff.delRows, "取证前提：这一版必须真的有删除行").toBeGreaterThan(0);
  expect(diff.textHasTerm, "diff 正文里确实有该词，0 标红才是缺陷").toBe(true);
  expect(diff.marksInDiff, "「高亮变更」必须跟随页面搜索词标红").toBeGreaterThan(0);
  expect(diff.marksInAddRows, "新增行里的命中词也要标到").toBeGreaterThan(0);
  expect(diff.marksInDelRows, "删除行里的命中词也要标到").toBeGreaterThan(0);
  expect(diff.gutterIsHit, "命中行指示走行号变红（与 .code-ln.is-hit 同口径）").toBeGreaterThan(0);

  // R41-3：搜索色只落在 <mark> 上，行背景仍是新增/删除的语义色
  expect(diff.addRowBg, "add 行背景必须还是 --diff-add-bg").toBe(diff.addBgToken);
  expect(diff.delRowBg, "del 行背景必须还是 --diff-del-bg").toBe(diff.delBgToken);
  expect(diff.markBgInAddRow, "命中词底色要与 .code-area 同档 0.28，压得住 add 行的绿").toBe("rgba(244, 71, 71, 0.28)");

  // AC3：同一 tab 内切到「原始内容」再切回来，两条分支都得吃到词
  await page.locator(".head-actions .btn", { hasText: "原始内容" }).first().click({ timeout: 15_000 });
  await expect(page.locator(".content-box .code-area").first()).toBeVisible({ timeout: 30_000 });
  const raw = await codeState(page);
  expect(raw.marksInCode, "切到原始内容后仍要标红（轮40 行为不回退）").toBeGreaterThan(0);
  await page.locator(".head-actions .btn", { hasText: "高亮变更" }).first().click({ timeout: 15_000 });
  await expect(page.locator(".diff-panel").first()).toBeVisible({ timeout: 30_000 });
  const back = await diffState(page);
  expect(back.marksInDiff, "切回高亮变更也要标红，词不许在半路丢掉").toBeGreaterThan(0);

  await page.screenshot({ path: "results/v41-diff-search-after.png", fullPage: true });
  await republishRetestData();
});

test("轮41-R6 按文件名搜索时，默认的「高亮变更」一处都不标", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await publishOneSwitchFlip();
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await page.setViewportSize({ width: 1280, height: 820 });

  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item").first()).toBeVisible({ timeout: 30_000 });
  // 默认「按 dataId」模式：搜索框里是 dataId 串，绝不能当成正文词去标
  await page.locator(".browser-search .search-input").first().fill(DATA_ID);
  await expect(page.locator(".browser-item", { hasText: DATA_ID }).first()).toBeVisible({ timeout: 30_000 });
  await openHistoryDiffView(page);

  const diff = await diffState(page);
  expect(diff.rows).toBeGreaterThan(0);
  expect(diff.textHasTerm, "正文里有该词（说明不是标不出来，而是根本不该标）").toBe(true);
  expect(diff.marksInDiff, "没有正文搜索词时一处都不许标").toBe(0);
  expect(diff.gutterIsHit).toBe(0);
  await republishRetestData();
});
