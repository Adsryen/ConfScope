// 轮49 真机永久回归：历史「高亮变更」正文（UnifiedDiff）接入文件内查找 + 正文视图分段控件说实话。
//
// 为什么钉成真机（jsdom 写不出这几条）：
// 1. 命中行定位靠量 DOM 矩形（`.udiff-text` 是 pre-wrap + break-all，行高公式不成立）；
// 2. 开栏净空 50px / 关栏归零 / 首行回原位，是锚点高度与滚动位置的联动；
// 3. 关栏后焦点还给 `.udiff`（tabIndex=0 + role=region）——jsdom 里 focus() 谁都察觉不到；
// 4. 分段控件的「哪个视图在屏上，按下态就在同名那颗上」要看真实 class 与在屏 DOM，静态守卫只能钉源码写法。
//
// 手顺（与真人一致）：配置浏览 → 按内容搜索 → 点 svc-billing.yaml → 「历史变更」tab → 选最新版本
// （默认落在这块 UnifiedDiff）→ 正文里点 ⌕ / 按 Ctrl+F → 敲词 → Enter 步进 → Esc 关栏。
//
// 取证前提靠造一次历史（publishMixedCaseSwitchFlip，注释里写了为什么单次发布不够）：
// 最新那条历史条目 = flipped，它的上一版 = baseline ⇒ 正文里恒有 1 删 1 增，
// 而 flipped 那行的新内容故意写成 `EnabledByflip: true`，给 Aa / ab| 备下两种各自能收窄的样本。
//
// 用例：
//   DF2-01/02 两个入口都开栏且焦点在输入框；命中标红 + 所在行行号变红 + 行号照常显示 + 当前命中恒一组
//   DF2-03/05 Enter 逐行步进且真的滚起来；关栏后净空归零、首行回原位、⌕ 回来、焦点给 .udiff
//   DF2-04 Aa 与 ab| 只会收窄（各有严格收窄的一档）；勾「仅显示变更」后每步都落在可见行上
//   DF2-06 分段控件：在屏视图与 active + aria-pressed 同名，文案不随状态变
//   DF2-07 外部内容搜索词与栏内查找互斥：开栏时外部词不再标红，关栏后回来
//
// 本轮实测基线（读数写在这里，改断言前先重跑）：
//   正文 57 行（scrollHeight 1139 / clientHeight 548）、add=1 del=1、行号槽 57 个全是数字；
//   外部词 enabled ⇒ 标红 7 处、行号变红 7 个、净空 0、⌕ 1 颗；
//   开栏（预填 enabled）⇒ 净空 50、第 1/7 处、当前标红 1、当前行 1 组、焦点在输入框；
//   Enter 走满一圈 ⇒ 序号 2→7、行序列 16,19,27,34,41,49、最大 scrollTop 641；
//   关栏 ⇒ 净空 0、首行回 272、⌕ 回来、activeElement=div.udiff.mono。
import { expect, type Page, type Locator } from "@playwright/test";
import { test, fetchNacosContent } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { publishNacosContent, republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog } from "./ui";
import { loadRetestState } from "../state";

const state = loadRetestState();
const BASE_A = state.nacos.a.baseUrl;
const NS_A = state.nacos.a.namespace;
const GROUP = "RETEST-PROD";
const DATA_ID = "svc-billing.yaml";

/** 页面级正文搜索词（配置浏览「按内容」模式的词），同时是栏内预填词。 */
const TERM = "enabled";
/** 只在栏内用的对照词：正文里 1 处命中，与外部词的 7 处一眼能分辨。 */
const IN_BAR_ONLY_TERM = "http";
/** 走步进用的词（7 组，分散在第 15→49 行，滚动有余量）。 */
const STEP_TERM = "enabled";

interface Probe {
  barCount: number;
  pillCount: number;
  countText: string;
  marks: number;
  currentMarks: number;
  currentRows: number[];
  hitGutters: number;
  currentGutters: number;
  numberedGutters: number;
  gutterTotal: number;
  anchorHeight: number;
  scrollTop: number;
  scrollRoom: number;
  firstRowTop: number | null;
  currentRowVisible: boolean | null;
  addRows: number;
  delRows: number;
  rows: number;
  activeElement: string;
  udiffVisible: boolean;
  codeAreaVisible: boolean;
}

