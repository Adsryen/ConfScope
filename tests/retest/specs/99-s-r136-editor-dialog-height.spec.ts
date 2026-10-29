// r136 真机判据：变更向导第三步「微调右侧」与第四步「编辑目标内容」改成弹窗以后的两件事——
//   ① 编辑区真的随视口长高（用户原话：「这个微调页面不应该内嵌，应该做成弹窗，才能看到更多的内容」，
//      量化口径 = 900px 高视口下可视正文 ≥ 30 行；写死 300px/360px 的老尺寸一律算不合格）；
//   ② 三条出口在真浏览器里各归各位：保存成功关窗、校验失败不关窗且错误条在窗内、
//      取消 / Esc 只收起不销毁字迹（重开逐字节相同）。
//
// 与相邻 spec 的分工（不重复、不互抄）：
// - 99-s-merge-arrow-keeps-scroll MA-01/MA-02 钉「合并箭头与弹层不越界动滚动/草稿」；
// - 30-apply T-AP-05 钉「编辑后的内容真的落进库」；
// - 本文件只量尺寸与出口语义，像素与行数全部留痕，红的时候能直接说清是谁动的手。
//
// 点击一律走 DOM click（page.evaluate 内 el.click()）：Playwright 的 locator.click() 会把元素
// 滚进视口，先污染再测量就分不清「谁动的手」。
import { test, expect } from "./retestTest";
import type { Page } from "@playwright/test";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog, setDiffSource } from "./ui";
import { loadRetestState } from "../state";

const state = loadRetestState();
const NS_A = state.nacos.a.namespace;
const NS_B = state.nacos.b.namespace;
const GROUP = "RETEST-PROD";

const ARROW_SEL = ".batch-diff-main button[aria-label='拿左侧到右侧预览']";
/** 弹层本身：只有外壳带 .modal-editor，宿主内嵌时代这个选择器恒空——所以「找到 = 已弹窗化」。 */
const DIALOG = '.modal-overlay [role="dialog"].modal-editor';
const TALL = { width: 1440, height: 900 };
const SHORT = { width: 1280, height: 720 };
/** 本轮的量化诉求（PRD §2.1）：900px 视口 ≥30 行。 */
const MIN_LINES_TALL = 30;
/** 矮视口下限：低于这个数就说明编辑区又退回写死像素高了。 */
const MIN_LINES_SHORT = 20;

interface DialogGeometry {
  viewport: { w: number; h: number };
  dialog: { w: number; h: number; top: number; bottom: number };
  editor: { clientH: number; scrollH: number };
  rowH: number;
  visibleLines: number;
  contentLines: number;
  focusOnBody: boolean;
  title: string;
}

async function bootstrap(page: Page) {
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
}

/** 批量网关对比（与 99-s-merge-arrow-keeps-scroll 同一配方，这里自带一份，不去 import 别人的私有 helper）。 */
async function enterBatchGatewayDiff(page: Page) {
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

async function loadSingleCompare(page: Page, dataId: string) {
  await navigate(page, "配置对比");
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP, dataId });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP, dataId });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".diff-panel")).toBeVisible({ timeout: 30_000 });
}

async function enterPlan(page: Page) {
  await page.getByRole("button", { name: "进入配置变更计划" }).last().click();
  await expect(page.locator(".apply-ledger, .apply-item-list").first()).toBeVisible({ timeout: 30_000 });
  await page
    .locator(".apply-item-row")
    .first()
    .click()
    .catch(() => undefined);
}

async function domClickFirstArrow(page: Page): Promise<string> {
  return page.evaluate((sel) => {
    const btns = Array.from(document.querySelectorAll(sel)) as HTMLButtonElement[];
    const btn = btns.find((b) => !b.disabled && b.offsetParent !== null);
    if (!btn) throw new Error(`没有可用箭头（共 ${btns.length} 颗，全部 disabled 或不可见）`);
    btn.click();
    return btn.getAttribute("aria-label") ?? "";
  }, ARROW_SEL);
}

