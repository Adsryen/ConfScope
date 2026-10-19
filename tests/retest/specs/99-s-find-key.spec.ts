// 轮39 R39-6 真机永久回归：查找快捷键（Ctrl+F / ⌘F / F3）的**所有权必须按焦点上下文归位**。
//
// 为什么钉成真机而不是只靠 jsdom（src/lib/findKeyOwnership.test.ts + 两个组件的用例）：
// 缺陷本身是"手顺级"的——真人是「在左侧列表点一条配置，然后按 Ctrl+F」，
// 焦点停在**不可编辑**的 `.browser-item` 上。旧判定把"activeElement 不是 body"一律当成
// 别人持有光标，于是浏览态和编辑态谁都不接管，Ctrl+F 成了死键；
// 而"焦点到底落在哪个元素"只有真浏览器（含自定义下拉、保活隐藏视图）才量得准。
//
// 判据来自 prd.md 的取证表（改判据必须先重跑取证，不许放宽断言）：
//   焦点上下文                    期望
//   ---------------------------  ----------------------------------------
//   .side-nav-item（刚进页面）    开栏
//   .browser-item（点了配置）     开栏，输入词后有命中 + 行号高亮
//   .fmt-bar .sel-trigger         开栏
//   .browser-search 搜索框        **让位**，代码区查找栏不许出现
//   pre.code-area（正文）         开栏，F3 能跳，Esc 后 ⌕ 浮标回来
//
// 断言一律走"可见实例"：keep-alive 的 `.browse-cache` 里藏着一整套隐藏 DOM
// （`.code-view` 类名在隐藏后仍然留在页面里——旧编辑态正是拿它猜"浏览态会不会抢"，
// 才把不挂监听的视图算成会抢）。所有权注册表 `data-find-key-owner` 由视图与监听同生同灭，
// 所以这里同时钉"注册表里只有真挂着监听的那一个"。
import { expect, type Page } from "@playwright/test";
import { test } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog } from "./ui";

const DATA_ID = "svc-legacy-prod.yaml";
/** svc-legacy-prod.yaml 里确实存在的键名（内容搜索与查找栏共用同一份数据）。 */
const TERM = "module";

const visible = (page: Page, sel: string) => page.locator(sel).filter({ visible: true });