// page.evaluate 只把「这一个函数」搬进浏览器，闭包里的模块级函数不会跟着过去，
// 所以取数必须在函数体里就地做完；keep-alive 会让别的页的 DOM 留在页面里，一律按可见性取。
function probeUdiff(): Probe {
  const vis = (list: NodeListOf<HTMLElement>) => Array.from(list).filter((e) => e.offsetParent !== null);
  const bodies = vis(document.querySelectorAll<HTMLElement>(".udiff"));
  const body = bodies.length ? bodies[bodies.length - 1] : null;
  const bars = vis(document.querySelectorAll<HTMLElement>(".code-find"));
  const pills = vis(document.querySelectorAll<HTMLElement>(".code-find-open"));
  const anchor = body ? (body.querySelector(".diff-find-anchor") as HTMLElement | null) : null;
  const countEl = bars.length ? bars[bars.length - 1].querySelector(".code-find-count") : null;
  const marks = body ? vis(body.querySelectorAll<HTMLElement>("mark.search-hit")) : [];
  const currentMarks = marks.filter((m) => m.classList.contains("search-hit-current"));
  const rowsWithCurrent = new Set<number>();
  currentMarks.forEach((m) => {
    const row = m.closest("[data-row-index]");
    if (row) rowsWithCurrent.add(Number(row.getAttribute("data-row-index")));
  });
  const gutters = body ? Array.from(body.querySelectorAll<HTMLElement>(".udiff-gutter")) : [];
  const rows = body ? Array.from(body.querySelectorAll<HTMLElement>(".udiff-row")) : [];
  const firstRow = rows.length ? rows[0] : null;
  let currentRowVisible: boolean | null = null;
  if (body && rowsWithCurrent.size === 1) {
    const row = body.querySelector(`[data-row-index="${Array.from(rowsWithCurrent)[0]}"]`) as HTMLElement | null;
    if (row) {
      const r = row.getBoundingClientRect();
      const b = body.getBoundingClientRect();
      currentRowVisible = r.bottom > b.top + 1 && r.top < b.bottom - 1;
    }
  }
  const a = document.activeElement;
  return {
    barCount: bars.length,
    pillCount: pills.length,
    countText: countEl ? (countEl.textContent ?? "").trim() : "",
    marks: marks.length,
    currentMarks: currentMarks.length,
    currentRows: Array.from(rowsWithCurrent).sort((x, y) => x - y),
    hitGutters: gutters.filter((g) => g.classList.contains("is-hit")).length,
    currentGutters: gutters.filter((g) => g.classList.contains("is-current")).length,
    numberedGutters: gutters.filter((g) => /^\d+$/.test((g.textContent ?? "").trim())).length,
    gutterTotal: gutters.length,
    anchorHeight: anchor ? Math.round(anchor.getBoundingClientRect().height) : -1,
    scrollTop: body ? Math.round(body.scrollTop) : -1,
    scrollRoom: body ? body.scrollHeight - body.clientHeight : -1,
    firstRowTop: firstRow ? Math.round(firstRow.getBoundingClientRect().top) : null,
    currentRowVisible,
    addRows: rows.filter((r) => r.classList.contains("add")).length,
    delRows: rows.filter((r) => r.classList.contains("del")).length,
    rows: rows.length,
    activeElement: a ? `${a.tagName.toLowerCase()}.${typeof a.className === "string" ? a.className.trim().split(/\s+/).join(".") : ""}` : "",
    udiffVisible: bodies.length > 0,
    codeAreaVisible: vis(document.querySelectorAll<HTMLElement>(".code-area")).length > 0,
  };
}

async function read(page: Page): Promise<Probe> {
  return page.evaluate(probeUdiff);
}

/** 命中总数（"第 3/7 处" 里那个 7）；无匹配时 null。 */
function totalCount(text: string): number | null {
  const found = /第\s*\d+\s*\/\s*(\d+)/.exec(text);
  return found ? Number(found[1]) : null;
}

/** 当前序号（"第 3/7 处" 里那个 3）。 */
function currentIndex(text: string): number | null {
  const found = /第\s*(\d+)\s*\//.exec(text);
  return found ? Number(found[1]) : null;
}

