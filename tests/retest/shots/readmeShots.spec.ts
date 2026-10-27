// README 界面预览截图取证（轮58 后补）。
//
// 为什么要有这么一条：README 的三张截图停在 2026-07-03（`4411fcf`），此后界面加了行号、
// 命中词标红与整行高亮、类 VSCode 缩略图、就地 Ctrl+F 查找、批量对比的跨项内容搜索，
// 图上一样都看不到；更要紧的是旧图里是**真实内网数据**——明文密码、mongodb 连接串、
// 192.168 内网 IP 与租户名（部分打了码仍可读），公开仓库里等于把配置泄露贴在了首屏。
// 本条改用 retest 播种的合成数据重拍，来源固定、可复跑，不再靠人手截。
//
// 用法（vite :1420 与 confscope-retest-nacos-a/b 容器需在跑）：
//   npx playwright test -c tests/retest/shots/playwright.config.ts
// 产物落在 shots/out/，人工看过再拷进 .github/assets/。
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { loadRetestState } from "../state";
import { dismissStartupDialog, navigate, setDiffSource } from "../specs/ui";

const OUT_DIR = resolve(fileURLToPath(new URL("./out", import.meta.url)));
const state = loadRetestState();
const NS_A = state.nacos.a.namespace;
const NS_B = state.nacos.b.namespace;
const GROUP = "RETEST-PROD";
/** 播种数据里的遗留单体配置：353 行，够把缩略图和滚动条撑出来。 */
const BIG_DATA_ID = "svc-legacy-prod.yaml";
/** 文内查找用词：该文件里命中 5 处，够显示「1/5」的计数。 */
const FIND_TERM = "module";
/** 跨配置内容搜索用词：多个播种文件都含该端口。 */
const CONTENT_TERM = "8080";
/** 内容搜索截图里点开的命中项：83 行，够撑出行号与缩略图。 */
const CONTENT_SHOT_DATA_ID = "svc-gateway.yaml";
/** 批量对比的跨项内容搜索用词：左右两侧处数不相等。 */
const BATCH_TERM = "timeout";
/** 变更计划/操作历史两张图的目标配置：小文件，一次就地编辑就是一条覆盖项。 */
const PLAN_TARGET_DATA_ID = "svc-pay.properties";

const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true });

/**
 * 截图前清掉顶部轻提示。
 *
 * 桥接层导入连接、批量对比完成都会弹 toast，它们停在视口正中，压在标题栏与步骤条上；
 * 发布说明里不该出现「已导入 2 条连接」这种本机一次性状态。toast 有 2.6s/6s 自动消失，
 * 但等待时间不可控（error 类 6s），直接点关闭按钮更稳。
 */
async function clearToasts(page: Page): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    const closes = visible(page, ".toast-close");
    const n = await closes.count();
    if (n === 0) break;
    for (let i = 0; i < n; i += 1) {
      await closes.nth(0).click({ timeout: 2_000 }).catch(() => undefined);
    }
  }
  await expect(visible(page, ".toast")).toHaveCount(0, { timeout: 5_000 });
}

async function shoot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  await clearToasts(page);
  await page.screenshot({ path: resolve(OUT_DIR, `${name}.png`) });
  console.log(`[shots] ${name}.png`);
}

/** 每个视图都从「装桥 → 打开首屏 → 关掉启动弹窗」开始，与永久回归同一手顺。 */
async function openApp(page: Page): Promise<void> {
  await installRetestBridge(page, state);
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
}

test.beforeAll(async () => {
  // 幂等：上一批用例可能把 B 侧改成与 A 一致（矩阵全绿、diff 无差异），重发种子恢复 A≠B。
  await republishRetestData();
});

test("配置浏览：正文的行号与右侧缩略图", async ({ page }) => {
  test.setTimeout(180_000);
  await openApp(page);
  await navigate(page, "配置浏览");
  await expect(visible(page, ".browser-item-id").first()).toBeVisible({ timeout: 30_000 });
  await visible(page, ".browser-item-id").filter({ hasText: BIG_DATA_ID }).first().click();
  await expect(visible(page, ".code-area").first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800);
  expect(await visible(page, ".code-ln").count(), "行号没渲染出来，截图失去意义").toBeGreaterThan(10);
  expect(await visible(page, ".code-minimap, .minimap").count(), "缩略图没出现").toBeGreaterThan(0);
  await shoot(page, "配置浏览");
});

