/**
 * 来源回落与设置联动（轮47 AC1 / AC2，用例号 SF-01…SF-02）。
 *
 * 立轮理由（轮47 探针 P47-B 真机读数，见 .trellis/tasks/10-20-ui-ux-47/prd.md §2.3）：
 * 删掉「正在用的来源」后，App 的回落 effect 读的是自己上一帧刚写进 cs.ui 的回声
 * ⇒ preferredConnection 的「同项目 / 同环境优先」三层判据全部失效，选中项跨环境跳到
 * 连接列表第 0 条（开发 → Development）。对配置工具这是危险落点：用户下一步的搜索、
 * 新建、应用计划会直接落在另一个环境上。
 *
 * 分工（别在这里重复单测已经钉死的东西）：
 *  SF-01 真机钉「删当前来源 ⇒ 落在同环境兄弟上、作用域条不跨环境」。单测只钉 connId 的落点，
 *        作用域条四格文案 + 页眉副标题这一整条用户可见链路只有真机能读。
 *  SF-02 真机钉「设置页改比较偏好 ⇒ 保活的对比页立刻生效」。单测能证明 useSettings 收到通知，
 *        但「不是靠重挂载把快照重读一遍」必须在真机上确认 DiffView 那一棵真的没被换掉——
 *        做法是在右面板 DOM 上打一个自定义属性，回到对比页后属性还在 ⇒ 同一个 React 实例，
 *        而命名空间顺序已经翻转 ⇒ 只能来自订阅推送。
 *
 * 环境注意：retest 种子两条连接的环境是英文 Development / Sandbox，而 UI 新建连接的默认
 * 环境是中文「开发」，两套名字别混。桥的 init 脚本每次整页加载都会重播种 cs.connections，
 * 所以 SF-01 自建自删、不留残留；SF-02 收尾把复选框勾回默认值。
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog, ensureSourcesPanelExpanded } from "./ui";
import { loadRetestState } from "../state";

const state = loadRetestState();
const BASE_A = state.nacos.a.baseUrl;
const NS_A = state.nacos.a.namespace;
const T = 20_000;

interface UiState {
  connId?: string;
  browseProject?: string;
  browseEnvironment?: string;
  browseSourceId?: string;
}
interface Conn {
  id: string;
  sourceName: string;
  environmentName: string;
}

async function readJson<T>(page: Page, key: string): Promise<T> {
  return page.evaluate(
    (k) => JSON.parse(window.localStorage.getItem(k) || "null") as T | null,
    key
  ) as Promise<T>;
}

async function boot(page: Page): Promise<void> {
  await installRetestBridge(page, state);
  await republishRetestData();
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
}

/** 连接管理页新建一条来源：项目手选 Retest Project，环境留默认「开发」。 */
async function createConn(page: Page, sourceName: string): Promise<void> {
  await navigate(page, "连接管理");
  await page.locator(".conn-create-btn").first().click();
  await page
    .locator(".conn-form")
    .getByRole("combobox", { name: /项目/ })
    .first()
    .selectOption({ label: "Retest Project" });
  await page
    .locator(".conn-form")
    .getByRole("combobox", { name: /认证方式/ })
    .first()
    .selectOption({ label: "免鉴权" });
  await page.getByRole("textbox", { name: "来源名称" }).first().fill(sourceName);
  await page.getByRole("textbox", { name: "目标地址" }).first().fill(BASE_A);
  await page.getByRole("textbox", { name: "默认命名空间" }).first().fill(NS_A);
  await page.locator(".conn-form-actions button.btn-primary", { hasText: "保存" }).click();
  await expect(page.locator(".conn-item", { hasText: sourceName }).first()).toBeVisible({ timeout: T });
}

/** 两步确认删除一条来源（第一下进确认态，第二下才真删）。 */
async function deleteConn(page: Page, sourceName: string): Promise<void> {
  await navigate(page, "连接管理");
  const item = page.locator(".conn-item", { hasText: sourceName }).first();
  await expect(item).toBeVisible({ timeout: T });
  await item.locator(".conn-item-del").first().click();
  await expect(item.locator(".conn-item-del.confirm", { hasText: "删除连接" }).first()).toBeVisible({
    timeout: 5_000,
  });
  await item.locator(".conn-item-del.confirm").first().click();
  await expect(page.locator(".conn-item", { hasText: sourceName })).toHaveCount(0, { timeout: T });
}