/** 量弹层与编辑区的几何：可视行数按 --code-row-h 折算，读数原样返回给调用方打日志。 */
async function measureDialogEditor(page: Page): Promise<DialogGeometry> {
  return page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>('.modal-overlay [role="dialog"].modal-editor');
    if (!dialog) throw new Error("编辑弹层不在：.modal-overlay [role=dialog].modal-editor 没命中");
    const editor = dialog.querySelector<HTMLElement>(".code-editor");
    const ta = dialog.querySelector<HTMLTextAreaElement>(".code-editor-ta");
    if (!editor || !ta) throw new Error("弹层里缺 .code-editor 或 .code-editor-ta");
    const dRect = dialog.getBoundingClientRect();
    // 行高取 CSS 变量本体，不写死 20：将来几何改了这条判据要跟着变，不能拿旧常量去量新尺寸。
    const rowH = Number.parseFloat(getComputedStyle(editor).getPropertyValue("--code-row-h")) || 20;
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      dialog: {
        w: Math.round(dRect.width),
        h: Math.round(dRect.height),
        top: Math.round(dRect.top),
        bottom: Math.round(dRect.bottom),
      },
      editor: { clientH: editor.clientHeight, scrollH: editor.scrollHeight },
      rowH,
      visibleLines: Math.floor(editor.clientHeight / rowH),
      contentLines: ta.value.split("\n").length,
      focusOnBody: document.activeElement === ta,
      title: dialog.querySelector(".modal-header h3")?.textContent ?? "",
    };
  });
}

function logGeometry(tag: string, g: DialogGeometry) {
  console.log(
    `[${tag}] 视口 ${g.viewport.w}x${g.viewport.h}；弹层 ${g.dialog.w}x${g.dialog.h}（top=${g.dialog.top} bottom=${g.dialog.bottom}）` +
      `；编辑区 clientHeight=${g.editor.clientH}px scrollHeight=${g.editor.scrollH}px 行高=${g.rowH}px → 可视 ${g.visibleLines} 行` +
      `（正文 ${g.contentLines} 行）；初始焦点在正文=${g.focusOnBody}；标题=${JSON.stringify(g.title)}`
  );
}

