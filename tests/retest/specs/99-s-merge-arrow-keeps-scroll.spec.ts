// r134 缺陷 A：「应用到右侧」的箭头点完，两侧编辑框滚动条跳到最顶端（用户原话见派工单）。
//
// 静态定位（2026-10-29，chromium 真机取证前）：批量结果区点行中「拿左侧到右侧预览」箭头
// → DiffView.setMergeSelection 只更新 mergePreviews → DiffPanel 的 rightText prop 变化 →
// DiffPanel 里 useScrollResetOnContentChange(bodyRef, [leftText, rightText], …)（轮48 加的
// 「换内容归零」，本意是切 dataId 后正文别停在上一份文件的偏移）分不清「换文件」与
// 「同一份文件被合并改内容」，rightText 一变就把唯一滚动容器 .diff-body 的
// scrollTop/scrollLeft 归零——左右两列同处这一个容器里，于是「两侧一起跳到顶端」。
// 本文件把这条链真机钉死：
//   MA-01 正文滚动位置在箭头点击后必须保住（当前实现预期红——红就是缺陷本身）；
//   MA-02 已打开的「微调右侧」抽屉里的编辑框（真·受控 textarea）在箭头点击后
//         滚动与草稿都不许动（工单「首要嫌疑」= 受控 textarea 被重新赋值归零；
//         此条若绿，该嫌疑出局，归零只能是 .diff-body 那条 hook）。
//
// 点击一律走 DOM click（page.evaluate 内 el.click()）：Playwright 的 locator.click()
// 会把元素滚进视口，先污染再测量就没法区分「谁动的手」。
import { test, expect } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog, setDiffSource } from "./ui";
import { loadRetestState } from "../state";

const state = loadRetestState();
const NS_A = state.nacos.a.namespace;
const NS_B = state.nacos.b.namespace;
const GROUP = "RETEST-PROD";

const ARROW_SEL = ".batch-diff-main button[aria-label='拿左侧到右侧预览']";
/** 滚动位置允许的自然抖动（px）：布局重排不该动 scrollTop，2px 内视为没动（MA-02 用，那条里草稿和滚动都不该有任何变化）。 */
const SCROLL_TOLERANCE_PX = 2;
/** 一行行高（styles.css 的 `.diff-row { min-height: 19px }`），MA-01 用它当「允许重排」的上限。 */
const ROW_HEIGHT_PX = 19;

async function enterBatchGatewayDiff(page: import("@playwright/test").Page) {
  await navigate(page, "配置对比");
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".match-list")).toBeVisible({ timeout: 30_000 });
  await page.locator(".match-toggle-all input").check();
  await page
    .getByRole("button", { name: /对比选中/ })
    .last()
    .click();
  await expect(page.locator(".batch-diff .batch-diff-nav-item").first()).toBeVisible({ timeout: 60_000 });
  await page.locator(".batch-diff-nav-item", { hasText: "svc-gateway.yaml" }).first().click();
  await expect(page.locator(".batch-diff-main .diff-panel")).toBeVisible({ timeout: 30_000 });
}

/** 量 .diff-body 自身 + 可滚祖先链：跳顶发生在哪一层，读数自己说话。 */
async function readBodyScroll(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const body = document.querySelector(".batch-diff-main .diff-panel .diff-body") as HTMLElement;
    if (!body) throw new Error("diff-body 不在");
    const self = { top: body.scrollTop, left: body.scrollLeft, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight };
    const chain: Array<{ tag: string; cls: string; top: number; scrollable: boolean }> = [];
    for (let el: HTMLElement | null = body.parentElement; el; el = el.parentElement) {
      const scrollable = el.scrollHeight > el.clientHeight + 1;
      chain.push({
        tag: el.tagName.toLowerCase(),
        cls: el.className ? String(el.className).split(" ")[0] : "",
        top: el.scrollTop,
        scrollable,
      });
      if (el === document.documentElement) break;
    }
    return { self, chain };
  });
}

/**
 * 每行的高度（按 DOM 序）+ 视口上方那些行的累计高度。
 * 用在 MA-01 的留痕上：合并只改一行的正文，若 scrollTop 有小偏移，得说清它是
 * 「上方某行重排后变矮/变高」这种内容重排，还是「有人又把滚动归零了一次」。
 */
async function readRowGeometry(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const body = document.querySelector(".batch-diff-main .diff-panel .diff-body") as HTMLElement;
    const rows = Array.from(body.querySelectorAll<HTMLElement>(".diff-row"));
    const heights = rows.map((r) => r.offsetHeight);
    const viewTop = body.getBoundingClientRect().top;
    let aboveViewport = 0;
    let firstVisibleIndex = -1;
    rows.forEach((r, i) => {
      if (r.getBoundingClientRect().bottom <= viewTop) aboveViewport += heights[i];
      else if (firstVisibleIndex < 0) firstVisibleIndex = i;
    });
    return { rowCount: rows.length, heights, aboveViewport, firstVisibleIndex, scrollTop: body.scrollTop };
  });
}

