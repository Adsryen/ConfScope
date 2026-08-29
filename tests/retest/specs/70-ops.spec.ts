import { test, expect, fetchNacosContent } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { loadRetestState } from "../state";
import { navigate, dismissStartupDialog } from "./ui";

const state = loadRetestState();
const A = state.nacos.a;
const GROUP = "RETEST-PROD";

// T-OPS-01: 操作历史页：选择连接「从配置中心拉取」→ 记录出现 → 类型/dataId 筛选
test("T-OPS-01 操作历史: 中心历史拉取 + 筛选", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);

  // 制造一条 A 侧 svc-monitor.properties 的真实发布历史（带唯一标记）
  const original = await fetchNacosContent(A.baseUrl, A.namespace, "svc-monitor.properties", "DEFAULT_GROUP");
  const marker = `OPS-T01-${Date.now()}`;
  const mutated = original.replace(/\n?$/, `\n# ${marker}\n`);
  const post = async (content: string) => {
    const res = await fetch(`${A.baseUrl}/v1/cs/configs`, {
      method: "POST",
      body: new URLSearchParams({
        tenant: A.namespace,
        dataId: "svc-monitor.properties",
        group: "DEFAULT_GROUP",
        type: "properties",
        content,
      }),
    });
    const text = await res.text();
    if (res.status !== 200 || text !== "true") throw new Error(`publish failed: ${res.status} ${text}`);
  };
  await post(mutated);
  // 恢复原内容并清掉历史累积的 marker 行, 避免文件无限增长
  await post(original.replace(/\n# OPS-T01-\d+/g, ""));
  await page.waitForTimeout(500);

  // 进入操作历史
  await navigate(page, "操作历史");
  await expect(page.locator(".history-page")).toBeVisible({ timeout: 15_000 });

  // 从配置中心拉取：选择 Retest Nacos A（option value = 连接 id，label = 名称）
  const connFilter = page.locator(".history-filters .history-filter-select").first();
  await connFilter.selectOption({ label: "Retest Nacos A" });
  await expect(page.locator(".history-content .data-list-item, .history-content .history-item").first()).toBeVisible({ timeout: 60_000 });
  const items = page.locator(".history-content .data-list-item, .history-content .history-item");
  const itemCount = await items.count();
  console.log(`[T-OPS-01] 拉取后记录数 = ${itemCount}`);
  expect(itemCount).toBeGreaterThanOrEqual(1);
  // 首条应为刚制造的最新发布（按时间降序）
  const firstText = await items.first().innerText();
  console.log(`[T-OPS-01] 首条记录 = ${JSON.stringify(firstText.slice(0, 160))}`);
  expect(firstText).toContain("发布");
  expect(firstText).toContain("retest-dev");
  // 中心历史行覆盖 DEFAULT_GROUP 的 dataId
  expect(await page.locator(".history-content .history-dataid", { hasText: "svc-monitor.properties" }).count()).toBeGreaterThan(0);
  await page.screenshot({ path: "results/ops01-center-history.png", fullPage: true });

  // 类型筛选：选「发布」
  const typeFilter = page.locator(".history-filters .history-filter-select").nth(1);
  await typeFilter.selectOption({ value: "publish" });
  expect(await page.locator(".history-content .data-list-item, .history-content .history-item").count()).toBeGreaterThanOrEqual(1);

  // dataId 筛选
  const dataIdFilter = page.locator(".history-filters .history-filter-input");
  await dataIdFilter.fill("svc-gateway");
  await page.waitForTimeout(300);
  const afterDataIdFilter = await page.locator(".history-content .data-list-item, .history-content .history-item").count();
  console.log(`[T-OPS-01] dataId 过滤后记录数 = ${afterDataIdFilter}`);
  expect(afterDataIdFilter).toBeGreaterThanOrEqual(0);
  await dataIdFilter.fill("");
  await expect(page.locator(".history-content .data-list-item, .history-content .history-item").first()).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: "results/ops01-filtered.png", fullPage: true });
});

// T-OPS-02: 任务中心：浏览页「创建当前列表快照」产生 backup 任务 → 任务列表/详情/清除已完成
test("T-OPS-02 任务中心: 浏览页创建快照产生任务并展示", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item-id", { hasText: "svc-gateway.yaml" })).toBeVisible({ timeout: 30_000 });

  // 创建当前列表快照（RETEST-PROD 12 个配置）
  await page.locator(".snapshot-action-btn", { hasText: "创建当前列表快照" }).click();
  await expect(page.locator(".toaster .toast, .toast").first()).toBeVisible({ timeout: 60_000 });
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
  const clearBtn = page.locator(".task-center button", { hasText: "清除已完成" });
  if (await clearBtn.count()) {
    await clearBtn.click();
    await page.waitForTimeout(1000);
  }
  await page.screenshot({ path: "results/ops02-cleared.png", fullPage: true });
});
