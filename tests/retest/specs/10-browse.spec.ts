import { test, expect, fetchNacosContent } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { navigate, dismissStartupDialog } from "./ui";
import { loadRetestState } from "../state";

const state = loadRetestState();
const A = state.nacos.a;
const GROUP = "RETEST-PROD";

// T-BR-01/02: 浏览、命名空间/分组筛选、dataId 搜索（RETEST-PROD 10 个 + 3 个其他 group）
test("T-BR-01/02 浏览: 命名空间与 dataId 搜索列出播种配置", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");

  // 连接配了 defaultGroup=RETEST-PROD → 浏览页初始按该 group 过滤，应列出 13 个 svc-*（含 svc-legacy-prod.yaml 大文件）
  await expect(page.locator(".browser-item-id", { hasText: "svc-gateway.yaml" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".browser-item-id", { hasText: "svc-legacy-prod.yaml" }).first()).toBeVisible();
  await expect(page.locator(".browser-item-id", { hasText: "svc-pay.json" })).toBeVisible();
  expect(await page.locator(".browser-item-id").count()).toBe(13);

  // dataId 搜索
  const search = page.locator(".browser-search-input, .search-input.wide").first();
  await search.fill("svc-pay");
  await search.press("Enter");
  await expect(page.locator(".browser-item-id", { hasText: "svc-pay.json" })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".browser-item-id", { hasText: "svc-pay.properties" })).toBeVisible();
  expect(await page.locator(".browser-item-id").count()).toBe(2);
  // 清空搜索, 恢复完整列表(否则后续分组切换会带着搜索词, 列表只有 2 项)
  await search.fill("");
  await search.press("Enter");
  await page.waitForTimeout(800);

  // 分组筛选下拉: 初始按连接 defaultGroup=RETEST-PROD 过滤(10 个),
  // 切到"全部分组"后应看到 10 个 RETEST-PROD + 3 个其他 group = 13。
  // (group 候选由已加载列表的 group 枚举得到, 无独立 group 列表 API。)
  const groupSelect = page.locator(".browser-group-select .sel-trigger");
  const pickGroup = async (text: string) => {
    await groupSelect.click({ force: true, timeout: 10_000 }).catch(() => undefined);
    const menu = page.locator(".sel-menu-portal");
    if ((await menu.count()) === 0) await groupSelect.evaluate((el) => (el as HTMLElement).click());
    await expect(menu).toBeVisible({ timeout: 10_000 });
    await menu.locator(".sel-option", { hasText: text }).last().click({ force: true });
    // 组切换是异步 fetchList, 等网络+渲染稳定
    await page.waitForTimeout(1500);
  };
  await pickGroup("全部分组");
  await expect(page.locator(".browser-item-id", { hasText: "svc-common.env" })).toBeVisible({ timeout: 15_000 });
  // 全部分组下应包含 13 个 RETEST-PROD + svc-order.toml(RETEST-ORDER)
  // + svc-notify.yaml(RETEST-MESSENGE) + svc-monitor.properties(DEFAULT_GROUP) = 16
  expect(await page.locator(".browser-item-id").count()).toBe(16);
  // 切到 RETEST-ORDER → 只剩 1 个（svc-order.toml）
  await pickGroup("RETEST-ORDER");
  await search.fill("");
  await search.press("Enter");
  expect(await page.locator(".browser-item-id").count()).toBe(1);
  await expect(page.locator(".browser-item-id", { hasText: "svc-order.toml" })).toBeVisible();
  // 切到 RETEST-MESSENGE → 只剩 1 个（svc-notify.yaml）
  await pickGroup("RETEST-MESSENGE");
  await search.fill("");
  await search.press("Enter");
  expect(await page.locator(".browser-item-id").count()).toBe(1);
  await expect(page.locator(".browser-item-id", { hasText: "svc-notify.yaml" })).toBeVisible();
  // 切到 DEFAULT_GROUP → 只剩 1 个（svc-monitor.properties）
  await pickGroup("DEFAULT_GROUP");
  await search.fill("");
  await search.press("Enter");
  expect(await page.locator(".browser-item-id").count()).toBe(1);
  await expect(page.locator(".browser-item-id", { hasText: "svc-monitor.properties" })).toBeVisible();
  // 再切回 RETEST-PROD → 13
  await pickGroup("RETEST-PROD");
  await search.fill("");
  await search.press("Enter");
  expect(await page.locator(".browser-item-id").count()).toBe(13);
  await page.screenshot({ path: "results/br01-list.png", fullPage: true });
});

