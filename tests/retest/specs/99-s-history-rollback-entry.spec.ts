// S30（轮72A）操作历史「回退」入口的呈现与导航。
//
// 与 S8b 的分工要说清：S8b 证明「回退计划执行后目标真的还原」——那是写入侧的后果。
// 本用例一个字都不写，只证明屏幕上关于回退的四句话是真的：
// ① 行内「可回退」徽章只挂在真能回退的记录上；②「只看可回退」筛的是同一批记录，
// 并且切走再回来还记得（记忆层，不是 localStorage）；③ 不可回退的记录给的是具体原因，
// 且同一块面板下面不再挂一个能点的回退按钮（本轮缺陷本体就是这两句话打脸）；
// ④ 从历史页点进来的回退计划，「返回」回的是历史页而不是配置浏览。
// 全程 Nacos 零变化 + 不允许出现「点了才报错」的直写失败呈现。
import { test, expect, fetchNacosContent, fetchNacosContentUntil } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData, publishNacosContent } from "../bridge/republishData";
import { navigate, dismissStartupDialog, setDiffSource } from "./ui";
import { expectNoDisabledWriteError } from "./planExit";
import { loadRetestState } from "../state";
import type { Page } from "@playwright/test";

const state = loadRetestState();
const BASE_A = state.nacos.a.baseUrl;
const BASE_B = state.nacos.b.baseUrl;
const NS_A = state.nacos.a.namespace;
const NS_B = state.nacos.b.namespace;
const GROUP = "RETEST-PROD";
const DATA_ID = "svc-billing.yaml";

async function bootstrap(page: Page) {
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
}

/**
 * 执行一次单文档 apply（svc-billing A→B），跑到「变更执行完成」为止。
 *
 * 回退徽章必须建立在「有写前备份快照的执行记录」上，造假记录证明不了界面说的是真话，
 * 所以这里只能真跑一次写入。落库回读交给 S8b，本用例只把执行完成当成本用例的现场。
 */
async function runBillingApply(page: Page): Promise<void> {
  await navigate(page, "配置对比");
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP, dataId: DATA_ID });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP, dataId: DATA_ID });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".diff-panel")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "进入配置变更计划" }).last().click();
  await expect(page.locator(".apply-ledger, .apply-item-list").first()).toBeVisible({ timeout: 30_000 });
  const selectAllBtn = page.getByRole("button", { name: "全选" }).first();
  if (await selectAllBtn.count()) await selectAllBtn.click();
  await page.locator("button", { hasText: "Dry-run 检查" }).last().click({ force: true }).catch(() => undefined);
  await expect(page.locator(".apply-execution-notice").filter({ hasText: "Dry-run 检查通过" })).toBeVisible({ timeout: 60_000 });
  await page.locator(".apply-confirm-check input").check();
  const execBtn = page.locator("button", { hasText: "执行变更" }).last();
  await execBtn.click({ force: true }).catch(() => undefined);
  if ((await page.locator(".apply-task-progress").count()) === 0) {
    await execBtn.evaluate((el) => (el as HTMLElement).click()).catch(() => undefined);
  }
  await expect(page.locator(".apply-execution-notice").filter({ hasText: /变更执行完成/ }).first()).toBeVisible({ timeout: 90_000 });
}

/** 按记录类型取历史列表里的行（类名来自 record.type，locale 无关）。 */
function historyRow(page: Page, type: "apply" | "export") {
  return page.locator(".op-history-item", { has: page.locator(`.history-type.${type}`) });
}

/**
 * 选中一条记录并确认详情面板真的打开了。
 *
 * 不能「点一下就算选中」：这条页的选中态走的是视图记忆层（切走再回来还在），
 * 而列表项是 toggle——上一秒选中的正是它时，这一秒的点击是取消选中，
 * 详情面板随之消失，后面的按钮就「元素不存在」了。先点，再看有没有开，没开再点一次。
 */
async function selectHistoryRow(page: Page, row: import("@playwright/test").Locator): Promise<void> {
  const detail = page.locator(".data-info-grid").first();
  await row.click();
  if (!(await detail.isVisible().catch(() => false))) await row.click();
  await expect(detail).toBeVisible({ timeout: 15_000 });
}

