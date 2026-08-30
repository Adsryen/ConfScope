import { test, expect } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog, setDiffSource } from "./ui";
import { loadRetestState } from "../state";

const state = loadRetestState();
const NS_A = state.nacos.a.namespace;
const NS_B = state.nacos.b.namespace;
const GROUP = "RETEST-PROD";

async function bootstrap(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
}

// A8: 配置浏览 → 历史变更 tab：版本列表 → 查看旧版本内容 → 回滚二次确认 → 被「直接写入已禁用」拦截
test("A8 历史变更tab: 版本查看 + 回滚被禁用拦截", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);
  await navigate(page, "配置浏览");
  const item = page.locator(".browser-item-id", { hasText: "svc-gateway.yaml" }).first();
  await expect(item).toBeVisible({ timeout: 30_000 });
  await item.click();
  await expect(page.locator(".fmt-bar").first()).toBeVisible({ timeout: 15_000 });

  // 切到历史变更 tab
  await page.getByRole("button", { name: "历史变更" }).click();
  const historyItems = page.locator(".history-item");
  await expect(historyItems.first()).toBeVisible({ timeout: 30_000 });
  const count = await historyItems.count();
  expect(count).toBeGreaterThanOrEqual(1);
  console.log(`[A8] svc-gateway.yaml 历史版本数=${count}`);

  // 查看第一个版本详情
  await historyItems.first().locator(".history-item-main").click();
  await expect(page.locator(".history-detail .content-box, .history-detail .pad-msg").first()).toBeVisible({ timeout: 15_000 });

  // 回滚：第一次点击进入二次确认态，第二次执行 → 被禁用拦截
  const rbBtn = page.getByRole("button", { name: /回滚/ }).last();
  await rbBtn.click();
  await expect(page.getByText("确认回滚").first()).toBeVisible({ timeout: 5_000 });
  await rbBtn.click();
  await expect(page.getByText("直接配置写入已禁用").first()).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: "results/a8-history-rollback-blocked.png", fullPage: true });
});

// A9: 内容搜索 → 勾选多个命中 → 批量替换面板 → 目标环境弹框 → 生成变更计划入口
test("A9 批量替换: 内容搜索勾选多文件→目标选择→生成变更计划", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);
  await navigate(page, "配置浏览");

  // 内容搜索 8080（命中 svc-gateway.yaml / svc-pay.properties / svc-order.toml 等）
  await page.getByRole("button", { name: "内容" }).click();
  const search = page.locator(".browser-search-input, .search-input.wide").first();
  await search.fill("8080");
  await search.press("Enter");
  await expect(page.locator(".browser-item-id", { hasText: "svc-gateway.yaml" })).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(2000); // 等内容搜索完成渲染勾选框

  // 勾选所有带「选择替换」勾选框的命中项
  const checks = page.locator(".browser-result-check input[type=checkbox]");
  const n = await checks.count();
  expect(n).toBeGreaterThanOrEqual(2);
  for (let i = 0; i < n; i++) await checks.nth(i).check({ force: true });

  // 打开批量替换面板
  await page.getByRole("button", { name: "批量替换" }).click();
  await expect(page.getByRole("heading", { name: "批量替换" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/已选择 \d+ 项配置/)).toBeVisible();

  // 填入替换文本（不执行写入，只验证面板与目标选择流程）
  await page.locator("#config-replace-find").fill("8080");
  await page.locator("#config-replace-text").fill("18080");

  // 选择目标 → 目标环境弹框
  const pickTargetBtn = page.getByRole("button", { name: /选择目标|应用到目标|目标环境/ }).first();
  if ((await pickTargetBtn.count()) > 0) {
    await pickTargetBtn.click();
  } else {
    // 按钮文案兜底：面板底部主按钮
    await page.locator(".browser-replace-modal .btn-primary").first().click();
  }
  await expect(page.getByRole("heading", { name: "应用到目标环境" })).toBeVisible({ timeout: 10_000 });
  // 目标来源默认/选择 Retest Nacos B
  const targetSel = page.locator(".browser-target-modal .sel-trigger").first();
  if ((await targetSel.count()) > 0) {
    await targetSel.click({ force: true });
    const menu = page.locator(".sel-menu-portal");
    if ((await menu.count()) > 0) {
      await menu.locator(".sel-option", { hasText: "Retest Nacos B" }).last().click({ force: true });
    }
  }
  await page.locator("#config-target-namespace").fill(NS_B);
  await expect(page.getByText("将先生成变更计划").first()).toBeVisible();

  // 生成变更计划 → 进入变更计划页（入口跳转即可，不执行写入）
  await page.getByRole("button", { name: /生成变更计划（\d+ 项）/ }).click();
  await expect(page.locator(".apply-ledger, .apply-item-list").first()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: "results/a9-batch-replace-to-plan.png", fullPage: true });
});

// B6: 对比页左右来源/命名空间/group 全部重新选择后，对比结果与所选一致
test("B6 来源切换: 重选左右来源与group后对比结果正确", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);
  await navigate(page, "配置对比");
  await page.waitForTimeout(500);

  // 初始默认 → 切左到 RETEST-ORDER/svc-order.toml，右保持 B 侧同 dataId
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: "RETEST-ORDER", dataId: "svc-order.toml" });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: "RETEST-ORDER", dataId: "svc-order.toml" });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".diff-panel")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);

  // diff 两侧都应出现 svc-order.toml 的特征内容（toml 表格）
  const leftText = await page.locator(".diff-panel").first().innerText();
  expect(leftText).toMatch(/\[|=/);

  // 再切回 RETEST-PROD/svc-gateway.yaml 验证切换生效
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP, dataId: "svc-gateway.yaml" });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP, dataId: "svc-gateway.yaml" });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".diff-panel")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  const body = await page.locator("body").innerText();
  expect(body).toContain("svc-gateway.yaml");
  await page.screenshot({ path: "results/b6-source-switch.png", fullPage: true });
});
