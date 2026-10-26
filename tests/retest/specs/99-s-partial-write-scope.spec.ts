/**
 * S32（轮79 E4 真机读数）半截失败的落笔范围：记录/本次改动/回退都只说真写过的那一项。
 *
 * 为什么必须真机跑：这条口径全链路过一遍才有意义——执行器逐条写、逐条记，
 * 失败记录里的 `appliedLocations` 是那一脚 `if (!itemError)` 攒出来的；
 * 「本次改动」按它收口，回退入口也按它收口。jsdom 里三处各自断言过自己的分支，
 * 但「第 1 项真落库、第 2 项被服务端拒」这个现场只能真的造出来。
 *
 * 造法（口径先写清，免得被当成改了生产代码）：复测那两个 Nacos 容器造不出
 * 「一条建得起来、另一条写不进去」——非法 dataId 含 `/`、content 空白这类条件
 * 在播种阶段（scripts/retest-data/publish.py）同样会被打回，1MB 正文不拒，
 * 靠外部并发改写去撞「最后一刻指纹复检」是毫秒窗口，读数会 flaky。
 * 所以拒绝注入落在桥的 provider 边界（tests/retest/bridge/retestBinding.ts 的
 * takeRetestPublishRefusal），抛出点与真实 `if (text !== "true") throw new Error(...)`
 * 同一支笔，生产代码一行不改。注入是否真的生效在第 2 项上，由 hits 快照自证。
 *
 * 读数清单：
 * ① 进度面板说「已处理 2/2 项」（含失败那条），部分写入提示说「已写入 1/2 项」——
 *    两句都真，但语义不同，这正是本轮要分开的两个数；
 * ② 操作历史失败记录的「本次改动」只列真写成的 1 项，并自己说明「只写成了 1 项」；
 * ③ 回退入口给的是「按备份快照回退已写入项」，生成的计划只有那 1 项
 *    （修前是 2 项：没写过的配置也在备份快照里有写前值，回退会把它再覆盖一遍）；
 * ④ 服务端真值同步校验：写成的那条 B 侧等于 A 侧基线，被拒的那条 B 侧还是原样。
 */
import { test, expect, fetchNacosContentUntil } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import {
  retestPublishRefusalHitsSnapshot,
  resetRetestPublishRefusals,
  setRetestPublishRefusals,
} from "../bridge/retestBinding";
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
/** 两条都在 16 对播种清单里且 A/B 内容必然不同（gen.py：注释措辞/行序/值差异）。 */
const CANDIDATES = ["svc-billing.yaml", "svc-search.yaml"];
const T = 30_000;

async function bootstrap(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
}

/** 基线取实测值：上一个用例可能刚把某一侧改过，常量不可信。 */
async function readBaselines(): Promise<Record<string, { a: string; b: string }>> {
  const out: Record<string, { a: string; b: string }> = {};
  for (const dataId of CANDIDATES) {
    const a = await fetchNacosContentUntil(BASE_A, NS_A, dataId, GROUP, (c) => c.trim().length > 0);
    const b = await fetchNacosContentUntil(BASE_B, NS_B, dataId, GROUP, (c) => c.trim().length > 0);
    expect(a.trim(), `A 侧基线为空：${dataId}`).not.toBe("");
    expect(b.trim(), `B 侧基线为空：${dataId}`).not.toBe("");
    expect(a.trim() === b.trim(), `A/B 两侧内容一致，${dataId} 进不了覆盖计划`).toBe(false);
    out[dataId] = { a, b };
  }
  return out;
}

