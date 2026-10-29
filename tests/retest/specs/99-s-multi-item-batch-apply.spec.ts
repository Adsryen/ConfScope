/**
 * 轮134 真机读数：同一份计划里的多条变更要能分几批执行完。
 *
 * 用户报的现场：第 5 步勾了几条配置，先执行其中一条，回去勾另一条时
 * 「执行选中」这颗按钮再也点不动了，界面只肯说「请重新生成计划」。
 * 根因是执行态上挂了一个「这一页成功过一次」的总闸，与项无关。
 *
 * 为什么必须真机跑（jsdom 给不了的三件事）：
 *  ① 「第二批只写没写过的那条」只能数服务端真收到的 publish——组件测试里执行器是 mock，
 *    两批加起来到底落了几脚写、有没有重复写同一条，jsdom 看不见；
 *  ② 整版写完后那趟只读预演是真发的请求：它必须什么都别写（publish 计数一条都不涨），
 *    又必须真的把「目标已经是这一版」报回界面，这条只能在桥日志与服务端真值上同时读；
 *  ③ 分批执行留下的两条操作历史记录，「本次写入」分别是 2 项与 1 项，
 *    按勾选数重算的话第一条会写成 3 项——审计数字只有一个来源这件事只有真机能验。
 *
 * MA-01 三项覆盖计划 → 取消勾选第 3 项 → 执行选中（2）：前两条各写 1 次、第 3 条 0 次，
 *       前两条变成「已应用」且勾选框灭掉，第 3 条仍可勾选可执行 →
 *       勾上第 3 项 → 执行选中（1）：第 3 条写 1 次，前两条计数仍为 1（不重写）→
 *       整版写完才收口：执行按钮灰掉且原因点名「都写完了」，只读预演照样能跑，
 *       预演如实报「计划写入 0 项 / 另有 3 项已经是这一版」，publish 一条都不涨。
 */
import { test, expect, fetchNacosContentUntil } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { onBridgeLog } from "../bridge/retestBinding";
import { republishRetestData, publishNacosContent } from "../bridge/republishData";
import { navigate, dismissStartupDialog, setDiffSource } from "./ui";
import { planRows } from "./planExit";
import { loadRetestState } from "../state";
import type { Page } from "@playwright/test";

const state = loadRetestState();
const BASE_A = state.nacos.a.baseUrl;
const BASE_B = state.nacos.b.baseUrl;
const NS_A = state.nacos.a.namespace;
const NS_B = state.nacos.b.namespace;
const GROUP = "RETEST-PROD";
/** 三条都在 16 对播种清单里且 A/B 内容必然不同（与 99-s-partial-write-skip 同一批数据）。 */
const THREE = ["svc-billing.yaml", "svc-search.yaml", "svc-config.yaml"];
const T = 30_000;

async function bootstrap(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
}

/** 基线取实测值：上一个用例可能刚把某一侧改过，常量不可信。 */
async function readBaselines(candidates: string[]): Promise<Record<string, { a: string; b: string }>> {
  const out: Record<string, { a: string; b: string }> = {};
  for (const dataId of candidates) {
    const a = await fetchNacosContentUntil(BASE_A, NS_A, dataId, GROUP, (c) => c.trim().length > 0);
    const b = await fetchNacosContentUntil(BASE_B, NS_B, dataId, GROUP, (c) => c.trim().length > 0);
    expect(a.trim(), `A 侧基线为空：${dataId}`).not.toBe("");
    expect(b.trim(), `B 侧基线为空：${dataId}`).not.toBe("");
    expect(a.trim() === b.trim(), `A/B 两侧内容一致，${dataId} 进不了覆盖计划`).toBe(false);
    out[dataId] = { a, b };
  }
  return out;
}

/** 批量模式（不填 dataId）建一份覆盖计划，返回计划项的可见顺序（= 执行顺序）。 */
async function buildBatchPlan(page: Page, candidates: string[]): Promise<Array<{ dataId: string; action: string }>> {
  await navigate(page, "配置对比");
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".match-list")).toBeVisible({ timeout: T });

  const boxes = page.locator('.match-item input[type="checkbox"]');
  const boxCount = await boxes.count();
  expect(boxCount, "匹配清单一条都没读到，后面的选择无从校验").toBeGreaterThan(0);
  for (let index = 0; index < boxCount; index += 1) {
    const row = page.locator(".match-item").nth(index);
    const dataId = (await row.locator(".match-dataid").getAttribute("title")) ?? "";
    const box = boxes.nth(index);
    const wanted = candidates.includes(dataId);
    if ((await box.isChecked()) !== wanted) await box.click();
  }
  await expect(page.locator('.match-item input[type="checkbox"]:checked')).toHaveCount(candidates.length, { timeout: T });

  await page
    .getByRole("button", { name: /对比选中/ })
    .last()
    .click();
  await expect(page.locator(".batch-diff .batch-diff-nav-item")).toHaveCount(candidates.length, { timeout: 90_000 });
  await page
    .getByRole("button", { name: /进入配置变更计划/ })
    .last()
    .click();

  const rows = await planRows(page);
  expect(rows.map((row) => row.dataId).sort(), "计划项与勾选的几条不一致").toEqual([...candidates].sort());
  expect(rows.map((row) => row.action).join(","), "每条都该是覆盖，别把 skip/阻塞算进来").toBe(candidates.map(() => "overwrite").join(","));
  return rows;
}

