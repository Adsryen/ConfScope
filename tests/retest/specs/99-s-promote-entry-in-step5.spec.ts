// S31（轮76）晋级入口搬回变更计划第5步 + 操作历史「本次改动」只读详情。
//
// 用户这一轮的原始诉求有两条：①「操作历史页面不应该有晋级的功能」——晋级是写路径的起点，
// 它该出现在刚写完沙箱、正盯着回读结论的那一秒；②「操作历史看不了具体改了什么东西」——
// 审计面必须能就地读出击项的写前/写后，而不是把人再赶去生成一份计划。
// 本用例一个字都不写生产：走一次沙箱 apply（这是晋级面板出现的唯一前提），
// 然后把「标记验证 → 选生产目标 → 生成晋级计划 → dry-run」全程跑一遍，
// 证明屏幕上关于晋级的每句话都是真的，且服务端只有第 2 步那一次真实写入。
//
// 读数清单：
// ① 执行成功后第5步出现 .apply-promote-panel（回读结论 + 沙箱验证两行读数）；
// ② 点「标记沙箱验证通过」→ 验证行转「已标记（…」，「按本次验证晋级」由灰转可点；
// ③ 生产目标候选只剩沙箱以外那一条，且它名字里没有生产标记 → 必须给琥珀色提醒
//    （这一栏叫「生产目标」，默认停在一条没标记的连接上不吭声，等于给假环境盖章）；
// ③b 命名空间这一栏默认「沿用沙箱」：沙箱租户在生产目标上不存在时必须说清「会新建」，
//     点明目标上已有的租户后提醒消失，公共空间读数不得写成「public ()」这种空括注；
// ④ 点晋级 → 计划重建并停在第4步、目标那一行是所选连接、dry-run 能跑通；
// ⑤ 这份晋级计划的步骤条第1/2/3步不再是按钮，气泡里不许再写「回到「（轮76 修的就是这句谎）；
// ⑥ 操作历史：「本次改动」逐项可读、展开出统一差异，且整页没有任何「晋级」按钮。
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
 * 晋级面板只挂在「真实写入 + 执行成功 + 拿得到本次记录」上，伪造不了：
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
  return page.locator(".apply-view .diff-workflow-step").evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLElement).getAttribute("title") ?? "")
  );
}

