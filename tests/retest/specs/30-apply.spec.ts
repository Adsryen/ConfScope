import { test, expect, fetchNacosContent } from "./retestTest";

import { installRetestBridge, RETEST_BRIDGE_MARKER } from "../bridge/installRetestBridge";
import { onBridgeLog } from "../bridge/retestBinding";
import { navigate, dismissStartupDialog, setDiffSource } from "./ui";

const NS_A = "retest-dev";
const NS_B = "retest-qa";
const BASE_A = "http://127.0.0.1:19848/nacos";
const BASE_B = "http://127.0.0.1:19849/nacos";
const GROUP = "retest_group";


/** 读取可能不存在的元素的文本：存在则等待至多 3s 并读取，否则返回 undefined（不触发 Playwright 无限自动等待）。 */
async function optionalText(page: any, selector: string, timeoutMs = 3_000): Promise<string | undefined> {
  const loc = page.locator(selector).first();
  try {
    await loc.waitFor({ state: "attached", timeout: timeoutMs });
    return await loc.textContent({ timeout: 1_000 });
  } catch {
    return undefined;
  }
}

async function loadSingleCompare(page: any) {
  await navigate(page, "配置对比");
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, dataId: "retest-plain.txt", group: GROUP });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, dataId: "retest-plain.txt", group: GROUP });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".diff-panel")).toBeVisible({ timeout: 30_000 });
}

async function enterPlan(page: any) {
  await page.getByRole("button", { name: "进入配置变更计划" }).last().click();
  await expect(page.locator(".apply-ledger, .apply-item-list").first()).toBeVisible({ timeout: 30_000 });
}

// T-AP-01: 单文档完整链路：对比 → 进入计划 → 生成 dry-run → Dry-run 检查 → 勾选确认 → 执行 → Nacos B 落库
test("T-AP-01 单文档变更计划: 生成→dry-run→执行→落库验证", async ({ page, retest }, testInfo) => {
  await installRetestBridge(page, retest);

  const t0 = Date.now();
  const mark = (label: string) => console.log(`[T-AP-01][t+${Date.now() - t0}ms] ${label}`);
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await loadSingleCompare(page);
  mark("对比完成");

  const before = await fetchNacosContent(BASE_B, NS_B, "retest-plain.txt", GROUP);
  mark("fetch before 完成");
  expect(before).toContain("line2 MODIFIED");
  expect(before).not.toContain("line2 已应用");

  await enterPlan(page);
  mark("进入计划");

  // 计划生成（draft）后，先跑 Dry-run 检查
  await page.getByRole("button", { name: /^Dry-run/ }).last().click();
  await expect(page.locator(".apply-execution-notice").filter({ hasText: "Dry-run 检查通过" })).toBeVisible({ timeout: 30_000 });
  mark("dry-run 通过");

  // 勾选确认框 → 执行变更
  await page.locator(".apply-confirm-check input").check();
  await page.getByRole("button", { name: /^执行变更/ }).last().click();
  mark("已点击执行变更");

  // 等待执行完成（执行进度面板显示 100% / 成功徽章，或出现执行失败错误块）
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

  // 落库验证：Nacos B 的 retest-plain.txt 应变成 A 侧内容（line2 恢复，MODIFIED 消失）
  const after = await fetchNacosContent(BASE_B, NS_B, "retest-plain.txt", GROUP);
  mark("fetch after 完成");
  expect(after).toContain("line2\n");
  expect(after).not.toContain("line2 MODIFIED");
  mark("全部完成");
});

