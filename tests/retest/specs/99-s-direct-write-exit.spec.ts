/**
 * 轮42 永久回归：四个直写入口改造成「变更计划入口」之后的真机契约。
 *
 * 与既有 8 处断言的分工：那些用例锁的是「点了没写进去」（意图不变、只换呈现），
 * 本文件补上它们给不出的两块证据——
 *  1. **出路真的能用**：就地编辑生成的计划能 dry-run、能执行、内容真的落到 A 侧
 *     （只验「被挡住」会留下一个没人管的洞：入口生成的计划是不是根本执行不了？）。
 *  2. **审计不再说谎**：四个入口各点一次，操作历史里 `result:"failure"` 的条数一条都不许多
 *     （改造前一次点击 = 一条必然失败的记录，用户什么也没做错，界面却记他失败）。
 * 外加「计划动作挂对了类型」：编辑/删除/新建分别落成 覆盖 / 删除 / 新增，回滚落在正在看的那个配置上。
 */
import { test, expect, fetchNacosContent } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog } from "./ui";
import { backToBrowseFromPlan, expectNoDisabledWriteError, expectRollbackPlanRow, planRows } from "./planExit";
import { loadRetestState } from "../state";

const state = loadRetestState();
const BASE_A = state.nacos.a.baseUrl;
const NS_A = state.nacos.a.namespace;
const GROUP = "RETEST-PROD";
/**
 * 就地编辑用例的目标配置。
 *
 * 为什么不是 svc-gateway.yaml：种子里**故意**留了一对重复的顶层 `elk:` key（重复键回归用），
 * 而 src/lib/validate.ts 的 YAML 校验 uniqueKeys 默认开启 ⇒ 重复键判成 error，
 * 编辑器弹「格式校验未通过」，永远走不到计划页。拦得对，不是产品缺陷，但选目标必须避开它。
 * svc-pay.properties 正文干净，且 UX-02 已证明它追加注释后能生成覆盖计划。
 */
const EDIT_TARGET = "svc-pay.properties";
/** src/store/operationHistory.ts 的存储键；按 id 做增量比对，比翻操作历史页的 DOM 稳。 */
const OPS_KEY = "cs.operationHistory";
const T = 15_000;

interface OpsRecord {
  id: string;
  type: string;
  result: string;
}

/** 读当前 profile 的操作历史（localStorage），返回精简字段用于增量比对。 */
async function readOps(page: import("@playwright/test").Page): Promise<OpsRecord[]> {
  return page.evaluate((key) => {
    let parsed: unknown = [];
    try {
      parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
    } catch {
      parsed = [];
    }
    const list = Array.isArray(parsed) ? parsed : [];
    return list
      .map((raw) => {
        const r = raw as Record<string, unknown>;
        return { id: String(r.id ?? ""), type: String(r.type ?? ""), result: String(r.result ?? "") };
      })
      .filter((r) => r.id);
  }, OPS_KEY);
}

/** Nacos 上这个位置是否存在（非 200 视为不存在）。 */
async function nacosExists(dataId: string, group: string): Promise<boolean> {
  const res = await fetch(
    `${BASE_A}/v1/cs/configs?dataId=${encodeURIComponent(dataId)}&group=${encodeURIComponent(group)}&tenant=${encodeURIComponent(NS_A)}`,
    { cache: "no-store" }
  );
  return res.status === 200;
}

/** 打开浏览页里某个配置的详情（正文区就绪）。 */
async function openBrowseDetail(page: import("@playwright/test").Page, dataId: string) {
  const item = page.locator(".browser-item-id", { hasText: dataId }).first();
  await expect(item).toBeVisible({ timeout: 30_000 });
  await item.click();
  await expect(page.locator(".fmt-bar").first()).toBeVisible({ timeout: T });
}

/** 计划页：全选 → dry-run → 勾选确认 → 执行 → 等完成（与 T-CR-01 同一套已验证手顺）。 */
async function executePlan(page: import("@playwright/test").Page) {
  await expect(page.locator(".apply-ledger, .apply-item-list").first()).toBeVisible({ timeout: 30_000 });
  const selectAllBtn = page.getByRole("button", { name: "全选" }).first();
  if (await selectAllBtn.count()) await selectAllBtn.click();
  await page.waitForTimeout(300);

  const dryRunBtn = page.locator("button", { hasText: "Dry-run 检查" }).last();
  await dryRunBtn.click({ force: true, timeout: 10_000 }).catch(() => undefined);
  if ((await page.locator(".apply-execution-notice").count()) === 0) {
    await dryRunBtn.evaluate((el) => (el as HTMLElement).click());
  }
  await expect(page.locator(".apply-execution-notice").filter({ hasText: "Dry-run 检查通过" })).toBeVisible({ timeout: 60_000 });

  await page.locator(".apply-confirm-check input").check();
  await page.waitForTimeout(300);
  const execBtn = page.locator("button", { hasText: "执行变更" }).last();
  await execBtn.click({ force: true, timeout: 10_000 }).catch(() => undefined);
  if ((await page.locator(".apply-task-progress").count()) === 0) {
    await execBtn.evaluate((el) => (el as HTMLElement).click());
  }
  await expect(page.locator(".apply-task-progress .task-status-success, .apply-task-progress .task-status-failed").first()).toBeVisible({
    timeout: 60_000,
  });
  const notice = await page
    .locator(".apply-execution-notice")
    .last()
    .textContent()
    .catch(() => "");
  expect(notice ?? "").toContain("变更执行完成");
}

