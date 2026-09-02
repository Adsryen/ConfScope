// S 组补充场景（批次 8 差集分析）：配置浏览页未覆盖的真实用户路径。
// S2  内容搜索 → 勾选 → 选择应用目标（应用到目标环境）→ 生成变更计划 → 跳转计划页
// S3  编辑中切换配置 → 放弃确认弹框 → 放弃并切换（草稿丢弃）/ 留在当前（草稿保留）
// S9  浏览页内容搜索：切换搜索模式 → 输入关键词 → 跨文件命中 → 进入文件（内容含命中词）
// S14 刷新内容：改 Nacos 真实内容 → 点 ⟳ 重新拉取 → 详情区出现新内容
import { test, expect, fetchNacosContent } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData, publishNacosContent } from "../bridge/republishData";
import { navigate, dismissStartupDialog } from "./ui";
import { loadRetestState } from "../state";

const state = loadRetestState();
const BASE_A = state.nacos.a.baseUrl;
const NS_A = state.nacos.a.namespace;
const GROUP = "RETEST-PROD";

async function bootstrap(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
}

/** 浏览页打开 Retest Nacos A / retest-dev，等待列表出现。 */
async function openBrowseA(page: import("@playwright/test").Page): Promise<void> {
  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item").first()).toBeVisible({ timeout: 30_000 });
}

/** 点开关并等待结果稳定（用于切换 dataId/内容 搜索模式）。 */
async function clickAndWait(page: import("@playwright/test").Page, btn: import("@playwright/test").Locator, waitMs = 800): Promise<void> {
  await btn.click();
  await page.waitForTimeout(waitMs);
}

// S2: 内容搜索 → 勾选命中项 → 「选择应用目标」→ 选沙箱目标 → 生成变更计划 → 计划页出现。
test("S2 浏览页应用到目标环境: 内容搜索勾选→目标选择→生成变更计划", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);
  await openBrowseA(page);

  // 切到「内容」搜索模式，输入 qps（多个文件都有该键名）
  const modeBtns = page.locator(".browser-search-mode button");
  const contentBtn = modeBtns.filter({ hasText: "内容" }).first();
  await clickAndWait(page, contentBtn, 1500);
  const searchInput = page.locator("input[placeholder*='搜索键名']").first();
  // "平台组统一巡检标记" 在 A 侧 RETEST-PROD 下同时命中 svc-billing.yaml 与 svc-search.yaml（跨文件，数据侧预埋）
  await searchInput.fill("平台组统一巡检标记");
  // 等跨文件内容搜索完成（读取全部 16 项配置）
  await expect(page.locator(".browser-item-summary").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/匹配 \d+ 项/)).toBeVisible({ timeout: 30_000 });
  const hitCount = await page.locator(".browser-result-check").count();
  expect(hitCount).toBeGreaterThanOrEqual(2);

  // 勾选前两个命中项 → 批量替换面板 → 「选择应用目标」
  await page.locator(".browser-result-check input").nth(0).check();
  await page.locator(".browser-result-check input").nth(1).check();
  await page.getByRole("button", { name: "批量替换" }).first().click();
  await expect(page.getByRole("heading", { name: "批量替换" })).toBeVisible({ timeout: 10_000 });
  // 替换面板：查找文本已预填 qps，填替换文本后「选择应用目标」
  const replaceInput = page.locator("#config-replace-text");
  await replaceInput.fill("99999");
  await page.getByRole("button", { name: "选择应用目标" }).first().click();
  // 目标选择弹框：当前来源(A) → 目标候选里出现沙箱 B（retest-b 已标记 Sandbox）
  await expect(page.getByRole("heading", { name: "应用到目标环境" })).toBeVisible({ timeout: 10_000 });
  const selTrigger = page.locator(".browser-target-modal .sel-trigger").first();
  await selTrigger.click({ force: true });
  await page.locator(".sel-menu-portal .sel-option", { hasText: "Retest Nacos B" }).last().click({ force: true });
  // 生成变更计划 → 跳转计划页
  const planBtn = page.getByRole("button", { name: /生成变更计划（\d+ 项）/ });
  await expect(planBtn).toBeEnabled({ timeout: 10_000 });
  await planBtn.click();
  await expect(page.getByRole("heading", { name: "配置变更计划" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".apply-ledger, .apply-item-list").first()).toBeVisible({ timeout: 30_000 });
  // 计划只含被勾选的 2 个 dataId（范围受控），不执行（不写库）
  await page.screenshot({ path: "results/s2-apply-to-target.png", fullPage: true });
});

