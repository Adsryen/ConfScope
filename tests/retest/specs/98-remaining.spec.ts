import { test, expect, fetchNacosContent, fetchNacosContentUntil } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog, setDiffSource } from "./ui";
import { loadRetestState } from "../state";

const state = loadRetestState();
const BASE_A = state.nacos.a.baseUrl;
const BASE_B = state.nacos.b.baseUrl;
const NS_A = state.nacos.a.namespace;
const NS_B = state.nacos.b.namespace;
const GROUP = "RETEST-PROD";

async function bootstrap(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
}

/** 执行一次单文档 apply（svc-gateway.yaml A→B）并断言成功落库，返回计划页前的操作历史入口。 */
async function runSingleApply(page: import("@playwright/test").Page): Promise<void> {
  await navigate(page, "配置对比");
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP, dataId: "svc-gateway.yaml" });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP, dataId: "svc-gateway.yaml" });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".diff-panel")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "进入配置变更计划" }).last().click();
  await expect(page.locator(".apply-ledger, .apply-item-list").first()).toBeVisible({ timeout: 30_000 });
  const selectAllBtn = page.getByRole("button", { name: "全选" }).first();
  if (await selectAllBtn.count()) await selectAllBtn.click();
  const dryRunBtn = page.locator("button", { hasText: "Dry-run 检查" }).last();
  await dryRunBtn.click({ force: true }).catch(() => undefined);
  await expect(page.locator(".apply-execution-notice").filter({ hasText: "Dry-run 检查通过" })).toBeVisible({ timeout: 60_000 });
  await page.locator(".apply-confirm-check input").check();
  const execBtn = page.locator("button", { hasText: "执行变更" }).last();
  await execBtn.click({ force: true }).catch(() => undefined);
  // 「执行成功」断言：任务进度条状态为 success，且执行面板给出成功回执；
  // 失败时会渲染 .task-status-failed 或 .inline-error，此处一并防御。
  const progressPanel = page.locator(".apply-task-progress").first();
  await expect(progressPanel).toBeVisible({ timeout: 60_000 });
  await expect(progressPanel.locator(".task-status-success")).toBeVisible({ timeout: 60_000 });
  const execNotice = page.locator(".apply-execution-notice").first();
  if (await execNotice.count()) {
    const txt = await execNotice.innerText();
    expect(txt, "执行回执必须是成功通知").toMatch(/完成|成功/);
  }
  // 落库断言：B 侧必须更新为 A 侧 dev 内容中的关键 dev 特征值（qps: 10000）。
  // 不做全文相等断言——apply 计划项是字段级分类（override/skip 混合）执行，
  // B 侧保留的 prod 结构行属于预期行为；整文档覆盖由其他用例（T-AP 系列）验证。
  const after = await fetchNacosContent(BASE_B, NS_B, "svc-gateway.yaml", GROUP);
  const before = await fetchNacosContent(BASE_A, NS_A, "svc-gateway.yaml", GROUP);
  if (before.includes("qps: 10000")) expect(after, "B 侧缺少 A 侧 dev 特征值，apply 未落库").toContain("qps: 10000");
}