// T-AP-02: 批量对比 → 批量进入计划 → 执行（仅左/仅右存在项的创建/删除）
test("T-AP-02 批量变更计划: 批量应用后 Nacos B 与 A 对齐", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  const t0 = Date.now();
  const mark = (label: string) => console.log(`[T-AP-02][t+${Date.now() - t0}ms] ${label}`);
  onBridgeLog((line) => console.log("[bridge]", line));
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置对比");
  await setDiffSource(page, "left", { connection: "Retest Nacos A" });
  await setDiffSource(page, "right", { connection: "Retest Nacos B" });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".match-list")).toBeVisible({ timeout: 30_000 });
  mark("匹配列表出现");

  await page.locator(".match-toggle-all input").check();
  await page.getByRole("button", { name: /对比选中/ }).last().click();
  await expect(page.locator(".batch-diff .batch-diff-nav-item").first()).toBeVisible({ timeout: 30_000 });
  mark("批量对比出现");

  // 批量进入计划（批量对比完成后的主按钮：进入配置变更计划（N 个文件））
  const batchApplyBtn = page.getByRole("button", { name: /进入配置变更计划/ }).last();
  await expect(batchApplyBtn).toBeVisible({ timeout: 10_000 });
  await batchApplyBtn.click();
  mark("已点击进入");
  await expect(page.locator(".apply-item-list, .apply-ledger").first()).toBeVisible({ timeout: 30_000 });
  mark("计划列表出现");
  await page.waitForTimeout(3000); // 等待草稿生成稳定
  mark("等待3s");
  // 从 localStorage 读取已保存的计划，打印每个 item 的 parseStatus/parseError
  const planDump = await page.evaluate(() => {
    const raw = localStorage.getItem("cs.applyPlans");
    if (!raw) return "no plans";
    const plans = JSON.parse(raw);
    const p = Array.isArray(plans) ? plans[plans.length - 1] : plans;
    if (!p || !p.items) return "no items";
    return JSON.stringify(p.items.map((it: any) => ({
      dataId: it.ref.dataId,
      action: it.action,
      blocked: it.blocked,
      blockReason: it.blockReason,
      srcPS: it.sourceValue?.parseStatus,
      srcPE: it.sourceValue?.parseError,
      tgtPS: it.targetValue?.parseStatus,
      tgtPE: it.targetValue?.parseError,
      srcFmt: it.sourceValue?.format,
      tgtFmt: it.targetValue?.format,
    })));
  });
  console.log(`[T-AP-02][plan-dump] ${planDump}`);
  await page.screenshot({ path: "results/ap02-batch-plan.png", fullPage: true });

  // 点击工具栏「全选」（选中所有可执行项）
  const itemCount = await page.locator(".apply-item-main").count();
  console.log(`[T-AP-02] 批量计划项数 = ${itemCount}`);
  expect(itemCount).toBeGreaterThanOrEqual(4);
  await page.getByRole("button", { name: "全选" }).click();
  await page.waitForTimeout(300);
  const itemRows = await page.evaluate(() => Array.from(document.querySelectorAll(".apply-item-row")).map((r) => ({
    cls: (r as HTMLElement).className,
    input: (r.querySelector("input") as HTMLInputElement | null)?.checked,
    inputDisabled: (r.querySelector("input") as HTMLInputElement | null)?.disabled,
    text: (r.textContent || "").slice(0, 50),
  })));
  console.log(`[T-AP-02][rows] ${JSON.stringify(itemRows)}`);
  const selCount = await page.locator(".apply-item-row.checked").count();
  mark(`已勾选 ${selCount} 项`);
  expect(selCount).toBeGreaterThanOrEqual(2);
  await page.locator(".apply-confirm-check input").check();
  mark("确认勾选");
  const execBtn = page.getByRole("button", { name: /执行/ }).last();
  mark(`执行按钮 text=${await execBtn.textContent()} disabled=${await execBtn.isDisabled()}`);
  await execBtn.click();
  mark("已点击执行变更");
  // 轮询观察执行进度：120s 内出现任务面板即记录状态；出现错误块立即记录
  const execDeadline = Date.now() + 120_000;
  let sawProgress = false;
  let lastNotice = "";
  let lastErr = "";
  while (Date.now() < execDeadline) {
    const state = await page.evaluate(() => {
      const progress = document.querySelector(".apply-task-progress");
      const notice = (document.querySelector(".apply-execution-notice")?.textContent || "").trim();
      const err = (document.querySelector(".inline-error-body")?.textContent || "").trim();
      const status = (document.querySelector(".apply-task-progress .task-status")?.textContent || "").trim();
      return { progress: !!progress, notice, err, status };
    });
    if (state.notice !== lastNotice || state.err !== lastErr) {
      mark(`exec-state progress=${state.progress} notice=${JSON.stringify(state.notice.slice(0, 120))} err=${JSON.stringify(state.err.slice(0, 200))} status=${state.status}`);
      lastNotice = state.notice;
      lastErr = state.err;
    }
    if (state.progress) sawProgress = true;
    if (state.err) break;
    if (sawProgress && (state.status.includes("成功") || state.status.includes("失败"))) break;
    await page.waitForTimeout(2000);
  }
  if (!sawProgress) mark("!! 120s 内未出现任务进度面板");
  await expect(page.locator(".apply-task-progress .task-status-success, .apply-task-progress .task-status-failed").first()).toBeVisible({ timeout: 90_000 });
  const taskStatus = await page.locator(".apply-task-progress .task-status").first().textContent().catch(() => null);
  const execError = await optionalText(page, ".inline-error-body");
  // 捕获被阻塞项的解析失败详情
  const detailText = await page.evaluate(() => {
    const errors = Array.from(document.querySelectorAll(".apply-parse-error")).map((e) => e.textContent || "");
    const panel = document.querySelector(".apply-detail");
    return JSON.stringify({ parseErrors: errors, detailHead: panel ? (panel.textContent || "").slice(0, 400) : "" });
  });
  console.log(`[T-AP-02] 任务状态=${taskStatus} 错误=${execError?.slice(0, 200)} 详情=${detailText.slice(0, 500)}`);
  expect(execError).toBeFalsy();
  expect(taskStatus).toContain("成功");
  await page.screenshot({ path: "results/ap02-batch-executed.png", fullPage: true });

  // 落库验证：B 侧应与 A 对齐。
  // 注意：批量匹配只覆盖 picker 所选 group（本例 DEFAULT_GROUP），retest-plain.txt 位于
  // retest_group，不参与批量对比/应用（已作为独立限制记录在 findings）。这里改为验证
  // 参与批量的 yaml 文件被覆盖为 A 内容。
  const bAfterYaml = await fetchNacosContent(BASE_B, NS_B, "retest-app.yaml", "DEFAULT_GROUP");
  expect(bAfterYaml).toContain("port: 8080");
  expect(bAfterYaml).toContain("name: alpha");
  expect(bAfterYaml).not.toContain("port: 9090");
  const bOnlyA = await fetchNacosContent(BASE_B, NS_B, "retest-only-a.yaml", "DEFAULT_GROUP").catch(() => null);
  console.log(`[T-AP-02] B 侧 retest-only-a.yaml = ${String(bOnlyA).slice(0, 80)}`);
  expect(bOnlyA).toContain("note: 仅存在于 A 侧的 dataId");
  expect(bOnlyA).toContain("key: value");
  // only-b 应已从 B 侧删除；Nacos v1 对不存在的配置返回 404 + "config data not exist"
  const bOnlyBRaw = await page.evaluate(async () => {
    const res = await fetch("http://127.0.0.1:19849/nacos/v1/cs/configs?dataId=retest-only-b.yaml&group=DEFAULT_GROUP&tenant=retest-qa");
    return { status: res.status, text: (await res.text()).slice(0, 60) };
  });
  console.log(`[T-AP-02] B 侧 retest-only-b.yaml = ${JSON.stringify(bOnlyBRaw)}`);
  expect(bOnlyBRaw.status === 404 || bOnlyBRaw.text === "config data not exist" || bOnlyBRaw.text.trim() === "").toBeTruthy();
});

