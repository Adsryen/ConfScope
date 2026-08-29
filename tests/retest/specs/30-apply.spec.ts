import { test, expect, fetchNacosContent } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { loadRetestState } from "../state";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog, setDiffSource } from "./ui";

const NS_A = "retest-dev";
const NS_B = "retest-qa";
const BASE_A = "http://127.0.0.1:19848/nacos";
const BASE_B = "http://127.0.0.1:19849/nacos";
const GROUP = "RETEST-PROD";

/** 读取可能不存在的元素文本（存在则等待，否则 undefined）。 */
async function optionalText(page: import("@playwright/test").Page, selector: string, timeoutMs = 3_000): Promise<string | undefined> {
  const loc = page.locator(selector).first();
  try {
    await loc.waitFor({ state: "attached", timeout: timeoutMs });
    return await loc.textContent({ timeout: 1_000 });
  } catch {
    return undefined;
  }
}

/** 单文档对比（自动恢复种子：左右连接+namespace+group 已预填 svc-gateway.yaml，这里显式重设保证确定性）。 */
async function loadSingleCompare(page: import("@playwright/test").Page, dataId = "svc-gateway.yaml") {
  await navigate(page, "配置对比");
  // 对比页自动恢复展开来源面板，过渡期间摘要条拦截点击，等过渡稳定。
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP, dataId });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP, dataId });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".diff-panel")).toBeVisible({ timeout: 30_000 });
}

// T-AP-01: 单文档完整链路：对比 → 进入计划 → 生成 dry-run → Dry-run 检查 → 勾选确认 → 执行 → Nacos B 落库
test("T-AP-01 单文档变更计划: 生成→dry-run→执行→落库验证", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  const t0 = Date.now();
  const mark = (label: string) => console.log(`[T-AP-01][t+${Date.now() - t0}ms] ${label}`);
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await loadSingleCompare(page);
  mark("对比完成");

  const before = await fetchNacosContent(BASE_B, NS_B, "svc-gateway.yaml", GROUP);
  mark("fetch before 完成");
  expect(before).toContain("生产环境");
  expect(before).not.toContain("开发环境");

  // 进入配置变更计划
  await page.getByRole("button", { name: "进入配置变更计划" }).last().click();
  await expect(page.locator(".apply-ledger, .apply-item-list").first()).toBeVisible({ timeout: 30_000 });
  mark("进入计划");

  // 全选变更项(计划默认可能未勾选, Dry-run 按钮需 selectedCount>0)
  const selectAllBtn = page.getByRole("button", { name: "全选" }).first();
  if (await selectAllBtn.count()) await selectAllBtn.click();
  await page.waitForTimeout(300);

  // Dry-run 检查 (自定义 button 组件, 用文本+force 定位)
  const dryRunBtn = page.locator("button", { hasText: "Dry-run 检查" }).last();
  await dryRunBtn.click({ force: true, timeout: 10_000 }).catch(() => undefined);
  if ((await page.locator(".apply-execution-notice").count()) === 0) {
    await dryRunBtn.evaluate((el) => (el as HTMLElement).click());
  }
  await expect(page.locator(".apply-execution-notice").filter({ hasText: "Dry-run 检查通过" })).toBeVisible({ timeout: 60_000 });
  mark("dry-run 通过");

  // 勾选确认 → 执行变更
  await page.locator(".apply-confirm-check input").check();
  await page.waitForTimeout(300);
  const execBtn = page.locator("button", { hasText: "执行变更" }).last();
  await execBtn.click({ force: true, timeout: 10_000 }).catch(() => undefined);
  if ((await page.locator(".apply-task-progress").count()) === 0) {
    await execBtn.evaluate((el) => (el as HTMLElement).click());
  }
  mark("已点击执行变更");

  await expect(page.locator(".apply-task-progress, .inline-error").first()).toBeVisible({ timeout: 60_000 });
  mark("进度面板出现");
  await expect(page.locator(".apply-task-progress .task-status-success, .apply-task-progress .task-status-failed").first()).toBeVisible({ timeout: 60_000 });
  mark("状态徽章出现");
  const taskStatus = await page.locator(".apply-task-progress .task-status").first().textContent().catch(() => null);
  const execNotice = await page.locator(".apply-execution-notice").last().textContent().catch(() => null);
  const execError = await optionalText(page, ".inline-error-body");
  console.log(`[T-AP-01] 任务状态=${taskStatus} 提示=${execNotice} 错误=${execError?.slice(0, 200)}`);
  expect(execError).toBeFalsy();
  expect(execNotice).toContain("变更执行完成");
  mark("执行完成断言通过");

  // 落库验证：B 侧变成 A 侧内容（开发环境注释回来，生产环境消失）
  const after = await fetchNacosContent(BASE_B, NS_B, "svc-gateway.yaml", GROUP);
  mark("fetch after 完成");
  expect(after).toContain("开发环境");
  expect(after).not.toContain("生产环境");
  await page.screenshot({ path: "results/ap01-single-executed.png", fullPage: true });
  mark("全部完成");
});

