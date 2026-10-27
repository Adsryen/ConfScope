/**
 * S33（轮97 K3）：正文重取失败时的编辑出口，与消息中心里那条旧「重试」——真机读数。
 *
 * 为什么必须真机跑（jsdom 给不了的两件事）：
 *  ① 「编辑中重取失败」这个现场的触发方是执行器写完后的失效广播 + 保活页切回前台合并补做
 *     （src/lib/configChangeBus.ts → ConfigBrowser.flushStale）。jsdom 里我们直接调
 *     publishConfigChange，跳过的是「页面被 display:none 藏起来时先欠着、回到前台才补做」这一段，
 *     而这一段恰好决定了草稿还在不在屏上。
 *  ② 过期重试那条：App 给浏览页的 key 是 `${连接}:${命名空间}`，换作用域 = 整棵子树重挂载，
 *     台账里那条「重试」挂的是**旧实例的闭包**。jsdom 的 setScope 只换 props，不换实例，
 *     于是「镜像跟上最新作用域」这件事从没被真的验过。这一条只能靠桥侧记账判：
 *     旧的 retry 被点下去时，A 侧那份正文的读取次数一次都不许再涨。
 *
 * 读数清单：
 *  CR-01 编辑中重取失败 ⇒ 草稿逐字还在且改得动、琥珀条把「基线未知」说清、复制草稿抄走的是
 *        屏幕上这一份、生成变更计划在两条入口（点击 / Ctrl+S）上都死；撤掉注入重试成功 ⇒ 一切恢复，
 *        计划照常能生成且带的是草稿那份内容。
 *  CR-02 换作用域后点旧「重试」⇒ 只出一条 warning，桥侧对那份正文的读取计数不涨，
 *        界面停在新的作用域上。
 */
import { test, expect, fetchNacosContent, fetchNacosContentUntil } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import {
  onBridgeLog,
  retestContentReadFailureHitsSnapshot,
  resetRetestContentReadFailures,
  setRetestContentReadFailures,
} from "../bridge/retestBinding";
import { republishRetestData, publishNacosContent } from "../bridge/republishData";
import { navigate, dismissStartupDialog, setDiffSource } from "./ui";
import { expectPlanItem, planRows } from "./planExit";
import { loadRetestState } from "../state";
import type { Locator, Page } from "@playwright/test";

const state = loadRetestState();
const BASE_A = state.nacos.a.baseUrl;
const BASE_B = state.nacos.b.baseUrl;
const NS_A = state.nacos.a.namespace;
const NS_B = state.nacos.b.namespace;
const GROUP = "RETEST-PROD";
/** 播种里 A/B 两侧内容必然不同（与 ST-06 同一份），覆盖计划才不会判成 skip。 */
const TARGET = "svc-pay.properties";
const T = 30_000;

/** 桥日志水位线：判「视图到底有没有自己去重取」只能数真实发出的请求。 */
function bridgeWaterline() {
  const lines: string[] = [];
  onBridgeLog((line) => lines.push(line));
  return {
    mark: () => lines.length,
    countSince: (from: number, needle: string) => lines.slice(from).filter((line) => line.includes(needle)).length,
    tail: (n = 40) => lines.slice(-n).join("\n"),
  };
}

const scopeTrigger = (page: Page, index: number): Locator =>
  page.locator(".page-header .browse-scope-field .sel-trigger").nth(index);

/** 作用域条四格：项目 / 环境 / 来源 / 命名空间（自绘 Select，选项落在 portal 里）。 */
async function pickScopeField(page: Page, index: number, optionText: string): Promise<void> {
  const trigger = scopeTrigger(page, index);
  await expect(trigger).toBeEnabled({ timeout: T });
  const current = (await trigger.innerText()).replace(/[▾▴⏄⏃]/g, "").trim();
  if (current.includes(optionText)) return;
  await trigger.click({ force: true, timeout: 10_000 });
  const menu = page.locator(".sel-menu-portal");
  await expect(menu).toBeVisible({ timeout: 10_000 });
  const opt = menu.locator(".sel-option", { hasText: optionText }).first();
  await expect(opt).toBeVisible({ timeout: 10_000 });
  await opt.click({ force: true, timeout: 10_000 });
  await expect(menu).toBeHidden({ timeout: 10_000 });
}