/**
 * 造一条**与上一版真有差异**的历史版本，顺便给口径开关备下样本。
 *
 * 单次发布不够（轮41 实测踩过）：Nacos 的历史条目存的是「这次发布之前那份内容」，
 * republish 之后相邻两条逐字节相同 ⇒ 正文只剩 ctx 行，取不到 add/del 样本。
 *
 * 为什么翻转那行写成 `EnabledByflip: true` 而不是 `enabled: false`：
 * 正文里 "enabled" 全是同一种小写形式，Aa（区分大小写）勾下去一处都不会少，
 * 「口径开关有没有接到这个宿主」就只能靠静态守卫说了算。改大小写 + 粘连成非整词，
 * 于是同一个词能分别测出「Aa 严格收窄」和「ab| 严格收窄」，两颗开关都不是装饰品。
 * 最后写回 baseline：A 侧当前内容不变，不给后续 spec 留脏数据。
 */
async function publishMixedCaseSwitchFlip(): Promise<void> {
  const baseline = await fetchNacosContent(BASE_A, NS_A, DATA_ID, GROUP);
  expect(baseline).toContain("enabled: true");
  const flipped = baseline.replace("enabled: true", "EnabledByflip: true");
  expect(flipped).not.toBe(baseline);
  await publishNacosContent(BASE_A, NS_A, DATA_ID, GROUP, flipped);
  await publishNacosContent(BASE_A, NS_A, DATA_ID, GROUP, baseline);
}

async function bootstrap(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await page.setViewportSize({ width: 1280, height: 820 });
}

/** 幂等进入「配置浏览」：搜索栏在别的视图下仍留在 DOM 里但不可见，直接点会超时；
 * 而已经在这一屏时再点一次侧边导航会重置列表 state（外部搜索词被抹掉），所以这里只补点、不重复点。 */
async function ensureBrowserView(page: Page): Promise<void> {
  if (await page.locator(".browser-search-mode").first().isVisible()) return;
  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item").first()).toBeVisible({ timeout: 30_000 });
}

/** 内容搜索模式 + 输入词 + 等列表摘要出现命中高亮（外部词的来源，与轮40/41 同一入口）。 */
async function searchByContent(page: Page, term: string): Promise<void> {
  await ensureBrowserView(page);
  await page.locator(".browser-search-mode .btn", { hasText: "内容" }).first().click({ timeout: 15_000 });
  await page.locator(".browser-search .search-input").first().fill(term);
  await expect(page.locator(".browser-item-summary mark.search-hit").first()).toBeVisible({ timeout: 30_000 });
}

/** 进「历史变更」，停在默认视图（默认就是 UnifiedDiff，不点分段控件）。 */
async function openHistoryUdiff(page: Page): Promise<void> {
  await ensureBrowserView(page);
  await page.locator(".browser-item", { hasText: DATA_ID }).first().click({ timeout: 15_000 });
  await expect(page.locator(".browser-detail .detail-dataid")).toHaveText(DATA_ID, { timeout: 15_000 });
  await page.locator(".detail-tabs .tab-btn", { hasText: "历史变更" }).first().click({ timeout: 15_000 });
  const items = page.locator(".history-item");
  await expect(items.first()).toBeVisible({ timeout: 30_000 });
  await items.first().locator(".history-item-main").click({ timeout: 15_000 });
  await expect(page.locator(".udiff").filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(500);
}

const barInput = (page: Page): Locator =>
  page.locator(".diff-find-anchor .code-find-input").filter({ visible: true }).first();
const pill = (page: Page): Locator => page.locator(".diff-find-anchor .code-find-open").filter({ visible: true }).first();
const bar = (page: Page): Locator => page.locator(".diff-find-anchor .code-find").filter({ visible: true }).first();
const toggles = (page: Page): Locator => page.locator(".diff-find-anchor .code-find-toggle").filter({ visible: true });

/** 焦点先落在正文层再按 Ctrl+F（与真人「在正文里按快捷键」一致）。 */
async function openFindWithShortcut(page: Page): Promise<void> {
  await page.locator(".udiff").filter({ visible: true }).first().click({ position: { x: 240, y: 220 } });
  await page.keyboard.press("Control+f");
  await expect(barInput(page), "正文里按 Ctrl+F 没开栏").toBeVisible({ timeout: 10_000 });
}

async function closeFind(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(barInput(page), "关栏没生效：查找输入框还在").toBeHidden({ timeout: 5_000 });
}

test.beforeEach(async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await publishMixedCaseSwitchFlip();
  await bootstrap(page);
});

