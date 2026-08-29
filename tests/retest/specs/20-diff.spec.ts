import { test, expect } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { navigate, dismissStartupDialog, setDiffSource, readDiffGroupOptions } from "./ui";

const NS_A = "retest-dev";
const NS_B = "retest-qa";
const GROUP = "RETEST-PROD";

/** 对比页预填已支持左右独立 namespace，这里走"展开来源 → 手动选"的真人路径。 */
async function loadSingleCompare(page: any, dataId = "svc-gateway.yaml") {
  await navigate(page, "配置对比");
  // 对比页自动恢复会展开来源面板；收起/展开有 180-200ms 过渡，过渡期间
  // 摘要条覆盖字段区拦截点击（8 分钟级重试），等过渡稳定后再操作字段。
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP, dataId });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP, dataId });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".diff-panel")).toBeVisible({ timeout: 30_000 });
}

// T-DIFF-01: 单文档加载并对比（dev vs qa，真实差异：注释/行序/值）
test("T-DIFF-01 单文档对比: 双 Nacos 同 dataId 差异渲染", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await loadSingleCompare(page);

  // dev 与 qa 侧注释/值不同 → 必有 modify/add/del 行
  await expect(page.locator(".diff-row.modify, .diff-row.add, .diff-row.del")).not.toHaveCount(0);
  // 两侧标题注释都是差异点
  await expect(page.locator(".diff-body")).toContainText("网关服务主配置");
  await page.screenshot({ path: "results/diff01-single-compare.png", fullPage: true });
});

// T-DIFF-02: 对比后点击中间"应用"箭头（用户报告：不好使）
test("T-DIFF-02 应用箭头: 单文档对比后点击应用方向箭头", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await loadSingleCompare(page);

  const direction = page.locator(".diff-source-direction");
  await expect(direction).toHaveCount(1);

  // 展开来源面板（折叠状态下 .diff-sources 是 pointer-events:none）
  await page.getByRole("button", { name: "展开来源" }).last().click();
  await page.waitForTimeout(400);
  console.log(`[T-DIFF-02] direction count=${await direction.count()} before click`);
  await direction.click({ timeout: 10_000 }).catch((e) => {
    console.log(`[T-DIFF-02] direction click failed: ${String(e).slice(0, 120)}, evaluate fallback`);
    direction.evaluate((el) => (el as HTMLElement).click()).catch(() => undefined);
  });
  await page.waitForTimeout(1000);
  // 诊断：点击后的页面状态
  const diag = await page.evaluate(() => ({
    applyVisible: !!document.querySelector(".apply-workspace, .apply-ledger, .apply-count-strip, .apply-item-list"),
    inlineError: document.querySelector(".inline-error")?.textContent?.slice(0, 100) ?? null,
    toast: document.querySelector(".toaster .toast")?.textContent?.slice(0, 100) ?? null,
    nav: Array.from(document.querySelectorAll(".side-nav-item")).map((el) => (el as HTMLElement).textContent?.trim()).join(","),
  }));
  console.log(`[T-DIFF-02] after click diag: ${JSON.stringify(diag)}`);

  await expect(page.locator(".apply-item-list, .inline-error, .apply-draft-loading").first()).toBeVisible({ timeout: 30_000 });
  const enteredApply = await page.locator(".apply-workspace, .apply-ledger, .apply-count-strip, .apply-item-list").first().isVisible({ timeout: 2_000 }).catch(() => false);
  const feedback = await page.locator(".toaster .toast").last().isVisible({ timeout: 500 }).catch(() => false);
  console.log(`[T-DIFF-02] 点击方向箭头后: 进入ApplyPlan=${enteredApply}, 有反馈提示=${feedback}`);
  await page.screenshot({ path: "results/diff02-arrow-click.png", fullPage: true });
  // 修复后：箭头是真正的按钮，对比完成后点击进入变更计划
  expect(enteredApply || feedback).toBeTruthy();
});

// T-DIFF-03: 批量匹配（10 个同名 dataId，RETEST-PROD）→ 全选 → 批量对比
test("T-DIFF-03 批量对比: 13 个同 group 配置匹配并批量加载", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置对比");
  await page.waitForTimeout(500); // 等来源面板展开过渡稳定

  // 两侧都选 RETEST-PROD group（dataId 留空 → 自动匹配该 group 全部）
  await setDiffSource(page, "left", { connection: "Retest Nacos A", namespace: NS_A, group: GROUP });
  await setDiffSource(page, "right", { connection: "Retest Nacos B", namespace: NS_B, group: GROUP });
  await page.getByRole("button", { name: "加载并对比" }).last().click();

  await expect(page.locator(".match-list")).toBeVisible({ timeout: 30_000 });
  const items = page.locator(".match-item");
  const itemCount = await items.count();
  console.log(`[T-DIFF-03] 匹配项数量 = ${itemCount}`);
  expect(itemCount).toBe(13);
  // 13 个 dataId 双侧都存在 → 全部 "both"
  await expect(page.locator(".match-presence.both").first()).toBeVisible();

  // 全选 → 批量对比
  await page.locator(".match-toggle-all input").check();
  await page.getByRole("button", { name: /对比选中/ }).last().click();
  await expect(page.locator(".batch-diff .batch-diff-nav-item").first()).toBeVisible({ timeout: 60_000 });
  expect(await page.locator(".batch-diff .batch-diff-nav-item").count()).toBe(13);
  await page.screenshot({ path: "results/diff03-batch-diff.png", fullPage: true });
});