test("EDH-01 第三步「微调右侧」弹窗：900px 视口 ≥30 行，保存即关窗、解释留在主体区", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await page.setViewportSize(TALL);
  await bootstrap(page);
  await enterBatchGatewayDiff(page);

  // 先挑一行制造行级标记：保存后「标记已清空」那句解释必须有地方看得见（PRD §2.5）
  await domClickFirstArrow(page);
  await expect(page.locator(".merge-draft-summary")).toContainText(/待带入右侧 \d+ 个文件/, { timeout: 10_000 });

  await page.locator(".batch-diff-main .tune-toggle").first().click();
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(`${DIALOG} .diff-tune-panel`)).toBeVisible();
  await page.waitForTimeout(300);

  const geo = await measureDialogEditor(page);
  logGeometry("EDH-01 900px", geo);
  expect(
    geo.visibleLines,
    `编辑区只有 ${geo.visibleLines} 行（clientHeight=${geo.editor.clientH}px / 行高 ${geo.rowH}px）：` +
      `本轮要求 900px 视口下 ≥${MIN_LINES_TALL} 行，退回写死 300px 就是这个数`
  ).toBeGreaterThanOrEqual(MIN_LINES_TALL);
  expect(geo.focusOnBody, "弹层打开后初始焦点不在正文：焦点落在 × 上，回车等于关窗、首键打字丢失").toBe(true);
  // 标题必须带上「在改哪一份内容」——弹层挡住背后，用户不能再靠列表位置认文件
  expect(geo.title, `标题没带文件名：${JSON.stringify(geo.title)}`).toContain("svc-gateway.yaml");

  // 矮视口：弹层不许顶出屏幕（保存按钮点不到就是事故），编辑区也不许塌回写死高度
  await page.setViewportSize(SHORT);
  await page.waitForTimeout(400);
  const short = await measureDialogEditor(page);
  logGeometry("EDH-01 720px", short);
  expect(short.dialog.bottom, "弹层底边越出视口：矮屏上底部的保存/取消会点不到").toBeLessThanOrEqual(short.viewport.h + 1);
  expect(short.dialog.top, "弹层顶边越出视口").toBeGreaterThanOrEqual(-1);
  expect(short.visibleLines, `矮视口只剩 ${short.visibleLines} 行（编辑区 ${short.editor.clientH}px）`).toBeGreaterThanOrEqual(
    MIN_LINES_SHORT
  );
  await page.setViewportSize(TALL);
  await page.waitForTimeout(400);

  const ta = page.locator(`${DIALOG} .apply-edit-editor textarea`);
  const saveBtn = page.locator(DIALOG).getByRole("button", { name: "保存微调" });
  const marker = `retest-r136-tune-${Date.now()}`;

  // ① 校验没过不许关窗（真机查出来的口径，不是猜的）：这份网关夹具「故意重复 key」
  //    （elk / tls 各写两遍，留给重复键警告回归用），YAML 校验把重复 key 判成 error。
  //    所以拿夹具原文直接保存必须被拦下来：窗不关、错误列在弹窗里、刚写的字迹一行不许少。
  await ta.fill(`${await ta.inputValue()}\n# ${marker}\n`);
  await saveBtn.click();
  await page.waitForTimeout(600);
  await expect(page.locator(DIALOG), "校验没过却把窗关了：用户看不到错在哪，字迹还被吞").toHaveCount(1);
  await expect(page.locator(`${DIALOG} .apply-edit-errors`), "保存被拦下却没给出任何错误说明").toBeVisible();
  await expect(ta, "校验失败时刚写的字迹被重播种冲掉了").toHaveValue(new RegExp(marker));

  // ② 换成合法正文：保存即收起，连带说明留在第三步主体区
  await ta.fill(
    [
      "# ConfScope 真机判据用正文：合法 YAML、无重复 key，专为「保存即关窗」这一条",
      "gateway:",
      "  port: 8080",
      `  # ${marker}`,
      "",
    ].join("\n")
  );
  await saveBtn.click();
  await expect(page.locator(DIALOG), "保存成功弹窗还赖着：本轮口径是保存即收起").toHaveCount(0, { timeout: 10_000 });

  // 解释的去处：从抽屉里搬到第三步主体区，DiffPanel 上方可见、可手动收起
  const notice = page.locator(".diff-tune-notice");
  await expect(notice, "行级挑选标记被保存清空了，却没有任何解释留给用户").toBeVisible({ timeout: 10_000 });
  await expect(notice).toContainText("行级挑选标记");
  await page.getByRole("button", { name: "收起这条说明" }).click();
  await expect(page.locator(".diff-tune-notice")).toHaveCount(0);
  await expect(page.locator(".batch-diff .tune-badge").first(), "保存后条目上没有「已手改」标记").toBeVisible();
  await page.screenshot({ path: "results/edh01-step3-tune-dialog.png", fullPage: true });
});

test("EDH-02 第四步「编辑目标内容」弹窗：同样 ≥30 行，保存即关窗并更新预览", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await page.setViewportSize(TALL);
  await bootstrap(page);
  await loadSingleCompare(page, "svc-pay.properties");
  await enterPlan(page);

  await page.getByRole("button", { name: "编辑目标内容" }).click({ timeout: 10_000 });
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(`${DIALOG} .apply-edit-panel`)).toBeVisible();
  await page.waitForTimeout(300);

  const geo = await measureDialogEditor(page);
  logGeometry("EDH-02 900px", geo);
  expect(
    geo.visibleLines,
    `编辑区只有 ${geo.visibleLines} 行（clientHeight=${geo.editor.clientH}px）：第四步与第三步共用外壳，` +
      `不该再出现 360px/420px 那套写死尺寸`
  ).toBeGreaterThanOrEqual(MIN_LINES_TALL);
  expect(geo.focusOnBody, "初始焦点不在正文：弹层一开焦点落在 × 上，回车等于关窗").toBe(true);
  expect(geo.title, `标题没带 dataId：${JSON.stringify(geo.title)}`).toContain("svc-pay.properties");

  const ta = page.locator(`${DIALOG} .apply-edit-editor textarea`);
  const marker = `retest.r136.marker-${Date.now()}=1`;
  await ta.fill(`${await ta.inputValue()}\n${marker}\n`);
  await page.locator(DIALOG).getByRole("button", { name: "保存并重新校验" }).click();
  await expect(page.locator(DIALOG), "保存成功弹窗没收起").toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator(".apply-edit-panel"), "面板只是被遮住、并没有真的收起").toHaveCount(0);
  await expect(page.locator(".apply-diff-preview").first(), "diff 预览没跟上手改内容").toContainText(marker, {
    timeout: 10_000,
  });
  await page.screenshot({ path: "results/edh02-step4-edit-dialog.png", fullPage: true });
});

