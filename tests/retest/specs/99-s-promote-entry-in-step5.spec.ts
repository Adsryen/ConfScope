// S31（r113）第5步「晋级到生产」入口撤除 + 操作历史「本次改动」只读详情。
//
// 用户这一轮的原始诉求有两条：①「操作历史页面不应该有晋级的功能」——晋级是写路径的起点，
// 它该出现在刚写完沙箱、正盯着回读结论的那一秒；②「操作历史看不了具体改了什么东西」——
// 审计面必须能就地读出击项的写前/写后，而不是把人再赶去生成一份计划。
// r113 的结论再往前一步：第5步这个入口整个撤掉（「以本次范围新建变更计划」未排期），
// 晋级的入口全站应该是零。本用例一个字都不写生产：走一次沙箱 apply
// （这是量执行后第5步画面的唯一前提），
// 验证第5步画面的入口缺席、步骤条的回退能力还在、操作历史的只读详情，
// 且服务端只有 apply 那一次真实写入。
//
// 读数清单：
// ① 执行成功后第5步无晋级入口：.apply-promote-panel 缺席、无「晋级」文案、
//    无「标记沙箱验证通过」按钮，当前步标题是「执行与验证」；
// ② 对照：沙箱计划的（返回落点是对比页）步骤条仍可点击回退、气泡仍写「回到「……（进度保留）」，
//    证明撤的是入口，不是步骤条本身；
// ③ 服务端只有 apply 那一次真实写入：B 侧换成开发变体、A 侧一个字节没动；
// ④ 操作历史：「本次改动」逐项可读、展开出统一差异（写前/写后），
//    记录级「标记沙箱验证通过」按钮还在，「晋级」按钮与指到第5步的指路句已无。

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
 * 在沙箱上真跑一次 apply（svc-billing A→B），一直跑到「变更执行完成」。
 *
 * 要量执行后的第5步画面与服务端写入次数，必须真跑一次 apply：
 * dry-run 什么都不写，失败记录连写前现场都没收口。所以这一步必须真写，
 * 写的是复测环境的 B，收尾时原样还原。
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
  await page
    .locator("button", { hasText: "Dry-run 检查" })
    .last()
    .click({ force: true })
    .catch(() => undefined);
  await expect(page.locator(".apply-execution-notice").filter({ hasText: "Dry-run 检查通过" })).toBeVisible({ timeout: 60_000 });
  await page.locator(".apply-confirm-check input").check();
  const execBtn = page.locator("button", { hasText: "执行变更" }).last();
  await execBtn.click({ force: true }).catch(() => undefined);
  if ((await page.locator(".apply-task-progress").count()) === 0) {
    await execBtn.evaluate((el) => (el as HTMLElement).click()).catch(() => undefined);
  }
  await expect(
    page
      .locator(".apply-execution-notice")
      .filter({ hasText: /变更执行完成/ })
      .first()
  ).toBeVisible({ timeout: 90_000 });
}

/**
 * 计划页步骤条里还能点的那几步（只有 completed 且允许回退时才是 button）。
 *
 * 必须锁在 .apply-view 里：对比页是常驻保活的（轮44 R1），它在 DOM 上也带一份步骤条，
 * 只是整块 hidden——不限定页面就会断到那一块看不见的上。
 */
function clickableSteps(page: Page) {
  return page.locator(".apply-view .diff-workflow-card button.diff-workflow-step-btn");
}

/** 计划页步骤条每一步的气泡文本（title），用来抓「回到「这句谎。 */
async function applyStepTitles(page: Page): Promise<string[]> {
  return page
    .locator(".apply-view .diff-workflow-step")
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).getAttribute("title") ?? ""));
}