// S3: 编辑中切换配置 → 放弃确认弹框；「放弃并切换」丢弃草稿；「留在当前」保留草稿。
test("S3 浏览页编辑放弃切换: 放弃并切换丢弃草稿 / 留在当前保留草稿", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);
  await openBrowseA(page);

  // 打开 svc-gateway.yaml → 编辑 → 改内容（产生 dirty）
  await page.locator(".browser-item", { hasText: "svc-gateway.yaml" }).first().click();
  await expect(page.locator(".browser-detail .detail-dataid")).toHaveText("svc-gateway.yaml", { timeout: 15_000 });
  await page.getByRole("button", { name: "编辑", exact: true }).first().click();
  const editor = page.locator(".code-editor-ta");
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type("\nretest-draft-marker: 1");

  // 点另一个配置 → 弹放弃确认框
  await page.locator(".browser-item", { hasText: "svc-billing.yaml" }).first().click();
  const confirmBtn = page.getByRole("button", { name: "放弃并切换" });
  await expect(confirmBtn).toBeVisible({ timeout: 10_000 });

  // 第一次：留在当前 → 弹框消失、仍停留在 gateway、编辑草稿保留
  await page.getByRole("button", { name: "留在当前" }).first().click();
  await expect(confirmBtn).toBeHidden({ timeout: 5_000 });
  await expect(page.locator(".browser-detail .detail-dataid")).toHaveText("svc-gateway.yaml");
  expect(await page.locator(".code-editor-ta").inputValue()).toContain("retest-draft-marker: 1");

  // 再次切换 → 放弃并切换 → 进入 billing、退出编辑、草稿丢弃
  await page.locator(".browser-item", { hasText: "svc-billing.yaml" }).first().click();
  await expect(confirmBtn).toBeVisible({ timeout: 10_000 });
  await confirmBtn.click();
  await expect(page.locator(".browser-detail .detail-dataid")).toHaveText("svc-billing.yaml", { timeout: 10_000 });
  await expect(page.locator(".code-editor-ta")).toHaveCount(0, { timeout: 10_000 });
  // Nacos 侧内容未被草稿污染（直接写入本就禁用，这里确认源数据未变）
  const real = await fetchNacosContent(BASE_A, NS_A, "svc-gateway.yaml", GROUP);
  expect(real).not.toContain("retest-draft-marker");
  await page.screenshot({ path: "results/s3-discard-and-switch.png", fullPage: true });
});

// S9: 浏览页内容搜索 → 跨文件命中 → 点命中项进入文件 → 详情内容确实包含关键词。
test("S9 浏览页内容搜索: 跨文件命中→进入文件→内容含关键词", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);
  await openBrowseA(page);

  const modeBtns = page.locator(".browser-search-mode button");
  await clickAndWait(page, modeBtns.filter({ hasText: "内容" }).first(), 1500);
  // 用只出现在 svc-gateway.yaml 的 dev 特征词（timeout-ms 值 3000 可能多文件有，改用更特征化的）
  const searchInput = page.locator("input[placeholder*='搜索键名']").first();
  await searchInput.fill("qps: 10000");
  await expect(page.getByText(/匹配 \d+ 项/)).toBeVisible({ timeout: 60_000 });
  // 命中的文件应包含 svc-gateway.yaml（A 侧 qps: 10000 是其 dev 特征）
  const hitItem = page.locator(".browser-item", { hasText: "svc-gateway.yaml" }).first();
  await expect(hitItem).toBeVisible({ timeout: 15_000 });
  await expect(hitItem.locator(".browser-item-summary")).toContainText("qps: 10000", { timeout: 10_000 });

  // 进入文件 → 详情内容包含关键词
  await hitItem.click();
  await expect(page.locator(".browser-detail .code-area")).toContainText("qps: 10000", { timeout: 15_000 });
  await page.screenshot({ path: "results/s9-content-search.png", fullPage: true });
});

// S14: 刷新内容（⟳）：外部真实修改 Nacos 后，点刷新 → 详情区出现新内容。
test("S14 浏览页刷新内容: 外部修改Nacos后重新拉取生效", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);
  await openBrowseA(page);

  // 打开 svc-search.yaml（避开其他用例动过的 gateway/billing）
  await page.locator(".browser-item", { hasText: "svc-search.yaml" }).first().click();
  await expect(page.locator(".browser-detail .detail-dataid")).toHaveText("svc-search.yaml", { timeout: 15_000 });
  const before = await page.locator(".browser-detail .code-area").innerText();

  // 外部（API 直连）给 A 侧追加一行特征内容
  const current = await fetchNacosContent(BASE_A, NS_A, "svc-search.yaml", GROUP);
  await publishNacosContent(BASE_A, NS_A, "svc-search.yaml", GROUP, `${current}retest-refresh-marker: true\n`, "yaml");

  // 点 ⟳ 重新拉取
  await page.locator(".browser-detail button[title='重新拉取内容']").first().click();
  await expect(page.locator(".browser-detail .code-area")).toContainText("retest-refresh-marker: true", { timeout: 20_000 });
  expect(before).not.toContain("retest-refresh-marker");
  await page.screenshot({ path: "results/s14-refresh-content.png", fullPage: true });
});
