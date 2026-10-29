/**
 * S33（轮98 A10 真机读数）半截写入的两条出口：跳过失败项继续、以及目标已经是这一版时一个字节都不写。
 *
 * 为什么必须真机跑（jsdom 给不了的三件事）：
 *  ① 「已写成那条没有被再写一遍」只能数服务端真实收到的 publish 请求——组件测试里
 *    executeApplyPlan 是 mock，第二轮到底发了几脚写，jsdom 看不见；
 *  ② 半截失败的现场（第 1 条落库、第 2 条被服务端拒、第 3 条没轮到）与 S32 同法造：
 *    拒绝注入落在桥的 provider 边界（takeRetestPublishRefusal），抛出点与真实
 *    `if (text !== "true") throw` 同一支笔，生产代码一行不改；
 *  ③ 「全部已达成 ⇒ 不写、不记历史」这条最危险的谎报形态（把什么都没做报成变更执行完成），
 *    只能在真历史列表上数记录条数、在真桥日志上数写入条数。
 *
 * PS-01 三项计划 → 第 2 项注入拒绝 → 失败屏出现「跳过这一项，继续剩下的」（与回退入口并存）
 *       → 点它 → 第 3 项落库、第 1 项 publish 计数仍是 1（本轮最硬的一条证据）、
 *         第 2 项一次都没被尝试；操作历史里成功记录的「本次改动」只有第 3 项。
 * PS-02 计划生成后由「另一个人」把目标写成我们要的那一版（外部 publish A 内容到 B）
 *       → dry-run 报「计划写入 0 项」并说明 2 项已达成 → 执行 → 屏上如实说没有写入、
 *         没有绿色成功横幅、桥侧 0 条 publish、操作历史 0 条 apply 记录。
 *
 * A3 的反向真机读数（目标变成第三个值 ⇒ 照样拦）已由 99-s-apply-failure-error-once.spec.ts 覆盖，
 * 这里不重复造。
 */
import { test, expect, fetchNacosContentUntil } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import {
  onBridgeLog,
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
/** 三条都在 16 对播种清单里且 A/B 内容必然不同（gen.py：注释措辞/行序/值差异）。 */
const THREE = ["svc-billing.yaml", "svc-search.yaml", "svc-config.yaml"];
const TWO = ["svc-billing.yaml", "svc-search.yaml"];
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

  // 匹配清单默认把全部同名项都勾上，逐条对齐到「只有这几条」，否则计划就成了 13 项。
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

/** 真人路径：全选 → dry-run（返回时 execute-notice 已就位）。 */
async function selectAllAndDryRun(page: Page, expectedItems: number): Promise<void> {
  const view = page.locator(".apply-view");
  const selectAll = view.getByRole("button", { name: "全选" }).first();
  if (await selectAll.count()) await selectAll.click().catch(() => undefined);
  await expect(view.locator(".apply-selection-note")).toContainText(String(expectedItems), { timeout: T });

  const dryRunBtn = view.locator("button", { hasText: "Dry-run 检查" }).last();
  await dryRunBtn.click({ force: true }).catch(() => undefined);
  if ((await view.locator(".apply-execution-notice, .apply-already-applied").count()) === 0) {
    await dryRunBtn.evaluate((el) => (el as HTMLElement).click()).catch(() => undefined);
  }
  await expect(view.locator(".apply-execution-notice").filter({ hasText: "Dry-run 检查通过" })).toBeVisible({ timeout: 90_000 });
}

/** 真人路径：勾确认 → 执行变更（endState 决定等成功还是等失败）。 */
async function confirmAndExecute(page: Page, endState: "success" | "failed"): Promise<void> {
  const view = page.locator(".apply-view");
  await view.locator(".apply-confirm-check input").check();
  const execBtn = view.locator("button", { hasText: "执行变更" }).last();
  await execBtn.click({ force: true }).catch(() => undefined);
  if ((await view.locator(".apply-task-progress").count()) === 0) {
    await execBtn.evaluate((el) => (el as HTMLElement).click()).catch(() => undefined);
  }
  await expect(view.locator(`.apply-task-progress .task-status-${endState}`).first()).toBeVisible({ timeout: 180_000 });
  await page.waitForTimeout(500);
}

/** 桥日志水位线：数「服务端真的收到过几脚写」，读屏看不到这件事。 */
function bridgeWaterline() {
  const lines: string[] = [];
  onBridgeLog((line) => lines.push(line));
  // 写路径的桥日志字面量：走 apply 计划的是 `ConfigCenter*FromApplyPlan`，它记的是
  // `publish <ns> <group> <dataId> type=ref`；通用绑定那条才是 type=nacos。两种都算「服务端收到写」。
  // 不能用裸 `publish`：注入拒绝记的是 `publish-refused … injected`，混进来就把 0 次读成 1 次。
  const publishLine = (dataId: string) => new RegExp(`publish ${NS_B} ${GROUP} ${dataId} type=(ref|nacos)`);
  const anyPublish = /publish \S+ \S+ \S+ type=(ref|nacos)/;
  return {
    /** 目标侧对某个 dataId 的 publish 次数（一次写一行，重复执行会涨）。 */
    publishCount: (dataId: string) => lines.filter((line) => publishLine(dataId).test(line)).length,
    publishCountAll: () => lines.filter((line) => anyPublish.test(line)).length,
    tail: (n = 40) => lines.slice(-n).join("\n"),
  };
}

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page, retest }) => {
  await installRetestBridge(page, retest);
});

