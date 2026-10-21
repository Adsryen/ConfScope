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