async function openBrowseDetail(page: Page, dataId: string): Promise<void> {
  const item = page.locator(".browser-item-id", { hasText: dataId }).filter({ visible: true }).first();
  await expect(item, `列表里没有 ${dataId}`).toBeVisible({ timeout: T });
  await item.click();
  await expect(page.locator(".code-area").filter({ visible: true }).first()).toBeVisible({ timeout: T });
}

const editor = (page: Page): Locator => page.locator(".code-editor-ta").filter({ visible: true }).first();
const amberBar = (page: Page): Locator => page.locator(".browser-baseline-unknown").filter({ visible: true }).first();
const planButton = (page: Page): Locator => page.locator(".fmt-bar .btn-primary").filter({ visible: true }).first();

/** 进浏览页并把作用域摆到指定那一格上（环境 + 来源），命名空间跟着连接的默认值走。 */
async function gotoBrowseScope(page: Page, env: string, source: string): Promise<void> {
  await navigate(page, "配置浏览");
  await pickScopeField(page, 1, env);
  await pickScopeField(page, 2, source);
  await expect(scopeTrigger(page, 2)).toContainText(source, { timeout: T });
  await page.waitForTimeout(800); // 列表按新作用域重取，等它落定再操作
}

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page, retest }) => {
  await installRetestBridge(page, retest);
});

test.afterEach(async () => {
  resetRetestContentReadFailures();
});