// T-AP-02: 批量对比（14 个同名 dataId，跨 RETEST-PROD/RETEST-ORDER/RETEST-MESSENGE/DEFAULT_GROUP 多 group）
// B 侧 svc-notify.yaml 是 tab 缩进 YAML 语法错误 → 该项 parse_error 被阻断，
// 勾选阻断项时执行按钮禁用（安全守卫）→ 取消勾选后执行其余 12 项
test("T-AP-02 批量变更计划: 13 项匹配 + parse_error 阻断守卫 + 执行落库", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  // 幂等：本测试会写库（执行变更），开始前重新发布种子数据，恢复 A/B 干净基线，
  // 否则上次执行已把 A/B 改成一致，计划会变成 11 skip 导致无可执行项。
  await republishRetestData();

  const t0 = Date.now();
  const mark = (label: string) => console.log(`[T-AP-02][t+${Date.now() - t0}ms] ${label}`);
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置对比");
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP });
  await page.getByRole("button", { name: "加载并对比" }).last().click();

  // 匹配列表：12 个 dataId 双侧都存在
  await expect(page.locator(".match-list")).toBeVisible({ timeout: 30_000 });
  const items = page.locator(".match-item");
  const itemCount = await items.count();
  console.log(`[T-AP-02] 匹配项数量 = ${itemCount}`);
  expect(itemCount).toBe(13);

  // 全选 → 批量对比
  await page.locator(".match-toggle-all input").check();
  await page.getByRole("button", { name: /对比选中/ }).last().click();
  await expect(page.locator(".batch-diff .batch-diff-nav-item").first()).toBeVisible({ timeout: 60_000 });
  mark("批量对比完成");

  // 批量进入变更计划
  const batchApplyBtn = page.getByRole("button", { name: /进入.*计划|批量.*计划/ }).last();
  if (await batchApplyBtn.count() === 0) {
    await page.getByRole("button", { name: "进入配置变更计划" }).last().click();
  } else {
    await batchApplyBtn.click();
  }
  await expect(page.locator(".apply-item-list, .apply-ledger").first()).toBeVisible({ timeout: 60_000 });
  mark("进入批量计划");

  // 计划摘要：13 项覆盖 + 1 项 parse_error（12 项中 1 项两侧一致被跳过）（svc-notify.yaml B 侧 tab 缩进）
  const summaryText = await page.locator(".apply-summary, .apply-count-strip").first().innerText().catch(() => "");
  console.log(`[T-AP-02] 计划摘要 = ${summaryText.slice(0, 200)}`);
  expect(summaryText).toMatch(/13/);
  expect(summaryText).toMatch(/解析失败 1|阻塞 1/);

  // svc-notify.yaml 行应标记为「已阻塞」
  const notifyRow = page.locator(".apply-item-row", { hasText: "svc-notify.yaml" }).first();
  await expect(notifyRow).toBeVisible({ timeout: 15_000 });
  expect(await notifyRow.locator(".apply-blocked").count()).toBeGreaterThan(0);
  await page.screenshot({ path: "results/ap02-batch-plan.png", fullPage: true });
  mark("parse_error 阻断项确认");

  // 安全守卫（执行层兜底 + UI 层禁用双保险）：
  //   ① svc-notify.yaml（parse_error）的 checkbox 必须 disabled，用户根本无法勾选它；
  //   ② 确认框 + 全选后，「执行变更」按钮针对 11 个可执行项可用（blocked 项从未进入选择集，
  //      所以按钮不该因它被禁用）；
  //   ③ 执行后 B 侧 svc-notify.yaml 必须保持原样（执行层 runPlan 兜底过滤 blocked/parse_error）。
  const notifyCheck = notifyRow.locator("input[type='checkbox']").first();
  expect(await notifyCheck.isDisabled()).toBeTruthy();
  console.log("[T-AP-02] svc-notify.yaml 复选框 disabled（不可被勾选）");

  // 确认框 + 点击「全选」按钮（限 .apply-item-toolbar，避免误命中匹配页/其他按钮）
  // → 仅 11 个可执行项进入选择集（blocked 项 checkbox 已 disabled，不会被全选）
  await page.locator(".apply-confirm-check input").check();
  await page.locator(".apply-item-toolbar button", { hasText: "全选" }).first().click();
  await page.waitForTimeout(300);
  const execBtn = page.getByRole("button", { name: /^执行/ }).last();
  const selectionText = await page.locator(".apply-item-toolbar > span").first().innerText().catch(() => "");
  console.log(`[T-AP-02] 选择集 = ${selectionText}  执行按钮 disabled=${await execBtn.isDisabled()}`);
  // 已选 11 项且不含 blocked → 执行按钮应可用
  expect(await execBtn.isDisabled()).toBeFalsy();
  await page.screenshot({ path: "results/ap02-exec-blocked.png", fullPage: true });
  mark("仅可执行项进入选择集，执行按钮可用");

  await execBtn.click();
  await expect(page.locator(".apply-task-progress .task-status-success, .apply-task-progress .task-status-failed").first()).toBeVisible({ timeout: 120_000 });
  const taskStatus = await page.locator(".apply-task-progress .task-status").first().textContent().catch(() => null);
  const execNotice = await page.locator(".apply-execution-notice").last().textContent().catch(() => null);
  console.log(`[T-AP-02] 任务状态=${taskStatus} 提示=${execNotice?.slice(0, 200)}`);
  expect(taskStatus).toContain("成功");
  expect(execNotice).toMatch(/变更执行完成|已应用 11/);
  // 阻断项未执行的提示
  expect(execNotice).toContain("已阻断");
  await page.screenshot({ path: "results/ap02-batch-executed.png", fullPage: true });
  mark("批量执行完成");

  // 落库验证：
  //  - B 侧 svc-gateway.yaml 应变成 A（开发）内容；
  //  - B 侧 svc-notify.yaml 因 B 侧 tab 缩进解析失败被跳过，保持原样（仍含 tab）；
  //  - 本次对比只针对 RETEST-PROD group，RETEST-ORDER 的 svc-order.toml 不在选择集内，
  //    必须保持原样（验证执行只改选择集内项，不跨 group 误写）。
  const bGateway = await fetchNacosContent(BASE_B, NS_B, "svc-gateway.yaml", GROUP);
  expect(bGateway).toContain("开发环境");
  const bNotify = await fetchNacosContent(BASE_B, NS_B, "svc-notify.yaml", GROUP);
  expect(bNotify).toContain("	");
  const bOrder = await fetchNacosContent(BASE_B, NS_B, "svc-order.toml", "RETEST-ORDER");
  expect(bOrder).not.toContain("开发端口"); // 未被 RETEST-PROD 对比波及
  mark("落库验证完成");
});

