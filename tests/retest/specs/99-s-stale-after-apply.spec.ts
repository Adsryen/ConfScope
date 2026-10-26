/**
 * 写后失真回归（轮43 AC3 / AC4 / AC5，用例号 ST-01…ST-05）。
 *
 * 立轮理由（轮42 之后才暴露）：全站唯一的写路径是变更计划，而执行发生在另一棵子树里
 * （ApplyPlanView）。浏览页 `.browse-cache` 与对比页 `.diff-apply-cache` 都是保活的——
 * 切走只 display:none，不卸载也不重新取数。于是「变更执行完成」刚提示完，切回浏览页
 * 正文还是执行前那一份（探针实测：UI 43 行 / 服务端 45 行），新建的配置不在当前列表里，
 * 对比面板还挂着执行前的差异。用户只能理解成「没写进去」，接着重复生成计划、重复执行。
 *
 * 口径：写后失效广播（src/lib/configChangeBus.ts）由执行器在真写成功后发，
 * 订阅方自己决定怎么刷新——浏览页按当前搜索态重取（隐藏期攒着，切回前台合并补做），
 * 对比页只标记过期 + 一键重比（对比是重操作，不自动打断）。
 *
 * 本文件把探针的 console 读数换成可判定断言：
 *  ST-01 就地编辑执行后回浏览页 ⇒ 正文 = 服务端真值，草稿不被冲掉，视图自己发过重取请求，
 *        并且刚写进去的内容不再被当成「未保存」（AC5 的 dirty 重算）。
 *  ST-02 新建执行后回浏览页 ⇒ 新配置直接出现在当前列表，不需要手动搜索自救。
 *  ST-03 计划删掉当前选中项 ⇒ 详情不再挂已删配置的 affordance，并给出可见说明。
 *  ST-04 A→B 执行后回对比页 ⇒ 出现「结果已过期」+ 一键重比，重比后两侧真值一致、提示消失。
 *  ST-05 不回退收益 ⇒ 没有任何写入时，切走切回仍然 0 次列表请求（保活不是白做的）。
 *
 * 断言只锁服务端真值与 DOM 钩子（`.browser-detail-notice` / `.diff-result-stale` /
 * `.diff-same` / `task-status-success`），不锁可改的用户文案字面量（轮43 定过的新口径）。
 */
import { test, expect, fetchNacosContent, fetchNacosContentChanged, fetchNacosContentUntil } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { onBridgeLog } from "../bridge/retestBinding";
import { republishRetestData, publishNacosContent } from "../bridge/republishData";
import { navigate, dismissStartupDialog, setDiffSource } from "./ui";
import { backToBrowseFromPlan, expectPlanItem, planRows } from "./planExit";
import { loadRetestState } from "../state";

const state = loadRetestState();
const BASE_A = state.nacos.a.baseUrl;
const BASE_B = state.nacos.b.baseUrl;
const NS_A = state.nacos.a.namespace;
const NS_B = state.nacos.b.namespace;
const GROUP = "RETEST-PROD";
const EDIT_TARGET = "svc-pay.properties";
const BILLING = "svc-billing.yaml";
const T = 30_000;

type Page_ = import("@playwright/test").Page;

/** 打开浏览页某条配置的正文（正文视图只在非编辑态挂着）。 */
async function openBrowseDetail(page: Page_, dataId: string): Promise<void> {
  const item = page.locator(".browser-item-id", { hasText: dataId }).filter({ visible: true }).first();
  await expect(item, `列表里没有 ${dataId}`).toBeVisible({ timeout: T });
  await item.click();
  await expect(page.locator(".code-area").filter({ visible: true }).first()).toBeVisible({ timeout: T });
}