test("配置浏览：Ctrl+F 文内查找的命中与当前行", async ({ page }) => {
  test.setTimeout(180_000);
  await openApp(page);
  await navigate(page, "配置浏览");
  await expect(visible(page, ".browser-item-id").first()).toBeVisible({ timeout: 30_000 });
  await visible(page, ".browser-item-id").filter({ hasText: BIG_DATA_ID }).first().click();
  await expect(visible(page, ".code-area").first()).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("Control+f");
  const findInput = visible(page, ".code-find-input").first();
  await expect(findInput).toBeVisible({ timeout: 10_000 });
  await findInput.fill(FIND_TERM);
  await expect(visible(page, "mark.search-hit").first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(600);
  expect(await visible(page, ".code-line.is-current").count(), "当前命中所在行要高亮").toBe(1);
  await shoot(page, "配置浏览-文内查找");
});

test("配置浏览：跨配置内容搜索的命中片段", async ({ page }) => {
  test.setTimeout(180_000);
  await openApp(page);
  await navigate(page, "配置浏览");
  await expect(visible(page, ".browser-item-id").first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "内容" }).click();
  const search = visible(page, ".browser-search-input, .search-input.wide").first();
  await search.fill(CONTENT_TERM);
  await search.press("Enter");
  await expect(visible(page, ".browser-item").first()).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1_500);
  expect(await visible(page, "mark.search-hit").count(), "命中片段没有标红").toBeGreaterThan(0);
  // 只截左侧列表的话，右半边是一整块「从左侧选择一个配置查看」的空态，
  // 白拍了一张能说明「搜索命中后正文同样标红」的图：点开一个命中项再拍。
  await visible(page, ".browser-item-id").filter({ hasText: CONTENT_SHOT_DATA_ID }).first().click();
  await expect(visible(page, ".code-area").first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800);
  // 命中词标红在正文层（.code-area code 内的 <mark>），.code-line 只是整行高亮的覆盖层。
  expect(
    await visible(page, ".code-area mark.search-hit").count(),
    "正文里的命中词没标红"
  ).toBeGreaterThan(0);
  expect(await visible(page, ".code-ln").count(), "行号没渲染出来").toBeGreaterThan(10);
  await shoot(page, "配置浏览-内容搜索");
});

test("配置对比：批量差异与跨项内容搜索", async ({ page }) => {
  test.setTimeout(420_000);
  await openApp(page);
  await navigate(page, "配置对比");
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".match-list")).toBeVisible({ timeout: 60_000 });
  await page.locator(".match-toggle-all input").check();
  await page.getByRole("button", { name: /对比选中/ }).last().click();
  await expect(visible(page, ".batch-diff-nav-item").first()).toBeVisible({ timeout: 180_000 });
  await page.waitForTimeout(800);
  const box = visible(page, ".batch-diff-search .search-input").first();
  await box.fill(BATCH_TERM);
  await expect(page.locator(".batch-diff-search-status")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1_200);
  expect(await visible(page, ".batch-diff-nav-hit-count").count(), "命中项没挂处数徽标").toBeGreaterThan(0);
  await shoot(page, "配置对比");
});

test("配置矩阵：双环境审计", async ({ page }) => {
  test.setTimeout(300_000);
  await openApp(page);
  await navigate(page, "配置矩阵");
  await expect(page.locator(".audit-page")).toBeVisible({ timeout: 20_000 });
  await page.locator(".audit-actions button.btn-primary", { hasText: "执行审计" }).click();
  await expect(visible(page, ".audit-matrix-row").first()).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(1_200);
  await shoot(page, "配置矩阵");
});