/** 浏览页作用域条四格文案：项目 / 环境 / 来源 / 命名空间。 */
async function scopeTriggers(page: Page): Promise<string[]> {
  await navigate(page, "配置浏览");
  const triggers = page.locator(".page-header .browse-scope-field .sel-trigger");
  await expect(triggers.nth(1)).toBeEnabled({ timeout: T });
  await page.waitForTimeout(1_200);
  // 触发器文本自带下拉箭头字形（真机实测 "开发▾"），断言前先剥掉，别把 UI 字形混进语义判据。
  return triggers.evaluateAll((els) =>
    els.map((el) => (el.textContent || "").replace(/[\u25be\u25b4\u2304\u2303]/g, "").trim())
  );
}

async function openScopeMenu(page: Page, index: number): Promise<Locator> {
  const trigger = page.locator(".page-header .browse-scope-field .sel-trigger").nth(index);
  await trigger.click({ force: true, timeout: 10_000 });
  const menu = page.locator(".sel-menu-portal");
  await expect(menu).toBeVisible({ timeout: 10_000 });
  return menu;
}

async function clickScopeOption(menu: Locator, text: string): Promise<void> {
  const opt = menu.locator(".sel-option", { hasText: text }).first();
  await expect(opt).toBeVisible({ timeout: 10_000 });
  const box = await opt.boundingBox();
  if (box) await menu.page().mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  else await opt.evaluate((el) => el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  await expect(menu).toBeHidden({ timeout: 10_000 });
}

// ---------------------------------------------------------------- SF-02 用的读序工具

/** 对比页右侧（目标）来源面板。 */
function rightPanel(page: Page): Locator {
  return page
    .locator(".source-picker")
    .filter({ has: page.locator('.source-title:has-text("目标（右）")') })
    .first();
}

/** 打开命名空间下拉读全部选项文本，读完 Escape 收起（不改动当前选择）。 */
async function openNamespaceOrder(page: Page, panel: Locator): Promise<string[]> {
  await ensureSourcesPanelExpanded(page);
  const field = panel
    .locator('label.field:has(> span:has-text("命名空间"))')
    .filter({ visible: true })
    .first();
  const trigger = field.locator(".sel").first().locator(".sel-trigger");
  await trigger.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
  await trigger.click({ force: true, timeout: 10_000 }).catch(() => undefined);
  const menu = page.locator(".sel-menu-portal");
  if ((await menu.count()) === 0) await trigger.evaluate((el) => (el as HTMLElement).click());
  await expect(menu).toBeVisible({ timeout: 10_000 });
  const texts = ((await menu.locator(".sel-option").allInnerTexts()) as string[]).map((s) => s.trim());
  await page.keyboard.press("Escape");
  if (await menu.isVisible().catch(() => false)) await trigger.evaluate((el) => (el as HTMLElement).click());
  await expect(menu).toBeHidden({ timeout: 10_000 });
  return texts;
}

/**
 * 等右侧命名空间候选到齐再返回：B 连接的真实命名空间是 retest-qa，
 * 复测桥还给 B 追加了哨兵 "B 侧 (prod)"（bridge/retestBinding.ts）。
 * 两条同时在列才有「服务端返回顺序」与「字典顺序」的差别，才判得动不动排序开关。
 */
async function namespaceOrder(page: Page, panel: Locator): Promise<string[]> {
  let last: string[] = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    last = await openNamespaceOrder(page, panel);
    const hasQa = last.some((text) => text.includes("retest-qa"));
    const hasSentinel = last.some((text) => text.includes("B 侧"));
    if (hasQa && hasSentinel) return last;
    await page.waitForTimeout(800);
  }
  throw new Error(`命名空间候选不齐，判不了顺序（读到=${JSON.stringify(last)}）`);
}

/** 按名称在选项里取位次（找不到返回 -1，失败信息里直接给出全部读数）。 */
function indexOfNs(order: string[], needle: string): number {
  const i = order.findIndex((text) => text.includes(needle));
  expect(i, `选项里没有 "${needle}"（全部=${JSON.stringify(order)}）`).toBeGreaterThanOrEqual(0);
  return i;
}

async function nsCheckbox(page: Page): Promise<Locator> {
  const box = page
    .locator("#settings-compare .settings-setting-row")
    .filter({ has: page.locator("input[type=checkbox]") })
    .nth(1)
    .locator("input[type=checkbox]");
  await expect(box).toBeVisible({ timeout: T });
  return box;
}