test("DF2-01/02 高亮变更正文：两个入口都开栏，命中标红 + 行号变红 + 当前命中恒一组", async ({ page }) => {
  test.setTimeout(300_000);
  await searchByContent(page, TERM);
  await openHistoryUdiff(page);

  const closed = await read(page);
  // 取证前提：这一版真有增删、行号照常显示、滚动有余量
  expect(closed.udiffVisible, "默认视图不是 UnifiedDiff").toBe(true);
  expect(closed.codeAreaVisible, "默认视图不该有 .code-area").toBe(false);
  expect(closed.rows, "正文没渲染出行").toBeGreaterThan(20);
  expect(closed.addRows, "取证前提：这一版必须有新增行").toBeGreaterThan(0);
  expect(closed.delRows, "取证前提：这一版必须有删除行").toBeGreaterThan(0);
  expect(closed.numberedGutters, "行号没显示出来").toBeGreaterThan(0);
  expect(closed.numberedGutters, "行号槽数量与行数对不上").toBe(closed.rows);
  expect(closed.scrollRoom, "正文没有滚动余量，步进那条断言会空转").toBeGreaterThan(200);
  // 关栏态：一条栏都不许留，净空归零，⌕ 浮标在
  expect(closed.barCount).toBe(0);
  expect(closed.anchorHeight, "关栏态的净空锚点不该占高度").toBe(0);
  expect(closed.pillCount, "关栏态必须留一颗能点的 ⌕ 浮标").toBe(1);

  // 入口一：⌕ 浮标
  await pill(page).click();
  await expect(barInput(page), "点 ⌕ 没开栏").toBeVisible({ timeout: 5_000 });
  await expect(barInput(page), "开栏后焦点要在查找输入框里").toBeFocused({ timeout: 5_000 });
  let probe = await read(page);
  expect(probe.barCount, "同时只许有一条可见查找栏").toBe(1);
  expect(probe.pillCount, "开栏后 ⌕ 浮标还留着 = 两个入口同时在场").toBe(0);
  await closeFind(page);

  // 入口二：焦点在正文上按 Ctrl+F（外部词应当被预填，与 CodeView 同一句话）
  await openFindWithShortcut(page);
  await expect(barInput(page), "Ctrl+F 没预填页面搜索词").toHaveValue(TERM, { timeout: 5_000 });
  probe = await read(page);
  expect(probe.barCount, "两个视图同时接管 = 弹两条查找栏").toBe(1);

  await expect
    .poll(async () => (await read(page)).marks, "正文里一处都不标红")
    .toBeGreaterThan(0, { timeout: 15_000 });
  probe = await read(page);

  // 命中标红 + 计数文案 + 当前命中恒为一组（单列视图每行只有一侧有文本）
  expect(probe.countText, "计数文案没出现「第 N/M 处」").toMatch(/第\s*\d+\s*\/\s*\d+/);
  expect(totalCount(probe.countText) ?? 0, "外部词与栏内词叠成了两层").toBe(7);
  expect(probe.marks, "标红处数与计数对不上").toBeGreaterThanOrEqual(totalCount(probe.countText) ?? 0);
  expect(probe.currentMarks, "当前命中的标红单元数必须为 1").toBe(1);
  expect(probe.currentRows, "同时出现两个「当前行」= 步进单位算错了").toHaveLength(1);
  // 所在行高亮：本视图的命中行指示走行号变红（行底色是新增/删除的语义色，不许被搜索色盖掉）
  expect(probe.hitGutters, "命中所在行的行号没变红").toBeGreaterThanOrEqual(1);
  expect(probe.currentGutters, "当前命中所在行的行号没进 is-current").toBe(1);
  expect(probe.numberedGutters, "命中态把行号数字吃掉了").toBe(probe.rows);
  expect(probe.anchorHeight, "开栏后第一行没给查找栏让位").toBeGreaterThan(0);
  expect(probe.currentRowVisible, "当前命中所在行不在可视区").toBe(true);
  console.log(
    `[DF2-02] ${probe.countText} 标红=${probe.marks} 行号变红=${probe.hitGutters} 当前行=${probe.currentRows[0]} 净空=${probe.anchorHeight}`
  );
  await page.screenshot({ path: "results/r49_udiff_find_hits.png" });
  await closeFind(page);
});