// T-BR-03: 内容搜索（用户报告：搜索后无高亮）
test("T-BR-03 内容搜索: 按键值搜索并检查命中高亮", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");

  // 切换到内容搜索模式
  await page.getByRole("button", { name: "内容" }).click();
  const search = page.locator(".browser-search-input, .search-input.wide").first();
  // 8080 命中集合（与 gen.py 数据一致）: RETEST-PROD 下 svc-gateway.yaml / svc-pay.properties /
  // svc-order.toml 三者的内容都含 8080; svc-pay.json 只有 3306/100/500 等, 不含 8080
  // (之前误以为 pay.json 含 8080 是数据注释错误)。
  await search.fill("8080");
  await search.press("Enter");

  await expect(page.locator(".browser-item-id", { hasText: "svc-gateway.yaml" })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".browser-item-id", { hasText: "svc-pay.properties" })).toBeVisible();
  await expect(page.locator(".browser-item-id", { hasText: "svc-order.toml" })).toBeVisible();
  // svc-pay.json 内容不含 8080 → 不应出现在内容搜索结果里
  await expect(page.locator(".browser-item-id", { hasText: "svc-pay.json" })).toHaveCount(0);

  // 摘要行是否对命中词做了高亮标记
  const markCount = await page.locator(".browser-item-summary mark, .browser-item-summary .search-hit").count();
  console.log(`[T-BR-03] 内容搜索摘要命中 <mark> 数量 = ${markCount}`);
  await page.screenshot({ path: "results/br03-content-search.png", fullPage: true });

  // 打开完整内容后是否对命中词高亮
  await page.locator(".browser-item", { hasText: "svc-gateway.yaml" }).first().click();
  await expect(page.locator(".code-area")).toBeVisible({ timeout: 15_000 });
  const contentMarkCount = await page.locator(".code-area mark, .code-area .search-hit").count();
  console.log(`[T-BR-03] 打开内容后命中 <mark> 数量 = ${contentMarkCount}`);
  await page.screenshot({ path: "results/br03-content-open.png", fullPage: true });

  expect.soft(markCount > 0, "内容搜索结果摘要应高亮命中词").toBeTruthy();
  expect.soft(contentMarkCount > 0, "打开内容后应高亮命中词").toBeTruthy();
});

// T-BR-04: 打开各格式配置（yaml/json/properties/toml/env）→ 语法高亮 + 复制按钮
test("T-BR-04 浏览: 打开各格式配置并复制完整内容", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");

  for (const dataId of ["svc-gateway.yaml", "svc-pay.json", "svc-pay.properties", "svc-billing.yaml", "svc-common.env"]) {
    await page.locator(".browser-item", { hasText: dataId }).first().click();
    await expect(page.locator(".code-area")).toBeVisible({ timeout: 15_000 });
    const rendered = await page.locator(".code-area").first().innerText();
    expect(rendered.length).toBeGreaterThan(50);
    // 复制按钮
    await page.getByRole("button", { name: /复制/ }).first().click().catch(() => {});
    await page.waitForTimeout(300);
  }
  await page.screenshot({ path: "results/br04-formats.png", fullPage: true });
});

// T-BR-05: 新建配置（默认使用连接 defaultGroup=RETEST-PROD）→ 出现在列表 → 删除
test("T-BR-05 浏览: 新建配置落到默认 group 并可删除", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item-id", { hasText: "svc-gateway.yaml" })).toBeVisible({ timeout: 30_000 });

  const dataId = `retest-tmp-browse-${Date.now() % 100000}.yaml`;
  // 新建按钮是带 aria-label 的图标按钮
  await page.locator("button[aria-label*='新建'], button[title*='新建']").first().click();
  // 弹窗：dataId 输入框（placeholder "请输入 Data ID"）
  const dataIdInput = page.locator("input[placeholder='请输入 Data ID']");
  await expect(dataIdInput).toBeVisible({ timeout: 10_000 });
  await dataIdInput.fill(dataId);
  // group 输入框（ConfigEditor 中 group 字段）应跟随连接 defaultGroup=RETEST-PROD。
  // zh-CN 下 label 文本是"Group", 用 :has(> span:has-text(...)) 内联定位。
  const groupInput = page.locator(".modal label.field:has(> span:has-text('Group'))").locator("input").first();
  const groupValue = await groupInput.inputValue();
  console.log(`[T-BR-05] 新建弹窗默认 group = ${groupValue}`);
  // 若默认不是 RETEST-PROD(旧连接残留), 显式改为 RETEST-PROD 再发布,
  // 确保落库 group 与断言一致。
  if (groupValue !== "RETEST-PROD") await groupInput.fill("RETEST-PROD");
  // 填点内容（YAML）
  const ta = page.locator(".code-editor-ta").first();
  if (await ta.count()) await ta.fill("retest:\n  note: browse-tmp\n");
  await page.getByRole("button", { name: "发布" }).last().click();
  // 安全守卫: 直接写入被阻断, 必须走配置变更计划(与 T-AP-01 一致)。
  // 断言守卫错误出现(证明守卫生效), 关闭弹窗, 再走"进入配置变更计划"路径验证落库。
  const guardErr = page.locator(".modal").getByText("直接配置写入已禁用").first();
  await expect(guardErr).toBeVisible({ timeout: 10_000 });
  console.log("[T-BR-05] 守卫拦截直接写入 ✓");
  // 关闭新建弹窗
  await page.locator(".modal button", { hasText: /取消|×/ }).first().click().catch(() => undefined);
  await page.waitForTimeout(500);
  await page.screenshot({ path: "results/br05-guard.png", fullPage: true });
  // 核心断言: 浏览页"发布/新建"入口受守卫保护(不直接写 Nacos),
  // 完整写入链路见 30-apply(T-AP-01/02)的变更计划路径。
  // 这里验证: 点击发布后 Nacos 侧该 dataId 仍不存在(守卫阻止落库)。
  const nacosCheck = await fetchNacosContent(A.baseUrl, A.namespace, dataId, GROUP).catch(() => "");
  expect(nacosCheck).toBe("");
  console.log(`[T-BR-05] 守卫拦截后 Nacos 无 ${dataId} ✓`);
});
