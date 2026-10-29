// r134 缺陷 A：「应用到右侧」的箭头点完，两侧编辑框滚动条跳到最顶端（用户原话见派工单）。
//
// 静态定位（2026-10-29，chromium 真机取证前）：批量结果区点行中「拿左侧到右侧预览」箭头
// → DiffView.setMergeSelection 只更新 mergePreviews → DiffPanel 的 rightText prop 变化 →
// DiffPanel 里 useScrollResetOnContentChange(bodyRef, [leftText, rightText], …)（轮48 加的
// 「换内容归零」，本意是切 dataId 后正文别停在上一份文件的偏移）分不清「换文件」与
// 「同一份文件被合并改内容」，rightText 一变就把唯一滚动容器 .diff-body 的
// scrollTop/scrollLeft 归零——左右两列同处这一个容器里，于是「两侧一起跳到顶端」。
// 本文件把这条链真机钉死：
//   MA-01 正文滚动位置在箭头点击后必须保住；
//   MA-02 微调弹层打开时箭头根本够不着（命中测试落在遮罩上）；
//   MA-03 「打开微调弹层」这一下不许动正文滚动位置；
//   MA-04 取消=收起：重开还是同一份字迹（逐字节）；
//   MA-05 收起弹层后点箭头，滚动仍按 MA-01 的判据保住。
//
// r136 口径变更（本轮迁移，别照旧写回）：原先 MA-02 假设「微调抽屉内嵌在结果区上方，
// 抽屉开着还能点到底下的箭头」。现在微调是全屏弹窗（EditorDialog），背后一切被遮罩挡住，
// 那条假设整体作废——所以旧的「抽屉里 textarea 滚动不许动」拆成上面 MA-02~MA-05 四条，
// 各自钉一件事：够不着 / 开弹窗不改滚动 / 收起不丢字 / 收起后箭头仍不改滚动。
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

/** 打开批量结果区的「微调右侧」弹层，并确认编辑器真的可用（弹层 + textarea 同时可见）。 */
async function openTuneDialog(page: import("@playwright/test").Page) {
  await page.locator(".batch-diff-main .tune-toggle").first().click();
  await expect(page.locator(".modal-editor")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".diff-tune-panel .code-editor-ta")).toBeVisible({ timeout: 10_000 });
}

/** 微调编辑框当前草稿长度（做「同一份字迹」的指纹）。 */
async function readTuneValueLen(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => (document.querySelector(".diff-tune-panel .code-editor-ta") as HTMLTextAreaElement).value.length);
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

test("MA-02 微调弹层打开时，箭头被遮罩挡住（旧「抽屉里点箭头」场景已不存在）", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);
  await enterBatchGatewayDiff(page);

  await openTuneDialog(page);

  // 命中测试：箭头几何中心那一点，最上层是谁。落在遮罩上 = 点不到箭头，
  // 这正是「内嵌抽屉会被背后的箭头干扰」这类缺陷的结构性解法。
  const hit = await page.evaluate((sel) => {
    const btn = (Array.from(document.querySelectorAll(sel)) as HTMLButtonElement[]).find((b) => !b.disabled && b.offsetParent !== null);
    if (!btn) throw new Error("箭头不在，测量无意义");
    const r = btn.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) as HTMLElement;
    const chain: string[] = [];
    // 一路走到根：遮罩在很外面，只数四层就断言「落在遮罩上」是自己把判据写窄了（首轮真机红在这）
    for (let cur: HTMLElement | null = el; cur; cur = cur.parentElement) {
      chain.push(cur.tagName.toLowerCase() + (cur.className ? "." + String(cur.className).split(" ")[0] : ""));
    }
    return {
      top: chain[0] ?? "",
      chain,
      // 命中点被弹层这一层接管 = 点不到箭头。至于是挡在遮罩上还是挡在弹窗正文上，不影响结论。
      coveredByDialogLayer: el.closest(".modal-overlay") !== null,
      hitIsArrow: el.closest(sel) !== null,
    };
  }, ARROW_SEL);
  console.log(
    `[MA-02 命中留痕] 箭头中心最上层=${hit.top}；被弹层这一层接管=${hit.coveredByDialogLayer}；命中的就是箭头本身=${hit.hitIsArrow}` +
      `；祖先链=${JSON.stringify(hit.chain.slice(0, 6))}`
  );
  expect(hit.coveredByDialogLayer, `弹层开着却还能命中箭头本身：最上层=${hit.top}`).toBe(true);
  expect(hit.hitIsArrow, "elementFromPoint 直接命中箭头：遮罩没盖住它，用户还是能在微调途中点到底下的箭头").toBe(false);
  await page.screenshot({ path: "results/ma02-tune-dialog-blocks-arrow.png" });
});

