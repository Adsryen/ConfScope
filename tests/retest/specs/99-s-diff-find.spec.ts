// 轮48 真机永久回归：并排差异正文（DiffPanel）接入文件内查找。
//
// 为什么钉成真机：这一轮的三条判据全都只在真浏览器里成立——
// 1. 命中行「居中」靠量 DOM 矩形（.diff-cell 是 pre-wrap + break-all，行高公式不成立）；
// 2. 关栏后净空归零、第一行回到原位，靠的是锚点高度与滚动位置的联动；
// 3. Ctrl+F 的所有权要看焦点落在 .diff-body 还是别的视图的隐藏 DOM 上。
// jsdom 量不出矩形，写出来的只能是「函数被调了」而不是「屏幕动了」。
//
// 手顺（与真人一致）：配置对比 → 选两侧来源 → 加载并对比 → 正文里按 Ctrl+F / 点 ⌕ → 敲词 → Enter 步进。
// 数据用播种好的 svc-gateway.yaml（左 83 行 / 右 98 行，命中分散在全文，滚动有余量）。
//
// 用例：
//   DF-01 两个入口都能开栏（⌕ 浮标 + Ctrl+F），且同时只有一条查找栏
//   DF-02 命中词标红 + 所在行行号变红 + 行号本身照常显示 + 当前命中恒为一组
//   DF-03 Enter 逐「行」步进，当前行始终与正文可视区重叠，滚动位置真的动过
//   DF-04 关栏：净空锚点归零、第一行回到原位、⌕ 浮标回来、焦点还给正文
//   DF-05 Aa / ab| 与浏览态同一把尺子（只会收窄命中）
//   DF-06 勾上「仅显示变更」后编号不失联（每一步都落在 DOM 里真实存在的行上）
//   DF-07 批量态换文件：正文滚动归零（本轮修的 useScrollResetOnContentChange 漏接）
import { expect, type Page } from "@playwright/test";
import { test } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog, setDiffSource } from "./ui";
import { loadRetestState } from "../state";

const state = loadRetestState();
const NS_A = state.nacos.a.namespace;
const NS_B = state.nacos.b.namespace;
const GROUP = "RETEST-PROD";
const DATA_ID = "svc-gateway.yaml";

/** 默认口径下全文多处命中的词（"http"：URL 里小写 9 行 + 注释里大写 2 行）。 */
const TERM = "http";
/** 混合大小写 + 词边界都有差别的词：Aa / ab| 两颗开关都必须让命中变少。 */
const TOGGLE_TERM = "HTTP";
/** 分散在多行、够 Enter 走出可视区的词。 */
const STEP_TERM = "http";

interface Probe {
  scrollTop: number;
  anchorHeight: number;
  barCount: number;
  pillCount: number;
  countText: string;
  marks: number;
  currentMarks: number;
  /** 当前命中所在行（data-row-index）。 */
  currentRows: number[];
  /** 命中行的行号槽（变红的那些）。 */
  hitGutters: number;
  /** 有数字行号的槽（行号确实显示着）。 */
  numberedGutters: number;
  firstRowTop: number | null;
  /** 当前行与正文可视区是否重叠。 */
  currentRowVisible: boolean | null;
  activeElement: string;
}

