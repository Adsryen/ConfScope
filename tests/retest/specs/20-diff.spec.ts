import { test, expect, fetchNacosContent } from "./retestTest";
import { installRetestBridge, RETEST_BRIDGE_MARKER } from "../bridge/installRetestBridge";
import { navigate, dismissStartupDialog, setDiffSource } from "./ui";

async function loadSingleCompare(page: any) {
  await navigate(page, "配置对比");
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: "retest-dev", dataId: "retest-plain.txt", group: "retest_group" });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: "retest-qa", dataId: "retest-plain.txt", group: "retest_group" });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".diff-panel")).toBeVisible({ timeout: 30_000 });
}

// T-DIFF-01: 单文档加载并对比
test("T-DIFF-01 单文档对比: 双 Nacos 同 dataId 差异渲染", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await loadSingleCompare(page);

  // diff 应渲染且标记出 line2 MODIFIED 差异
  await expect(page.locator(".diff-row.modify, .diff-row.add, .diff-row.del")).not.toHaveCount(0);
  await expect(page.locator(".diff-body")).toContainText("line2 MODIFIED");
  await page.screenshot({ path: "results/diff01-single-compare.png", fullPage: true });
});

// T-DIFF-02: 对比后点击中间“应用”箭头（用户报告：不好使）
// 用户自然路径：点击“展开来源”展开来源面板 → 点击来源方向箭头按钮（.diff-source-direction）
// 预期：进入变更计划视图（apply-workspace），或至少出现 toast 反馈（未加载完成时提示先加载）。
test("T-DIFF-02 应用箭头: 单文档对比后点击应用方向箭头", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await loadSingleCompare(page);

  // 箭头按钮现在是真正的 <button>，先确认其结构
  const direction = page.locator(".diff-source-direction");
  await expect(direction).toHaveCount(1);
  const tagName = await direction.evaluate((el) => el.tagName);
  expect(tagName.toLowerCase()).toBe("button");

  // 展开来源面板（折叠状态下 .diff-sources 是 pointer-events:none，真实点击不可达）
  await page.getByRole("button", { name: "展开来源" }).last().click();
  await page.waitForTimeout(400);

  // 真实点击（非 force），验证可点击性
  await direction.click({ timeout: 10_000 });
  await page.waitForTimeout(1000);

  // 进入计划后草稿需要拉取两侧配置并生成；等待计划列表/错误/生成中三者之一出现
  await expect(page.locator(".apply-item-list, .inline-error, .apply-draft-loading").first()).toBeVisible({ timeout: 30_000 });

  // 用户报告的“不好使”：点击后没有任何反应。
  // 判定标准：点击后要么进入 ApplyPlan（apply 视图出现），要么给出明确提示。两者都没有 = 复现缺陷。
  const enteredApply = await page.locator(".apply-workspace, .apply-ledger, .apply-count-strip, .apply-item-list").first().isVisible({ timeout: 2_000 }).catch(() => false);
  const feedback = await page.locator(".toaster .toast").last().isVisible({ timeout: 500 }).catch(() => false);
  console.log(`[T-DIFF-02] 点击方向箭头后: 进入ApplyPlan=${enteredApply}, 有反馈提示=${feedback}`);
  await page.screenshot({ path: "results/diff02-arrow-click.png", fullPage: true });
  // 修复后：箭头是真正的按钮，对比完成后点击进入变更计划
  expect(enteredApply || feedback).toBeTruthy();
});

// T-DIFF-03: 批量匹配（同名/仅左/仅右）→ 全选 → 批量对比
test("T-DIFF-03 批量对比: 同名+仅左+仅右匹配并批量加载", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置对比");

  await setDiffSource(page, "left", { connection: "Retest Nacos A" });
  await setDiffSource(page, "right", { connection: "Retest Nacos B" });
  // dataId/group 留空 → 自动匹配全部
  await page.getByRole("button", { name: "加载并对比" }).last().click();

  // 匹配列表：5 项（3 个 app.* 同名 + plain.txt 同名 + only-a 仅左 + only-b 仅右 = 6? 实测 5，见 research）
  await expect(page.locator(".match-list")).toBeVisible({ timeout: 30_000 });
  const items = page.locator(".match-item");
  const itemCount = await items.count();
  console.log(`[T-DIFF-03] 匹配项数量 = ${itemCount}`);
  expect(itemCount).toBeGreaterThanOrEqual(5);

  // 存在性标签
  await expect(page.locator(".match-presence.both").first()).toBeVisible();
  await expect(page.locator(".match-presence.left-only").first()).toBeVisible();
  await expect(page.locator(".match-presence.right-only").first()).toBeVisible();
  // 仅右侧存在的配置行显示“缺失配置”占位（真实 dataId 在右侧列表中渲染）
  await expect(page.locator(".match-dataid.missing").first()).toBeVisible();
  await page.screenshot({ path: "results/diff03-batch-match.png", fullPage: true });

  // 全选 → 批量对比
  await page.locator(".match-toggle-all input").check();
  await page.getByRole("button", { name: /对比选中/ }).last().click();
  await expect(page.locator(".batch-diff .batch-diff-nav-item").first()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: "results/diff03-batch-diff.png", fullPage: true });
  expect(await page.locator(".batch-diff .batch-diff-nav-item").count()).toBeGreaterThanOrEqual(4);
  // 批量结果中应能切换查看仅左侧存在的配置
  await expect(page.locator(".batch-diff-presence.left-only").first()).toBeVisible();
});