test("CR-01 编辑中重取失败: 草稿还在改得动、基线未知说清、计划两条入口都死; 重试成功后恢复", async ({ page }) => {
  test.setTimeout(480_000);
  await republishRetestData();
  const t0 = Date.now();
  const log = (s: string) => console.log(`[CR-01][t+${Date.now() - t0}ms] ${s}`);
  const water = bridgeWaterline();

  const bBase = await fetchNacosContent(BASE_B, NS_B, TARGET, GROUP);
  const aSide = await fetchNacosContent(BASE_A, NS_A, TARGET, GROUP);
  expect(aSide, "A/B 两侧内容相同，覆盖计划会判成 skip").not.toBe(bBase);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await gotoBrowseScope(page, "Sandbox", "Retest Nacos B");

  await openBrowseDetail(page, TARGET);
  await page.getByRole("button", { name: "编辑" }).filter({ visible: true }).first().click();
  const ta = editor(page);
  await expect(ta).toBeVisible({ timeout: T });
  const draftMarker = `# r97-unsaved-draft-${Date.now()}`;
  await ta.fill(`${bBase}\n${draftMarker}\n`);
  log("浏览页（沙箱 B）停在编辑态，草稿未保存");

  /** 唯一的写路径：对比页把 A 侧当前内容覆盖到 B 侧这份配置（执行期间注入还没挂上）。 */
  await navigate(page, "配置对比");
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP, dataId: TARGET });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP, dataId: TARGET });
  await page.getByRole("button", { name: "加载并对比" }).filter({ visible: true }).last().click();
  await expect(page.locator(".diff-panel").filter({ visible: true }).first()).toBeVisible({ timeout: T });
  await page.getByRole("button", { name: "进入配置变更计划" }).filter({ visible: true }).last().click();
  await expectPlanItem(page, "overwrite");
  const applyView = page.locator(".apply-view").filter({ visible: true }).first();
  await applyView.getByRole("button", { name: "全选" }).first().click().catch(() => undefined);
  await page.waitForTimeout(300);
  const dryRun = page.locator("button", { hasText: "Dry-run 检查" }).filter({ visible: true }).last();
  await dryRun.click({ force: true }).catch(() => undefined);
  await expect(page.locator(".apply-execution-notice").filter({ visible: true }).first()).toBeVisible({ timeout: 120_000 });
  await page.locator(".apply-confirm-check input").filter({ visible: true }).first().check();
  const exec = page.locator("button", { hasText: "执行变更" }).filter({ visible: true }).last();
  await exec.click({ force: true }).catch(() => undefined);
  await expect(page.locator(".apply-task-progress .task-status-success").filter({ visible: true }).first()).toBeVisible({
    timeout: 120_000,
  });
  const written = await fetchNacosContentUntil(BASE_B, NS_B, TARGET, GROUP, (text) => text === aSide);
  expect(written, "服务端没被计划改成 A 侧内容：后面的「重取」就没有靶子").toBe(aSide);
  log("执行器写完，浏览页被藏着，这笔失效通知欠着");

  // 此刻把这份正文的读取钉死，再回前台：合并补做的那次重取必然失败
  setRetestContentReadFailures([{ dataId: TARGET, group: GROUP, namespace: NS_B }]);
  const at = water.mark();
  await navigate(page, "配置浏览");
  await expect
    .poll(() => water.countSince(at, "ConfigCenterListConfigs"), { timeout: T, message: `回浏览页没有自动重取：\n${water.tail()}` })
    .toBeGreaterThan(0);

  // ① 编辑区没被这次失败吞掉：草稿逐字还在，而且改得动
  await expect(ta, "重取失败把编辑态整个退了").toBeVisible({ timeout: T });
  await expect.poll(async () => (await ta.inputValue()).includes(draftMarker), { timeout: T, message: "草稿丢了" }).toBe(true);
  const draftNow = `${await ta.inputValue()}\n# r97-still-editable\n`;
  await ta.fill(draftNow);
  await expect.poll(async () => ta.inputValue()).toBe(draftNow);
  log("草稿可见可改 ✓");

  // ② 琥珀条把「基线未知」这件事说在场地上（role=status 让读屏也收到）
  const bar = amberBar(page);
  await expect(bar, "基线未知却没有可见说明").toBeVisible({ timeout: T });
  await expect(bar).toHaveAttribute("role", "status");
  const copyDraft = bar.locator(".browser-baseline-unknown-actions .copy-action-btn");
  await expect(copyDraft, "失败态没给把草稿抄走的出口").toHaveCount(1);

  // ③ 生成计划两条入口都死着：原生 disabled 点不动，Ctrl+S 那条路径自己拦
  const planBtn = planButton(page);
  await expect(planBtn, "基线未知时「生成变更计划」还是可点的").toBeDisabled();
  await planBtn.evaluate((el) => (el as HTMLButtonElement).click());
  await page.waitForTimeout(1_200);
  await expect(page.locator(".apply-view").filter({ visible: true }).first(), "被禁用的按钮还是把人带进了计划页").toHaveCount(0);
  await ta.press("Control+s");
  await expect(page.locator(".fmt-bar .inline-error").filter({ visible: true }).first(), "Ctrl+S 被拒却什么都没没说").toBeVisible({
    timeout: T,
  });
  await expect(page.locator(".apply-view").filter({ visible: true }).first()).toHaveCount(0);
  log("计划入口死掉（点击 + Ctrl+S）✓");

  // ④ 复制草稿抄走的正是屏幕上这一份
  await page.bringToFront();
  await copyDraft.click();
  await expect
    .poll(async () => page.evaluate(() => navigator.clipboard.readText()), { timeout: T, message: "剪贴板里不是编辑器那份" })
    .toBe(draftNow);
  log("复制草稿 = 屏幕内容 ✓");
  await page.screenshot({ path: "results/r97-cr01-baseline-unknown.png", fullPage: true });

  // ⑤ 撤掉注入后重试成功 ⇒ 一切恢复，并且真的还能生成计划（计划里带的是草稿那份）
  resetRetestContentReadFailures();
  const errCard = page.locator(".inline-error").filter({ visible: true }).filter({ hasText: TARGET }).first();
  await expect(errCard, "正文读取失败却没有就地错误卡").toBeVisible({ timeout: T });
  await errCard.getByRole("button", { name: "重试" }).click();
  await expect(amberBar(page), "重取成功了琥珀条还挂着").toHaveCount(0, { timeout: T });
  await expect(planBtn).toBeEnabled({ timeout: T });
  await expect.poll(async () => (await ta.inputValue()).includes(draftMarker), { timeout: T, message: "重试把草稿顶掉了" }).toBe(true);

  await planBtn.click();
  const rows = await planRows(page);
  expect(rows.map((row) => row.dataId), "恢复后生成的计划挂在了别的配置上").toEqual([TARGET]);
  expect(rows[0].action, "服务端已被写成 A 侧内容，草稿相对它就是覆盖").toBe("overwrite");
  // 计划正文只看详情区的 diff 预览：`.apply-item-list` 那一列只有 dataId / key / 动作三种文本，
  // 从来不含正文（与 30-apply.spec.ts 的「编辑保存后 diff 已更新」同一口径）。
  const planText = (await page.locator(".apply-diff-preview").filter({ visible: true }).first().textContent()) ?? "";
  expect(planText, "计划里带的不是草稿那一份").toContain(draftMarker);
  expect(planText, "计划里丢了失败期间新写的那一行").toContain("# r97-still-editable");
  log("恢复原状并可生成计划 ✓");

  // 收尾：把 B 侧还原成用例开始前的基线（整批串行，后面还指着这份数据）
  await publishNacosContent(BASE_B, NS_B, TARGET, GROUP, bBase, "properties");
  await fetchNacosContentUntil(BASE_B, NS_B, TARGET, GROUP, (text) => text === bBase);
  log("B 侧基线已还原");
});