// 注意：page.evaluate 只把「这一个函数」搬进浏览器，闭包里的模块级函数不会跟着过去，
// 所以取可见正文这件事必须在函数体里就地做完（keep-alive 会让别的页的 DOM 留在页面里）。
function probeDiff(): Probe {
  const body = (Array.from(document.querySelectorAll<HTMLElement>(".diff-body")).find((b) => b.offsetParent !== null) ?? null) as HTMLElement | null;
  const anchor = body ? (body.querySelector(".diff-find-anchor") as HTMLElement | null) : null;
  const bars = Array.from(document.querySelectorAll<HTMLElement>(".code-find")).filter((b) => b.offsetParent !== null);
  const pills = Array.from(document.querySelectorAll<HTMLElement>(".code-find-open")).filter((b) => b.offsetParent !== null);
  const countEl = bars.length ? bars[bars.length - 1].querySelector(".code-find-count") : null;
  const marks = body ? Array.from(body.querySelectorAll<HTMLElement>("mark.search-hit")).filter((m) => m.offsetParent !== null) : [];
  const currentMarks = marks.filter((m) => m.classList.contains("search-hit-current"));
  const rowsWithCurrent = new Set<number>();
  currentMarks.forEach((m) => {
    const row = m.closest("[data-row-index]");
    if (row) rowsWithCurrent.add(Number(row.getAttribute("data-row-index")));
  });
  const gutters = body ? Array.from(body.querySelectorAll<HTMLElement>(".diff-gutter")) : [];
  const firstRow = body ? (body.querySelector(".diff-row") as HTMLElement | null) : null;
  let currentRowVisible: boolean | null = null;
  if (body && rowsWithCurrent.size === 1) {
    const row = body.querySelector(`[data-row-index="${Array.from(rowsWithCurrent)[0]}"]`) as HTMLElement | null;
    if (row) {
      const r = row.getBoundingClientRect();
      const b = body.getBoundingClientRect();
      currentRowVisible = r.bottom > b.top + 1 && r.top < b.bottom - 1;
    }
  }
  const active = document.activeElement;
  return {
    scrollTop: body ? Math.round(body.scrollTop) : -1,
    anchorHeight: anchor ? Math.round(anchor.getBoundingClientRect().height) : -1,
    barCount: bars.length,
    pillCount: pills.length,
    countText: countEl ? (countEl.textContent ?? "").trim() : "",
    marks: marks.length,
    currentMarks: currentMarks.length,
    currentRows: Array.from(rowsWithCurrent).sort((a, b) => a - b),
    hitGutters: gutters.filter((g) => g.classList.contains("is-hit")).length,
    numberedGutters: gutters.filter((g) => /^\d+$/.test((g.textContent ?? "").trim())).length,
    firstRowTop: firstRow ? Math.round(firstRow.getBoundingClientRect().top) : null,
    currentRowVisible,
    activeElement: active ? `${active.tagName.toLowerCase()}.${typeof active.className === "string" ? active.className.trim().split(/\s+/).join(".") : ""}` : "",
  };
}

async function readDiff(page: Page): Promise<Probe> {
  return page.evaluate(probeDiff);
}

/** 命中总数（"第 3/11 处" 里那个 11）。触顶时是 "第 3/5000+ 处"，取分母即可。 */
function totalCount(text: string): number | null {
  const found = /第\s*\d+\s*\/\s*(\d+)/.exec(text);
  return found ? Number(found[1]) : null;
}

/** 当前序号（"第 3/11 处" 里那个 3）。 */
function currentIndex(text: string): number | null {
  const found = /第\s*(\d+)\s*\//.exec(text);
  return found ? Number(found[1]) : null;
}

async function bootstrap(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
}

/** 进对比页并加载一份单文件差异（左右各取一份真实配置）。 */
async function loadSingleDiff(page: Page): Promise<void> {
  await navigate(page, "配置对比");
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP, dataId: DATA_ID });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP, dataId: DATA_ID });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".diff-panel").filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".diff-row").filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(500);
}

/** 可见的 diff 查找条 / 输入框（用 .diff-body 里的锚点定位，避开别的视图留下的隐藏 DOM）。 */
function diffInput(page: Page) {
  return page.locator(".diff-find-anchor .code-find-input").filter({ visible: true }).first();
}

async function openFindOnBody(page: Page): Promise<void> {
  await page.locator(".diff-body").filter({ visible: true }).first().click({ position: { x: 40, y: 60 } });
  await page.keyboard.press("Control+f");
  await expect(diffInput(page)).toBeVisible({ timeout: 10_000 });
}