/** 按钮包在 .btn-guard 里，disabled 时点不动：真人路径 = 先试点，没反应就查一次状态。 */
async function clickActionButton(page: Page, label: string): Promise<void> {
  const view = page.locator(".apply-view");
  const button = view.locator("button", { hasText: label }).last();
  await expect(button, `界面上找不到「${label}」这颗按钮`).toBeVisible({ timeout: T });
  await expect(button, `「${label}」被守卫锁着，点不下去`).toBeEnabled({ timeout: T });
  await button.click({ force: true }).catch(() => undefined);
  if ((await view.locator(".apply-task-progress, .apply-execution-notice").count()) === 0) {
    await button.evaluate((el) => (el as HTMLElement).click()).catch(() => undefined);
  }
}

async function waitBatchDone(page: Page): Promise<void> {
  const view = page.locator(".apply-view");
  await expect(view.locator(".apply-task-progress .task-status-success").first()).toBeVisible({ timeout: 180_000 });
  await page.waitForTimeout(500);
}

function bridgeWaterline(namespaceB: string, group: string) {
  const lines: string[] = [];
  onBridgeLog((line) => lines.push(line));
  const publishLine = (dataId: string) => new RegExp(`publish ${namespaceB} ${group} ${dataId} type=(ref|nacos)`);
  const anyPublish = /publish \S+ \S+ \S+ type=(ref|nacos)/;
  return {
    publishCount: (dataId: string) => lines.filter((line) => publishLine(dataId).test(line)).length,
    publishCountAll: () => lines.filter((line) => anyPublish.test(line)).length,
    tail: (n = 40) => lines.slice(-n).join("\n"),
  };
}

function rowBox(page: Page, index: number) {
  return page.locator(".apply-item-row").filter({ visible: true }).nth(index).locator(".apply-item-check");
}

function rowOf(page: Page, index: number) {
  return page.locator(".apply-item-row").filter({ visible: true }).nth(index);
}

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page, retest }) => {
  await installRetestBridge(page, retest);
});