/** 批量模式（不填 dataId）建一份 2 项计划，返回计划项的可见顺序。 */
async function buildBatchPlan(page: Page): Promise<Array<{ dataId: string; action: string }>> {
  await navigate(page, "配置对比");
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".match-list")).toBeVisible({ timeout: T });

  // 匹配清单默认把全部同名项都勾上（首屏 selectedIds = 全量），逐条对齐到「只有这两条」，
  // 不能指望 check() 自己把别人家的勾选清掉——那样计划就成了 13 项。
  const boxes = page.locator('.match-item input[type="checkbox"]');
  const boxCount = await boxes.count();
  expect(boxCount, "匹配清单一条都没读到，后面的选择无从校验").toBeGreaterThan(0);
  for (let index = 0; index < boxCount; index += 1) {
    const row = page.locator(".match-item").nth(index);
    const dataId = (await row.locator(".match-dataid").getAttribute("title")) ?? "";
    const box = boxes.nth(index);
    const wanted = CANDIDATES.includes(dataId);
    if ((await box.isChecked()) !== wanted) await box.click();
  }
  await expect(page.locator('.match-item input[type="checkbox"]:checked')).toHaveCount(CANDIDATES.length);
  for (const dataId of CANDIDATES) {
    const row = page
      .locator(".match-item")
      .filter({ has: page.locator(`.match-dataid[title="${dataId}"]`) })
      .first();
    await expect(row.locator("input[type=checkbox]"), `匹配清单里没有 ${dataId} 或它没被勾上`).toBeChecked({ timeout: T });
  }

  await page.getByRole("button", { name: /对比选中/ }).last().click();
  await expect(page.locator(".batch-diff .batch-diff-nav-item")).toHaveCount(CANDIDATES.length, { timeout: 90_000 });
  await page.getByRole("button", { name: /进入配置变更计划/ }).last().click();

  const rows = await planRows(page);
  expect(rows.map((row) => row.dataId).sort(), "计划项与勾选的两条不一致").toEqual([...CANDIDATES].sort());
  expect(rows.map((row) => row.action).join(","), "两条都该是覆盖，别把 skip/阻塞算进来").toBe(
    CANDIDATES.map(() => "overwrite").join(",")
  );
  return rows;
}

/** 真人路径：全选 → dry-run → 勾确认 → 执行。 */
async function dryRunAndExecute(page: Page): Promise<void> {
  const view = page.locator(".apply-view");
  const selectAll = view.getByRole("button", { name: "全选" }).first();
  if (await selectAll.count()) await selectAll.click().catch(() => undefined);
  await expect(view.locator(".apply-selection-note")).toContainText(String(CANDIDATES.length), { timeout: T });

  const dryRunBtn = view.locator("button", { hasText: "Dry-run 检查" }).last();
  await dryRunBtn.click({ force: true }).catch(() => undefined);
  if ((await view.locator(".apply-execution-notice").count()) === 0) {
    await dryRunBtn.evaluate((el) => (el as HTMLElement).click()).catch(() => undefined);
  }
  await expect(view.locator(".apply-execution-notice").filter({ hasText: "Dry-run 检查通过" })).toBeVisible({ timeout: 90_000 });

  await view.locator(".apply-confirm-check input").check();
  const execBtn = view.locator("button", { hasText: "执行变更" }).last();
  await execBtn.click({ force: true }).catch(() => undefined);
  if ((await view.locator(".apply-task-progress").count()) === 0) {
    await execBtn.evaluate((el) => (el as HTMLElement).click()).catch(() => undefined);
  }
  await expect(view.locator(".apply-task-progress .task-status-failed").first()).toBeVisible({ timeout: 120_000 });
}

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page, retest }) => {
  await installRetestBridge(page, retest);
});