/** 焦点落在哪儿：`TAG.class.class`，与取证表同一读法。 */
function activeTag(): string {
  const el = document.activeElement;
  if (!el) return "";
  const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).join(".") : "";
  return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`;
}

/** 当前"真的挂着查找快捷键监听"的视图根（所有权注册表）。 */
function ownerIds(): string[] {
  return Array.from(document.querySelectorAll("[data-find-key-owner]")).map((el) => {
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).join(".") : "";
    return `${el.tagName.toLowerCase()}.${cls}${el.closest("[hidden]") ? " (hidden)" : ""}`;
  });
}

async function readActive(page: Page): Promise<string> {
  return page.evaluate(activeTag);
}

async function readOwners(page: Page): Promise<string[]> {
  return page.evaluate(ownerIds);
}

async function bootstrap(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
}

/** 进配置浏览并选中一条真实配置（353 行、17KB，正文与左列都有滚动余量）。 */
async function selectConfig(page: Page): Promise<void> {
  await visible(page, ".browser-item-id").filter({ hasText: DATA_ID }).first().click();
  await expect(visible(page, ".code-area").first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(400);
}

/** 按 Ctrl+F，断言查找栏开/不开，并把状态打进日志（与取证表逐行对齐）。 */
async function pressFind(page: Page, focusDesc: string, wantOpen: boolean): Promise<void> {
  const active = await readActive(page);
  await page.keyboard.press("Control+f");
  await page.waitForTimeout(500);
  const bars = await visible(page, ".code-find-input").count();
  console.log(`| ${focusDesc} | activeElement=${active} | 查找栏=${bars} | 期望=${wantOpen ? "1" : "0"} |`);
  if (wantOpen) {
    expect(bars, `焦点在「${focusDesc}」时 Ctrl+F 没开栏（activeElement=${active}）`).toBe(1);
    const owners = await readOwners(page);
    expect(owners.length, `所有权注册表应当只有正在接管的那个视图，实测 ${owners.join(",")}`).toBe(1);
    expect(owners[0], `注册表里挂着隐藏视图，等于把旧那条 .code-view 猜测请回来了：${owners.join(",")}`).not.toContain("(hidden)");
  } else {
    expect(bars, `焦点在「${focusDesc}」里时页面根本没有文本光标，不该让查找栏死掉`).toBe(0);
  }
  if (wantOpen) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    expect(await visible(page, ".code-find-input").count(), "Esc 后查找栏没收").toBe(0);
  }
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("R39-6 配置浏览：不可编辑焦点按 Ctrl+F 必须就地开栏，搜索框持有光标时必须让位", async ({ page, retest }) => {
  test.setTimeout(240_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);

  // 取证 #0：刚点进「配置浏览」还没选文件——页面里没有查找宿主，
  // Ctrl+F 不该凭空弹一条无主的栏（轮39 第一轮探针把这条记成死键，是取证口径错了：
  // 那时 `.code-view` 根本还没渲染。真正的缺陷从"已打开文件"起算）。
  await navigate(page, "配置浏览");
  await expect(visible(page, ".browser-item").first()).toBeVisible({ timeout: 30_000 });
  expect(await readActive(page), "导航后焦点应当落在侧边导航项").toContain("side-nav-item");
  expect(await readOwners(page), "没有打开配置时不该有视图认领 Ctrl+F").toEqual([]);
  await page.keyboard.press("Control+f");
  await page.waitForTimeout(400);
  console.log(`| 未选文件（.side-nav-item active，无宿主） | 查找栏=${await visible(page, ".code-find-input").count()} | 期望=0 |`);
  expect(await visible(page, ".code-find-input").count(), "没有代码视图时凭空弹栏 = 栏没有归属").toBe(0);

  // 取证 #1：左侧列表点一条配置——用户最自然的手顺，旧判定在这里是死键
  await selectConfig(page);
  expect(await readActive(page), "点列表行后焦点应当留在该行上").toContain("browser-item");
  await pressFind(page, "点了配置列表项（.browser-item active）", true);

  // 取证 #2：文件已打开，焦点停在侧边导航项（用户点完配置又点了下导航）——同样是不可编辑焦点
  await navigate(page, "配置浏览");
  expect(await readActive(page), "再点一次导航后焦点应回到导航项").toContain("side-nav-item");
  await expect(visible(page, ".code-area").first()).toBeVisible({ timeout: 10_000 });
  await pressFind(page, "已打开配置 + 焦点在 .side-nav-item", true);

  // 取证 #3：格式下拉的触发按钮（自定义 Select，不是原生 select）
  await visible(page, ".fmt-bar .sel-trigger").first().focus();
  expect(await readActive(page)).toContain("sel-trigger");
  await pressFind(page, "格式下拉触发器（BUTTON.sel-trigger）", true);

  // 取证 #6：正文里按（轮3/轮8 的既有手顺，不许回退）
  await visible(page, ".code-area")
    .first()
    .click({ position: { x: 40, y: 40 } });
  await page.waitForTimeout(150);
  expect(await readActive(page)).toContain("code-area");
  await pressFind(page, "代码正文（PRE.code-area）", true);

  // 取证 #7：焦点在左侧列表搜索框里 → 谁都不许抢（原生查找/输入法归那个框）
  await visible(page, ".browser-search .search-input").first().click();
  expect(await readActive(page), "点列表搜索框后光标应在框里").toContain("search-input");
  await pressFind(page, "左侧列表搜索框（INPUT.search-input）", false);
  expect(await readActive(page), "让位之后焦点还必须在搜索框里").toContain("search-input");

  await page.screenshot({ path: "results/v39_find_key_browse.png", fullPage: false });
});

test("R39-6 配置浏览：开栏后能搜到命中、行号跟着高亮，Esc 后 ⌕ 浮标回到可 Tab 态", async ({ page, retest }) => {
  test.setTimeout(240_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);
  await navigate(page, "配置浏览");
  await selectConfig(page);

  // 用户手顺：点列表项 → Ctrl+F → 直接敲词
  await page.keyboard.press("Control+f");
  const findInput = visible(page, ".code-find-input").first();
  await expect(findInput, "点完列表项按 Ctrl+F 必须直接能敲词").toBeVisible({ timeout: 10_000 });
  await expect(findInput).toBeFocused({ timeout: 5_000 });
  await findInput.fill(TERM);
  await expect(visible(page, "mark.search-hit").first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(400);
  expect(await visible(page, "mark.search-hit").count(), "搜索内容必须标红").toBeGreaterThan(0);
  expect(await visible(page, "mark.search-hit-current").count(), "当前命中只许有一处").toBe(1);
  expect(await visible(page, ".code-line.is-current").count(), "命中所在行必须高亮").toBe(1);
  expect(await visible(page, ".code-ln.is-current").count(), "行号所在行要跟着高亮").toBe(1);

  // F3 继续导航（所有权判定的第 1 支：按键来自查找栏自己）
  const currentBefore = await visible(page, ".code-find-count").first().innerText();
  await page.keyboard.press("F3");
  await page.waitForTimeout(300);
  const currentAfter = await visible(page, ".code-find-count").first().innerText();
  console.log(`F3 前=${currentBefore.trim()} F3 后=${currentAfter.trim()}`);
  expect(currentAfter.trim(), "F3 没有跳到下一处命中").not.toBe(currentBefore.trim());
  expect(await visible(page, "mark.search-hit-current").count(), "F3 之后当前命中还是只能有一处").toBe(1);

  // Esc 关栏：焦点回到被查找的那一层，⌕ 浮标回来且可以 Tab 到
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  expect(await visible(page, ".code-find-input").count(), "Esc 后查找栏没收").toBe(0);
  const reopen = visible(page, ".code-find-open").first();
  await expect(reopen, "关栏后必须留一个能 Tab 到的 ⌕ 浮标").toBeVisible({ timeout: 5_000 });
  expect(await reopen.getAttribute("tabindex"), "⌕ 浮标不该被锁在 Tab 序列之外").not.toBe("-1");
  expect(await readActive(page), "Esc 后焦点该还给正文层").toContain("code-area");

  await page.screenshot({ path: "results/v39_find_key_hits.png", fullPage: false });
});

test("R39-6 编辑态：隐藏的浏览态不参与所有权，焦点在不可编辑控件上 Ctrl+F 只开一条栏", async ({ page, retest }) => {
  test.setTimeout(240_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);
  await navigate(page, "配置浏览");
  await selectConfig(page);

  // 切到编辑态：浏览态 CodeView 从分支里卸掉，编辑态 CodeEditor 成为唯一的监听者
  await page.getByRole("button", { name: "编辑", exact: true }).first().click();
  await expect(visible(page, ".code-editor-ta").first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(400);

  // 焦点在编辑区（既有手顺，轮8）
  await visible(page, ".code-editor-ta")
    .first()
    .click({ position: { x: 30, y: 20 } });
  expect(await readActive(page)).toContain("code-editor-ta");
  await pressFind(page, "编辑区 textarea", true);

  // 焦点在编辑态那排按钮里的格式下拉触发器上（本轮的缺陷面：旧判定这里必死）
  await visible(page, ".fmt-bar .sel-trigger").first().focus();
  expect(await readActive(page)).toContain("sel-trigger");
  await pressFind(page, "编辑态格式下拉触发器", true);

  // 开栏后能直接搜：只许编辑区那一条栏
  await page.keyboard.press("Control+f");
  await expect(visible(page, ".code-editor .code-find-input").first()).toBeVisible({ timeout: 10_000 });
  expect(await visible(page, ".code-find-input").count(), "两个视图同时接管 = 弹两条查找栏").toBe(1);
  const owners = await readOwners(page);
  expect(owners, "编辑态的所有权注册表应当只有 .code-editor").toEqual(["div.code-editor"]);
  await visible(page, ".code-editor .code-find-input").first().fill(TERM);
  await expect(visible(page, ".code-editor mark.search-hit").first()).toBeVisible({ timeout: 10_000 });
  expect(await visible(page, ".code-editor mark.search-hit").count(), "编辑态命中也要标红").toBeGreaterThan(0);
  expect(await visible(page, ".code-editor .code-ln.is-current").count(), "编辑态命中所在行号也要高亮").toBe(1);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);

  await page.screenshot({ path: "results/v39_find_key_edit.png", fullPage: false });
});
