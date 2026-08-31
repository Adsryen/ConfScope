import { test, expect, fetchNacosContent } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData, publishAExtraMarker, overrideAReQaGateway, E4_MARKER_CONFIG, E4_TARGET_OVERRIDE } from "../bridge/republishData";
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

// E4 晋级全链路：沙箱验证 → 晋级到另一目标 → dry-run → 执行 → 目标侧落库。
// 真人视角：apply 到「沙箱」(B) 后标记验证通过，晋级到 A（另一受管连接），
// 计划来源=B、目标=A，执行后 A 侧内容与 B 侧一致（真实回读断言）。
test("E4 晋级全链路: 沙箱验证→晋级→dry-run→执行→目标落库", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);

  await runSingleApply(page);
  // 晋级差异标记（两个）：
  // 1) A/retest-qa 里放一个 B 侧不存在的 dataId —— 晋级计划不含它，
  //    若执行后仍存在，即证明执行范围受控（不会整体把 A 刷成 B）。
  // 2) 把 A/retest-qa 的 svc-gateway.yaml 覆盖成与沙箱 B 不同的内容 ——
  //    晋级后它必须变成沙箱内容，证明晋级执行真实写库且方向 B→A。
  await publishAExtraMarker(BASE_A, "retest-qa");
  const markerBefore = await fetchNacosContent(BASE_A, "retest-qa", E4_MARKER_CONFIG.dataId, E4_MARKER_CONFIG.group);
  expect(markerBefore).toContain("e4: promote-marker");
  await overrideAReQaGateway(BASE_A);
  expect(await fetchNacosContent(BASE_A, "retest-qa", "svc-gateway.yaml", GROUP)).toContain(E4_TARGET_OVERRIDE.split("\n")[0]);
  console.log("[E4] A/retest-qa 差异标记 dataId + 目标覆盖已就位");

  // 操作历史：选中 apply 记录 → 标记沙箱验证通过
  await navigate(page, "操作历史");
  const recordBtn = page.getByRole("button", { name: /配置变更计划.*svc-gateway\.yaml/ }).first();
  await expect(recordBtn).toBeVisible({ timeout: 30_000 });
  await recordBtn.click();
  const verifyBtn = page.getByRole("button", { name: "标记沙箱验证通过" }).first();
  await expect(verifyBtn).toBeVisible({ timeout: 30_000 });
  await verifyBtn.click();
  await expect(page.getByText("已保存沙箱验证").first()).toBeVisible({ timeout: 30_000 });

  // 晋级目标：候选应为「除沙箱(B)外」的连接；显式选择 Retest Nacos A
  const targetSelect = page.locator(".history-promote-row select").first();
  await expect(targetSelect).toBeVisible({ timeout: 15_000 });
  const options = await targetSelect.locator("option").allInnerTexts();
  console.log("[E4] 晋级候选 =", JSON.stringify(options));
  expect(options.some((o) => o.includes("Retest Nacos A"))).toBe(true);
  expect(options.some((o) => o.includes("Retest Nacos B"))).toBe(false); // 沙箱自身不得作为晋级目标
  await targetSelect.selectOption({ label: options.find((o) => o.includes("Retest Nacos A"))! });

  // 生成晋级 dry-run 计划
  await page.getByRole("button", { name: "晋级到所选目标" }).first().click();
  await expect(page.locator(".apply-view").first()).toBeVisible({ timeout: 15_000 });
  await page
    .locator(".apply-view .apply-workspace, .apply-view .inline-error")
    .first()
    .waitFor({ state: "visible", timeout: 60_000 });
  const genFailed = await page.getByText("变更计划生成失败").first().isVisible().catch(() => false);
  expect(genFailed, "晋级计划必须成功生成").toBe(false);
  const summary = await page.locator(".apply-view .apply-plan-summary").first().innerText();
  // 来源=B（沙箱）、目标=A
  expect(summary).toContain("Retest Nacos B");
  expect(summary).toContain("Retest Nacos A");
  await page.screenshot({ path: "results/e4-promotion-plan.png", fullPage: true });

  // dry-run → 执行
  const selectAllBtn = page.getByRole("button", { name: "全选" }).first();
  if (await selectAllBtn.count()) await selectAllBtn.click();
  const dryRunBtn = page.locator("button", { hasText: "Dry-run 检查" }).last();
  await dryRunBtn.click({ force: true }).catch(() => undefined);
  await expect(page.locator(".apply-execution-notice").filter({ hasText: "Dry-run 检查通过" })).toBeVisible({ timeout: 60_000 });
  await page.locator(".apply-confirm-check input").check();
  const execBtn = page.locator("button", { hasText: "执行变更" }).last();
  await execBtn.click({ force: true }).catch(() => undefined);
  const promoteProgress = page.locator(".apply-task-progress").first();
  await expect(promoteProgress).toBeVisible({ timeout: 60_000 });
  await expect(promoteProgress.locator(".task-status-success")).toBeVisible({ timeout: 60_000 });
  const execNotice = page.locator(".apply-execution-notice").first();
  if (await execNotice.count()) {
    const txt = await execNotice.innerText();
    expect(txt, "执行回执必须是成功通知").toMatch(/完成|成功/);
  }
  await page.screenshot({ path: "results/e4-promotion-executed.png", fullPage: true });

  // 落库验证：晋级目标 A/retest-qa 的 svc-gateway.yaml 必须 == B/retest-qa 沙箱内容
  // （apply A→B 时 B/retest-qa 已等于 A/retest-dev，即沙箱内容；晋级把它带回 A 的目标 ns）。
  const aAfter = await fetchNacosContent(BASE_A, "retest-qa", "svc-gateway.yaml", GROUP);
  const bAfter = await fetchNacosContent(BASE_B, NS_B, "svc-gateway.yaml", GROUP);
  expect(aAfter.trim(), "晋级执行后 A/retest-qa 侧必须等于 B/retest-qa 沙箱内容").toBe(bAfter.trim());
  // 范围控制验证：计划外的 dataId（A 独有标记）不得被误删/误改
  const markerAfter = await fetchNacosContent(BASE_A, "retest-qa", E4_MARKER_CONFIG.dataId, E4_MARKER_CONFIG.group);
  expect(markerAfter, "计划外 dataId 必须保持原样").toContain("e4: promote-marker");
  // 操作历史应出现 promote 类型记录
  await navigate(page, "操作历史");
  const body = await page.locator("body").innerText();
  expect(body).toMatch(/晋级|promote/i);
  await page.screenshot({ path: "results/e4-promotion-done.png", fullPage: true });
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