test("EDH-03 第四步校验失败不关窗：错误条必须留在弹窗内", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await page.setViewportSize(TALL);
  await bootstrap(page);
  await loadSingleCompare(page, "svc-pay.properties");
  await enterPlan(page);

  await page.getByRole("button", { name: "编辑目标内容" }).click({ timeout: 10_000 });
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 10_000 });
  const ta = page.locator(`${DIALOG} .apply-edit-editor textarea`);
  const dupKey = `retest.dup-key-${Date.now()}`;
  const base = await ta.inputValue();

  // 同一个键写两遍：Properties 走 dupKeysByLine，必然报「重复的键」
  await ta.fill(`${base}\n${dupKey}=1\n${dupKey}=2\n`);
  await page.locator(DIALOG).getByRole("button", { name: "保存并重新校验" }).click();
  await page.waitForTimeout(800);

  await expect(page.locator(DIALOG), "校验没过却把窗关了：用户看不到错在哪，字迹还被吞").toHaveCount(1);
  const errors = page.locator(`${DIALOG} .apply-edit-errors`);
  await expect(errors, "错误条跑到弹窗外面了：弹窗内看不到就该关窗").toBeVisible();
  await expect(errors).toContainText(dupKey);
  await page.screenshot({ path: "results/edh03-invalid-keeps-dialog.png" });

  // 修对了才能走出去：保存成功 = 关窗，草稿不留残骸
  await ta.fill(`${base}\n${dupKey}=1\n`);
  await page.locator(DIALOG).getByRole("button", { name: "保存并重新校验" }).click();
  await expect(page.locator(DIALOG)).toHaveCount(0, { timeout: 10_000 });
});

test("EDH-04 取消 / Esc 只收起不销毁：重开字迹逐字节相同", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await page.setViewportSize(TALL);
  await bootstrap(page);
  await loadSingleCompare(page, "svc-pay.properties");
  await enterPlan(page);

  const ta = () => page.locator(`${DIALOG} .apply-edit-editor textarea`);
  const marker = `retest.r136.keep-${Date.now()}=yes`;

  await page.getByRole("button", { name: "编辑目标内容" }).click({ timeout: 10_000 });
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 10_000 });
  await ta().fill(`${await ta().inputValue()}\n${marker}\n`);
  const draft = await ta().inputValue();

  // 出口一：Esc
  await page.keyboard.press("Escape");
  await expect(page.locator(DIALOG)).toHaveCount(0, { timeout: 10_000 });
  // 字迹留下的两条可见证据：条目行的未保存徽章 + 入口按钮文案换成「继续编辑」
  await expect(page.locator(".apply-item-row .tune-badge").first(), "有手改草稿却没在条目上标出来").toBeVisible();
  await expect(page.getByRole("button", { name: "继续编辑" }).first(), "入口按钮没变成「继续编辑」").toBeVisible({
    timeout: 10_000,
  });

  await page.getByRole("button", { name: "继续编辑" }).first().click();
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 10_000 });
  const reopened = await ta().inputValue();
  console.log(
    `[EDH-04 草稿留痕] Esc 收起前后 value.length ${draft.length} → ${reopened.length}；` +
      `逐字节相同=${draft === reopened}；marker 命中=${reopened.includes(marker)}`
  );
  expect(reopened, "Esc 收起把字迹改了或清空了：收起不等于丢弃").toBe(draft);

  // 出口二：底部「取消」按钮，同样只收起
  await page.locator(DIALOG).getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator(DIALOG)).toHaveCount(0, { timeout: 10_000 });
  await page.getByRole("button", { name: "继续编辑" }).first().click();
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 10_000 });
  expect(await ta().inputValue(), "取消按钮把草稿抹了：第四步贴着真正要写进生产的内容").toBe(draft);
  await page.screenshot({ path: "results/edh04-draft-survives-close.png" });
});

