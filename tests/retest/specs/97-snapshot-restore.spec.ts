import { test, expect } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { dismissStartupDialog } from "./ui";
import { loadRetestState } from "../state";

const state = loadRetestState();

/** 标准启动：装桥 + 播种 + 进首页关启动弹窗。 */
async function boot(page: import("@playwright/test").Page) {
  await installRetestBridge(page, state);
  await republishRetestData();
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
}

async function nav(page: import("@playwright/test").Page, label: string) {
  await page.locator(".side-nav-item", { hasText: label }).first().click();
}

// F3: 从快照恢复（备份快照页「生成变更计划」入口）
// 真人路径：浏览页创建快照 → 备份快照页选中快照条目 → 点「生成变更计划」
// → 进入配置变更计划页。
// 说明：本地快照读路径在真实 Wails 中由 Go 侧 local provider 从磁盘读取，
// retest 浏览器桥从快照缓存按 dataId/group 取内容（bridge 已支持 provider=local）。
// 若计划生成失败，页面必须给出明确错误卡片（变更计划生成失败），不允许静默卡死。
test("F3 从快照恢复: 备份快照条目可生成变更计划且反馈明确", async ({ page }) => {
  await boot(page);

  // 1) 浏览页创建当前列表快照（真实 UI 路径，F1/F2 同款：逐条 getConfig）
  await nav(page, "配置浏览");
  await expect(page.locator(".browser-item-id").first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "创建当前列表快照" }).click();
  // 快照创建逐条 getConfig（约 13 项），去任务中心等任务跑完（success 出现）
  await nav(page, "任务中心");
  await expect(page.getByText("创建当前列表快照：").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".task-status-success").first()).toBeVisible({ timeout: 60_000 });
  const taskName = await page.locator(".task-center .task-item .task-item-name", { hasText: "创建当前列表快照：" }).first().innerText();
  console.log(`[F3] 快照任务 = ${taskName}`);

  // 2) 备份快照页：应出现刚创建的快照（retest-backup-*）
  await nav(page, "备份快照");
  const snapItem = page.locator(".backup-view .backup-item", { hasText: "retest-backup-" }).first();
  await expect(snapItem).toBeVisible({ timeout: 15_000 });
  await snapItem.click();
  await page.waitForTimeout(500);

  // 3) 选中快照后应列出配置条目，且有「生成变更计划」按钮
  const applyBtn = page.locator(".backup-config-item button", { hasText: "生成变更计划" }).first();
  await expect(applyBtn).toBeVisible({ timeout: 15_000 });
  await applyBtn.click();

  // 4) 进入配置变更计划页：等生成终态（成功=计划工作区/失败=错误卡片），45s 内必须出结果。
  // 真人视角红线：不允许一直停留在「正在生成」加载态（静默卡死）。
  await expect(page.locator(".apply-view").first()).toBeVisible({ timeout: 10_000 });
  await page
    .locator(".apply-view .apply-workspace, .apply-view .inline-error, .apply-view .data-empty-state")
    .first()
    .waitFor({ state: "visible", timeout: 45_000 });
  // 计划页不应停留在「正在生成」加载态
  const stillLoading = await page.getByText("正在生成 dry-run 计划...").first().isVisible().catch(() => false);
  expect(stillLoading, "计划生成不得静默停留在加载态").toBe(false);

  const failed = await page.locator(".apply-view .inline-error", { hasText: "变更计划生成失败" }).first().isVisible().catch(() => false);
  if (failed) {
    // 失败路径：错误卡片必须含可读 detail（便于排查），且「返回」可用不卡死
    const detail = (await page.locator(".apply-view .inline-error .inline-error-body").first().innerText()).trim();
    expect(detail.length, "失败详情不得为空").toBeGreaterThan(0);
    console.log(`[F3] 分支 = error; detail = ${detail.slice(0, 200)}`);
    await page.locator(".apply-view button", { hasText: "返回" }).first().click();
    await expect(page.locator(".backup-view").first()).toBeVisible({ timeout: 10_000 });
  } else {
    // 成功路径：计划工作区出现，来源=本地快照、目标=Nacos，计划条目可交互
    await expect(page.locator(".apply-view .apply-workspace").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".apply-view .apply-plan-summary").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".apply-view .apply-item-row").first()).toBeVisible({ timeout: 10_000 });
    // 来源标签应体现本地快照（快照名），目标应为 Nacos A（retest-dev 原来源连接）
    const summaryText = await page.locator(".apply-view .apply-plan-summary").first().innerText();
    expect(summaryText).toContain("retest-backup-");
    console.log("[F3] 分支 = success; summary =", summaryText.slice(0, 200).replace(/\s+/g, " "));
    // 「返回」按钮可用，可回到备份快照页
    await page.locator(".apply-view button", { hasText: "返回" }).first().click();
    await expect(page.locator(".backup-view").first()).toBeVisible({ timeout: 10_000 });
  }
  await page.screenshot({ path: "results/f3-snapshot-restore.png", fullPage: true });
});