test("S30 操作历史回退入口: 徽章/筛选/原因/返回全程零写入", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();

  // 基线读实：不假设 republish 之后 B 侧一定是 prod 变体（上一个用例可能刚覆写过它，
  // republish 的写还有最终一致性窗口）。后面「零变化」的期望值用实测值，不是常量。
  const baseline = await fetchNacosContentUntil(BASE_B, NS_B, DATA_ID, GROUP, (c) => c.includes("cycle: daily"));
  expect(baseline, "republish 后 B 侧没回到 prod 变体，本用例的基线不成立").toContain("cycle: daily");
  await bootstrap(page);

  // 一条不可回退记录：导出当前列表（只读 Nacos，产物是本地文件）
  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item-id").first()).toBeVisible({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent("download", { timeout: 20_000 }).catch(() => undefined);
  await page.getByRole("button", { name: "导出当前列表" }).click();
  await expect(page.locator(".toaster .toast-success", { hasText: "已导出配置列表" }).first()).toBeVisible({ timeout: 20_000 });
  await downloadPromise;

  // 一条可回退记录：真的执行一次 apply
  await runBillingApply(page);
  const afterApply = await fetchNacosContentUntil(BASE_B, NS_B, DATA_ID, GROUP, (c) => c.includes("cycle: hourly"));
  expect(afterApply, "apply 没把 B 侧换成 dev 变体，后面的零变化断言无意义").toContain("cycle: hourly");

  await navigate(page, "操作历史");
  const applyRow = historyRow(page, "apply").first();
  const exportRow = historyRow(page, "export").first();
  await expect(applyRow).toBeVisible({ timeout: 30_000 });
  await expect(exportRow).toBeVisible({ timeout: 30_000 });

  // ① 徽章只挂在真能回退的那条上
  await expect(applyRow.locator(".history-rollback-chip")).toHaveText("可回退");
  await expect(exportRow.locator(".history-rollback-chip")).toHaveCount(0);

  // ③ 不可回退的记录：给具体原因，且面板里不再挂能点的回退按钮
  await selectHistoryRow(page, exportRow);
  const infoGrid = page.locator(".data-info-grid").first();
  await expect(infoGrid.locator(".history-rollback-state")).toHaveText("不可回退");
  await expect(infoGrid.locator(".history-rollback-state")).toHaveClass(/unavailable/);
  await expect(infoGrid.locator(".info-row", { hasText: "回退原因" })).toContainText("导出只生成本地文件，不能回滚");
  await expect(page.locator(".history-followup-panel button", { hasText: "回退计划" })).toHaveCount(0);

  // ② 筛掉不可回退的记录，并记住这个选择（切走再回来还在）
  await selectHistoryRow(page, applyRow);
  await infoGrid.locator(".history-rollback-state").filter({ hasText: "可回退" }).waitFor({ timeout: 15_000 });
  const toggle = page.locator(".history-filter-toggle input").first();
  await toggle.check();
  await expect(exportRow).toBeHidden({ timeout: 15_000 });
  await expect(applyRow).toBeVisible();
  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item-id").first()).toBeVisible({ timeout: 30_000 });
  await navigate(page, "操作历史");
  await expect(page.locator(".history-filter-toggle input").first()).toBeChecked();
  await expect(historyRow(page, "export")).toBeHidden({ timeout: 15_000 });
  await expect(historyRow(page, "apply")).toBeVisible();

  // ④ 回退入口生成计划 → 返回落回操作历史（不是配置浏览）
  await selectHistoryRow(page, historyRow(page, "apply").first());
  const genBtn = page.getByRole("button", { name: "生成回退计划" }).first();
  await expect(genBtn).toBeVisible({ timeout: 15_000 });
  await genBtn.click();
  await expect(page.getByRole("heading", { name: "配置变更计划" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".apply-view .apply-workspace").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".apply-view .apply-plan-summary").first()).toContainText("Retest Nacos B");
  await page.getByRole("button", { name: "返回" }).first().click();
  await expect(page.locator(".op-history-list").first()).toBeVisible({ timeout: 30_000 });
  // 回历史页后筛选仍然记得，且刚才那条可回退记录还在列表里（没被跳转换页洗掉）
  await expect(page.locator(".history-filter-toggle input").first()).toBeChecked();
  await expect(historyRow(page, "apply").first()).toBeVisible({ timeout: 15_000 });

  // 全程零写入：生成回退计划不碰服务端，A 侧还是播种内容、B 侧还停在 apply 之后的 dev 变体
  await expectNoDisabledWriteError(page);
  const bNow = await fetchNacosContent(BASE_B, NS_B, DATA_ID, GROUP);
  expect(bNow.trim(), "生成回退计划把目标侧改了").toBe(afterApply.trim());
  const aNow = await fetchNacosContent(BASE_A, NS_A, DATA_ID, GROUP);
  expect(aNow, "源侧被这个用例改了").toContain("cycle: hourly");

  await page.screenshot({ path: "results/s30-history-rollback-entry.png", fullPage: true });

  // 收尾：把 B 侧恢复成本用例开始实测到的基线，别把现场留给后面的用例
  await publishNacosContent(BASE_B, NS_B, DATA_ID, GROUP, baseline, "yaml");
  await fetchNacosContentUntil(BASE_B, NS_B, DATA_ID, GROUP, (c) => c.trim() === baseline.trim());
});