test("DF-01/02 对比正文：两个入口都开栏，命中标红 + 行号变红 + 当前命中恒一组", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);
  await loadSingleDiff(page);

  // 入口一：关栏态那颗 ⌕ 浮标
  const pill = page.locator(".diff-find-anchor .code-find-open").filter({ visible: true }).first();
  await expect(pill, "关栏态必须留一颗能点的 ⌕ 浮标").toBeVisible({ timeout: 10_000 });
  await pill.click();
  await expect(diffInput(page), "点 ⌕ 没开栏").toBeVisible({ timeout: 5_000 });
  await expect(diffInput(page), "开栏后焦点要在查找输入框里").toBeFocused({ timeout: 5_000 });
  let probe = await readDiff(page);
  expect(probe.barCount, "同时只许有一条可见查找栏").toBe(1);
  await page.keyboard.press("Escape");
  await expect(diffInput(page), "关栏没生效：查找输入框还在").toBeHidden({ timeout: 5_000 });

  // 入口二：焦点在正文（.diff-body，tabIndex=0）上按 Ctrl+F
  await openFindOnBody(page);
  await expect(diffInput(page), "正文里按 Ctrl+F 没开栏").toBeVisible({ timeout: 10_000 });
  probe = await readDiff(page);
  expect(probe.barCount, "两个视图同时接管 = 弹两条查找栏").toBe(1);

  await diffInput(page).fill(TERM);
  await expect
    .poll(async () => (await readDiff(page)).marks, { message: "正文里一处都不标红", timeout: 15_000 })
    .toBeGreaterThan(0);
  probe = await readDiff(page);

  // 命中词标红（红底由 .search-hit 给，守卫另有静态钉）
  expect(probe.marks, "命中处数与计数对不上").toBeGreaterThanOrEqual(totalCount(probe.countText) ?? 0);
  expect(probe.countText, "计数文案没出现「第 N/M 处」").toMatch(/第\s*\d+\s*\/\s*\d+/);
  // 当前命中恒为一组（等行左右两格同时亮，仍是「一处」）
  expect(probe.currentMarks, "当前命中的标红单元数必须 ≥ 1").toBeGreaterThanOrEqual(1);
  expect(probe.currentRows, "同时出现两个「当前行」= 步进单位算错了").toHaveLength(1);
  // 行号：照常显示（有数字的槽），且命中所在行的行号变红
  expect(probe.numberedGutters, "行号没显示出来").toBeGreaterThan(0);
  expect(probe.hitGutters, "命中所在行的行号没变红").toBeGreaterThanOrEqual(1);
  console.log(`[DF-02] ${probe.countText} 标红=${probe.marks} 行号变红=${probe.hitGutters} 当前行=${probe.currentRows[0]}`);
  await page.screenshot({ path: "results/v48_diff_find_hits.png", fullPage: false });

  await page.keyboard.press("Escape");
});

test("DF-03/04 Enter 逐行步进并真的滚动；关栏后净空归零、首行回原位", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);
  await loadSingleDiff(page);

  // 基准：滚动归零时第一行的屏幕位置（关栏后必须回到这里）
  await page.evaluate(() => {
    const body = Array.from(document.querySelectorAll<HTMLElement>(".diff-body")).find((b) => b.offsetParent !== null);
    if (body) body.scrollTop = 0;
  });
  await page.waitForTimeout(300);
  const baseline = await readDiff(page);
  expect(baseline.scrollTop).toBe(0);
  expect(baseline.anchorHeight, "关栏态的净空锚点不该占高度").toBe(0);

  await openFindOnBody(page);
  await diffInput(page).fill(STEP_TERM);
  await expect
    .poll(async () => (await readDiff(page)).marks, { message: "没有命中就无法步进", timeout: 15_000 })
    .toBeGreaterThan(0);

  const first = await readDiff(page);
  const total = totalCount(first.countText) ?? 0;
  expect(total, "分母为 0：这个词在差异正文里没命中").toBeGreaterThan(1);
  const steps = Math.min(total - 1, 6);
  const seen: number[] = [];
  let maxScrollTop = first.scrollTop;
  for (let i = 0; i < steps; i += 1) {
    await diffInput(page).press("Enter");
    await page.waitForTimeout(250);
    const after = await readDiff(page);
    seen.push(after.currentRows[0]);
    expect(after.currentRows, `第 ${i + 2} 次 Enter 出现多个当前行`).toHaveLength(1);
    expect(currentIndex(after.countText), `第 ${i + 2} 次 Enter 序号没前进（步进单位不是行）`).toBe(i + 2);
    expect(after.currentRowVisible, `第 ${i + 2} 次 Enter 后当前行不在可视区里`).toBe(true);
    maxScrollTop = Math.max(maxScrollTop, after.scrollTop);
  }
  expect(new Set(seen).size, "Enter 一直停在同一行：步进单位退回「处」了").toBe(steps);
  expect(maxScrollTop, "命中分散在全文，但正文一次都没滚起来").toBeGreaterThan(0);

  // 关栏：净空归零 + 首行回到基准位置 + 焦点还给正文 + ⌕ 浮标回来
  await page.evaluate(() => {
    const body = Array.from(document.querySelectorAll<HTMLElement>(".diff-body")).find((b) => b.offsetParent !== null);
    if (body) body.scrollTop = 0;
  });
  await page.waitForTimeout(200);
  await page.locator(".diff-find-anchor .code-find").filter({ visible: true }).first().getByRole("button", { name: "关闭查找" }).click();
  await expect(diffInput(page), "关栏没生效：查找输入框还在").toBeHidden({ timeout: 5_000 });
  const closed = await readDiff(page);
  expect(closed.anchorHeight, "关栏后净空锚点还占着高度：第一行永远让在半空").toBe(0);
  expect(closed.firstRowTop, "关栏后第一行没回到原位").toBe(baseline.firstRowTop);
  expect(closed.pillCount, "关栏后 ⌕ 浮标没回来").toBe(1);
  expect(closed.activeElement, "关栏后焦点该还给正文层").toContain("diff-body");
  console.log(`[DF-04] 步进=${steps} 最大滚动=${maxScrollTop} 首行基准=${baseline.firstRowTop} 关栏后=${closed.firstRowTop}`);
  await page.screenshot({ path: "results/v48_diff_find_closed.png", fullPage: false });
});