/** 逐行高度差，只留下真的变了的行（没有变化就返回空数组，不拿 354 个 0 去刷屏）。 */
function diffRowHeights(before: number[], after: number[]) {
  const out: { index: number; from: number; to: number }[] = [];
  const n = Math.min(before.length, after.length);
  for (let i = 0; i < n; i += 1) {
    if (before[i] !== after[i]) out.push({ index: i, from: before[i], to: after[i] });
  }
  if (after.length !== before.length) out.push({ index: -1, from: before.length, to: after.length });
  return out;
}

/** 把 .diff-body 滚到可滚区间的 50%，读回确认（防止「没滚上去」的假测量）。 */
async function scrollToMidBody(page: import("@playwright/test").Page): Promise<{ top: number; left: number }> {
  return page.evaluate(() => {
    const body = document.querySelector(".batch-diff-main .diff-panel .diff-body") as HTMLElement;
    const max = body.scrollHeight - body.clientHeight;
    if (max < 200) throw new Error(`diff-body 可滚空间太小（max=${max}），这条判据没有测量意义`);
    body.scrollTop = Math.floor(max / 2);
    body.scrollLeft = 0;
    return { top: body.scrollTop, left: body.scrollLeft };
  });
}

/** DOM click 第一个可用箭头，返回点击到的 aria-label（防 Playwright 自动滚动污染）。 */
async function domClickFirstArrow(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate((sel) => {
    const btns = Array.from(document.querySelectorAll(sel)) as HTMLButtonElement[];
    const btn = btns.find((b) => !b.disabled && b.offsetParent !== null);
    if (!btn) throw new Error(`没有可用箭头（共 ${btns.length} 颗，全部 disabled 或不可见）`);
    btn.click();
    return btn.getAttribute("aria-label") ?? "";
  }, ARROW_SEL);
}

async function bootstrap(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
}

test("MA-01 点「拿左侧到右侧预览」后 .diff-body 滚动位置必须保住", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);
  await enterBatchGatewayDiff(page);

  await expect(page.locator(".merge-draft-summary")).toContainText("尚未产生合并预览", { timeout: 10_000 });

  // 点击前：滚到正文中部
  await scrollToMidBody(page);
  const before = await readBodyScroll(page);
  expect(before.self.top, "前置：滚动没有落到 50% 位置，测量无效").toBeGreaterThan(100);
  const rowsBefore = await readRowGeometry(page);

  await domClickFirstArrow(page);
  // 合并必须真实发生（摘要计数 + 行级 merge 标记），否则后面读到的 0 没有归因
  await expect(page.locator(".merge-draft-summary")).toContainText(/待带入右侧 \d+ 个文件/, { timeout: 10_000 });
  const mergeRows = await page.locator(".batch-diff-main .diff-row.merge-left-to-right").count();
  expect(mergeRows, "合并没有落到行上，这条判据空转").toBeGreaterThan(0);

  const after = await readBodyScroll(page);
  const rowsAfter = await readRowGeometry(page);
  console.log(
    `[MA-01 滚动留痕] 点击前 scrollTop=${before.self.top} scrollLeft=${before.self.left}（scrollHeight=${before.self.scrollHeight} clientHeight=${before.self.clientHeight}）` +
      ` → 点击后 scrollTop=${after.self.top} scrollLeft=${after.self.left}（scrollHeight=${after.self.scrollHeight} clientHeight=${after.self.clientHeight}）；merge 行=${mergeRows}` +
      `；祖先链=${JSON.stringify(before.chain.filter((c) => c.scrollable))}（可滚层）`
  );
  console.log(
    `[MA-01 重排留痕] 行数 ${rowsBefore.rowCount} → ${rowsAfter.rowCount}；首个可见行 ${rowsBefore.firstVisibleIndex} → ${rowsAfter.firstVisibleIndex}` +
      `；视口上方累计行高 ${rowsBefore.aboveViewport} → ${rowsAfter.aboveViewport}（差 ${rowsAfter.aboveViewport - rowsBefore.aboveViewport}）` +
      `；逐行高度变化 ${JSON.stringify(diffRowHeights(rowsBefore.heights, rowsAfter.heights))}`
  );

  // 判据是「用户正看着的那一行还在那一行」，不是「scrollTop 一个像素都不许动」：
  // 合并会改正文、行数 114 → 115、行高也会重排（实测 index=1 那行 24 → 19，视口上方累计少 5px），
  // 这 5px 是内容自己的位移，谁也拦不住。拦住的是「整屏弹回开头」这件事。
  // 2026-10-29 修复前后各跑一次：修复前 scrollTop 1057 → 0、首个可见行 47 → 0；
  // 修复后 scrollTop 1057 → 1052（正好等于上方重排的 -5）、首个可见行 47 → 47。
  expect(
    rowsAfter.firstVisibleIndex,
    `点箭头把视口弹回了文件开头：首个可见行 ${rowsBefore.firstVisibleIndex} → ${rowsAfter.firstVisibleIndex}` +
      `（scrollTop ${before.self.top} → ${after.self.top}）。同一份文件被合并改内容不是换文件，不该触发归零。`
  ).toBe(rowsBefore.firstVisibleIndex);
  expect(after.self.top, "滚动位置落到了顶端：缺陷 A 复发").toBeGreaterThan(100);
  // 允许的重排上限 = 一行行高。超过它就是「弹走了不止一行」，得单独归因，不许混在重排里过。
  expect(
    Math.abs(after.self.top - before.self.top),
    `scrollTop 偏移 ${after.self.top - before.self.top}px 超过一行行高，不像内容重排，像有人又动了一次滚动`
  ).toBeLessThanOrEqual(ROW_HEIGHT_PX);
  await page.screenshot({ path: "results/ma01-merge-arrow-scroll.png" });
});