/** 真人出路：全选 → dry-run → 勾选确认 → 执行 → 任务成功。 */
async function executePlan(page: Page_): Promise<void> {
  await expect(page.locator(".apply-ledger, .apply-item-list").filter({ visible: true }).first()).toBeVisible({ timeout: T });
  const selectAll = page.getByRole("button", { name: "全选" }).first();
  if (await selectAll.count()) await selectAll.click().catch(() => undefined);
  await page.waitForTimeout(300);

  const dryRunBtn = page.locator("button", { hasText: "Dry-run 检查" }).last();
  await dryRunBtn.click({ force: true, timeout: 10_000 }).catch(() => undefined);
  if ((await page.locator(".apply-execution-notice").count()) === 0) {
    await dryRunBtn.evaluate((el) => (el as HTMLElement).click());
  }
  await expect(page.locator(".apply-execution-notice").first()).toBeVisible({ timeout: 120_000 });

  await page.locator(".apply-confirm-check input").check();
  await page.waitForTimeout(300);
  const execBtn = page.locator("button", { hasText: "执行变更" }).last();
  await execBtn.click({ force: true, timeout: 10_000 }).catch(() => undefined);
  if ((await page.locator(".apply-task-progress").count()) === 0) {
    await execBtn.evaluate((el) => (el as HTMLElement).click());
  }
  // 成功信号取任务状态类名（task-status-success），不锁「变更执行完成」那句文案
  await expect(page.locator(".apply-task-progress .task-status-success").first()).toBeVisible({ timeout: 120_000 });
}

/**
 * bridge 调用水位线：「视图有没有自己去重取」这种收益只能按请求次数判定，
 * 读屏看不到，文案也证明不了。retest 桥的调用日志在 node 侧汇总（installRetestBridge
 * 用 exposeFunction 把绑定搬到 node），所以这里数的是真实发出的 ConfigCenter* 请求。
 */
function bridgeWaterline() {
  const lines: string[] = [];
  onBridgeLog((line) => lines.push(line));
  return {
    mark: () => lines.length,
    countSince: (from: number, method: string) => lines.slice(from).filter((line) => line.includes(method)).length,
    tail: (n = 40) => lines.slice(-n).join("\n"),
  };
}

/** 首尾都要把复测基线写回去：整批是串行的，后面 99-s-* 还指着这份数据。 */
async function restoreBaseline(probe: { dataId: string; group: string } | null, side: "A" | "B" = "A"): Promise<void> {
  await republishRetestData();
  const base = side === "A" ? BASE_A : BASE_B;
  const ns = side === "A" ? NS_A : NS_B;
  if (probe) {
    // republish 只覆写基线那一套，探针自己造的条目要显式清掉，否则列表条数漂给后面的用例
    const url = `${base}/v1/cs/configs?dataId=${encodeURIComponent(probe.dataId)}&group=${encodeURIComponent(probe.group)}&tenant=${encodeURIComponent(ns)}`;
    const res = await fetch(url, { method: "DELETE" }).catch(() => null);
    console.log(`[stale] 清理探针条目 ${probe.dataId} HTTP=${res?.status ?? "n/a"}`);
  }
}

test.beforeEach(async ({ page, retest }) => {
  await installRetestBridge(page, retest);
});