test("MA-03 打开微调弹层这一下不许动正文滚动位置", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);
  await enterBatchGatewayDiff(page);

  await scrollToMidBody(page);
  const before = await readBodyScroll(page);
  expect(before.self.top, "前置：滚动没有落到 50% 位置，测量无效").toBeGreaterThan(100);

  await openTuneDialog(page);
  // 弹层挂载会带 focus trap / body 滚动锁一类的副作用，读正文滚动要等它们跑完一拍
  await page.waitForTimeout(300);
  const after = await readBodyScroll(page);
  console.log(`[MA-03 滚动留痕] 打开弹层前后 scrollTop ${before.self.top} → ${after.self.top}（scrollLeft ${before.self.left} → ${after.self.left}）`);
  expect(
    Math.abs(after.self.top - before.self.top),
    `打开微调弹层把正文从 ${before.self.top} 拽到 ${after.self.top}：弹层是盖在上面的层，不该动背后容器的滚动`
  ).toBeLessThanOrEqual(SCROLL_TOLERANCE_PX);
  await page.screenshot({ path: "results/ma03-open-dialog-keeps-scroll.png" });
});

test("MA-04 取消=收起：重开弹层字迹逐字节不变", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);
  await enterBatchGatewayDiff(page);

  await openTuneDialog(page);
  // 手写字迹：追加一行，作为「同一份草稿」的指纹
  const typed = await page.evaluate(() => {
    const ta = document.querySelector(".diff-tune-panel .code-editor-ta") as HTMLTextAreaElement;
    if (!ta) throw new Error("微调编辑框不在");
    const marker = `# retest-tune-draft-${Date.now()}`;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(ta, `${ta.value}\n${marker}`);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    return marker;
  });
  await page.waitForTimeout(200);
  const draftLen = await readTuneValueLen(page);

  await page.locator(".modal-editor .modal-footer").getByRole("button", { name: "取消" }).click();
  await expect(page.locator(".modal-editor")).toHaveCount(0, { timeout: 10_000 });

  await page.locator(".batch-diff-main .tune-toggle").first().click();
  await expect(page.locator(".modal-editor")).toBeVisible({ timeout: 10_000 });
  const reopened = await page.evaluate(() => {
    const ta = document.querySelector(".diff-tune-panel .code-editor-ta") as HTMLTextAreaElement;
    if (!ta) throw new Error("重开后编辑框不在");
    return { len: ta.value.length, hasMarker: ta.value.includes("# retest-tune-draft-") };
  });
  console.log(`[MA-04 草稿留痕] 手写字迹=${JSON.stringify(typed)}；长度 ${draftLen} → 重开 ${reopened.len}；标记仍在=${reopened.hasMarker}`);
  expect(reopened.hasMarker, "取消后重开，手写的字迹不见了：收起被实现成了丢弃").toBe(true);
  expect(reopened.len, `重开后草稿长度 ${draftLen} → ${reopened.len}，字迹不是逐字节同一份`).toBe(draftLen);
  await page.screenshot({ path: "results/ma04-cancel-keeps-draft.png" });
});

test("MA-05 收起弹层后点箭头，正文滚动仍按 MA-01 判据保住", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);
  await enterBatchGatewayDiff(page);

  // 先进一次弹层再退出，确保这条测的是「用过微调之后」的箭头，而不是干净页面
  await openTuneDialog(page);
  await page.locator(".modal-editor .modal-header .modal-x").click();
  await expect(page.locator(".modal-editor")).toHaveCount(0, { timeout: 10_000 });

  await scrollToMidBody(page);
  const before = await readBodyScroll(page);
  const rowsBefore = await readRowGeometry(page);
  expect(before.self.top, "前置：滚动没有落到 50% 位置，测量无效").toBeGreaterThan(100);

  await domClickFirstArrow(page);
  await expect(page.locator(".merge-draft-summary")).toContainText(/待带入右侧 \d+ 个文件/, { timeout: 10_000 });

  const after = await readBodyScroll(page);
  const rowsAfter = await readRowGeometry(page);
  console.log(
    `[MA-05 滚动留痕] scrollTop ${before.self.top} → ${after.self.top}；首个可见行 ${rowsBefore.firstVisibleIndex} → ${rowsAfter.firstVisibleIndex}`
  );
  expect(rowsAfter.firstVisibleIndex, `收起弹层后点箭头把视口弹回开头：首个可见行 ${rowsBefore.firstVisibleIndex} → ${rowsAfter.firstVisibleIndex}`).toBe(
    rowsBefore.firstVisibleIndex
  );
  expect(Math.abs(after.self.top - before.self.top), "滚动偏移超过一行行高").toBeLessThanOrEqual(ROW_HEIGHT_PX);
  await page.screenshot({ path: "results/ma05-arrow-after-dialog.png" });
});