test("MA-02 已打开的微调抽屉：箭头点击不许动它的滚动与草稿（受控 textarea 嫌疑的对照测量）", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);
  await enterBatchGatewayDiff(page);

  // 打开「微调右侧」抽屉（批量结果头部的 tune-toggle）
  await page.locator(".batch-diff-main .tune-toggle").first().click();
  const tuneTa = page.locator(".diff-tune-panel .code-editor-ta");
  await expect(tuneTa).toBeVisible({ timeout: 10_000 });

  const before = await page.evaluate(() => {
    const ta = document.querySelector(".diff-tune-panel .code-editor-ta") as HTMLTextAreaElement;
    const pre = document.querySelector(".diff-tune-panel .code-editor-pre") as HTMLElement;
    if (!ta || !pre) throw new Error("微调抽屉里的编辑框不在");
    const max = ta.scrollHeight - ta.clientHeight;
    if (max < 100) throw new Error(`微调编辑框可滚空间太小（max=${max}），测量无意义`);
    ta.scrollTop = Math.floor(max / 2);
    return {
      taTop: ta.scrollTop,
      taLeft: ta.scrollLeft,
      preTop: pre.scrollTop,
      preLeft: pre.scrollLeft,
      valueLen: ta.value.length,
      valueHead: ta.value.slice(0, 40),
    };
  });
  // 给 onScroll→syncScroll 一拍，读 pre 的最终跟手值
  await page.waitForTimeout(200);
  const beforeSync = await page.evaluate(() => {
    const pre = document.querySelector(".diff-tune-panel .code-editor-pre") as HTMLElement;
    return { preTop: pre.scrollTop, preLeft: pre.scrollLeft };
  });

  await domClickFirstArrow(page);
  await expect(page.locator(".merge-draft-summary")).toContainText(/待带入右侧 \d+ 个文件/, { timeout: 10_000 });

  const after = await page.evaluate(() => {
    const ta = document.querySelector(".diff-tune-panel .code-editor-ta") as HTMLTextAreaElement;
    const pre = document.querySelector(".diff-tune-panel .code-editor-pre") as HTMLElement;
    return {
      taTop: ta.scrollTop,
      taLeft: ta.scrollLeft,
      preTop: pre.scrollTop,
      preLeft: pre.scrollLeft,
      valueLen: ta.value.length,
      valueHead: ta.value.slice(0, 40),
    };
  });
  console.log(
    `[MA-02 微调抽屉留痕] ta.scrollTop ${before.taTop} → ${after.taTop}（pre 跟手 ${beforeSync.preTop} → ${after.preTop}）` +
      `；草稿 value.length ${before.valueLen} → ${after.valueLen}` +
      `；value 头 ${JSON.stringify(before.valueHead)} → ${JSON.stringify(after.valueHead)}`
  );

  expect(
    Math.abs(after.taTop - before.taTop),
    `箭头点击把微调编辑框从 scrollTop=${before.taTop} 拽到 ${after.taTop}：抽屉里这份草稿的 value 没有变，` +
      `受控 textarea 不该有任何理由动（工单首要嫌疑若成立，红的应该正是这里）`
  ).toBeLessThanOrEqual(SCROLL_TOLERANCE_PX);
  expect(
    Math.abs(after.preTop - after.taTop),
    `pre 层没跟上 textarea（ta=${after.taTop} pre=${after.preTop}），两层滚动分叉`
  ).toBeLessThanOrEqual(SCROLL_TOLERANCE_PX);
  expect(after.valueLen, "草稿被箭头点击动了长度：合并预览与微调草稿是两份状态，不许互串").toBe(before.valueLen);
  await page.screenshot({ path: "results/ma02-tune-drawer-untouched.png" });
});