test("S32 半截失败的落笔范围: 记录/本次改动/回退都只说真写过的那一项", async ({ page }) => {
  test.setTimeout(420_000);
  await republishRetestData();
  const baselines = await readBaselines();
  await bootstrap(page);

  // ① 2 项覆盖计划，写入顺序 = 计划项顺序（planWrites 按 items 生成，DOM 同序）
  const rows = await buildBatchPlan(page);
  const writtenId = rows[0].dataId;
  const refusedId = rows[1].dataId;

  // 注入：只有被拒那条写不进去，命中即拒（可重复执行仍拒），hits 由桥自己记账
  setRetestPublishRefusals([{ dataId: refusedId, group: GROUP, namespace: NS_B }]);
  await dryRunAndExecute(page);

  // ② 屏幕上的两个数：进度面板数「已处理」，部分写入提示数「已写入」
  const view = page.locator(".apply-view");
  const meta = await view.locator(".apply-task-progress-meta").innerText();
  expect(meta.replace(/\s+/g, ""), "进度面板没把两条都算进已处理").toMatch(/已处理2\/2项/);
  const partial = await view.locator(".apply-partial-write").innerText();
  expect(partial, "部分写入提示谎报了真正落笔的条数").toMatch(/已写入\s*1\s*\/\s*2\s*项/);
  expect(partial, "部分写入提示没说是哪一条失败").toContain(refusedId);
  const inlineError = await view.locator(".inline-error-body").innerText();
  expect(inlineError, "失败详情里没有那条被拒的配置").toContain(refusedId);

  // ③ 注入自证：拒绝真的只发生在第 2 项上，一次
  const hits = retestPublishRefusalHitsSnapshot();
  expect(hits.length, `注入命中次数不是 1：${JSON.stringify(hits)}`).toBe(1);
  expect(hits[0].dataId, "被拒的不是第 2 项").toBe(refusedId);

  // ④ 服务端真值：写成那条 B=A 基线，被拒那条 B 还是原样
  const writtenOnB = await fetchNacosContentUntil(BASE_B, NS_B, writtenId, GROUP, (c) => c.trim() === baselines[writtenId].a.trim());
  expect(writtenOnB.trim(), "写成的那条没落库，后面的读数都没意义").toBe(baselines[writtenId].a.trim());
  const refusedOnB = await fetchNacosContentUntil(BASE_B, NS_B, refusedId, GROUP, (c) => c.trim() === baselines[refusedId].b.trim());
  expect(refusedOnB.trim(), "被拒的那条被写了进去：注入没生效或执行器谎报").toBe(baselines[refusedId].b.trim());

  // ⑤ 操作历史：失败记录的「本次改动」只列真写成的那一条
  await navigate(page, "操作历史");
  const applyRow = page.locator(".op-history-item", { has: page.locator(".history-type.apply") }).first();
  await expect(applyRow).toBeVisible({ timeout: T });
  await expect(applyRow.locator(".history-result.failure")).toBeVisible();

  const detail = page.locator(".history-change-detail").first();
  await applyRow.click();
  if (!(await detail.isVisible().catch(() => false))) await applyRow.click();
  await expect(detail, "半截失败的记录不该没有「本次改动」——它真写过一条").toBeVisible({ timeout: T });
  await expect(detail.locator(".history-change-summary")).toContainText("本次写入 1 项");
  await expect(detail.locator('.field-hint[role="note"]')).toContainText("只写成了 1 项");
  await expect(detail.locator(".history-change-row")).toHaveCount(1);
  await expect(detail.locator(".history-change-row").first().locator(".history-change-item")).toContainText(writtenId);
  await expect(detail.locator(".history-change-list")).not.toContainText(refusedId);

  await detail.locator(".history-change-item").first().click();
  await expect(detail.locator(".history-change-body .udiff")).toBeVisible({ timeout: T });
  await page.screenshot({ path: "results/s32-history-partial-scope.png", fullPage: true });

  // ⑥ 回退入口（同一个会话内先断完再点）：按钮说的是「已写入项」，计划也只有那一条
  const infoGrid = page.locator(".data-info-grid").first();
  await expect(infoGrid.locator(".history-rollback-state.available")).toBeVisible({ timeout: T });
  const rollbackBtn = page.locator(".history-followup-panel button", { hasText: "按备份快照回退已写入项" }).first();
  await expect(rollbackBtn, "失败记录给的回退按钮不该是「生成回退计划」那句笼统说法").toBeVisible({ timeout: T });
  await rollbackBtn.click();

  const rollbackPlan = await planRows(page);
  expect(
    rollbackPlan.map((row) => row.dataId),
    "回退计划把没写过的配置也算进去了：那一项目的值是「写前现场」，回退会把没人碰过的配置再覆盖一遍"
  ).toEqual([writtenId]);
  await page.screenshot({ path: "results/s32-rollback-scope.png", fullPage: true });

  // 收尾：撤掉注入、把 B 侧还原成用例开始前的基线（整批是串行的，后面还指着这份数据）
  resetRetestPublishRefusals();
  for (const dataId of CANDIDATES) {
    await publishNacosContent(BASE_B, NS_B, dataId, GROUP, baselines[dataId].b, "yaml");
    await fetchNacosContentUntil(BASE_B, NS_B, dataId, GROUP, (c) => c.trim() === baselines[dataId].b.trim());
  }
});