// DWE-01: 就地编辑 → 生成计划 → dry-run → 执行 → A 侧真落库（轮42 出路的可用性证明）
test("DWE-01 就地编辑的计划出路: 预告可见→生成覆盖计划→dry-run→执行→A 侧落库", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();

  const t0 = Date.now();
  const mark = (label: string) => console.log(`[DWE-01][t+${Date.now() - t0}ms] ${label}`);

  const before = await fetchNacosContent(BASE_A, NS_A, EDIT_TARGET, GROUP);
  expect(before.length).toBeGreaterThan(0);
  const marker = `# dwe01-plan-write: ${Date.now()}`;

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");
  await openBrowseDetail(page, EDIT_TARGET);
  const opsBefore = await readOps(page);
  mark(`浏览页就绪，操作历史基线 ${opsBefore.length} 条`);

  // 进入编辑态：工具栏必须先**看得见**「保存会生成变更计划」，不是点下去才知道
  await page.getByRole("button", { name: "编辑" }).click();
  const ta = page.locator(".code-editor-ta").first();
  await expect(ta).toBeVisible({ timeout: T });
  await expect(page.locator(".fmt-write-hint").filter({ visible: true }).first()).toContainText("变更计划", { timeout: T });

  await ta.fill(`${before}\n${marker}\n`);
  await page.getByRole("button", { name: /生成变更计划/ }).click();

  // 计划页：恰好一条、挂在同一个配置上、动作是覆盖
  const rows = await planRows(page);
  expect(rows.length, "就地编辑应当只生成一条计划项").toBe(1);
  expect(rows[0].dataId).toBe(EDIT_TARGET);
  expect(rows[0].action).toBe("overwrite");
  await expectNoDisabledWriteError(page);
  mark("覆盖计划已生成（1 项）");

  // 执行前：Nacos 一个字都不该变（生成计划 ≠ 写入）
  expect(await fetchNacosContent(BASE_A, NS_A, EDIT_TARGET, GROUP)).not.toContain(marker);

  await executePlan(page);
  mark("dry-run + 执行完成");

  // 真写路径落地
  const after = await fetchNacosContent(BASE_A, NS_A, EDIT_TARGET, GROUP);
  expect(after).toContain(marker);
  mark("A 侧落库断言通过");

  // 执行由计划执行器记操作历史；无论记成什么，都不许出现「必然失败」的记录
  const opsAfter = await readOps(page);
  const newOps = opsAfter.filter((r) => !opsBefore.some((o) => o.id === r.id));
  console.log(`[DWE-01] 本次新增操作记录 = ${JSON.stringify(newOps)}`);
  expect(
    newOps.filter((r) => r.result === "failure"),
    "直写入口改造后不该再产生失败审计"
  ).toEqual([]);

  await page.screenshot({ path: "results/dwe01-plan-executed.png", fullPage: true });

  // 收尾：恢复种子基线，别把 marker 漏给后面的用例
  await republishRetestData();
  for (let i = 0; i < 10; i++) {
    const text = await fetchNacosContent(BASE_A, NS_A, EDIT_TARGET, GROUP);
    if (!text.includes("dwe01-plan-write")) break;
    await page.waitForTimeout(1_500);
  }
  expect(await fetchNacosContent(BASE_A, NS_A, EDIT_TARGET, GROUP)).not.toContain(marker);
  mark("基线已恢复");
});