test("S31 第5步晋级入口撤除: 画面无晋级块、步骤条对照、历史页只读详情", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();

  // 基线读实：A 是开发变体、B 是生产变体，后面的「服务端只有这一次变化」才有对照物
  const baselineA = await fetchNacosContentUntil(BASE_A, NS_A, DATA_ID, GROUP, (c) => c.includes("cycle: hourly"));
  expect(baselineA, "republish 后 A 侧不是开发变体，本用例的基线不成立").toContain("cycle: hourly");
  const baselineB = await fetchNacosContentUntil(BASE_B, NS_B, DATA_ID, GROUP, (c) => c.includes("cycle: daily"));
  expect(baselineB, "republish 后 B 侧不是生产变体，本用例的基线不成立").toContain("cycle: daily");
  await bootstrap(page);

  // ① 沙箱写入成功 → 量第5步画面，晋级入口必须为零
  await runBillingApply(page);
  const afterApply = await fetchNacosContentUntil(BASE_B, NS_B, DATA_ID, GROUP, (c) => c.includes("cycle: hourly"));
  expect(afterApply, "沙箱 apply 没把 B 换成开发变体，后面的读数无意义").toContain("cycle: hourly");

  await expect(page.locator(".apply-promote-panel"), "晋级面板已撤，画面不许再有这个容器").toHaveCount(0);
  await expect(page.locator(".apply-view").getByText("晋级"), "第5步还留着晋级文案").toHaveCount(0);
  await expect(page.locator(".apply-view button", { hasText: "标记沙箱验证通过" }), "标记验证是记录级操作，入口在操作历史").toHaveCount(0);
  await expect(page.locator('.apply-view .diff-workflow-step[aria-current="step"]')).toContainText("执行与验证");

  // 对照：沙箱计划本身（返回落点是对比页）步骤条可以回退——
  // 证明「可点」没有整体做坏，第5步步骤条只是回到纯指示。
  await expect(clickableSteps(page).first()).toBeVisible({ timeout: 15_000 });
  expect(
    (await applyStepTitles(page)).some((title) => title.includes("回到「")),
    "沙箱计划的步骤气泡应当给出可回退的说明"
  ).toBe(true);

  // ③ 全程只有 apply 那一次真实写入：服务端只许有这一次变化
  await expectNoDisabledWriteError(page);
  const bNow = await fetchNacosContent(BASE_B, NS_B, DATA_ID, GROUP);
  expect(bNow.trim(), "沙箱计划之外的动作把 B 侧改了").toBe(afterApply.trim());
  const aNow = await fetchNacosContent(BASE_A, NS_A, DATA_ID, GROUP);
  expect(aNow.trim(), "A 侧被改了：apply 只写沙箱，A 该保持读实基线").toBe(baselineA.trim());

  await page.screenshot({ path: "results/s31-step5-no-promote.png", fullPage: true });

  // ④ 操作历史：「本次改动」能就地读出，记录级验证按钮还在，整页没有晋级入口
  await navigate(page, "操作历史");
  const applyRow = page.locator(".op-history-item", { has: page.locator(".history-type.apply") }).first();
  await expect(applyRow).toBeVisible({ timeout: 30_000 });
  // 列表项是切换语义：上一秒正选中它时再点一次会取消选中（S30 同一坑）
  const detail = page.locator(".history-change-detail").first();
  await applyRow.click();
  if (!(await detail.isVisible().catch(() => false))) await applyRow.click();
  await expect(detail).toBeVisible({ timeout: 15_000 });
  await expect(detail.locator(".history-change-summary")).toContainText("本次写入");
  const rows = detail.locator(".history-change-row");
  await expect(rows.first()).toBeVisible({ timeout: 15_000 });
  await expect(rows.first().locator(".history-change-item")).toContainText(DATA_ID);
  await rows.first().locator(".history-change-item").click();
  await expect(detail.locator(".history-change-body .udiff")).toBeVisible({ timeout: 15_000 });
  await expect(detail.locator(".history-change-body")).toContainText("写前");
  // 记录级操作留在历史页：标记沙箱验证仍在这里做
  await expect(page.locator("button", { hasText: "标记沙箱验证通过" }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("button", { hasText: "晋级" })).toHaveCount(0);
  // 指到第5步的指路句（operationHistory.promoteEntryLocation）随入口撤除
  await expect(page.getByText("晋级到生产的入口在变更计划第5步")).toHaveCount(0);

  await page.screenshot({ path: "results/s31-history-change-detail.png", fullPage: true });

  // 收尾：把两侧还原成本用例开始实测到的基线，别把现场留给后面的用例
  await publishNacosContent(BASE_A, NS_A, DATA_ID, GROUP, baselineA, "yaml");
  await publishNacosContent(BASE_B, NS_B, DATA_ID, GROUP, baselineB, "yaml");
  await fetchNacosContentUntil(BASE_A, NS_A, DATA_ID, GROUP, (c) => c.trim() === baselineA.trim());
  await fetchNacosContentUntil(BASE_B, NS_B, DATA_ID, GROUP, (c) => c.trim() === baselineB.trim());
});