test("DF2-03/05 Enter 逐行步进并真的滚动；关栏后净空归零、首行回原位、焦点给正文", async ({ page }) => {
  test.setTimeout(300_000);
  await openHistoryUdiff(page);

  // 基准：关栏 + 滚动归零时第一行的屏幕位置（关栏后必须回到这里）
  await page.evaluate(() => {
    const bodies = Array.from(document.querySelectorAll<HTMLElement>(".udiff")).filter((e) => e.offsetParent !== null);
    if (bodies.length) bodies[bodies.length - 1].scrollTop = 0;
  });
  await page.waitForTimeout(300);
  const baseline = await read(page);
  expect(baseline.scrollTop).toBe(0);
  expect(baseline.anchorHeight).toBe(0);
  expect(baseline.firstRowTop, "基准位置取不到").not.toBeNull();

  await openFindWithShortcut(page);
  await barInput(page).fill(STEP_TERM);
  await expect
    .poll(async () => (await read(page)).marks, "没有命中就无法步进")
    .toBeGreaterThan(0, { timeout: 15_000 });

  const first = await read(page);
  const total = totalCount(first.countText) ?? 0;
  expect(total, "分母为 0：这个词在高亮变更正文里没命中").toBeGreaterThan(1);
  const steps = Math.min(total - 1, 6);
  const seen: number[] = [];
  let maxScrollTop = first.scrollTop;
  for (let i = 0; i < steps; i += 1) {
    await barInput(page).press("Enter");
    await page.waitForTimeout(220);
    const after = await read(page);
    seen.push(after.currentRows[0]);
    expect(after.currentRows, `第 ${i + 2} 次 Enter 出现多个当前行`).toHaveLength(1);
    expect(currentIndex(after.countText), `第 ${i + 2} 次 Enter 序号没前进（步进单位不是行）`).toBe(i + 2);
    expect(after.currentRowVisible, `第 ${i + 2} 次 Enter 后当前行不在可视区里`).toBe(true);
    expect(after.marks, `第 ${i + 2} 次 Enter 把标红重画掉了（应当只换类名）`).toBe(first.marks);
    maxScrollTop = Math.max(maxScrollTop, after.scrollTop);
  }
  expect(new Set(seen).size, "Enter 一直停在同一行：步进单位退回「处」了").toBe(steps);
  expect(maxScrollTop, "命中分散在全文，但正文一次都没滚起来").toBeGreaterThan(baseline.scrollTop);

  // 关栏（走 X 那颗，而不是 Esc）：净空归零 + 首行回到基准 + ⌕ 回来 + 焦点还给 .udiff
  await page.evaluate(() => {
    const bodies = Array.from(document.querySelectorAll<HTMLElement>(".udiff")).filter((e) => e.offsetParent !== null);
    if (bodies.length) bodies[bodies.length - 1].scrollTop = 0;
  });
  await page.waitForTimeout(200);
  await bar(page).getByRole("button", { name: "关闭查找" }).click();
  await expect(barInput(page), "点 X 关栏没生效").toBeHidden({ timeout: 5_000 });
  const closed = await read(page);
  expect(closed.anchorHeight, "关栏后净空锚点还占着高度：第一行永远让在半空").toBe(0);
  expect(closed.firstRowTop, "关栏后第一行没回到原位").toBe(baseline.firstRowTop);
  expect(closed.pillCount, "关栏后 ⌕ 浮标没回来").toBe(1);
  expect(closed.barCount).toBe(0);
  expect(closed.activeElement, "关栏后焦点该还给正文层（掉了就得先点一下才能滚）").toContain("udiff");
  console.log(
    `[DF2-03] 步进=${steps} 最大滚动=${maxScrollTop} 首行基准=${baseline.firstRowTop} 关栏后=${closed.firstRowTop} 焦点=${closed.activeElement}`
  );
  await page.screenshot({ path: "results/r49_udiff_find_closed.png" });
});