test("S31 第5步晋级入口: 标记验证/生产目标提醒/晋级计划不写服务端", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();

  // 基线读实：A 是开发变体、B 是生产变体，后面的「服务端只有这一次变化」才有对照物
  const baselineA = await fetchNacosContentUntil(BASE_A, NS_A, DATA_ID, GROUP, (c) => c.includes("cycle: hourly"));
  expect(baselineA, "republish 后 A 侧不是开发变体，本用例的基线不成立").toContain("cycle: hourly");
  const baselineB = await fetchNacosContentUntil(BASE_B, NS_B, DATA_ID, GROUP, (c) => c.includes("cycle: daily"));
  expect(baselineB, "republish 后 B 侧不是生产变体，本用例的基线不成立").toContain("cycle: daily");
  await bootstrap(page);

  // ① 沙箱写入成功 → 第5步出现晋级面板
  await runBillingApply(page);
  const afterApply = await fetchNacosContentUntil(BASE_B, NS_B, DATA_ID, GROUP, (c) => c.includes("cycle: hourly"));
  expect(afterApply, "沙箱 apply 没把 B 换成开发变体，后面的读数无意义").toContain("cycle: hourly");

  const panel = page.locator(".apply-promote-panel").first();
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel.locator(".apply-promote-actions")).toBeVisible();
  await expect(panel.locator(".apply-promote-head")).toContainText("晋级到生产");
  const stepValues = panel.locator(".apply-promote-step-value");
  await expect(stepValues.nth(0)).toContainText("全部项与写入一致", { timeout: 15_000 });
  await expect(stepValues.nth(1)).toHaveText("未标记");

  // 还没标记验证时，那颗晋级按钮必须是灰的，并且原因写得出来
  const promoteBtn = panel.locator("button", { hasText: "按本次验证晋级" }).last();
  await expect(promoteBtn).toBeDisabled();

  // ② 标记沙箱验证通过 → 验证行转「已标记」，晋级按钮转可点
  await panel.locator("button", { hasText: "标记沙箱验证通过" }).last().click();
  await expect(stepValues.nth(1)).toContainText("已标记（", { timeout: 30_000 });
  await expect(stepValues.nth(1)).toHaveClass(/is-ok/);
  await expect(stepValues.nth(1)).toContainText("Retest Nacos B");
  await expect(promoteBtn).toBeEnabled({ timeout: 15_000 });

  // ③ 生产目标候选：沙箱自己不算，只剩一条；它名字里没有生产标记 → 必须提醒
  const targetField = panel.locator(".apply-promote-target").first();
  await expect(targetField.locator(".sel-value")).toHaveText("Retest Nacos A");
  await targetField.locator(".sel-trigger").click();
  const menu = page.locator(".sel-menu-portal").first();
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await expect(menu.locator(".sel-option")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(targetField.locator(".apply-promote-target-note")).toContainText("Retest Nacos A");
  await expect(targetField.locator(".apply-promote-target-note")).toContainText("没有生产环境的标记");

  // 沙箱计划本身（返回落点是对比页）步骤条是可以回退的——这是⑤的对照，
  // 证明「不可点」不是把功能整体做坏了，而是只对没有对比现场的计划关掉。
  await expect(clickableSteps(page).first()).toBeVisible({ timeout: 15_000 });
  expect((await applyStepTitles(page)).some((title) => title.includes("回到「")), "沙箱计划的步骤气泡应当给出可回退的说明").toBe(true);

  // ③b 命名空间落点：默认「沿用沙箱」，而沙箱那套租户在生产目标上并不存在——
  // 落进去是「新建一套租户」而不是「覆盖同名配置」，这句话必须写在屏幕上；
  // 点明目标上已有的租户后提醒消失，公共空间的读数还得不带空括注。
  const namespaceField = panel.locator(".apply-promote-namespace");
  await expect(namespaceField.locator(".sel-value")).toHaveText(`沿用沙箱（${NS_B}）`);
  const namespaceNote = namespaceField.locator(".apply-promote-namespace-note");
  await expect(namespaceNote).toContainText(`${NS_B} 在 Retest Nacos A 上不是已有的命名空间`);
  await expect(namespaceNote).toContainText("晋级会新建它");
  await namespaceField.locator(".sel-trigger").click({ force: true });
  const namespaceMenu = page.locator(".sel-menu-portal").first();
  await expect(namespaceMenu).toBeVisible({ timeout: 10_000 });
  const namespaceOptions = await namespaceMenu.locator(".sel-option").allTextContents();
  expect(namespaceOptions[0], "第一项必须还是「沿用沙箱」，不能把人默认值藏起来").toBe(`沿用沙箱（${NS_B}）`);
  expect(namespaceOptions.includes("public"), `公共空间就该写成 public，实际读数=${JSON.stringify(namespaceOptions)}`).toBe(true);
  expect(
    namespaceOptions.some((text) => text.trim().endsWith("()")),
    `出现了空括注的脏读数：${JSON.stringify(namespaceOptions)}`
  ).toBe(false);
  expect(namespaceOptions.some((text) => text.includes(NS_A)), `命名空间列表里没有目标上已有的 ${NS_A}`).toBe(true);
  await namespaceMenu.locator(".sel-option", { hasText: NS_A }).click({ force: true });
  await expect(namespaceField.locator(".sel-value")).toHaveText(NS_A, { timeout: 10_000 });
  await expect(namespaceNote).toHaveCount(0);

  // ④ 点晋级 → 计划重建，停在第4步，目标换成所选连接。
  // 先把生产目标造成与沙箱不同的内容（服务端直改，不借应用自己的写路径），
  // 这样这份晋级计划真有东西要写，dry-run 报出来的不是「无变化」；
  // 沙箱 B 一个字节都没动，验证指纹不会漂，晋级不会被误拒。
  await publishNacosContent(BASE_A, NS_A, DATA_ID, GROUP, baselineB, "yaml");
  const driftA = await fetchNacosContentUntil(BASE_A, NS_A, DATA_ID, GROUP, (c) => c.includes("cycle: daily"));
  expect(driftA, "生产目标没能造成与沙箱不同的内容，dry-run 的读数就是空的").toContain("cycle: daily");
  await promoteBtn.click();
  await expect(page.locator(".apply-view .apply-plan-summary").first()).toContainText(
    "Retest Nacos A / " + NS_A,
    { timeout: 30_000 }
  );
  // 落点落在目标上已有的租户，这份计划才是「覆盖同名配置」；落错租户就变成新建一套租户（新增）
  await expect(page.locator(".apply-view .apply-action.apply-action-overwrite").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".apply-view .apply-action.apply-action-create")).toHaveCount(0);
  await expect(page.locator(".apply-view .apply-workspace").first()).toBeVisible({ timeout: 30_000 });
  // 晋级面板跟着旧执行态一起消失：新计划还没执行过，不该再挂着「已写入沙箱」的结论
  await expect(page.locator(".apply-promote-panel")).toHaveCount(0);
  await expect(page.locator('.apply-view .diff-workflow-step[aria-current="step"]')).toContainText("生成并审核变更计划");

  // ⑤ 这份晋级计划没有对比现场可回：步骤条退回纯指示，气泡不许再写「回到「
  await expect(clickableSteps(page)).toHaveCount(0);
  const stepTitles = await applyStepTitles(page);
  expect(stepTitles.length, "步骤条一条都没读到，等于什么都没校验").toBeGreaterThan(0);
  for (const title of stepTitles) {
    expect(title, `步骤气泡仍在承诺「${title}」，但这一点下去并不会回到对比页`).not.toContain("回到「");
  }

  const promoteSelectAll = page.getByRole("button", { name: "全选" }).first();
  if (await promoteSelectAll.count()) await promoteSelectAll.click();
  await page.locator("button", { hasText: "Dry-run 检查" }).last().click({ force: true }).catch(() => undefined);
  await expect(page.locator(".apply-execution-notice").filter({ hasText: "Dry-run 检查通过" })).toBeVisible({ timeout: 60_000 });

  // 全程到这里只有第 2 步那一次真实写入：dry-run 与晋级计划都不许碰服务端
  await expectNoDisabledWriteError(page);
  const bNow = await fetchNacosContent(BASE_B, NS_B, DATA_ID, GROUP);
  expect(bNow.trim(), "沙箱计划之外的动作把 B 侧改了").toBe(afterApply.trim());
  const aNow = await fetchNacosContent(BASE_A, NS_A, DATA_ID, GROUP);
  expect(aNow.trim(), "晋级计划的 dry-run 把生产目标写了").toContain("cycle: daily");

  await page.screenshot({ path: "results/s31-promote-entry-step5.png", fullPage: true });

  // ⑥ 操作历史：能就地读出「本次改动」，且整页没有任何晋级按钮
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
  await expect(page.locator("button", { hasText: "晋级" })).toHaveCount(0);
  await expect(page.locator(".history-followup-panel")).toContainText("晋级到生产的入口在变更计划第5步");

  await page.screenshot({ path: "results/s31-history-change-detail.png", fullPage: true });

  // 收尾：把两侧还原成本用例开始实测到的基线，别把现场留给后面的用例
  await publishNacosContent(BASE_A, NS_A, DATA_ID, GROUP, baselineA, "yaml");
  await publishNacosContent(BASE_B, NS_B, DATA_ID, GROUP, baselineB, "yaml");
  await fetchNacosContentUntil(BASE_A, NS_A, DATA_ID, GROUP, (c) => c.trim() === baselineA.trim());
  await fetchNacosContentUntil(BASE_B, NS_B, DATA_ID, GROUP, (c) => c.trim() === baselineB.trim());
});
