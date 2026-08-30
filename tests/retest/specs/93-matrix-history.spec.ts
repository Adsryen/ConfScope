import { test, expect, fetchNacosContent } from "./retestTest";
import { installRetestBridge, RETEST_AUDIT_FILE } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog, setDiffSource } from "./ui";
import { loadRetestState } from "../state";
import { readFileSync } from "node:fs";

const state = loadRetestState();
const BASE_B = state.nacos.b.baseUrl;
const NS_A = state.nacos.a.namespace;
const NS_B = state.nacos.b.namespace;
const GROUP = "RETEST-PROD";

async function bootstrap(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
}

/** 执行一次单文档 apply（svc-gateway.yaml A→B），返回执行完成后的 B 侧内容。 */
async function runSingleApply(page: import("@playwright/test").Page): Promise<string> {
  await navigate(page, "配置对比");
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP, dataId: "svc-gateway.yaml" });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP, dataId: "svc-gateway.yaml" });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".diff-panel")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "进入配置变更计划" }).last().click();
  await expect(page.locator(".apply-ledger, .apply-item-list").first()).toBeVisible({ timeout: 30_000 });
  const selectAllBtn = page.getByRole("button", { name: "全选" }).first();
  if (await selectAllBtn.count()) await selectAllBtn.click();
  const dryRunBtn = page.locator("button", { hasText: "Dry-run 检查" }).last();
  await dryRunBtn.click({ force: true }).catch(() => undefined);
  await expect(page.locator(".apply-execution-notice").filter({ hasText: "Dry-run 检查通过" })).toBeVisible({ timeout: 60_000 });
  await page.locator(".apply-confirm-check input").check();
  const execBtn = page.locator("button", { hasText: "执行变更" }).last();
  await execBtn.click({ force: true }).catch(() => undefined);
  await expect(page.locator(".apply-task-progress .task-status-success, .apply-task-progress .task-status-failed").first()).toBeVisible({ timeout: 60_000 });
  const after = await fetchNacosContent(BASE_B, NS_B, "svc-gateway.yaml", GROUP);
  // B 侧目标文件是「生产环境 (QA 预演)」变体：应用后 B 侧应呈现 dev 源内容，
  // 但 dev 源自身也含「生产环境」字样（变更单注释行），这里断言应用后 B 侧
  // 与 A 侧源内容一致（真实落库验证）。
  const before = await fetchNacosContent("http://127.0.0.1:19848/nacos", NS_A, "svc-gateway.yaml", GROUP);
  expect(after.trim()).toBe(before.trim());
  return after;
}

// C1: 配置矩阵（AuditView）加载 + 双环境执行审计生成一致性矩阵
test("C1 配置矩阵: 双环境执行审计生成一致性矩阵", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);
  await navigate(page, "配置矩阵");
  await page.waitForTimeout(800);

  // 添加第二个环境（A→B），group 对齐 RETEST-PROD
  await page.getByRole("button", { name: "+ 环境" }).click();
  await page.waitForTimeout(300);
  // 第二个环境的 group 输入框填 RETEST-PROD（第一个默认连接 defaultGroup 已是）
  const groupInputs = page.locator(".audit-env input.mono, .audit-env .search-input.mono");
  const gn = await groupInputs.count();
  console.log(`[C1] 环境组输入框数=${gn}`);

  await page.getByRole("button", { name: "执行审计" }).click();
  // 矩阵行出现（dataId × 环境）
  await expect(page.locator(".audit-matrix-row").nth(1)).toBeVisible({ timeout: 60_000 });
  const rowCount = await page.locator(".audit-matrix-row").count();
  expect(rowCount).toBeGreaterThan(1);
  // 至少存在一种状态标签（不一致/一致/缺失）
  const body = await page.locator("body").innerText();
  expect(/一致|不一致|缺失|部分一致/.test(body)).toBeTruthy();
  console.log(`[C1] 矩阵行数=${rowCount}`);
  await page.screenshot({ path: "results/c1-audit-matrix.png", fullPage: true });
});