/**
 * EDH-05 · 弹窗开着时 Ctrl+F 归谁。
 *
 * 弹窗化以前，微调编辑器与背后的对比正文不会同时「在场且可达」；现在背后那份一直在 DOM 里、
 * 也一直挂着查找快捷键监听。所有权判据（`findKeyOwnership` 第 4 支）在焦点不在任何编辑器时
 * 放行「文档序第一个 owner」——弹窗里的编辑器是后渲染的，于是这一支可能把键交给背后那份，
 * 用户在弹窗里按 Ctrl+F，查找栏开在遮罩底下，看着就像「没反应」。
 * 两种落点各钉一条：① 初始焦点在正文（最常见的按法）；② 点过标题/提示后焦点离开正文。
 */
test("EDH-05 弹窗开着时 Ctrl+F 起的是弹窗里那份正文的查找栏", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await page.setViewportSize(TALL);
  await bootstrap(page);
  await enterBatchGatewayDiff(page);

  await page.locator(".batch-diff-main .tune-toggle").first().click();
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 10_000 });

  /** 读「现在开着的查找栏各属于哪一层」，比数个数更能说清是谁接的键。 */
  const openBars = () =>
    page.evaluate(() => {
      const bars = Array.from(document.querySelectorAll(".code-find")) as HTMLElement[];
      return bars.map((b) =>
        b.closest(".modal-editor") ? "dialog" : b.closest(".diff-panel") ? "diff" : b.closest(".code-view") ? "browse" : "other"
      );
    });

  // ① 焦点在弹窗正文里
  await expect(page.locator(`${DIALOG} .code-editor-ta`), "弹层打开后初始焦点不在正文").toBeFocused();
  await page.keyboard.press("Control+f");
  await expect(page.locator(`${DIALOG} .code-find`), "焦点在弹窗正文里按 Ctrl+F，弹窗内没起查找栏").toBeVisible({ timeout: 10_000 });
  expect(await openBars(), `① Ctrl+F 只该开一条查找栏且属于弹窗，实测=${JSON.stringify(await openBars())}`).toEqual(["dialog"]);

  // 收起这次的查找栏再测第二种落点。Esc 有两层语义（关查找栏 / 关弹窗），
  // 这里不赌它归谁：还在就点 ×，然后重开，保证 ② 从一个干净的弹窗开始。
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  if ((await page.locator(DIALOG).count()) > 0) {
    await page.locator(`${DIALOG} .modal-x`).click();
    await expect(page.locator(DIALOG)).toHaveCount(0, { timeout: 10_000 });
  }
  await page.locator(".batch-diff-main .tune-toggle").first().click();
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 10_000 });
  expect(await openBars(), `重开弹窗后不该留着上一条查找栏，实测=${JSON.stringify(await openBars())}`).toEqual([]);

  // ② 焦点不在任何编辑器里（用户点过标题/提示/下拉之后的常态）
  await page.locator(`${DIALOG} .modal-header h3`).click({ force: true });
  await page.waitForTimeout(200);
  const active = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el ? `${el.tagName.toLowerCase()}.${String(el.className ?? "").split(" ")[0]}` : "none";
  });
  await page.keyboard.press("Control+f");
  const bars = await openBars();
  console.log(`[EDH-05 留痕] ② 按键前焦点=${active}；开着的查找栏归属=${JSON.stringify(bars)}`);
  expect(bars, `② 焦点不在正文时按 Ctrl+F，查找栏该仍归弹窗里的编辑器，实测=${JSON.stringify(bars)}（落在遮罩背后等于没反应）`).toEqual(["dialog"]);
  await page.screenshot({ path: "results/edh05-find-in-tune-dialog.png" });
});