test("DF-05/06 Aa 与 ab| 只会收窄命中；勾「仅显示变更」后编号不失联", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);
  await loadSingleDiff(page);

  await openFindOnBody(page);
  await diffInput(page).fill(TOGGLE_TERM);
  await expect
    .poll(async () => (await readDiff(page)).marks, { message: "没有命中，口径开关无从验证", timeout: 15_000 })
    .toBeGreaterThan(0);
  const base = await readDiff(page);
  const baseTotal = totalCount(base.countText) ?? 0;
  expect(baseTotal, "默认口径下没有命中").toBeGreaterThan(1);

  const toggles = page.locator(".diff-find-anchor .code-find-toggle").filter({ visible: true });
  // Aa：区分大小写
  await toggles.nth(0).click();
  await expect
    .poll(async () => {
      const p = await readDiff(page);
      return totalCount(p.countText) ?? 0;
    }, "勾了 Aa 命中没变少（口径没接到 diff）")
    .toBeLessThan(baseTotal);
  expect(await toggles.nth(0).getAttribute("aria-pressed"), "Aa 的按压态没同步").toBe("true");

  // ab|：全词（在 Aa 已开的基础上只会更窄或持平）
  const afterCase = totalCount((await readDiff(page)).countText) ?? 0;
  await toggles.nth(1).click();
  await expect
    .poll(async () => {
      const p = await readDiff(page);
      return (totalCount(p.countText) ?? 0) > afterCase ? "变宽了" : "ok";
    }, "全词口径让命中变宽：两个宿主用的不是同一把尺子")
    .toBe("ok");
  const both = await readDiff(page);
  expect(both.marks, "两颗开关都勾上后应当仍有命中（词选错了，换 TERM 而不是放宽断言）").toBeGreaterThanOrEqual(1);
  expect(await toggles.nth(1).getAttribute("aria-pressed"), "ab| 的按压态没同步").toBe("true");
  console.log(`[DF-05] 默认=${baseTotal} 区分大小写=${afterCase} 再加全词=${totalCount(both.countText)}`);

  // 两颗都退回默认，再验「仅显示变更」
  await toggles.nth(0).click();
  await toggles.nth(1).click();
  await expect.poll(async () => totalCount((await readDiff(page)).countText) ?? 0, "取消勾选后没回到默认口径").toBe(baseTotal);

  // 勾「仅显示变更」：隐藏的行不许留在编号里，否则 Enter 会落到 DOM 里不存在的 <mark> 上
  const onlyChanges = page.locator(".diff-toggle input[type='checkbox']").filter({ visible: true }).first();
  await onlyChanges.check();
  await page.waitForTimeout(500);
  const filtered = await readDiff(page);
  const filteredTotal = totalCount(filtered.countText) ?? 0;
  expect(filteredTotal, "勾掉等行后命中数反而变多（隐藏行还留在编号里）").toBeLessThanOrEqual(baseTotal);
  expect(filtered.marks, "勾掉等行后一处都不标了：编号还指向被隐藏的行").toBeGreaterThanOrEqual(1);

  // 走完整一圈：每一步都必须落在 DOM 里真实存在、且可见的那一行上
  for (let i = 0; i < Math.max(filteredTotal, 1); i += 1) {
    await diffInput(page).press("Enter");
    await page.waitForTimeout(200);
    const step = await readDiff(page);
    expect(step.currentRows, `第 ${i + 1} 步没有当前行 = 失联`).toHaveLength(1);
    expect(step.currentMarks, `第 ${i + 1} 步没有标红单元`).toBeGreaterThanOrEqual(1);
    expect(step.currentRowVisible, `第 ${i + 1} 步的当前行不在可视区`).toBe(true);
    expect(currentIndex(step.countText), `第 ${i + 1} 步序号越界（分母 ${filteredTotal}）`).toBeLessThanOrEqual(filteredTotal);
  }
  await page.screenshot({ path: "results/v48_diff_find_only_changes.png", fullPage: false });
  await onlyChanges.uncheck();
});