// T-AP-03: 浏览页直接发布被阻断（安全模型：只能走 ApplyPlan）
test("T-AP-03 浏览页直接发布被阻断且 Nacos 不变", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");
  await page.locator(".browser-item", { hasText: "svc-pay.json" }).first().click();
  await expect(page.locator(".code-area")).toBeVisible({ timeout: 15_000 });

  // 进入编辑模式
  await page.getByRole("button", { name: "编辑" }).first().click();
  await expect(page.locator(".code-editor-ta")).toBeVisible({ timeout: 15_000 });
  const editor = page.locator(".code-editor-ta").first();
  await editor.click();
  await page.keyboard.press("Control+a");
  // 关键：编辑对象是 JSON 格式（svc-pay.json），若填入纯文本会被 validateConfig 判为
  // 「JSON 解析失败」而止步于格式校验，根本走不到直接发布守卫。必须填入合法 JSON，
  // 才能触发 directWriteRequiresApplyPlan 安全守卫（本测试真正要验证的）。
  await editor.evaluate((el) => {
    const input = el as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set?.bind(input);
    setter?.("{\"retest\": \"direct publish attempt\"}");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // 保存/发布
  const saveBtn = page.getByRole("button", { name: /保存|发布/ }).first();
  if (await saveBtn.count()) {
    await saveBtn.click();
    await page.waitForTimeout(1500);
  }
  // 直接写入守卫错误展示在编辑器错误行（.test-msg.err），消息中心记未读徽标
  const editorErr = (await page.locator(".test-msg.err, .inline-error").allInnerTexts()).filter((t) => t.length > 0);
  const toast = await page.locator(".toaster .toast").allInnerTexts();
  console.log(`[T-AP-03] editorErr = ${JSON.stringify(editorErr)} toast = ${JSON.stringify(toast)}`);

  // 直接发布必须失败；错误详情记录在消息中心。
  // headless 下 mouseenter/mouseleave 不可靠（click 触发 focus+blur 会立即 scheduleClose），
  // 因此用原生 DOM click 打开面板；面板未展开时读按钮徽标作为未读错误存在的证据。
  const msgBtn = page.locator(".message-center-btn");
  const badgeCount = await msgBtn.locator(".message-badge").count();
  const msgBadge = badgeCount > 0 ? await msgBtn.locator(".message-badge").first().textContent() : null;
  await msgBtn.evaluate((el) => (el as HTMLButtonElement).click());
  let msgPanel = await page
    .locator(".message-panel")
    .innerText()
    .catch(() => "");
  if (!msgPanel) {
    await msgBtn.evaluate((el) => (el as HTMLButtonElement).click());
    await msgBtn.evaluate((el) => (el as HTMLButtonElement).click());
    msgPanel = await page
      .locator(".message-panel")
      .innerText()
      .catch(() => "");
  }
  console.log(`[T-AP-03] 消息中心徽标=${msgBadge} 面板=${msgPanel.slice(0, 600)}`);
  await page.screenshot({ path: "results/ap03-direct-publish.png", fullPage: true });
  // 守卫生效的证据（任一命中）：编辑器错误行 / toast / 消息中心面板 / 未读徽标
  const evidence = [...editorErr, ...toast, msgPanel, String(msgBadge ?? "")].join("\n");
  expect(evidence).toMatch(/变更计划|直接配置写入已禁用|失败/);
  if (msgPanel || msgBadge) {
    expect(msgPanel || String(msgBadge)).toMatch(/变更计划|直接配置写入已禁用|阻断/);
  }

  // Nacos 内容不变：守卫阻止了写入，A 侧 svc-pay.json 不应包含本次注入的标记
  const after = await fetchNacosContent(BASE_A, NS_A, "svc-pay.json", GROUP);
  expect(after).not.toContain("direct publish attempt");
});
