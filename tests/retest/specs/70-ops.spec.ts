import { test, expect } from "./retestTest";
import type { Page } from "@playwright/test";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { onBridgeLog } from "../bridge/retestBinding";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog } from "./ui";

const CENTER_HISTORY_NOTE = "该配置中心不提供命名空间级的历史列表：请到配置浏览选中配置后看「历史变更」。";

/**
 * 浏览页作用域切到指定来源连接。
 *
 * 作用域条四格顺序（App.tsx:589-619）：项目 / 环境 / 来源 / 命名空间 —— 来源是第 3 格。
 * 触发器文本自带下拉箭头字形（真机实测 "Retest Nacos A▾"），断言前先剥掉。
 */
async function ensureBrowseSource(page: Page, name: string): Promise<void> {
  const trigger = page.locator(".page-header .browse-scope-field .sel-trigger").nth(2);
  await expect(trigger).toBeEnabled({ timeout: 20_000 });
  const current = (await trigger.innerText()).replace(/[\u25be\u25b4\u2304\u2303]/g, "").trim();
  if (current.includes(name)) return;
  await trigger.click({ force: true, timeout: 10_000 });
  const menu = page.locator(".sel-menu-portal").first();
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await menu.locator(".sel-option", { hasText: name }).first().click({ force: true });
  await expect(menu).toBeHidden({ timeout: 10_000 });
  await expect(page.locator(".page-header .browse-scope-field .sel-trigger").nth(2)).toContainText(name, { timeout: 10_000 });
}

// T-OPS-01: 操作历史页（当前契约）：本地记录来自应用自己的动作 → 中心历史能力闸门 → 类型/dataId 筛选。
//
// 轮55 R55-E3 把「中心历史」按能力收口：nacos 的命名空间级历史拿不到（v1 空查询恒 0 行 = 静默假空，
// blur 查询直接 500），所以选择不支持的连接时根本不发请求，界面只讲「去哪看历史」。
// 本用例因此钉三件事：① 本地记录确实由应用动作产生且计数如实；② 能力闸门那句 note 是真的、
// 且选择连接不会把已有记录刷空；③ 反向守卫——桥日志里一条 ListHistory in 都不许出现。
test("T-OPS-01 操作历史: 本地记录 + 中心历史能力闸门 + 筛选", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  const bridgeLines: string[] = [];
  onBridgeLog((line) => bridgeLines.push(line));

  // 自己造现场：复测数据必须先就位，否则快照会空跑（原来靠上一条用例留下的现场 = 隐患）
  await republishRetestData();

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);

  // 产生一条真实本地记录：浏览页「创建当前列表快照」→ recordOperation(type:"snapshot")
  await navigate(page, "配置浏览");
  await ensureBrowseSource(page, "Retest Nacos A");
  await expect(page.locator(".browser-item-id", { hasText: "svc-gateway.yaml" }).first()).toBeVisible({ timeout: 30_000 });
  await page.locator(".snapshot-action-btn", { hasText: "创建当前列表快照" }).click();
  // 闸门必须等「快照已创建」那一条，不能等「任意一条 toast 可见」：
  // 列表快照是后台任务，别的 toast 先亮也算过，那时 recordOperation 还没落账
  // （真机实测：通用 toast 出现时 cs.operationHistory 仍是 []，4s 后才出现那条 snapshot 记录）。
  await expect(page.locator(".toast", { hasText: "快照已创建" }).first()).toBeVisible({ timeout: 90_000 });

  // 进入操作历史：列表项是 .op-history-item（OperationHistoryView.tsx:469）
  await navigate(page, "操作历史");
  await expect(page.locator(".history-page")).toBeVisible({ timeout: 15_000 });
  const items = page.locator(".history-page .op-history-item");
  await expect(items.first()).toBeVisible({ timeout: 30_000 });
  const itemCount = await items.count();
  console.log(`[T-OPS-01] 快照后本地记录数 = ${itemCount}`);
  expect(itemCount).toBeGreaterThanOrEqual(1);

  // 副标题的条数必须等于列表实际条数（计数撒谎是这类列表页的老毛病）
  await expect(page.locator(".history-page .page-subtitle")).toContainText(`共 ${itemCount} 条记录`);

  // 首条就是刚创建的那个快照：类型徽章 snapshot、连接名如实
  const firstItem = items.first();
  await expect(firstItem.locator(".history-type.snapshot")).toBeVisible();
  await expect(firstItem).toContainText("创建快照");
  const firstMeta = await firstItem.locator(".history-item-meta span").first().innerText();
  console.log(`[T-OPS-01] 首条记录连接名 = ${JSON.stringify(firstMeta)}`);
  expect(firstMeta).toBe("Retest Nacos A");
  await page.screenshot({ path: "results/ops01-local-records.png", fullPage: true });

  // 能力闸门：选 Retest Nacos A（原生 select，option value = 连接 id）
  const connFilter = page.locator(".history-filters .history-filter-select").first();
  await connFilter.selectOption({ label: "Retest Nacos A" });
  await expect(page.locator(".history-page .history-center-note").first()).toContainText(CENTER_HISTORY_NOTE, { timeout: 15_000 });
  // 闸门是「不发请求」，不是「把本地记录刷空」
  await expect(items.first()).toBeVisible({ timeout: 10_000 });
  expect(await items.count(), "选择不支持的连接后本地记录被刷空").toBe(itemCount);
  // 反向守卫：整条用例都不该向配置中心发过历史请求
  const listHistoryCalls = bridgeLines.filter((line) => line.includes("ListHistory in"));
  console.log(`[T-OPS-01] ListHistory 桥调用次数 = ${listHistoryCalls.length}`);
  expect(listHistoryCalls, `中心历史闸门被绕过，实际发出请求：${JSON.stringify(listHistoryCalls)}`).toEqual([]);

  // 类型筛选：快照记录该被筛出来；换成「发布」必须给空态，而不是白屏或残留
  const typeFilter = page.locator(".history-filters .history-filter-select").nth(1);
  await typeFilter.selectOption({ value: "snapshot" });
  await expect(items.first()).toBeVisible({ timeout: 10_000 });
  expect(await items.count()).toBeGreaterThanOrEqual(1);
  await typeFilter.selectOption({ value: "publish" });
  // 空态要盯列表那一块（.op-history-list）：右侧详情面板也有一份 .data-empty-state.detail-empty，
  // 写宽选择器会撞 strict mode（真机实测：同屏两个 .data-empty-state）。
  await expect(page.locator(".history-page .op-history-list .data-empty-state")).toBeVisible({ timeout: 10_000 });
  expect(await items.count(), "类型筛到 0 条时列表仍有残留行").toBe(0);
  await typeFilter.selectOption({ value: "" });
  await expect(items.first()).toBeVisible({ timeout: 10_000 });
  expect(await items.count(), "切回全部类型后记录没有回来").toBe(itemCount);

  // dataId 筛选：原来那句 >= 0 是恒真断言（等于没断），这里改成「筛掉就是空态、清空就得回来」
  const dataIdFilter = page.locator(".history-filters .history-filter-input");
  await dataIdFilter.fill("no-such-config-ops01.yaml");
  await expect(page.locator(".history-page .op-history-list .data-empty-state")).toBeVisible({ timeout: 10_000 });
  expect(await items.count(), "dataId 筛选没生效，不匹配的记录还在列表里").toBe(0);
  await dataIdFilter.fill("");
  await expect(items.first()).toBeVisible({ timeout: 10_000 });
  expect(await items.count(), "清空 dataId 后记录没有回来").toBe(itemCount);
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