test("DF2-04 Aa 与 ab| 只会收窄；勾「仅显示变更」后每步都落在真实存在且可见的行上", async ({ page }) => {
  test.setTimeout(300_000);
  await openHistoryUdiff(page);
  await openFindWithShortcut(page);
  await barInput(page).fill(TERM);
  await expect
    .poll(async () => (await read(page)).marks, "没有命中，口径开关无从验证")
    .toBeGreaterThan(0, { timeout: 15_000 });

  const base = await read(page);
  const baseTotal = totalCount(base.countText) ?? 0;
  expect(baseTotal, "默认口径下没有命中").toBeGreaterThan(1);

  const switchTo = async (index: number, expectPressed: boolean) => {
    const btn = toggles(page).nth(index);
    await btn.click();
    await expect(btn, `第 ${index + 1} 颗开关的按压态没同步`).toHaveAttribute("aria-pressed", String(expectPressed));
    await page.waitForTimeout(400);
    return (await read(page)).countText;
  };

  // ab|（全词）单开：粘连成非整词的那处应当掉出去 —— 严格收窄，且仍有命中
  const afterWord = await switchTo(1, true);
  const wordTotal = totalCount(afterWord) ?? 0;
  expect(wordTotal, "勾了 ab| 命中没变少：全词口径没接到这个宿主").toBeLessThan(baseTotal);
  expect(wordTotal, "ab| 把命中清成 0（词选错了，换 TERM 而不是放宽断言）").toBeGreaterThanOrEqual(1);
  expect((await read(page)).marks, "ab| 之后标红数与编号对不上").toBeGreaterThanOrEqual(wordTotal);

  // 关掉 ab|，开 Aa（区分大小写）：大写了的那处应当掉出去 —— 同样严格收窄
  await switchTo(1, false);
  const afterCase = await switchTo(0, true);
  const caseTotal = totalCount(afterCase) ?? 0;
  expect(caseTotal, "勾了 Aa 命中没变少：大小写口径没接到这个宿主").toBeLessThan(baseTotal);
  expect(caseTotal, "Aa 把命中清成 0").toBeGreaterThanOrEqual(1);

  // 两颗同时开：只会更窄或持平，绝不放宽（与 CodeView / DiffPanel 同一把尺子）
  await switchTo(1, true);
  const both = await read(page);
  const bothTotal = totalCount(both.countText) ?? 0;
  expect(bothTotal, "Aa + ab| 比单开 Aa 还宽：三个宿主用的不是同一份命中层").toBeLessThanOrEqual(caseTotal);
  expect(both.marks, "两颗开关都勾上后应当仍有命中").toBeGreaterThanOrEqual(1);
  console.log(`[DF2-04] 默认=${baseTotal} ab|=${wordTotal} Aa=${caseTotal} 两颗都开=${bothTotal}`);

  // 两颗都退回默认
  await switchTo(1, false);
  await switchTo(0, false);
  await expect
    .poll(async () => totalCount((await read(page)).countText) ?? 0, "取消勾选后没回到默认口径")
    .toBe(baseTotal);

  // 勾「仅显示变更」：被隐藏的行不许留在编号里，否则 Enter 会落到 DOM 里不存在的 <mark> 上
  const onlyChanges = page.locator(".diff-toggle input[type='checkbox']").filter({ visible: true }).first();
  await onlyChanges.check();
  await barInput(page).fill(TERM);
  await expect
    .poll(async () => totalCount((await read(page)).countText) ?? 0, "只剩变更行后没命中")
    .toBeGreaterThan(0, { timeout: 15_000 });
  const filtered = await read(page);
  const filteredTotal = totalCount(filtered.countText) ?? 0;
  expect(filteredTotal, "勾掉等行后命中数反而变多（隐藏行还留在编号里）").toBeLessThanOrEqual(baseTotal);
  expect(filtered.rows, "只剩变更行的行数与编号口径对不上").toBe(filtered.delRows + filtered.addRows);
  expect(filtered.marks, "勾掉等行后一处都不标了：编号还指向被隐藏的行").toBeGreaterThanOrEqual(1);

  // 走两圈：每一步都必须落在 DOM 里真实存在、且可见的那一行上
  for (let i = 0; i < filteredTotal * 2; i += 1) {
    await barInput(page).press("Enter");
    await page.waitForTimeout(200);
    const step = await read(page);
    expect(step.currentRows, `第 ${i + 1} 步没有当前行 = 失联`).toHaveLength(1);
    expect(step.marks, `第 ${i + 1} 步没有标红单元`).toBeGreaterThanOrEqual(1);
    expect(step.currentRowVisible, `第 ${i + 1} 步的当前行不在可视区`).toBe(true);
    expect(currentIndex(step.countText), `第 ${i + 1} 步序号越界（分母 ${filteredTotal}）`).toBeLessThanOrEqual(filteredTotal);
    expect(step.currentRows[0], `第 ${i + 1} 步落在不存在的行上`).toBeLessThan(step.rows);
  }
  console.log(`[DF2-04b] 仅显示变更：行数=${filtered.rows} 命中=${filtered.marks} 分母=${filteredTotal}`);
  await page.screenshot({ path: "results/r49_udiff_find_only_changes.png" });
  await onlyChanges.uncheck();
  await closeFind(page);
});