/**
 * 变更计划（第 5 步的勾选区）+ 操作历史（可回退的那条记录）——轮96 K3。
 *
 * 为什么两张图挤在同一条用例里：桥的本地数据是内存替身，`installRetestBridge` 每调一次就
 * `resetRetestAppDataDoc()` 清一次台账（tests/retest/bridge/installRetestBridge.ts:126）。
 * 拆成两条的话，第二条打开时第一条执行出来的操作记录已经被清了，第二张只能拍到空列表。
 *
 * 手顺走真人那一条，中途不抄近路：就地编辑 → 生成变更计划 → 全选 → Dry-run →
 * 停在确认区拍第一张 → 勾选确认 → 执行 → 到操作历史选中那条记录、展开「具体改了什么」拍第二张。
 * 结尾 republishRetestData() 把种子正文写回去，A 侧真值不留脏给下一批用例。
 */
test("变更计划与操作历史：确认勾选区 + 可回退的记录", async ({ page }) => {
  test.setTimeout(420_000);
  await openApp(page);
  await navigate(page, "配置浏览");
  await expect(visible(page, ".browser-item-id").first()).toBeVisible({ timeout: 30_000 });
  await visible(page, ".browser-item-id").filter({ hasText: PLAN_TARGET_DATA_ID }).first().click();
  await expect(visible(page, ".code-area").first()).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "编辑" }).click();
  const ta = visible(page, ".code-editor-ta").first();
  await expect(ta).toBeVisible({ timeout: 30_000 });
  await ta.fill(`${await ta.inputValue()}\n# README 截图：这一行由一次就地编辑产生\n`);

  await page.getByRole("button", { name: /生成变更计划/ }).click();
  await expect(visible(page, ".apply-item-list").first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "全选" }).first().click();
  await expect(visible(page, ".apply-item-check").first()).toBeChecked({ timeout: 10_000 });

  const dryRunBtn = page.locator("button", { hasText: "Dry-run 检查" }).last();
  await dryRunBtn.click({ force: true, timeout: 10_000 }).catch(() => undefined);
  if ((await visible(page, ".apply-execution-notice").count()) === 0) {
    await dryRunBtn.evaluate((el) => (el as HTMLElement).click());
  }
  await expect(visible(page, ".apply-execution-notice").first()).toBeVisible({ timeout: 120_000 });

  const confirmBox = visible(page, ".apply-confirmation").first();
  await expect(confirmBox, "第 5 步的确认区没渲染出来").toBeVisible({ timeout: 30_000 });
  await confirmBox.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  expect(
    await visible(page, ".apply-confirm-check input").first().isVisible(),
    "确认勾选框不在截图里，这张图说明不了第 5 步长什么样"
  ).toBe(true);
  await shoot(page, "变更计划");

  await page.locator(".apply-confirm-check input").check();
  const execBtn = page.locator("button", { hasText: "执行变更" }).last();
  await execBtn.click({ force: true, timeout: 10_000 }).catch(() => undefined);
  if ((await visible(page, ".apply-task-progress").count()) === 0) {
    await execBtn.evaluate((el) => (el as HTMLElement).click());
  }
  await expect(visible(page, ".apply-task-progress .task-status-success").first()).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(800);

  await navigate(page, "操作历史");
  const row = visible(page, ".op-history-item")
    .filter({ has: page.locator(".history-dataid", { hasText: PLAN_TARGET_DATA_ID }) })
    .first();
  await expect(row, "执行完的这条操作没进操作历史列表").toBeVisible({ timeout: 30_000 });
  await expect(row.locator(".history-rollback-chip"), "行上没有「可回退」徽标").toBeVisible();
  await row.click();
  await expect(visible(page, ".history-change-detail").first(), "详情里看不到改动明细").toBeVisible({ timeout: 30_000 });
  // 展开第一处变更，把「具体改了什么」那半边内容拍进图里——只看状态徽标说明不了它。
  await visible(page, ".history-change-item").first().click();
  await expect(visible(page, ".history-change-body").first()).toBeVisible({ timeout: 30_000 });
  await expect(
    page
      .getByRole("button", { name: /生成回退计划/ })
      .or(page.getByRole("button", { name: /按备份快照回退/ }))
      .first(),
    "回退入口不在图里，这张图就只是又一条流水记录"
  ).toBeVisible({ timeout: 30_000 });
  await shoot(page, "操作历史");

  await republishRetestData();
});