test("ST-01 编辑执行后回浏览页: 正文=服务端真值 + 草稿不被冲掉 + 自动重取", async ({ page }) => {
  test.setTimeout(300_000);
  await republishRetestData();
  const t0 = Date.now();
  const log = (s: string) => console.log(`[ST-01][t+${Date.now() - t0}ms] ${s}`);
  const water = bridgeWaterline();

  const before = await fetchNacosContent(BASE_A, NS_A, EDIT_TARGET, GROUP);
  const marker = `# r43-stale-${Date.now()}`;
  log(`基线正文 ${before.split("\n").length} 行`);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");
  await openBrowseDetail(page, EDIT_TARGET);

  await page.getByRole("button", { name: "编辑" }).click();
  const ta = page.locator(".code-editor-ta").filter({ visible: true }).first();
  await expect(ta).toBeVisible({ timeout: T });
  await ta.fill(`${before}\n${marker}\n`);

  await page.getByRole("button", { name: /生成变更计划/ }).click();
  const rows = await planRows(page);
  expect(rows.map((row) => row.action).join(",")).toBe("overwrite");
  expect(rows[0].dataId).toBe(EDIT_TARGET);
  await executePlan(page);
  log("执行完成");

  const server = await fetchNacosContentUntil(BASE_A, NS_A, EDIT_TARGET, GROUP, (text) => text.includes(marker));
  expect(server, "服务端没写进去就不是写后失真问题").toContain(marker);

  const at = water.mark();
  await backToBrowseFromPlan(page);
  // 视图自己去重取：切回来这段时间里必须真的发过列表请求（不是等用户手动搜索自救）
  await expect
    .poll(() => water.countSince(at, "ConfigCenterListConfigs"), { timeout: T, message: `切回浏览页没有自动重取列表：\n${water.tail()}` })
    .toBeGreaterThan(0);

  // 草稿安全：重取只换服务端数据，不退编辑态、不覆盖用户正在写的东西
  await expect(ta).toBeVisible({ timeout: T });
  await expect.poll(async () => (await ta.inputValue()).includes(marker), { timeout: T, message: "草稿被写后重取冲掉了" }).toBe(true);

  // 刚写进去的内容不该再被当成「未保存」：退出编辑不许冒出放弃确认
  await page
    .locator(".fmt-bar button", { hasText: /^取消$/ })
    .first()
    .click();
  await expect(page.getByRole("dialog").filter({ hasText: "放弃" })).toHaveCount(0);

  const area = page.locator(".code-area").filter({ visible: true }).first();
  await expect(area).toBeVisible({ timeout: T });
  await expect
    .poll(async () => (await area.innerText()).includes(marker), { timeout: T, message: "回浏览页正文还是执行前那一份" })
    .toBe(true);
  log("正文与列表都反映新值 ✓");

  await page.screenshot({ path: "results/r43-st01-body-after-apply.png", fullPage: true });
  await restoreBaseline(null);
});

test("ST-02 新建执行后回浏览页: 新配置直接出现在当前列表", async ({ page }) => {
  test.setTimeout(300_000);
  await republishRetestData();
  const t0 = Date.now();
  const log = (s: string) => console.log(`[ST-02][t+${Date.now() - t0}ms] ${s}`);
  const water = bridgeWaterline();

  const NEW_ID = `retest-r43-created-${Date.now() % 100000}.properties`;
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item-id").filter({ visible: true }).first()).toBeVisible({ timeout: T });
  const countBefore = await page.locator(".browser-item-id").filter({ visible: true }).count();
  log(`列表基线条数=${countBefore}`);

  await page.getByRole("button", { name: "新建配置" }).click();
  await expect(page.getByRole("heading", { name: "新建配置" })).toBeVisible({ timeout: T });
  await page.getByPlaceholder("请输入 Data ID").fill(NEW_ID);
  const groupInput = page.locator(".modal label.field:has(> span:has-text('Group'))").locator("input").first();
  if ((await groupInput.inputValue()) !== GROUP) await groupInput.fill(GROUP);
  await page.locator(".modal .code-editor-ta, .modal textarea").first().fill(`r43=created\n`);
  await page.getByRole("button", { name: /生成变更计划/ }).click();
  const rows = await planRows(page);
  expect(rows.map((row) => row.action).join(",")).toBe("create");
  expect(rows[0].dataId).toBe(NEW_ID);
  await executePlan(page);
  log("执行完成");

  const created = await fetchNacosContentUntil(BASE_A, NS_A, NEW_ID, GROUP, (text) => text.includes("r43=created"));
  expect(created, "服务端没建出来就不是写后失真问题").toContain("r43=created");

  const at = water.mark();
  await backToBrowseFromPlan(page);
  await expect
    .poll(() => water.countSince(at, "ConfigCenterListConfigs"), { timeout: T, message: `切回浏览页没有自动重取列表：\n${water.tail()}` })
    .toBeGreaterThan(0);

  // 关弹层：新建弹层里那份草稿这时已经写到服务端了，放弃它不丢任何东西
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: /放弃/ })
    .first()
    .click()
    .catch(() => undefined);

  const createdRow = page.locator(".browser-item-id", { hasText: NEW_ID }).filter({ visible: true }).first();
  await expect(createdRow, "新建并执行成功的配置没有直接进当前列表").toBeVisible({ timeout: T });
  const countAfter = await page.locator(".browser-item-id").filter({ visible: true }).count();
  expect(countAfter, "列表条数没跟着新配置走").toBeGreaterThan(countBefore);
  log(`列表 ${countBefore} → ${countAfter}，新条目直接可见 ✓`);

  await page.screenshot({ path: "results/r43-st02-created-in-list.png", fullPage: true });
  await restoreBaseline({ dataId: NEW_ID, group: GROUP });
});