test("DF2-06 分段控件：在屏视图与 active + aria-pressed 同名，文案不随状态变", async ({ page }) => {
  test.setTimeout(300_000);
  await openHistoryUdiff(page);

  const readSeg = () =>
    page.evaluate(() => {
      const vis = (list: NodeListOf<HTMLElement>) => Array.from(list).filter((e) => e.offsetParent !== null);
      const group = vis(document.querySelectorAll<HTMLElement>(".view-mode"))[0] ?? null;
      const buttons = group ? vis(group.querySelectorAll<HTMLElement>(".btn")) : [];
      return {
        role: group ? group.getAttribute("role") : null,
        groupLabel: group ? group.getAttribute("aria-label") : null,
        buttons: buttons.map((b) => ({
          text: (b.textContent ?? "").trim(),
          pressed: b.getAttribute("aria-pressed"),
          active: b.classList.contains("active"),
          bg: getComputedStyle(b).backgroundColor,
          color: getComputedStyle(b).color,
        })),
        udiffVisible: vis(document.querySelectorAll<HTMLElement>(".udiff")).length > 0,
        codeAreaVisible: vis(document.querySelectorAll<HTMLElement>(".code-area")).length > 0,
      };
    });

  const sameDirection = (seg: Awaited<ReturnType<typeof readSeg>>, pressedView: "高亮变更" | "原始内容") => {
    expect(seg.role, "两颗按钮不成组").toBe("group");
    expect(seg.groupLabel, "分组名应当是恒定的「正文视图」").toBe("正文视图");
    expect(seg.buttons.map((b) => b.text).sort(), "按钮文案不许随状态变").toEqual(["原始内容", "高亮变更"]);
    const on = seg.buttons.find((b) => b.text === pressedView)!;
    const off = seg.buttons.find((b) => b.text !== pressedView)!;
    expect(on, `找不到名为 ${pressedView} 的按钮`).toBeTruthy();
    expect(on.pressed, `${pressedView} 的 aria-pressed 与文案不同名`).toBe("true");
    expect(on.active, `${pressedView} 的 active 类与按下态不同名`).toBe(true);
    expect(off.pressed, "另一颗应当是未按下").toBe("false");
    expect(off.active, "另一颗不该也亮着").toBe(false);
    // 按下态要看得见：active 那颗的背景/前景与非按下那颗必须不同
    expect(on.bg, "active 没有可见底色（按下态只是说说）").not.toBe(off.bg);
  };

  // 默认在屏的是「高亮变更」
  const first = await readSeg();
  expect(first.udiffVisible).toBe(true);
  expect(first.codeAreaVisible).toBe(false);
  sameDirection(first, "高亮变更");

  await page.getByRole("button", { name: "原始内容" }).first().click({ timeout: 15_000 });
  await expect(page.locator(".code-area").filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
  const second = await readSeg();
  expect(second.codeAreaVisible, "按下「原始内容」却没换出原文视图").toBe(true);
  expect(second.udiffVisible, "切走后 UnifiedDiff 还留在屏上").toBe(false);
  sameDirection(second, "原始内容");
  expect(second.buttons.map((b) => b.text).sort(), "切换后文案漂了").toEqual(["原始内容", "高亮变更"]);

  await page.getByRole("button", { name: "高亮变更" }).first().click({ timeout: 15_000 });
  await expect(page.locator(".udiff").filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
  const third = await readSeg();
  expect(third.udiffVisible).toBe(true);
  expect(third.codeAreaVisible).toBe(false);
  sameDirection(third, "高亮变更");

  // 换视图时查找快捷键的 owner 恒为一个，且不留第二栏
  const owners = await page.evaluate(() => ({
    owner: document.querySelectorAll("[data-find-key-owner]").length,
    bars: Array.from(document.querySelectorAll<HTMLElement>(".code-find")).filter((e) => e.offsetParent !== null).length,
  }));
  expect(owners.owner, "查找快捷键注册表恒为一个 owner").toBe(1);
  expect(owners.bars, "切视图后残留可见查找栏").toBe(0);
  console.log(`[DF2-06] 三态同名：高亮=${JSON.stringify(first.buttons)} 原始=${JSON.stringify(second.buttons)}`);
  await page.screenshot({ path: "results/r49_udiff_view_mode.png" });
});

test("DF2-07 外部内容搜索词与栏内查找互斥：开栏时外部词不再标红，关栏后回来", async ({ page }) => {
  test.setTimeout(300_000);
  await searchByContent(page, TERM);
  await openHistoryUdiff(page);

  // 没开栏：外部词照旧标红（轮41 那条线不能被本轮弄反）
  const ext = await read(page);
  expect(ext.barCount).toBe(0);
  expect(ext.marks, "外部词没标红").toBeGreaterThan(0);
  expect(ext.hitGutters, "外部词的命中行行号没变红").toBeGreaterThanOrEqual(1);
  const extMarks = ext.marks;

  // 开栏并换成另一个词：红字只许来自栏内词，外部词那 7 处必须一起退场
  await openFindWithShortcut(page);
  await barInput(page).fill(IN_BAR_ONLY_TERM);
  await expect
    .poll(async () => (await read(page)).marks, "栏内词没接管标红")
    .toBeGreaterThan(0, { timeout: 15_000 });
  const inBar = await read(page);
  const inBarTotal = totalCount(inBar.countText) ?? 0;
  expect(inBarTotal, "栏内词没算出分母").toBeGreaterThan(0);
  expect(inBar.marks, "开栏后外部词还在标红：两层红字叠在一起").toBe(inBarTotal);
  expect(inBar.marks, "开栏后红字数量与外部词一样 = 外部词没让位").not.toBe(extMarks);
  expect(inBar.hitGutters, "命中行指示没跟着栏内词走").toBe(inBarTotal);
  expect(inBar.currentMarks, "换词后当前命中不恒为一组").toBe(1);

  // 清空栏内词：一处都不标（外部词不许在栏开着的时候偷偷回来）
  await barInput(page).fill("");
  await expect.poll(async () => (await read(page)).marks, "空词仍在标红（外部词偷偷回来了）").toBe(0, { timeout: 15_000 });
  const cleared = await read(page);
  expect(cleared.hitGutters, "空词还留着命中行号").toBe(0);

  // 关栏：外部词回来，红字与行号都回到开栏前的样子
  await closeFind(page);
  await expect
    .poll(async () => (await read(page)).marks, "关栏后外部词没回来")
    .toBe(extMarks, { timeout: 15_000 });
  const back = await read(page);
  expect(back.hitGutters, "关栏后行号命中态没跟着回来").toBe(ext.hitGutters);
  expect(back.barCount).toBe(0);
  console.log(`[DF2-07] 外部词=${extMarks} 栏内词=${inBar.countText} 标红=${inBar.marks} 空词=0 关栏后=${back.marks}`);
  await page.screenshot({ path: "results/r49_udiff_find_mutual_exclude.png" });
});
