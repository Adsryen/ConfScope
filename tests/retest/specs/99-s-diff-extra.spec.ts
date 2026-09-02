// S 组补充场景（批次 8 差集分析）：对比页批量结果区的未覆盖真实用户路径。
// S1  批量对比合并预览 workbench（中间箭头 → 待带入右侧 → 重置 → 进入变更计划）
// S10 批量对比 → 返回文件选择 → 重新选文件 → 再对比
// S11 批量对比 → 导出差异 JSON（真实 download 事件 + blob 内容断言）
import { test, expect, fetchNacosContent } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog, setDiffSource } from "./ui";
import { loadRetestState } from "../state";

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

/** 批量对比 RETEST-PROD 全部 13 个 dataId，进入批量结果视图。 */
async function enterBatchDiff(page: import("@playwright/test").Page): Promise<void> {
  await navigate(page, "配置对比");
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".match-list")).toBeVisible({ timeout: 30_000 });
  await page.locator(".match-toggle-all input").check();
  await page.getByRole("button", { name: /对比选中/ }).last().click();
  await expect(page.locator(".batch-diff .batch-diff-nav-item").first()).toBeVisible({ timeout: 60_000 });
}

// S1: 合并预览 workbench。
// 真人路径：批量对比 → 点开有差异的文件 → 点差异行中间 "→"（拿左侧到右侧预览）
// → 顶部出现「待带入右侧 N 个文件」→ 点「重置预览」回到「尚未产生合并预览」
// → 再点箭头 → 「进入配置变更计划（N 个文件）」只带变化文件 → 计划页出现。
test("S1 批量对比合并预览: 箭头→待带入右侧→重置→进入变更计划(N个文件)", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);
  await enterBatchDiff(page);

  // 选第一个有差异的 nav 项（svc-gateway.yaml 两侧内容不同，必有差异行）
  await page.locator(".batch-diff-nav-item", { hasText: "svc-gateway.yaml" }).first().click();
  await expect(page.locator(".batch-diff-main .diff-panel")).toBeVisible({ timeout: 30_000 });

  // 合并 workbench 初始状态：尚未产生合并预览
  const summary = page.locator(".merge-draft-summary");
  await expect(summary).toBeVisible({ timeout: 10_000 });
  expect(await summary.innerText()).toContain("尚未产生合并预览");

  // 点第一个差异块中间的 "→"（aria-label=拿左侧到右侧预览）
  const arrows = page.locator(".batch-diff-main button[aria-label='拿左侧到右侧预览']");
  expect(await arrows.count()).toBeGreaterThan(0);
  await arrows.first().click();
  // 合并预览生效：右侧列文本应包含左侧差异行内容（workbench 摘要计数 ≥1）
  await expect(summary).toContainText(/待带入右侧 \d+ 个文件/, { timeout: 10_000 });

  // 行级标记：被合并的行带 merge-left-to-right 类
  expect(await page.locator(".batch-diff-main .diff-row.merge-left-to-right").count()).toBeGreaterThan(0);

  // 重置预览：摘要回到空态，行标记清除，按钮恢复可点
  await page.getByRole("button", { name: "重置预览" }).first().click();
  await expect(summary).toContainText("尚未产生合并预览", { timeout: 10_000 });
  expect(await page.locator(".batch-diff-main .diff-row.merge-left-to-right").count()).toBe(0);

  // 再点一次箭头 → 进入变更计划：按钮文案为「进入配置变更计划（N 个文件）」且 N≥1
  await arrows.first().click();
  await expect(summary).toContainText(/待带入右侧 \d+ 个文件/, { timeout: 10_000 });
  const planBtn = page.getByRole("button", { name: /进入配置变更计划（\d+ 个文件）/ });
  await expect(planBtn).toBeVisible({ timeout: 10_000 });
  const btnText = (await planBtn.innerText()).replace(/\s+/g, "");
  const n = Number(btnText.match(/（(\d+)个文件）/)?.[1]);
  expect(n).toBeGreaterThanOrEqual(1);

  // 进入计划页：计划工作区出现，且只含 svc-gateway.yaml（仅变化文件）
  await planBtn.click();
  await expect(page.getByRole("heading", { name: "配置变更计划" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".apply-ledger, .apply-item-list").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".apply-view", { hasText: "svc-gateway.yaml" }).first()).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: "results/s1-merge-workbench.png", fullPage: true });
});

// S10: 返回文件选择 → 重新勾选（只勾一个）→ 再对比，结果只含 1 个文件。
test("S10 批量对比: 返回文件选择→重新勾选→再对比(范围变化生效)", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);
  await enterBatchDiff(page);

  // 批量结果视图出现 → 点「返回文件选择」
  await page.getByRole("button", { name: "返回文件选择" }).first().click();
  await expect(page.locator(".match-list")).toBeVisible({ timeout: 15_000 });
  // 之前的勾选保留（selectedIds 不清空）→ 先取消全选，再只勾 svc-billing.yaml
  await expect(page.locator(".match-toggle-all input")).toBeChecked();
  await page.locator(".match-toggle-all input").uncheck();
  const billingItem = page.locator(".match-item", { hasText: "svc-billing.yaml" }).first();
  await billingItem.locator("input[type='checkbox']").check();
  await page.getByRole("button", { name: /对比选中/ }).last().click();
  await expect(page.locator(".batch-diff .batch-diff-nav-item").first()).toBeVisible({ timeout: 60_000 });
  // 批量结果只含 1 个文件
  expect(await page.locator(".batch-diff .batch-diff-nav-item").count()).toBe(1);
  await expect(page.locator(".batch-diff-nav-item", { hasText: "svc-billing.yaml" })).toBeVisible();
  await page.screenshot({ path: "results/s10-back-to-match-list.png", fullPage: true });
});

// S11: 导出差异 JSON：真实 download 事件 + 下载内容断言（含 dataId 与两侧原文）。
test("S11 批量对比: 导出差异 JSON 真实下载且内容完整", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);
  await enterBatchDiff(page);

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30_000 }),
    page.getByRole("button", { name: "导出差异" }).first().click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^diff_\d+\.json$/);
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dest = path.join(os.tmpdir(), download.suggestedFilename());
  await download.saveAs(dest);
  const text = await fs.readFile(dest, "utf8");
  const parsed = JSON.parse(text) as { metadata: { total: number }; items: Array<{ dataId: string; leftValue: string; rightValue: string }> };
  expect(parsed.metadata.total).toBe(13);
  expect(parsed.items.length).toBe(13);
  const gw = parsed.items.find((it) => it.dataId === "svc-gateway.yaml");
  expect(gw).toBeTruthy();
  // 内容断言：导出的是双侧原文（A 侧含 dev 特征 qps: 10000，B 侧含 prod 特征值）
  expect(gw!.leftValue).toContain("qps: 10000");
  const realB = await fetchNacosContent(BASE_B, NS_B, "svc-gateway.yaml", GROUP);
  expect(gw!.rightValue.trim()).toBe(realB.trim());
  await fs.unlink(dest).catch(() => undefined);
  await page.screenshot({ path: "results/s11-export-diff.png", fullPage: true });
});