test("ST-03 计划删掉当前选中项: 详情清空并给出可见说明", async ({ page }) => {
  test.setTimeout(300_000);
  await republishRetestData();
  const t0 = Date.now();
  const log = (s: string) => console.log(`[ST-03][t+${Date.now() - t0}ms] ${s}`);
  const water = bridgeWaterline();

  // 造一条只属于本用例的配置：删掉它不会动其他用例的基线，收尾再显式清理
  const PROBE_ID = `retest-r43-deleted-${Date.now() % 100000}.yaml`;
  await publishNacosContent(BASE_A, NS_A, PROBE_ID, GROUP, "r43: to-be-deleted\n", "yaml");
  log(`预置 ${PROBE_ID}`);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");
  await openBrowseDetail(page, PROBE_ID);

  await page.getByRole("button", { name: "删除" }).click();
  await expect(page.getByRole("heading", { name: "删除配置" })).toBeVisible({ timeout: T });
  await page.locator(".del-body input").fill(PROBE_ID);
  await page
    .getByRole("button", { name: /生成删除计划/ })
    .last()
    .click();
  const rows = await planRows(page);
  expect(rows.map((row) => row.action).join(",")).toBe("delete");
  expect(rows[0].dataId).toBe(PROBE_ID);
  await executePlan(page);
  log("执行完成");

  const gone = await fetchNacosContentChanged(BASE_A, NS_A, PROBE_ID, GROUP, "r43: to-be-deleted\n");
  expect(gone.includes("to-be-deleted"), `服务端还留着被删的内容：${gone.slice(0, 80)}`).toBe(false);

  const at = water.mark();
  await backToBrowseFromPlan(page);
  await expect
    .poll(() => water.countSince(at, "ConfigCenterListConfigs"), { timeout: T, message: `切回浏览页没有自动重取列表：\n${water.tail()}` })
    .toBeGreaterThan(0);

  // 不许静默变空：说明容器（带播报语义）必须出现，且点名是哪一条被删了
  const notice = page.locator(".browser-detail-notice").filter({ visible: true }).first();
  await expect(notice, "选中项被计划删掉后没有可见说明").toBeVisible({ timeout: T });
  await expect
    .poll(async () => (await notice.innerText()).includes(PROBE_ID), { timeout: T, message: "说明里没有那条配置的 dataId" })
    .toBe(true);
  await expect(notice).toHaveAttribute("role", "status");

  // 已删配置的正文与写入口 affordance 一个都不许留着
  await expect(page.locator(".code-area").filter({ visible: true })).toHaveCount(0);
  await expect(page.locator(".detail-header").filter({ visible: true })).toHaveCount(0);
  await expect(page.locator(".browser-item-id", { hasText: PROBE_ID }).filter({ visible: true })).toHaveCount(0);
  log("详情给出说明、正文与编辑入口都不再挂着已删配置 ✓");

  await page.screenshot({ path: "results/r43-st03-removed-notice.png", fullPage: true });
  await restoreBaseline({ dataId: PROBE_ID, group: GROUP });
});