test("CR-02 换作用域后点台账里的旧「重试」: 只说已过期，且不再为那份正文发一次读取", async ({ page }) => {
  test.setTimeout(300_000);
  const t0 = Date.now();
  const log = (s: string) => console.log(`[CR-02][t+${Date.now() - t0}ms] ${s}`);

  // 注入挂在 A 侧这份正文上：第一次点开就会失败，并在台账里留下一条带「重试」的旧闭包
  setRetestContentReadFailures([{ dataId: TARGET, group: GROUP, namespace: NS_A }]);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await gotoBrowseScope(page, "Development", "Retest Nacos A");

  await page.locator(".browser-item-id", { hasText: TARGET }).filter({ visible: true }).first().click();
  await expect(page.locator(".inline-error").filter({ visible: true }).first()).toBeVisible({ timeout: T });
  const afterFirstFail = retestContentReadFailureHitsSnapshot().length;
  expect(afterFirstFail, "注入没生效：第一次正文读取就没失败，后面全都没意义").toBe(1);
  log("A 侧正文读取失败，台账里留下一条旧「重试」");

  // 人把弹框关掉（正文失败不占即时弹层，页面就地报错），换个命名空间继续干活
  await pickScopeField(page, 3, "public");
  await expect(scopeTrigger(page, 3)).toContainText("public", { timeout: T });
  log("作用域已换到 public（连接不变，整棵浏览页按 key 重挂载）");

  const baseline = retestContentReadFailureHitsSnapshot().length;

  // 从消息中心把那条旧记录翻出来，点它的「重试」
  await page.locator(".message-center").hover();
  const panel = page.locator(".message-panel");
  await expect(panel).toBeVisible({ timeout: T });
  const entry = panel.locator(".message-item", { hasText: TARGET }).first();
  await expect(entry, "消息中心里找不到那条正文加载失败").toBeVisible({ timeout: T });
  await entry.locator(".message-actions .message-icon-btn").first().click(); // 查看详情
  const dialog = page.locator(".modal-error").filter({ visible: true }).first();
  await expect(dialog, "详情弹框没打开").toBeVisible({ timeout: T });

  // 「复制完整错误」那颗也长 .btn-ghost，按类名抓会撞 strict mode；按可访问名点重试。
  await dialog.getByRole("button", { name: "重试", exact: true }).click(); // 重试（旧实例的闭包）
  log("点下了旧「重试」");

  // 判据一（只能真机拿）：桥侧对那份正文的读取一次都没再发生
  await expect
    .poll(() => retestContentReadFailureHitsSnapshot().length, {
      timeout: 15_000,
      message: "过期重试还是把旧作用域的正文又取了一次",
    })
    .toBe(baseline);

  // 判据二：给出说明，而且是一条 warning（不是又造一次失败）
  await page.locator(".message-center").hover();
  const warn = page.locator(".message-panel .message-item.message-warning").first();
  await expect(warn, "点了旧重试既不发请求也不说为什么没动").toBeVisible({ timeout: T });

  // 判据三：界面停在人当前盯着的作用域上，没被旧闭包甩回去
  await expect(scopeTrigger(page, 3)).toContainText("public", { timeout: T });
  await expect(scopeTrigger(page, 2)).toContainText("Retest Nacos A", { timeout: T });
  log("过期重试只说明、不发请求、不甩作用域 ✓");
  await page.screenshot({ path: "results/r97-cr02-stale-retry.png", fullPage: true });
});