// E4 执行落库范围：一次执行只碰计划里那条 dataId。
//
// 真人视角：把 A/retest-dev 的 svc-gateway.yaml 应用到 B/retest-qa，同 group 的邻居配置与源侧
// 那条正文都必须一个字节不动。本用例只钉执行本身的三件事（写后晋级面板已在 r113 整块撤除，
// 入口缺席由 S31 与 99-t 判定，不在此重复）：
// ① 执行真实落库：目标侧带上源侧特征值，且相对执行前确实变了；
// ② 写方向只朝目标：来源侧正文原样；
// ③ 范围只到计划内 dataId：同租户同 group 的邻居一字未动（不会整片刷掉）；
// ④ 服务端只留下这一次 apply 记录：操作历史最新一行是本次执行，且不额外长出写后记录。
test("E4 执行落库范围: 只写计划内 dataId，源侧与邻居配置不动", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);

  // 执行前三份基线：源侧正文、同租户邻居正文、目标侧正文
  const sourceBefore = await fetchNacosContent(BASE_A, NS_A, "svc-gateway.yaml", GROUP);
  const neighborBefore = await fetchNacosContent(BASE_B, NS_B, "svc-search.yaml", GROUP);
  const targetBefore = await fetchNacosContent(BASE_B, NS_B, "svc-gateway.yaml", GROUP);
  expect(sourceBefore, "源侧播种不带 dev 特征值，本用例失去意义").toContain("qps: 10000");
  expect(neighborBefore.length, "邻居配置 svc-search.yaml 不在目标租户里，判不了范围").toBeGreaterThan(0);
  console.log(`[E4] 执行前基线: 源侧 ${sourceBefore.length}B / 邻居 ${neighborBefore.length}B / 目标 ${targetBefore.length}B`);

  await runSingleApply(page);

  // ① 真实落库（Nacos 写库有最终一致性窗口，轮询到特征值出现为止）
  const targetAfter = await fetchNacosContentUntil(
    BASE_B,
    NS_B,
    "svc-gateway.yaml",
    GROUP,
    (c) => c.includes("qps: 10000")
  );
  expect(targetAfter, "目标侧没带上源侧 dev 特征值").toContain("qps: 10000");
  expect(targetAfter, "正文没变却把执行记成成功").not.toBe(targetBefore);

  // ② 写方向只朝目标
  expect(await fetchNacosContent(BASE_A, NS_A, "svc-gateway.yaml", GROUP), "执行回写了来源侧").toBe(sourceBefore);

  // ③ 范围受控：计划外的同租户配置必须原样
  expect(await fetchNacosContent(BASE_B, NS_B, "svc-search.yaml", GROUP), "计划外的配置被波及").toBe(neighborBefore);
  await page.screenshot({ path: "results/e4-scope-executed.png", fullPage: true });

  // ④ 这次执行在操作历史里只留一条「配置变更计划」记录：最新一行必须是本次 apply，
  //    且列表里不许再长出「沙箱晋级」那种写后额外记录（旧的写后晋级路径正是这么刷的）。
  //    作用域必须收在记录行：类型筛选下拉里始终保留「沙箱晋级」选项供旧记录展示，
  //    整页文本判这个词会被下拉恒定命中，判不出任何事。
  await navigate(page, "操作历史");
  const applyRecord = page.getByRole("button", { name: /配置变更计划.*svc-gateway\.yaml/ }).first();
  await expect(applyRecord, "执行后操作历史应留下这条记录").toBeVisible({ timeout: 30_000 });
  const historyItems = page.locator(".op-history-list .op-history-item");
  await expect(historyItems.first().locator(".history-type.apply"), "最新一条不是本次执行记录").toBeVisible();
  await expect(historyItems.locator(".history-type.promote"), "一次执行多刷出了写后晋级记录").toHaveCount(0);
  await page.screenshot({ path: "results/e4-scope-history.png", fullPage: true });
});

// B7-fix 复测：dataId 手填不存在值 → 加载并对比必须给出明确错误（不再静默回退）
test("B7-fix 对比 dataId 不存在: 明确报错且不回退", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);
  await navigate(page, "配置对比");
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP, dataId: "not-exist-ux98.yaml" });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP, dataId: "not-exist-ux98.yaml" });
  // 输入框保持手填值（combobox 未候选命中时不替换 value）
  const leftInput = page.locator(".source-picker").first().locator("label.field:has(> span:has-text('dataId')) input").first();
  expect(await leftInput.inputValue()).toBe("not-exist-ux98.yaml");
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  // 必须出现明确错误提示（两侧 404），而不是静默回退/自动匹配
  await expect(page.locator(".diff-loaderr").first()).toBeVisible({ timeout: 15_000 });
  const errText = await page.locator(".diff-loaderr").first().innerText();
  expect(errText).toContain("not-exist-ux98.yaml");
  // 页面骨架完整，可继续导航
  await expect(page.locator(".side-nav-item").first()).toBeVisible();
  await page.screenshot({ path: "results/b7fix-diff-missing-dataid.png", fullPage: true });
});