test("DF-07 批量态换文件：正文滚动归零，不把上一份文件的滚动位置带过去", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);

  await navigate(page, "配置对比");
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".match-list").filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
  await page.locator(".match-toggle-all input").check();
  await page.getByRole("button", { name: /对比选中/ }).last().click();
  await expect(page.locator(".batch-diff .batch-diff-nav-item").filter({ visible: true }).first()).toBeVisible({ timeout: 60_000 });

  const items = page.locator(".batch-diff .batch-diff-nav-item").filter({ visible: true });
  expect(await items.count(), "批量结果不足 2 个文件，换不了文件").toBeGreaterThanOrEqual(2);

  await items.filter({ hasText: DATA_ID }).first().click();
  const body = page.locator(".batch-diff-main .diff-body").filter({ visible: true }).first();
  await expect(body).toBeVisible({ timeout: 30_000 });

  // 先把这份文件滚到底部，再换文件
  await openFindOnBody(page);
  await diffInput(page).fill(STEP_TERM);
  await expect
    .poll(async () => (await readDiff(page)).marks, { message: "批量态也没命中", timeout: 15_000 })
    .toBeGreaterThan(0);
  for (let i = 0; i < 4; i += 1) await diffInput(page).press("Enter");
  await page.waitForTimeout(300);
  const scrolled = await readDiff(page);
  expect(scrolled.scrollTop, "没滚起来，这条断言就是空转（换词或换文件顺序要重排）").toBeGreaterThan(0);

  // 换到下一个有差异的文件
  // 换到「不是当前这一份」的下一个文件：先按文本找出它的位置，再点同一行的另一格。
  // 不许写 items.filter((_, i) => ...)：locator.filter 只收条件对象，不收谓词函数。
  const itemCount = await items.count();
  let otherIndex = -1;
  for (let i = 0; i < itemCount; i += 1) {
    const label = await items.nth(i).innerText();
    if (!label.includes(DATA_ID)) {
      otherIndex = i;
      break;
    }
  }
  expect(otherIndex, "批量结果里除当前这份之外没有第二份可换").toBeGreaterThanOrEqual(0);
  await items.nth(otherIndex).click();
  await expect
    .poll(async () => {
      const p = await readDiff(page);
      return p.scrollTop;
    }, { message: "换文件后正文还停在上一份的滚动位置", timeout: 15_000 })
    .toBe(0);
  const next = await readDiff(page);
  expect(next.scrollTop).toBe(0);
  console.log(`[DF-07] 换文件前 scrollTop=${scrolled.scrollTop} 换文件后=${next.scrollTop}`);
  await page.screenshot({ path: "results/v48_diff_find_batch_switch.png", fullPage: false });
});
