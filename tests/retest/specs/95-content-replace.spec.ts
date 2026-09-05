import { test, expect, fetchNacosContent } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog } from "./ui";
import { loadRetestState } from "../state";

const state = loadRetestState();
const BASE_A = state.nacos.a.baseUrl;
const BASE_B = state.nacos.b.baseUrl;
const NS_A = state.nacos.a.namespace;
const NS_B = state.nacos.b.namespace;
const GROUP = "RETEST-PROD";

// 种子数据里恰有 2 个 RETEST-PROD 配置含该标记（svc-billing.yaml / svc-search.yaml，各 1 处），
// 用于内容搜索 → 批量替换的确定性命中。
const FIND = "每季度复核";
const REPLACE = "每半年复核";

/** 重新发布种子数据并轮询确认 A 侧基线恢复（publish 异步落库，偶尔返回后尚未可查）。 */
async function republishAndVerifyBaseline() {
  await republishRetestData();
  for (let i = 0; i < 10; i++) {
    try {
      const text = await fetchNacosContent(BASE_A, NS_A, "svc-billing.yaml", GROUP);
      if (text.includes(FIND)) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("republish 后 A 侧基线未恢复");
}

/** 浏览页 → 内容搜索 → 勾选全部命中 → 打开替换面板并填写替换值。 */
async function startContentReplace(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "内容" }).click();
  const search = page.locator(".browser-search-input, .search-input.wide").first();
  await search.fill(FIND);
  await search.press("Enter");
  await expect(page.locator(".browser-item-id", { hasText: "svc-billing.yaml" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".browser-item-id", { hasText: "svc-search.yaml" })).toBeVisible({ timeout: 30_000 });
  expect(await page.locator(".browser-item-id").count()).toBe(2);

  const checks = page.locator(".browser-result-check input");
  expect(await checks.count()).toBe(2);
  await checks.first().check();
  await checks.last().check();

  await page.getByRole("button", { name: "批量替换" }).last().click();
  await expect(page.locator("#config-replace-find")).toHaveValue(FIND);
  await page.locator("#config-replace-text").fill(REPLACE);
  await expect(page.locator(".browser-replace-summary span")).toHaveText(`将影响 2 个配置，共 2 处替换`);
  await page.getByRole("button", { name: "选择应用目标" }).click();
  await expect(page.locator(".browser-target-modal")).toBeVisible({ timeout: 10_000 });
}

/** 在目标选择器里打开"目标来源"下拉并选择指定连接；返回菜单 Locator 供断言。 */
async function pickTargetConnection(page: import("@playwright/test").Page, optionText: string) {
  const modal = page.locator(".browser-target-modal");
  const field = modal.locator(".field").filter({ hasText: "目标来源" });
  const trigger = field.locator(".sel-trigger");
  await trigger.click({ force: true, timeout: 10_000 }).catch(() => undefined);
  const menu = page.locator(".sel-menu-portal");
  if ((await menu.count()) === 0) {
    await trigger.evaluate((el) => (el as HTMLElement).click());
  }
  await expect(menu).toBeVisible({ timeout: 10_000 });
  const option = menu.locator(".sel-option", { hasText: optionText }).last();
  await expect(option).toBeVisible({ timeout: 10_000 });
  await option.click({ force: true, timeout: 10_000 }).catch(async () => {
    await option.evaluate((el) => (el as HTMLElement).click());
  });
}

/** 计划页：全选 → dry-run → 勾选确认 → 执行 → 等待完成。 */
async function executePlan(page: import("@playwright/test").Page) {
  await expect(page.locator(".apply-ledger, .apply-item-list").first()).toBeVisible({ timeout: 30_000 });
  const selectAllBtn = page.getByRole("button", { name: "全选" }).first();
  if (await selectAllBtn.count()) await selectAllBtn.click();
  await page.waitForTimeout(300);

  const dryRunBtn = page.locator("button", { hasText: "Dry-run 检查" }).last();
  await dryRunBtn.click({ force: true, timeout: 10_000 }).catch(() => undefined);
  if ((await page.locator(".apply-execution-notice").count()) === 0) {
    await dryRunBtn.evaluate((el) => (el as HTMLElement).click());
  }
  await expect(page.locator(".apply-execution-notice").filter({ hasText: "Dry-run 检查通过" })).toBeVisible({ timeout: 60_000 });

  await page.locator(".apply-confirm-check input").check();
  await page.waitForTimeout(300);
  const execBtn = page.locator("button", { hasText: "执行变更" }).last();
  await execBtn.click({ force: true, timeout: 10_000 }).catch(() => undefined);
  if ((await page.locator(".apply-task-progress").count()) === 0) {
    await execBtn.evaluate((el) => (el as HTMLElement).click());
  }
  await expect(page.locator(".apply-task-progress .task-status-success, .apply-task-progress .task-status-failed").first()).toBeVisible({ timeout: 60_000 });
  const execNotice = await page.locator(".apply-execution-notice").last().textContent().catch(() => "");
  expect(execNotice ?? "").toContain("变更执行完成");
}

// T-CR-01: 同连接原地批量替换（issue #2 主场景）
// 内容搜索命中 2 个配置 → 批量替换 → 目标=来源连接 A / retest-dev → 执行 → A 侧落库
test("T-CR-01 内容批量替换: 来源连接作为目标（原地）→ 执行 → A 侧落库", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishAndVerifyBaseline();

  const t0 = Date.now();
  const mark = (label: string) => console.log(`[T-CR-01][t+${Date.now() - t0}ms] ${label}`);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item-id", { hasText: "svc-gateway.yaml" })).toBeVisible({ timeout: 30_000 });
  mark("浏览页就绪");

  await startContentReplace(page);
  mark("替换面板就绪");

  // 目标选项里必须出现来源连接本身并带"来源"标记；B 是沙箱仍带沙箱标记且为默认
  const modal = page.locator(".browser-target-modal");
  const field = modal.locator(".field").filter({ hasText: "目标来源" });
  const trigger = field.locator(".sel-trigger");
  await trigger.click({ force: true, timeout: 10_000 }).catch(() => undefined);
  const menu = page.locator(".sel-menu-portal");
  if ((await menu.count()) === 0) {
    await trigger.evaluate((el) => (el as HTMLElement).click());
  }
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await expect(menu.locator(".sel-option", { hasText: "Retest Nacos A" })).toHaveText(/· 来源/);
  await expect(menu.locator(".sel-option", { hasText: "Retest Nacos B" })).toHaveText(/· 默认沙箱/);
  // 显式选回来源连接（默认是沙箱 B）
  await menu.locator(".sel-option", { hasText: "Retest Nacos A" }).last().click({ force: true }).catch(async () => {
    await menu.locator(".sel-option", { hasText: "Retest Nacos A" }).last().evaluate((el) => (el as HTMLElement).click());
  });
  // 命名空间维持默认（来源的 retest-dev）
  await expect(page.locator("#config-target-namespace")).toHaveValue(NS_A);
  mark("目标已选 A（来源）");

  await page.getByRole("button", { name: "生成变更计划（2 项）" }).click();
  mark("已生成变更计划");
  await executePlan(page);
  mark("执行完成");

  // 落库验证：A 侧两个配置就地变为替换后内容
  for (const dataId of ["svc-billing.yaml", "svc-search.yaml"]) {
    const after = await fetchNacosContent(BASE_A, NS_A, dataId, GROUP);
    expect(after).toContain(REPLACE);
    expect(after).not.toContain(FIND);
  }
  mark("A 侧落库断言通过");
  await page.screenshot({ path: "results/cr01-same-conn-executed.png", fullPage: true });

  await republishAndVerifyBaseline();
  mark("基线已恢复");
});

