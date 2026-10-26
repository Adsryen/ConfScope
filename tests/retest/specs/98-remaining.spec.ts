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

// E4 晋级全链路：沙箱验证 → 第5步面板晋级到另一目标 → dry-run → 执行 → 目标侧落库。
//
// 真人视角：apply 到「沙箱」(B) 后就地标记验证通过，从第5步晋级面板晋级到 A（另一受管连接），
// 计划来源=B、目标=A/retest-qa，执行后 A 侧内容与 B 侧一致（真实回读断言）。
//
// 轮76 把晋级入口整体搬出操作历史（PostApplyPromotionPanel 是唯一入口），所以本用例跑完 apply
// 就停在第5步就地操作面板——不再 navigate 去历史页，那会把面板现场（执行态）丢掉。
// 它钉的是 S31 没钉的两件事：① 晋级真实落库；② 执行范围受控（A 独有 dataId 不得被整体刷掉）。
test("E4 晋级全链路: 第5步标记验证→晋级→dry-run→执行→目标落库", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);

  await runSingleApply(page);
  // 晋级差异标记（两个，都走服务端直改，不借应用自己的写路径）：
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

  // 第5步晋级面板现场：回读结论如实、未标记时晋级按钮必须是灰的
  const panel = page.locator(".apply-promote-panel").first();
  await expect(panel).toBeVisible({ timeout: 15_000 });
  const stepValues = panel.locator(".apply-promote-step-value");
  await expect(stepValues.nth(0)).toContainText("全部项与写入一致", { timeout: 15_000 });
  await expect(stepValues.nth(1)).toHaveText("未标记");
  const promoteBtn = panel.locator("button", { hasText: "按本次验证晋级" }).last();
  await expect(promoteBtn).toBeDisabled();

  // 标记沙箱验证通过 → 验证行转「已标记（…」并亮起来，晋级按钮由灰转可点
  await panel.locator("button", { hasText: "标记沙箱验证通过" }).last().click();
  await expect(stepValues.nth(1)).toContainText("已标记（", { timeout: 30_000 });
  await expect(stepValues.nth(1)).toHaveClass(/is-ok/);
  await expect(stepValues.nth(1)).toContainText("Retest Nacos B");
  await expect(promoteBtn).toBeEnabled({ timeout: 15_000 });

  // 生产目标候选：必须是「除沙箱(B)外」的连接，默认落在 Retest Nacos A
  const targetField = panel.locator(".apply-promote-target").first();
  await expect(targetField.locator(".sel-value")).toHaveText("Retest Nacos A");
  await targetField.locator(".sel-trigger").click({ force: true });
  const targetMenu = page.locator(".sel-menu-portal").first();
  await expect(targetMenu).toBeVisible({ timeout: 10_000 });
  const targetOptions = await targetMenu.locator(".sel-option").allTextContents();
  console.log("[E4] 晋级候选 =", JSON.stringify(targetOptions));
  expect(targetOptions.some((o) => o.includes("Retest Nacos A")), "Retest Nacos A 不在晋级候选里").toBe(true);
  expect(targetOptions.some((o) => o.includes("Retest Nacos B")), "沙箱自身不得作为晋级目标").toBe(false);
  await page.keyboard.press("Escape");

  // 命名空间保持默认「沿用沙箱（retest-qa）」：retest-qa 在 A 上不是已列出的租户，
  // 面板该给「晋级会新建它」那句提醒——本轮不判它消失，只把读数如实记进日志。
  const namespaceField = panel.locator(".apply-promote-namespace");
  await expect(namespaceField.locator(".sel-value")).toHaveText("沿用沙箱（retest-qa）");
  console.log("[E4] 命名空间提醒读数 =", JSON.stringify(await namespaceField.locator(".apply-promote-namespace-note").allInnerTexts()));

  // 点晋级 → 生成晋级计划
  await promoteBtn.click();
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
  // 晋级执行后 Nacos 写库存在最终一致性窗口：轮询直至目标侧 == 沙箱内容（或超时）。
  const bSnapshot = await fetchNacosContent(BASE_B, NS_B, "svc-gateway.yaml", GROUP);
  let aAfter = "";
  for (let i = 0; i < 20; i++) {
    aAfter = await fetchNacosContent(BASE_A, "retest-qa", "svc-gateway.yaml", GROUP);
    if (aAfter.trim() === bSnapshot.trim()) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const execNotice = page.locator(".apply-execution-notice").first();
  if (await execNotice.count()) {
    const txt = await execNotice.innerText();
    expect(txt, "执行回执必须是成功通知").toMatch(/完成|成功/);
  }
  await page.screenshot({ path: "results/e4-promotion-executed.png", fullPage: true });

  // 落库验证：晋级目标 A/retest-qa 的 svc-gateway.yaml 必须 == B/retest-qa 沙箱内容
  // （apply A→B 时 B/retest-qa 已等于 A/retest-dev，即沙箱内容；晋级把它带回 A 的目标 ns）。
  expect(aAfter.trim(), "晋级执行后 A/retest-qa 侧必须等于 B/retest-qa 沙箱内容").toBe(bSnapshot.trim());
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