test("ST-04 A→B 执行后回对比页: 结果过期提示 + 一键重比后两侧一致", async ({ page }) => {
  test.setTimeout(300_000);
  await republishRetestData();
  const t0 = Date.now();
  const log = (s: string) => console.log(`[ST-04][t+${Date.now() - t0}ms] ${s}`);

  // 前置真值：A 是 dev 变体（cycle: hourly），B 是 prod 变体（cycle: daily），两侧必须真的不同
  const devSide = await fetchNacosContentUntil(BASE_A, NS_A, BILLING, GROUP, (text) => text.includes("cycle: hourly"));
  expect(devSide, "A 侧不是 dev 变体，ST-04 的前提不成立").toContain("cycle: hourly");
  const prodSide = await fetchNacosContentUntil(BASE_B, NS_B, BILLING, GROUP, (text) => text.includes("cycle: daily"));
  expect(prodSide, "B 侧不是 prod 变体，ST-04 的前提不成立").toContain("cycle: daily");

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置对比");
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP, dataId: BILLING });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP, dataId: BILLING });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  const panel = page.locator(".diff-panel").filter({ visible: true }).first();
  await expect(panel).toBeVisible({ timeout: T });
  await expect(page.locator(".diff-same").filter({ visible: true }), "执行前两侧就一致，本用例没有意义").toHaveCount(0);
  log("执行前：两侧有差异");

  await page.getByRole("button", { name: "进入配置变更计划" }).last().click();
  await expectPlanItem(page, "overwrite");
  await executePlan(page);
  log("执行完成");

  const leftAfter = await fetchNacosContent(BASE_A, NS_A, BILLING, GROUP);
  const rightAfter = await fetchNacosContentUntil(BASE_B, NS_B, BILLING, GROUP, (text) => text === leftAfter);
  expect(rightAfter, "服务端两侧还没一致，重比结果不该显示无差异").toBe(leftAfter);

  // 回对比页走计划页的「返回」：`.diff-apply-cache` 只在 diff↔apply 之间保活，
  // 面板里的差异统计还是执行前那一刻 ⇒ 必须标过期并给一键重比。
  // （取证的反面：中途绕道配置浏览会把对比子树整个卸载，那条路径上没有旧结果挂着，
  //  过期提示本就不该出现——统一保活范围另立一轮处理，见 prd.md 同类问题清单。）
  await page.locator(".apply-view button", { hasText: "返回" }).first().click();
  await expect(page.locator(".diff-panel").filter({ visible: true }).first()).toBeVisible({ timeout: T });
  const stale = page.locator(".diff-result-stale").filter({ visible: true }).first();
  await expect(stale, "写后回对比页没有给出结果过期的可见提示").toBeVisible({ timeout: T });
  await expect(stale).toHaveAttribute("role", "status");
  log("过期提示出现 ✓");

  const retry = stale.locator("button").first();
  await expect(retry).toBeEnabled({ timeout: T });
  await retry.click();
  await expect(page.locator(".diff-result-stale").filter({ visible: true }), "重比后过期提示没消失").toHaveCount(0);
  await expect(page.locator(".diff-same").filter({ visible: true }).first(), "重比后面板没反映两侧已一致的真值").toBeVisible({
    timeout: T,
  });
  log("重比后面板显示两侧一致 ✓");

  await page.screenshot({ path: "results/r43-st04-diff-restale.png", fullPage: true });
  await republishRetestData();
  await fetchNacosContentUntil(BASE_B, NS_B, BILLING, GROUP, (text) => text.includes("cycle: daily"));
  log("基线已恢复");
});

test("ST-05 保活收益不回退: 无写入时切走切回仍 0 次列表请求", async ({ page }) => {
  test.setTimeout(180_000);
  await republishRetestData();
  const t0 = Date.now();
  const log = (s: string) => console.log(`[ST-05][t+${Date.now() - t0}ms] ${s}`);
  const water = bridgeWaterline();

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item-id").filter({ visible: true }).first()).toBeVisible({ timeout: T });
  await openBrowseDetail(page, EDIT_TARGET);

  const at = water.mark();
  await navigate(page, "设置");
  await expect(page.locator(".settings-page").filter({ visible: true }).first()).toBeVisible({ timeout: T });
  await page.waitForTimeout(800);
  await navigate(page, "配置浏览");
  await expect(page.locator(".code-area").filter({ visible: true }).first()).toBeVisible({ timeout: T });

  const listed = water.countSince(at, "ConfigCenterListConfigs");
  console.log(`[ST-05] 切走切回期间的列表请求次数=${listed}\n${water.tail(20)}`);
  expect(listed, "轮43 的写后失效把保活收益换掉了：没有写入也去重取列表").toBe(0);

  // 选中态与正文都还在（不是「回来重新加载一遍」）
  await expect(page.locator(".browser-item.active").filter({ visible: true }).first()).toContainText(EDIT_TARGET, { timeout: T });
  log("无写入切走切回 0 次列表请求 ✓");

  await restoreBaseline(null);
});