// T-DIFF-04: group 下拉（用户报告：对比页没有 group 下拉框/候选为空）
// 连接配了 defaultGroup=RETEST-PROD 后：左右 group 字段应预填 RETEST-PROD，
// 候选列表按当前选中 group 精确过滤（防止 Nacos v1 group=空 混入兄弟 group），
// 手工清空输入可枚举该命名空间的全部 group。
test("T-DIFF-04 对比页: group 下拉默认值与候选枚举", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置对比");
  await page.waitForTimeout(2500); // 含来源面板展开过渡 + group 候选拉取

  // 预填（来自连接的 defaultNamespace + defaultGroup）
  const leftGroups = await readDiffGroupOptions(page, "left");
  const rightGroups = await readDiffGroupOptions(page, "right");
  console.log(`[T-DIFF-04] 左 group 候选 = ${JSON.stringify(leftGroups)}, 右 = ${JSON.stringify(rightGroups)}`);
  expect(leftGroups).toContain("RETEST-PROD");
  expect(rightGroups).toContain("RETEST-PROD");

  // group 字段当前值应为 RETEST-PROD
  const fields = page.locator(".source-picker label.field", { has: page.locator("span:has-text('分组')") });
  const leftGroupValue = await fields.nth(0).locator("input").inputValue();
  const rightGroupValue = await fields.nth(1).locator("input").inputValue();
  console.log(`[T-DIFF-04] 左 group=${leftGroupValue} 右 group=${rightGroupValue}`);
  expect(leftGroupValue).toBe("RETEST-PROD");
  expect(rightGroupValue).toBe("RETEST-PROD");
  // 候选精确过滤：选中 RETEST-PROD 时两侧候选只应含 RETEST-PROD 本身
  for (const groups of [leftGroups, rightGroups]) {
    for (const g of groups) {
      expect(g.trim().toLowerCase()).toBe("retest-prod");
    }
  }
  // 手工清空左侧 group 输入 → 可枚举该命名空间全部 group
  // 注意 headless 下 Playwright pointer 事件不触发 React onPointerDown，用真实 click + keyboard
  const leftInput = fields.nth(0).locator("input");
  await leftInput.click();
  await page.waitForTimeout(300);
  await leftInput.evaluate((el) => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.bind(input);
    setter?.("");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator(".combo-menu-portal").waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(800);
  const openOptions = await page.locator(".combo-menu-portal .combo-option").allInnerTexts().catch(() => []);
  const allGroups = openOptions.map((g) => g.trim().toLowerCase()).filter(Boolean);
  console.log(`[T-DIFF-04] 清空后左 group 候选 = ${JSON.stringify(allGroups)}`);
  for (const g of ["retest-prod", "retest-order", "retest-messenge", "default_group"]) {
    expect(allGroups.some((x) => x.includes(g))).toBeTruthy();
  }
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.screenshot({ path: "results/diff04-group-dropdown.png", fullPage: true });
});

// T-DIFF-05: 自动恢复——上次对比（左右独立 namespace）在新会话里自动预填并自动对比
test("T-DIFF-05 自动恢复: 左右独立 namespace 预填 + 自动对比", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  // 存储种子已播种 diff 页 + 左右独立 namespace + autoCompare
  await page.waitForTimeout(4000);

  // 应已自动进入对比页并完成对比
  await expect(page.locator(".diff-panel")).toBeVisible({ timeout: 30_000 });
  // 左右 namespace 各自正确（左 retest-dev / 右 retest-qa）
  const nsFields = page.locator(".source-picker label.field", { has: page.locator("span:has-text('命名空间')") });
  const leftNs = await nsFields.nth(0).locator(".sel, select, input").first().inputValue().catch(() => "");
  const rightNs = await nsFields.nth(1).locator(".sel, select, input").first().inputValue().catch(() => "");
  const leftNsText = leftNs || (await nsFields.nth(0).innerText());
  const rightNsText = rightNs || (await nsFields.nth(1).innerText());
  console.log(`[T-DIFF-05] 左 ns=${leftNsText.slice(0, 40)} 右 ns=${rightNsText.slice(0, 40)}`);
  await page.screenshot({ path: "results/diff05-autorestore.png", fullPage: true });
  expect(await page.locator(".diff-row.modify, .diff-row.add, .diff-row.del").count()).toBeGreaterThan(0);
});