// ---------------------------------------------------------------------- 用例

test("SF-01 删当前来源: 落到同环境兄弟，作用域不跨环境", async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  await createConn(page, "SF01 开发1");
  await createConn(page, "SF01 开发2");

  // 把当前来源指到「开发」环境下的 SF01 开发1
  await navigate(page, "配置浏览");
  const triggers = page.locator(".page-header .browse-scope-field .sel-trigger");
  await expect(triggers.nth(1)).toBeEnabled({ timeout: T });
  await clickScopeOption(await openScopeMenu(page, 1), "开发");
  await clickScopeOption(await openScopeMenu(page, 2), "SF01 开发1");
  await page.waitForTimeout(1_500);

  const uiBefore = await readJson<UiState>(page, "cs.ui");
  const connsBefore = await readJson<Conn[]>(page, "cs.connections");
  const activeId = uiBefore.connId ?? "";
  const sibling = connsBefore.find((c) => c.id !== activeId && c.environmentName === "开发");
  expect(activeId, "前置没立住：当前来源应为 SF01 开发1").toContain("c_");
  expect(sibling?.sourceName, "前置没立住：同环境应有兄弟来源").toBe("SF01 开发2");

  await deleteConn(page, "SF01 开发1");

  // 回落目标必须是同环境兄弟，而不是连接列表第 0 条（种子 retest-a / Development）
  await expect
    .poll(async () => (await readJson<UiState>(page, "cs.ui")).connId, { timeout: 10_000 })
    .toBe(sibling!.id);
  const uiAfter = await readJson<UiState>(page, "cs.ui");
  expect(uiAfter.browseEnvironment, "删完不许把环境写成另一个环境的名字").toBe("开发");
  expect(uiAfter.browseSourceId).toBe(sibling!.id);

  const scope = await scopeTriggers(page);
  expect(scope[1], `作用域条环境格串了环境：${JSON.stringify(scope)}`).toBe("开发");
  expect(scope[2]).toContain("SF01 开发2");
  expect(scope[2]).not.toContain("Retest Nacos A");
  const subtitle = (await page.locator(".browse-page .page-subtitle").first().textContent()) ?? "";
  expect(subtitle).toContain("开发");
});

test("SF-02 设置联动: 关命名空间排序后保活的对比页立刻换序（不是重挂载重读快照）", async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);

  const panel = rightPanel(page);
  await expect(panel).toBeVisible({ timeout: T });

  // 默认 sortNamespaces=true：字典顺序把哨兵 "B 侧 (prod)" 排到 retest-qa 之前
  const sortedOrder = await namespaceOrder(page, panel);
  expect(indexOfNs(sortedOrder, "B 侧")).toBeLessThan(indexOfNs(sortedOrder, "retest-qa"));

  // 打保活标记：右面板这个 DOM 节点属于当前这棵 DiffView 实例
  await panel.evaluate((el) => el.setAttribute("data-sf-keepalive", "diff-instance"));

  await navigate(page, "设置");
  const box = await nsCheckbox(page);
  await expect(box).toBeChecked();
  await box.uncheck();
  await expect
    .poll(async () => (await readJson<{ compare?: { sortNamespaces?: boolean } }>(page, "cs.settings")).compare?.sortNamespaces, {
      timeout: 5_000,
    })
    .toBe(false);

  await navigate(page, "配置对比");
  await expect(panel).toBeVisible({ timeout: T });
  // 标记还在 ⇒ 同一个实例、没重挂载；此时顺序只可能来自订阅推送
  expect(
    await panel.evaluate((el) => el.getAttribute("data-sf-keepalive")),
    "右面板被重挂载了，这条用例就退化成「重挂载重读快照」，判不出订阅是否生效"
  ).toBe("diff-instance");

  const unsortedOrder = await namespaceOrder(page, panel);
  expect(indexOfNs(unsortedOrder, "retest-qa")).toBeLessThan(indexOfNs(unsortedOrder, "B 侧"));

  // 再开回来：双向都即时，且收尾不留脏设置
  await navigate(page, "设置");
  await nsCheckbox(page).then((b) => b.check());
  await navigate(page, "配置对比");
  const sortedAgain = await namespaceOrder(page, panel);
  expect(indexOfNs(sortedAgain, "B 侧")).toBeLessThan(indexOfNs(sortedAgain, "retest-qa"));
});