test("PS-01 半截失败后「跳过这一项继续剩下的」: 已写成的不重写、剩下的真落库", async ({ page }) => {
  test.setTimeout(600_000);
  await republishRetestData();
  const baselines = await readBaselines(THREE);
  await bootstrap(page);

  // ① 3 项覆盖计划，执行顺序 = 计划项可见顺序（planWrites 按 items 生成）
  const rows = await buildBatchPlan(page, THREE);
  const writtenId = rows[0].dataId; // 会写成
  const refusedId = rows[1].dataId; // 注入拒绝
  const pendingId = rows[2].dataId; // 一失败就停 ⇒ 这一轮没轮到

  const water = bridgeWaterline();
  setRetestPublishRefusals([{ dataId: refusedId, group: GROUP, namespace: NS_B }]);
  await selectAllAndDryRun(page, THREE.length);
  await confirmAndExecute(page, "failed");

  const view = page.locator(".apply-view");

  // ② 失败屏：进度数「已处理」，部分写入提示数「已写入」，并点名失败那条
  const meta = await view.locator(".apply-task-progress-meta").innerText();
  expect(meta.replace(/\s+/g, ""), "进度面板没把三条都算进已处理").toMatch(/已处理\s*2\s*\/\s*3\s*项/);
  const partial = await view.locator(".apply-partial-write").innerText();
  expect(partial, "部分写入提示谎报了真正落笔的条数").toMatch(/已写入\s*1\s*\/\s*3\s*项/);
  expect(partial, "部分写入提示没说是哪一条失败").toContain(refusedId);

  // ③ 桥侧计数：第 1 条真写成一次，第 2 条被拒（请求到了服务端才算），第 3 条压根没轮到
  await expect.poll(() => water.publishCount(writtenId), { timeout: T, message: `第 1 条没落库：\n${water.tail()}` }).toBe(1);
  expect(water.publishCount(refusedId), "被注入拒的这条在桥里连一次 publish 都没发起：注入没生效").toBe(0);
  expect(water.publishCount(pendingId), "一失败就停的语义变了：第 3 条在第 2 条失败后还被尝试").toBe(0);
  const hits = retestPublishRefusalHitsSnapshot();
  expect(hits.length, `注入命中次数不是 1：${JSON.stringify(hits)}`).toBe(1);
  expect(hits[0].dataId, "被拒的不是第 2 条").toBe(refusedId);

  // ④ 第二条出口出现，且与回退入口并存（跳过在前：想留着已写成的部分继续）
  const skipExit = view.locator(".apply-skip-exit");
  await expect(skipExit, "半截失败屏上没有「跳过这一项，继续剩下的」").toBeVisible({ timeout: T });
  const skipBtn = skipExit.locator("button").first();
  await expect(skipBtn, "跳过出口被守卫锁死（确认勾选没延到这一步？）").toBeEnabled();
  const exits = await view.locator(".apply-skip-exit, .apply-rollback-entry").evaluateAll((nodes) => nodes.map((node) => node.className));
  expect(exits, "两条出口少了一条或顺序反了").toEqual(["apply-skip-exit", "apply-rollback-entry"]);
  const hint = await skipExit.locator(".apply-skip-exit-hint").innerText();
  expect(hint.replace(/\s+/g, ""), "跳过出口没说清剩下几条").toContain("剩下的2项");

  // ⑤ 服务端真值（点跳过之前）：第 1 条 = A 基线，第 2/3 条还是原样
  const firstOnB = await fetchNacosContentUntil(BASE_B, NS_B, writtenId, GROUP, (c) => c.trim() === baselines[writtenId].a.trim());
  expect(firstOnB.trim(), "第 1 条没落库，后面的读数都没意义").toBe(baselines[writtenId].a.trim());
  const thirdOnBBefore = await fetchNacosContentUntil(BASE_B, NS_B, pendingId, GROUP, () => true);
  expect(thirdOnBBefore.trim(), "没轮到的第 3 条被写了").toBe(baselines[pendingId].b.trim());

  // ⑥ 点「跳过这一项」：摘掉失败项，用剩下的 2 条（含已写成那条）再执行一次
  await skipBtn.click({ force: true }).catch(() => undefined);
  await expect
    .poll(() => view.locator(".apply-task-progress .task-status-success").count(), {
      timeout: 180_000,
      message: `点了跳过没跑出第二次执行：\n${water.tail()}`,
    })
    .toBeGreaterThan(0);
  await page.waitForTimeout(1_000);

  // ⑦ 本轮最硬的一条证据：已写成的第 1 条没有被再写一遍（publish 计数仍为 1）
  expect(water.publishCount(writtenId), `重试把已经写成的 ${writtenId} 又写了一遍：\n${water.tail()}`).toBe(1);
  await expect.poll(() => water.publishCount(pendingId), { timeout: T, message: `摘掉失败项后第 3 条仍没写入：\n${water.tail()}` }).toBe(1);
  expect(water.publishCount(refusedId), "摘掉的失败项在第二轮还被尝试").toBe(0);

  // ⑧ 屏上的事实跟着变了：失败屏消失，已达成项如实说明，成功横幅仍在（这一轮真写过一条）
  await expect(view.locator(".apply-partial-write"), "第二轮成功后还挂着上一轮的半截写入提示").toHaveCount(0);
  await expect(view.locator(".apply-skip-exit"), "第二轮成功后还留着跳过出口").toHaveCount(0);
  const note = view.locator(".apply-already-applied");
  await expect(note, "第二轮没说明有一条已经是这一版").toBeVisible({ timeout: T });
  expect((await note.innerText()).replace(/\s+/g, ""), "已达成条数报错").toContain("另有1项");
  const banner = await view.locator(".apply-execution-notice").innerText();
  expect(banner, "真写过一条却不许报执行完成").toContain("变更执行完成");
  // 横幅那个数必须与同一轮历史里的「本次写入 1 项」对上：勾了 2 条（含已写成那条）不等于写了 2 条
  expect(banner.replace(/\s+/g, ""), `横幅按勾选数报了已应用：${banner}`).toContain("已应用1项");

  // ⑨ 服务端真值（第二轮之后）
  const thirdOnB = await fetchNacosContentUntil(BASE_B, NS_B, pendingId, GROUP, (c) => c.trim() === baselines[pendingId].a.trim());
  expect(thirdOnB.trim(), "摘掉失败项后第 3 条没写进服务端").toBe(baselines[pendingId].a.trim());
  const refusedOnB = await fetchNacosContentUntil(BASE_B, NS_B, refusedId, GROUP, () => true);
  expect(refusedOnB.trim(), "被摘掉的失败项内容变了").toBe(baselines[refusedId].b.trim());
  const firstOnBAfter = await fetchNacosContentUntil(BASE_B, NS_B, writtenId, GROUP, () => true);
  expect(firstOnBAfter.trim(), "已写成那条的内容被第二轮改动").toBe(baselines[writtenId].a.trim());
  await page.screenshot({ path: "results/s33-skip-exit.png", fullPage: true });

  // ⑩ 操作历史：两条 apply 记录（失败 + 成功），成功记录的「本次改动」只有第 3 条
  await navigate(page, "操作历史");
  const applyRows = page.locator(".op-history-item", { has: page.locator(".history-type.apply") });
  await expect(applyRows).toHaveCount(2, { timeout: T });
  const successRow = applyRows.filter({ has: page.locator(".history-result.success") }).first();
  await expect(successRow, "第二轮的成功记录没进操作历史").toBeVisible({ timeout: T });
  await successRow.click();
  const detail = page.locator(".history-change-detail").first();
  if (!(await detail.isVisible().catch(() => false))) await successRow.click();
  await expect(detail, "成功记录没有「本次改动」").toBeVisible({ timeout: T });
  await expect(detail.locator(".history-change-summary")).toContainText("本次写入 1 项");
  await expect(detail.locator(".history-change-row")).toHaveCount(1);
  await expect(detail.locator(".history-change-row").first().locator(".history-change-item")).toContainText(pendingId);
  await expect(detail.locator(".history-change-list"), "已达成那条进了落笔清单").not.toContainText(writtenId);
  await page.screenshot({ path: "results/s33-history-after-skip.png", fullPage: true });

  // 收尾：撤掉注入、把 B 侧还原成用例开始前的基线（整批串行，后面还指着这份数据）
  resetRetestPublishRefusals();
  for (const dataId of THREE) {
    await publishNacosContent(BASE_B, NS_B, dataId, GROUP, baselines[dataId].b, "yaml");
    await fetchNacosContentUntil(BASE_B, NS_B, dataId, GROUP, (c) => c.trim() === baselines[dataId].b.trim());
  }
});