// E2: 沙箱验证标记 → 晋级入口出现（A 侧作为沙箱来源，B 已应用后到操作历史标记验证）
test("E2 操作历史: 沙箱验证标记 + 晋级目标选择", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);

  await runSingleApply(page);

  // 到操作历史找到刚才的 apply 记录并选中
  await navigate(page, "操作历史");
  const recordBtn = page.getByRole("button", { name: /配置变更计划.*svc-gateway\.yaml/ }).first();
  await expect(recordBtn).toBeVisible({ timeout: 30_000 });
  await recordBtn.click();
  await expect(page.locator(".history-detail-panel").getByText("svc-gateway.yaml").first()).toBeVisible({ timeout: 15_000 });
  // 找「标记沙箱验证通过」按钮（选中记录后的跟进面板）
  const verifyBtn = page.getByRole("button", { name: "标记沙箱验证通过" }).first();
  await expect(verifyBtn).toBeVisible({ timeout: 30_000 });
  await verifyBtn.click();
  await expect(page.getByText("已保存沙箱验证").first()).toBeVisible({ timeout: 30_000 });
  // 晋级入口出现：目标选择 + 「晋级到所选目标」
  const promoteBtn = page.getByRole("button", { name: /晋级到所选目标|晋级/ }).first();
  await expect(promoteBtn).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: "results/e2-sandbox-verify.png", fullPage: true });
});

// E3: 操作历史回滚 → 生成回退计划（不执行），验证入口与计划页跳转
test("E3 操作历史: 生成回退计划跳转计划页", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);

  await runSingleApply(page);

  await navigate(page, "操作历史");
  // 选中最新的 apply 记录（列表默认倒序第一条）
  const recordBtn = page.getByRole("button", { name: /配置变更计划.*svc-gateway\.yaml/ }).first();
  await expect(recordBtn).toBeVisible({ timeout: 30_000 });
  await recordBtn.click();
  await expect(page.getByRole("button", { name: "生成回退计划" }).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "生成回退计划" }).first().click();
  // 跳转到变更计划页：回退计划以执行时自动快照为来源（local provider），
  // 桥已支持 local-snapshot 读路径 → 应成功生成回退计划（来源=快照、目标=B）。
  // 断言：页面到达变更计划 + 生成成功（计划工作区）或明确报错（不得静默卡死）+ B 侧零写入。
  await expect(page.getByRole("heading", { name: "配置变更计划" })).toBeVisible({ timeout: 30_000 });
  await page
    .locator(".apply-view .apply-workspace, .apply-view .inline-error")
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  const genFailed = await page.getByText("变更计划生成失败").first().isVisible().catch(() => false);
  if (!genFailed) {
    // 成功路径：回退计划以本地快照为来源、B 为目标
    const summary = await page.locator(".apply-view .apply-plan-summary").first().innerText();
    expect(summary).toContain("retest-backup-");
    expect(summary).toContain("Retest Nacos B");
  } else {
    // 失败路径：错误详情不得为空
    const detail = (await page.locator(".apply-view .inline-error .inline-error-body").first().innerText()).trim();
    expect(detail.length).toBeGreaterThan(0);
  }
  // 关键：任何路径下都不得写入 B 侧（回退只是生成计划，不执行）
  const before = await fetchNacosContent("http://127.0.0.1:19848/nacos", NS_A, "svc-gateway.yaml", GROUP);
  const content = await fetchNacosContent(BASE_B, NS_B, "svc-gateway.yaml", GROUP);
  expect(content.trim()).toBe(before.trim()); // 保持 runSingleApply 已应用后的状态
  await page.screenshot({ path: "results/e3-rollback-plan.png", fullPage: true });
});

// D7: 执行后返回再进入计划页：无「已执行」残留误导状态
test("D7 执行后返回再进入: 无已执行残留误导", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);

  await runSingleApply(page);

  // 返回再重新进入同一对比的计划页
  await navigate(page, "配置对比");
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP, dataId: "svc-gateway.yaml" });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP, dataId: "svc-gateway.yaml" });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".diff-panel")).toBeVisible({ timeout: 30_000 });
  // 已应用后两侧一致 → 差异可能为 0；进入计划页（若有按钮）
  const enterBtn = page.getByRole("button", { name: "进入配置变更计划" }).last();
  if ((await enterBtn.count()) > 0 && !(await enterBtn.isDisabled())) {
    await enterBtn.click();
    await expect(page.locator(".apply-ledger, .apply-item-list").first()).toBeVisible({ timeout: 30_000 });
    const body = await page.locator("body").innerText();
    const suspicious = ["变更执行完成", "已写入右侧", "应用成功"].filter((w) => body.includes(w));
    expect(suspicious).toEqual([]);
  } else {
    console.log("[D7] 无差异时未提供进入计划入口（符合预期）");
  }
  await page.screenshot({ path: "results/d7-no-residual.png", fullPage: true });
});