// T-CR-02: 跨环境批量替换回归（修复前执行必然 stale 的现有功能）
// 内容搜索命中 2 个配置 → 批量替换 → 目标=B / retest-qa → 执行 → B 侧落库
test("T-CR-02 内容批量替换: 跨环境 A→B → 执行 → B 侧落库（回归）", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishAndVerifyBaseline();

  const t0 = Date.now();
  const mark = (label: string) => console.log(`[T-CR-02][t+${Date.now() - t0}ms] ${label}`);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item-id", { hasText: "svc-gateway.yaml" })).toBeVisible({ timeout: 30_000 });
  mark("浏览页就绪");

  await startContentReplace(page);
  mark("替换面板就绪");

  await pickTargetConnection(page, "Retest Nacos B");
  await page.locator("#config-target-namespace").fill(NS_B);
  mark("目标已选 B / retest-qa");

  await page.getByRole("button", { name: "生成变更计划（2 项）" }).click();
  mark("已生成变更计划");
  await executePlan(page);
  mark("执行完成");

  // 落库验证：B 侧两个配置变为 A 的替换后内容
  for (const dataId of ["svc-billing.yaml", "svc-search.yaml"]) {
    const after = await fetchNacosContent(BASE_B, NS_B, dataId, GROUP);
    expect(after).toContain(REPLACE);
  }
  mark("B 侧落库断言通过");
  await page.screenshot({ path: "results/cr02-cross-env-executed.png", fullPage: true });

  await republishAndVerifyBaseline();
  mark("基线已恢复");
});