test("MA-01 三项计划分两批执行：第二批只写没写过的那条，整版写完后只读预演照样能跑", async ({ page }) => {
  test.setTimeout(600_000);
  await republishRetestData();
  const baselines = await readBaselines(THREE);
  await bootstrap(page);

  const rows = await buildBatchPlan(page, THREE);
  const [firstId, secondId, thirdId] = rows.map((row) => row.dataId);
  const water = bridgeWaterline(NS_B, GROUP);
  const view = page.locator(".apply-view");

  // ① 真人第一步：默认全选，把第 3 项摘掉——这一批只写前两条
  await rowBox(page, 2).click();
  await expect(rowBox(page, 2)).not.toBeChecked();
  await expect(view.locator(".apply-selection-note")).toContainText("已选变更项：2", { timeout: T });

  await view.locator(".apply-confirm-check input").check();
  await clickActionButton(page, "执行选中（2）");
  await waitBatchDone(page);

  // ② 服务端真值：前两条各写一次，第 3 条一次都没被尝试
  await expect.poll(() => water.publishCount(firstId), { timeout: T, message: `第 1 条没落库：\n${water.tail()}` }).toBe(1);
  expect(water.publishCount(secondId), "第 2 条没跟着这一批落库").toBe(1);
  expect(water.publishCount(thirdId), `第 3 条没被勾选却写了：\n${water.tail()}`).toBe(0);
  for (const dataId of [firstId, secondId]) {
    const onB = await fetchNacosContentUntil(BASE_B, NS_B, dataId, GROUP, (c) => c.trim() === baselines[dataId].a.trim());
    expect(onB.trim(), `${dataId} 没写成 A 侧那一版`).toBe(baselines[dataId].a.trim());
  }
  const thirdStillB = await fetchNacosContentUntil(BASE_B, NS_B, thirdId, GROUP, () => true);
  expect(thirdStillB.trim(), "没勾的这条不该被写").toBe(baselines[thirdId].b.trim());

  // ③ 界面按项记账：写过的两条标「已应用」并灭掉勾选框，没写的这条还能选
  await expect(rowOf(page, 0)).toHaveClass(/applied/, { timeout: T });
  await expect(rowOf(page, 1)).toHaveClass(/applied/);
  await expect(rowOf(page, 0).locator(".tune-badge.is-applied")).toHaveCount(1);
  await expect(rowBox(page, 0)).toBeDisabled();
  await expect(rowBox(page, 1)).toBeDisabled();
  await expect(rowBox(page, 2)).toBeEnabled();
  await expect(rowBox(page, 2)).not.toBeChecked();
  // 此刻还剩一条没写：收口那句「都写完了」不许提前出现，缺的只是勾选
  await expect(view.locator(".apply-blocker-hint")).toContainText("至少勾选一项配置。", { timeout: T });
  await expect(view.locator(".apply-blocker-hint")).not.toContainText("本计划里可执行的项都已经写入目标了");

  // ④ 用户报的那颗按钮：勾上剩下的第 3 项，「执行选中」必须重新亮起来
  await rowBox(page, 2).click();
  await expect(rowBox(page, 2)).toBeChecked();
  await clickActionButton(page, "执行选中（1）");
  await waitBatchDone(page);

  await expect.poll(() => water.publishCount(thirdId), { timeout: T, message: `第二批没把第 3 条写进去：\n${water.tail()}` }).toBe(1);
  expect(water.publishCount(firstId), `第二批重写了两条：\n${water.tail()}`).toBe(1);
  expect(water.publishCount(secondId), `第二批重写了两条：\n${water.tail()}`).toBe(1);
  const thirdOnB = await fetchNacosContentUntil(BASE_B, NS_B, thirdId, GROUP, (c) => c.trim() === baselines[thirdId].a.trim());
  expect(thirdOnB.trim(), "第 3 条没写进服务端").toBe(baselines[thirdId].a.trim());

  // ⑤ 整版写完才收口：执行按钮灰掉、原因点名「都写完了」，三项都带「已应用」
  await expect(rowOf(page, 2)).toHaveClass(/applied/, { timeout: T });
  const allAppliedReason = "本计划里可执行的项都已经写入目标了";
  await expect(view.locator(".apply-blocker-hint")).toContainText(allAppliedReason, { timeout: T });
  await expect(view.locator(".apply-blocker-hint")).not.toContainText("至少勾选一项配置。");
  const execBtn = view.locator("button", { hasText: "执行选中（0）" }).last();
  await expect(execBtn).toBeDisabled({ timeout: T });
  expect(water.publishCountAll(), `收口后又发了写请求：\n${water.tail()}`).toBe(3);

  // ⑥ 只读预演不受收口限制（R55-D3）：写完再干跑一次核对目标现状
  const dryRunBtn = view.locator("button", { hasText: "Dry-run 检查" }).last();
  await expect(dryRunBtn, "整版写完后连核对现状都点不动").toBeEnabled({ timeout: T });
  await clickActionButton(page, "Dry-run 检查");
  await expect(view.locator(".apply-execution-notice").filter({ hasText: "Dry-run 检查通过" })).toBeVisible({ timeout: 180_000 });
  const dryNotice = await view.locator(".apply-execution-notice").innerText();
  expect(dryNotice.replace(/\s+/g, ""), `预演还打算写东西：${dryNotice}`).toContain("计划写入0项");
  const dryNote = view.locator(".apply-already-applied").first();
  await expect(dryNote, "预演没说清三条都已经是这一版").toBeVisible({ timeout: T });
  expect((await dryNote.innerText()).replace(/\s+/g, ""), "已达成条数报错").toContain("另有3项");
  expect(water.publishCountAll(), `只读预演写了东西：\n${water.tail()}`).toBe(3);
  await page.screenshot({ path: "results/s34-multi-batch-applied.png", fullPage: true });

  // ⑦ 操作历史两笔，各自的「本次改动」跟着真落笔的条数，不按勾选数
  await navigate(page, "操作历史");
  const applyRows = page.locator(".op-history-item", { has: page.locator(".history-result.success") });
  await expect(applyRows).toHaveCount(2, { timeout: T });
  const second = applyRows.nth(0);
  await second.click();
  const detail = page.locator(".history-change-detail").first();
  if (!(await detail.isVisible().catch(() => false))) await second.click();
  await expect(detail, "第二批的成功记录没有「本次改动」").toBeVisible({ timeout: T });
  await expect(detail.locator(".history-change-summary")).toContainText("本次写入 1 项");
  await expect(detail.locator(".history-change-row")).toHaveCount(1);
  await page.screenshot({ path: "results/s34-multi-batch-history.png", fullPage: true });

  // 收尾：把 B 侧还原成用例开始前的基线（整批串行，后面还指着这份数据）
  for (const dataId of THREE) {
    await publishNacosContent(BASE_B, NS_B, dataId, GROUP, baselines[dataId].b, "yaml");
    await fetchNacosContentUntil(BASE_B, NS_B, dataId, GROUP, (c) => c.trim() === baselines[dataId].b.trim());
  }
});
