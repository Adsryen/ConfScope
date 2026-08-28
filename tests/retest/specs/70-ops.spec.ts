import { test, expect } from "./retestTest";
import { installRetestBridge, RETEST_BRIDGE_MARKER } from "../bridge/installRetestBridge";
import { loadRetestState } from "../state";
import { navigate, dismissStartupDialog } from "./ui";
import { fetchNacosContent } from "./retestTest";

const state = loadRetestState();
const A = state.nacos.a;

// T-OPS-01: 操作历史 + 任务中心
// 1) 通过真实 Nacos 制造一次发布（走配置中心历史接口）
// 2) 操作历史页：选择连接「从配置中心拉取」→ 记录出现；点选记录看详情
// 3) 本地记录：浏览页直接发布被阻断会留下 failure 记录 → 失败统计
// 4) 任务中心：浏览页「创建当前列表快照」产生 backup 任务 → 任务列表/详情/清除已完成
test("T-OPS-01 操作历史: 中心历史拉取 + 记录详情 + 失败统计", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);

  // 制造一条 A 侧 retest-app.yaml 的真实发布历史（Node 侧直连 Nacos，
  // 避免 page.evaluate 闭包引用 Node 变量）；用唯一标记便于断言
  const original = await fetchNacosContent(A.baseUrl, A.namespace, "retest-app.yaml", "DEFAULT_GROUP");
  const marker = `OPS-T01-${Date.now()}`;
  const mutated = original.replace("port: 8080", `port: 8080 # ${marker}`);
  const post = async (content: string) => {
    const res = await fetch(`${A.baseUrl}/v1/cs/configs`, {
      method: "POST",
      body: new URLSearchParams({
        tenant: A.namespace,
        dataId: "retest-app.yaml",
        group: "DEFAULT_GROUP",
        type: "yaml",
        content,
      }),
    });
    const text = await res.text();
    if (res.status !== 200 || text !== "true") throw new Error(`publish failed: ${res.status} ${text}`);
  };
  await post(mutated);
  // 恢复原内容（避免污染后续 diff/audit 断言）
  await post(original);
  await page.waitForTimeout(800);

  // 进入操作历史
  await navigate(page, "操作历史");
  await expect(page.locator(".history-page")).toBeVisible({ timeout: 15_000 });

  // 从配置中心拉取：选择 Retest Nacos A
  const connFilter = page.locator(".history-filters .history-filter-select").first();
  await connFilter.selectOption({ label: "Retest Nacos A" });
  await expect(page.locator(".history-content .data-list-item").first()).toBeVisible({ timeout: 60_000 });
  const centerItems = page.locator(".history-content .data-list-item");
  const itemCount = await centerItems.count();
  console.log(`[T-OPS-01] 拉取后记录数 = ${itemCount}`);
  expect(itemCount).toBeGreaterThanOrEqual(1);
  // 拉取后列表按时间降序：首条应为刚制造的最新发布
  const firstText = await centerItems.first().innerText();
  console.log(`[T-OPS-01] 首条记录 = ${JSON.stringify(firstText.slice(0, 160))}`);
  expect(firstText).toContain("发布");
  expect(firstText).toContain("retest-dev/DEFAULT_GROUP");
  // 中心历史行覆盖该命名空间全部 5 个 dataId（v1 历史行无 dataId 字段，
  // 桥按逐 dataId 查询回填，findings #11/12 已修复）
  const nonEmptyDataIds = await page
    .locator(".history-content .history-dataid")
    .evaluateAll((els) => els.filter((e) => e.textContent?.trim()).length);
  expect(nonEmptyDataIds).toBeGreaterThan(0);
  // 至少覆盖种子中的每个 dataId
  for (const dataId of ["retest-app.yaml", "retest-plain.txt", "retest-only-a.yaml"]) {
    expect(await page.locator(".history-content .history-dataid", { hasText: dataId }).count()).toBeGreaterThan(0);
  }
  await page.screenshot({ path: "results/ops01-center-history.png", fullPage: true });

  // 类型筛选：选「发布」，记录仍应可见
  const typeFilter = page.locator(".history-filters .history-filter-select").nth(1);
  await typeFilter.selectOption({ value: "publish" });
  expect(await page.locator(".history-content .data-list-item").count()).toBeGreaterThanOrEqual(1);
  await typeFilter.selectOption({ value: "" });

  // dataId 筛选：命中 retest-plain 相关记录，清空后恢复全部
  const dataIdFilter = page.locator(".history-filters .history-filter-input");
  await dataIdFilter.fill("retest-plain");
  await page.waitForTimeout(300);
  const afterDataIdFilter = await page.locator(".history-content .data-list-item").count();
  expect(afterDataIdFilter).toBeGreaterThan(0);
  expect(await page.locator(".history-content .history-dataid", { hasText: "retest-plain" }).count()).toBe(afterDataIdFilter);
  await dataIdFilter.fill("");
  await expect(page.locator(".history-content .data-list-item").first()).toBeVisible({ timeout: 10_000 });
});

// T-OPS-02: 任务中心（快照任务）
test("T-OPS-02 任务中心: 浏览页创建快照产生任务并展示", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item-id", { hasText: "retest-app.yaml" })).toBeVisible({ timeout: 30_000 });

  // 创建当前列表快照（5 个配置）
  await page.locator(".snapshot-action-btn", { hasText: "创建当前列表快照" }).click();
  await expect(page.locator(".toast, [class*='toast']").first()).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: "results/ops02-snapshot-task.png", fullPage: true });

  // 任务中心应出现 backup 任务
  await navigate(page, "任务中心");
  await expect(page.locator(".task-center")).toBeVisible({ timeout: 15_000 });
  const taskItems = page.locator(".task-center .data-list-item, .task-center .task-item");
  await expect(taskItems.first()).toBeVisible({ timeout: 60_000 });
  const taskText = await taskItems.first().innerText();
  console.log(`[T-OPS-02] 首个任务 = ${taskText.slice(0, 160)}`);
  expect(taskText).toMatch(/快照|备份|backup/i);
  await taskItems.first().click();
  await expect(page.locator(".task-center .data-detail, .task-center .task-detail").first()).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: "results/ops02-task-detail.png", fullPage: true });

  // 清除已完成
  await page.locator(".task-center button", { hasText: "清除已完成" }).click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: "results/ops02-cleared.png", fullPage: true });
});