// DWE-02: 四个入口各点一次 → 动作分别是 覆盖/删除/新增/回滚 → Nacos 零变化 + 操作历史零失败
test("DWE-02 四个入口只生成计划: 覆盖/删除/新增/回滚 + Nacos 零变化 + 零失败审计", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();

  const t0 = Date.now();
  const mark = (label: string) => console.log(`[DWE-02][t+${Date.now() - t0}ms] ${label}`);

  const payBefore = await fetchNacosContent(BASE_A, NS_A, EDIT_TARGET, GROUP);
  const billingBefore = await fetchNacosContent(BASE_A, NS_A, "svc-billing.yaml", GROUP);
  const envBefore = await fetchNacosContent(BASE_A, NS_A, "svc-common.env", GROUP);
  const NEW_ID = "dwe-new.properties";

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item-id").first()).toBeVisible({ timeout: 30_000 });
  const opsBefore = await readOps(page);
  mark(`基线：操作历史 ${opsBefore.length} 条`);

  // ---- 入口 1：就地编辑 → 覆盖 ----
  await openBrowseDetail(page, EDIT_TARGET);
  await page.getByRole("button", { name: "编辑" }).click();
  await page.locator(".code-editor-ta").first().fill(`${payBefore}\n# dwe02-edit\n`);
  await page.getByRole("button", { name: /生成变更计划/ }).click();
  let rows = await planRows(page);
  expect(rows.map((r) => r.action).join(",")).toBe("overwrite");
  expect(rows[0].dataId).toBe(EDIT_TARGET);
  await expectNoDisabledWriteError(page);
  await backToBrowseFromPlan(page);
  // 草稿还在（生成计划不是写入成功），退出时必须有放弃确认，不能静默丢
  await page
    .locator(".fmt-bar button", { hasText: /^取消$/ })
    .first()
    .click();
  await page.getByRole("button", { name: "放弃并切换" }).click();
  await expect(page.locator(".code-editor-ta").filter({ visible: true })).toHaveCount(0, { timeout: T });
  mark("入口1 编辑 → 覆盖计划 ✓");

  // ---- 入口 2：删除 → 删除 ----
  await openBrowseDetail(page, "svc-common.env");
  await page.getByRole("button", { name: "删除" }).click();
  await expect(page.getByRole("heading", { name: "删除配置" })).toBeVisible({ timeout: T });
  await page.locator(".del-body input").fill("svc-common.env");
  await page
    .getByRole("button", { name: /生成删除计划/ })
    .last()
    .click();
  rows = await planRows(page);
  expect(rows.map((r) => r.action).join(",")).toBe("delete");
  expect(rows[0].dataId).toBe("svc-common.env");
  await expectNoDisabledWriteError(page);
  await backToBrowseFromPlan(page);
  await expect(page.getByRole("heading", { name: "删除配置" })).toBeHidden({ timeout: T });
  mark("入口2 删除 → 删除计划 ✓");

  // ---- 入口 3：新建 → 新增 ----
  await page.getByRole("button", { name: "新建配置" }).click();
  await expect(page.getByRole("heading", { name: "新建配置" })).toBeVisible({ timeout: T });
  await page.getByPlaceholder("请输入 Data ID").fill(NEW_ID);
  await page.locator(".modal .code-editor-ta, .modal textarea").first().fill("dwe02=1\n");
  await page.getByRole("button", { name: /生成变更计划/ }).click();
  rows = await planRows(page);
  expect(rows.map((r) => r.action).join(",")).toBe("create");
  expect(rows[0].dataId).toBe(NEW_ID);
  await expectNoDisabledWriteError(page);
  await backToBrowseFromPlan(page);
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: /放弃/ })
    .first()
    .click()
    .catch(() => undefined);
  await page.waitForTimeout(300);
  mark("入口3 新建 → 新增计划 ✓");

  // ---- 入口 4：历史回滚 → 挂在正在看的配置上 ----
  await openBrowseDetail(page, "svc-billing.yaml");
  await page.getByRole("button", { name: "历史变更" }).click();
  await expect(page.locator(".history-item").first()).toBeVisible({ timeout: 30_000 });
  await page.locator(".history-item").first().locator(".history-item-main").click();
  const rbBtn = page.getByRole("button", { name: /生成回滚计划/ }).last();
  await expect(rbBtn).toBeVisible({ timeout: T });
  await rbBtn.click();
  await expect(rbBtn).toHaveText(/确认生成回滚计划/, { timeout: T });
  await rbBtn.click();
  // 历史条目存的是发布**之前**的内容，且 v1 同内容连发会合并 nid ⇒ 与线上现值可能相同（skip）也可能不同（overwrite）
  const rollbackAction = await expectRollbackPlanRow(page, "svc-billing.yaml");
  await expectNoDisabledWriteError(page);
  await backToBrowseFromPlan(page);
  mark(`入口4 历史回滚 → ${rollbackAction} 计划 ✓`);

  // ---- 零写入：四个入口都没碰过 Nacos ----
  expect(await fetchNacosContent(BASE_A, NS_A, EDIT_TARGET, GROUP)).toBe(payBefore);
  expect(await fetchNacosContent(BASE_A, NS_A, "svc-billing.yaml", GROUP)).toBe(billingBefore);
  expect(await fetchNacosContent(BASE_A, NS_A, "svc-common.env", GROUP)).toBe(envBefore);
  expect(await nacosExists(NEW_ID, GROUP), "新建计划未执行却出现在 Nacos").toBeFalsy();
  expect(await nacosExists(NEW_ID, "DEFAULT_GROUP"), "新建计划未执行却出现在 Nacos").toBeFalsy();
  mark("Nacos 零变化 ✓");

  // ---- 零失败审计：改造前一次点击 = 一条 result:"failure"，现在一条都不许多 ----
  const opsAfter = await readOps(page);
  const newOps = opsAfter.filter((r) => !opsBefore.some((o) => o.id === r.id));
  console.log(`[DWE-02] 四次入口点击新增操作记录 = ${JSON.stringify(newOps)}`);
  expect(
    newOps.filter((r) => r.result === "failure"),
    "直写入口又写了失败审计"
  ).toEqual([]);
  expect(
    newOps.filter((r) => ["publish", "delete", "rollback"].includes(r.type)),
    "未执行计划却出现直写类操作记录"
  ).toEqual([]);

  await expectNoDisabledWriteError(page);
  await page.screenshot({ path: "results/dwe02-four-entries.png", fullPage: true });
});