test("PS-02 目标已经是这一版: dry-run 报 0 项、执行不写不记历史、界面不许报成功", async ({ page }) => {
  test.setTimeout(600_000);
  await republishRetestData();
  const baselines = await readBaselines(TWO);
  await bootstrap(page);

  const rows = await buildBatchPlan(page, TWO);

  // 现场：计划生成之后，另一个人已经把这两条写成了我们要的那一版（外部写 B 侧，绕开应用）
  for (const { dataId } of rows) {
    await publishNacosContent(BASE_B, NS_B, dataId, GROUP, baselines[dataId].a, "yaml");
    await fetchNacosContentUntil(BASE_B, NS_B, dataId, GROUP, (c) => c.trim() === baselines[dataId].a.trim());
  }

  const water = bridgeWaterline();

  // ① dry-run 如实报数：要写 0 项，另有 2 项已经是这一版
  await selectAllAndDryRun(page, TWO.length);
  const view = page.locator(".apply-view");
  const dryNotice = await view.locator(".apply-execution-notice").innerText();
  expect(dryNotice.replace(/\s+/g, ""), `dry-run 还打算写：${dryNotice}`).toContain("计划写入0项");
  const dryNote = view.locator(".apply-already-applied");
  await expect(dryNote, "dry-run 没说清哪几条已经是这一版").toBeVisible({ timeout: T });
  expect((await dryNote.innerText()).replace(/\s+/g, ""), "已达成条数报错").toContain("另有2项");

  // ② 执行：一个字节都不写
  await confirmAndExecute(page, "success");
  expect(water.publishCountAll(), `全部已达成还是发了写请求：\n${water.tail()}`).toBe(0);

  // ③ 界面如实：没有绿色成功横幅那句「变更执行完成」，摊开项清单
  const box = view.locator(".apply-already-applied").first();
  await expect(box).toBeVisible({ timeout: T });
  const boxText = await box.innerText();
  expect(boxText, "全部已达成没说实话").toContain("没有需要写入的内容");
  for (const { dataId } of rows) {
    expect(boxText, `已达成清单里点名缺了 ${dataId}`).toContain(dataId);
  }
  const screen = await view.innerText();
  expect(screen, "什么都没写却报成变更执行完成").not.toMatch(/变更执行完成/);
  await expect(view.locator(".apply-execution-notice"), "已达成屏不该再出那条执行横幅").toHaveCount(0);
  await page.screenshot({ path: "results/s33-already-applied-only.png", fullPage: true });

  // ④ 服务端仍是「另一个人」写的那份，没被这一轮改动
  for (const { dataId } of rows) {
    const stillThere = await fetchNacosContentUntil(BASE_B, NS_B, dataId, GROUP, () => true);
    expect(stillThere.trim(), `这一轮明明写了 ${dataId}`).toBe(baselines[dataId].a.trim());
  }

  // ⑤ 操作历史：没有发生任何变更 ⇒ 一条记录都不该有（桥每次 install 重置内存历史）
  await navigate(page, "操作历史");
  const applyRows = page.locator(".op-history-item", { has: page.locator(".history-type.apply") });
  await expect(applyRows, "什么都没写却记了一条操作历史").toHaveCount(0, { timeout: T });

  // 收尾：把 B 侧还原成用例开始前的基线
  for (const dataId of TWO) {
    await publishNacosContent(BASE_B, NS_B, dataId, GROUP, baselines[dataId].b, "yaml");
    await fetchNacosContentUntil(BASE_B, NS_B, dataId, GROUP, (c) => c.trim() === baselines[dataId].b.trim());
  }
});