// T-AP-03: 浏览页直接编辑发布应被阻断（安全模型：只能走 ApplyPlan）
test("T-AP-03 浏览页直接编辑/删除被阻断", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");
  await page.locator(".browser-item", { hasText: "retest-plain.txt" }).first().click();
  await expect(page.locator(".code-area")).toBeVisible({ timeout: 15_000 });

  // 进入编辑模式
  await page.getByRole("button", { name: "编辑" }).first().click();
  await expect(page.locator(".code-editor-ta")).toBeVisible({ timeout: 15_000 });
  const editor = page.locator(".code-editor-ta").first();
  await editor.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("retest 直接发布尝试\n");

  // 保存/发布
  const saveBtn = page.getByRole("button", { name: /保存|发布/ }).first();
  const btnCount = await page.locator(".code-area button, .editor-actions button, button").allInnerTexts();
  console.log(`[T-AP-03] 编辑页按钮 = ${JSON.stringify(btnCount.filter((b) => b.trim()))}`);
  if (await saveBtn.count()) {
    await saveBtn.click();
    await page.waitForTimeout(1500);
  }
  const toast = await page.locator(".toaster .toast").allInnerTexts();
  console.log(`[T-AP-03] toast = ${JSON.stringify(toast)}`);
  // 直接发布必须失败；错误详情记录在消息中心（侧边栏悬浮面板）
  await page.locator(".message-center-btn").hover();
  await expect(page.locator(".message-panel")).toBeVisible({ timeout: 10_000 });
  await page.locator(".message-panel").scrollIntoViewIfNeeded().catch(() => {});
  const msgPanel = await page.locator(".message-panel").innerText();
  console.log(`[T-AP-03] 消息中心面板 = ${msgPanel.slice(0, 600)}`);
  await page.screenshot({ path: "results/ap03-direct-publish.png", fullPage: true });
  expect(toast.join("\n")).toMatch(/失败|阻断/);
  expect(msgPanel).toMatch(/阻断|必须通过|ApplyPlan|变更计划|发布失败/);
  // Nacos 内容不变
  const after = await fetchNacosContent(BASE_A, NS_A, "retest-plain.txt", GROUP);
  expect(after).not.toContain("直接发布尝试");
});
