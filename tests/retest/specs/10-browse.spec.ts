import { test, expect, fetchNacosContent } from "./retestTest";
import { installRetestBridge, RETEST_BRIDGE_MARKER } from "../bridge/installRetestBridge";
import { navigate, dismissStartupDialog } from "./ui";
import { loadRetestState } from "../state";

const state = loadRetestState();
const A = state.nacos.a;

// T-BR-01/02: 浏览、命名空间/分组筛选、dataId 搜索
test("T-BR-01/02 浏览: 命名空间与 dataId 搜索列出播种配置", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");

  // 默认连接 retest-a，默认命名空间 retest-dev 应自动选中
  await expect(page.locator(".browser-item-id", { hasText: "retest-app.yaml" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".browser-item-id", { hasText: "retest-app.json" })).toBeVisible();
  await expect(page.locator(".browser-item-id", { hasText: "retest-plain.txt" })).toBeVisible();
  await expect(page.locator(".browser-item-id", { hasText: "retest-only-a.yaml" })).toBeVisible();
  await expect(page.locator(".browser-item-id", { hasText: "retest-app.toml" })).toBeVisible();
  expect(await page.locator(".browser-item-id").count()).toBe(8);

  // dataId 搜索（前端拼成 *term*，后端 search=blur 直接匹配）
  const search = page.locator(".browser-search-input, .search-input.wide").first();
  await search.fill("retest-plain");
  await search.press("Enter");
  await expect(page.locator(".browser-item-id", { hasText: "retest-plain.txt" })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".browser-item-id", { hasText: "retest-app.yaml" })).toHaveCount(0);

  // 分组筛选
  const groupSelect = page.locator(".browser-group-select .sel-trigger");
  await groupSelect.click();
  await page.locator(".sel-menu-portal .sel-option", { hasText: "retest_group" }).last().click();
  await expect(page.locator(".browser-item-id", { hasText: "retest-plain.txt" })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".browser-item-id", { hasText: "retest-app.yaml" })).toHaveCount(0);

  // 清空恢复
  await groupSelect.click();
  await page.locator(".sel-menu-portal .sel-option", { hasText: "全部分组" }).last().click();
  await search.fill("");
  await search.press("Enter");
  await expect(page.locator(".browser-item-id", { hasText: "retest-app.yaml" })).toBeVisible({ timeout: 15_000 });
  expect(await page.locator(".browser-item-id").count()).toBe(8);
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
  await search.fill("8080");
  await search.press("Enter");

  // retest-app.yaml 与 retest-app.properties 都含 8080
  await expect(page.locator(".browser-item-id", { hasText: "retest-app.yaml" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".browser-item-id", { hasText: "retest-app.properties" })).toBeVisible();
  // 不应命中 retest-plain.txt
  await expect(page.locator(".browser-item-id", { hasText: "retest-plain.txt" })).toHaveCount(0);

  // 摘要行是否对命中词做了高亮标记
  const markCount = await page.locator(".browser-item-summary mark, .browser-item-summary .search-hit").count();
  console.log(`[T-BR-03] 内容搜索摘要命中 <mark> 数量 = ${markCount}`);
  await page.screenshot({ path: "results/br03-content-search.png", fullPage: true });

  // 打开完整内容后是否对命中词高亮
  await page.locator(".browser-item", { hasText: "retest-app.yaml" }).first().click();
  await expect(page.locator(".code-area")).toBeVisible({ timeout: 15_000 });
  const contentMarkCount = await page.locator(".code-area mark, .code-area .search-hit").count();
  console.log(`[T-BR-03] 打开内容后命中 <mark> 数量 = ${contentMarkCount}`);
  await page.screenshot({ path: "results/br03-content-open.png", fullPage: true });

  expect.soft(markCount > 0, "内容搜索结果摘要应高亮命中词，否则复现用户报告的'搜索无高亮'").toBeTruthy();
  expect.soft(contentMarkCount > 0, "打开内容后应高亮命中词，否则复现用户报告的'搜索无高亮'").toBeTruthy();
});
// T-BR-04: 打开各格式配置（yaml/json/properties/txt）→ 语法高亮 + 元信息 + 复制按钮
// 复制按钮点击后剪贴板应等于完整内容（含末尾换行）
test("T-BR-04 浏览: 打开各格式配置并复制完整内容", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");

  const cases = [
    { dataId: "retest-app.yaml", marker: "port:" },
    { dataId: "retest-app.json", marker: '"app"' },
    { dataId: "retest-app.properties", marker: "app.name" },
    { dataId: "retest-plain.txt", marker: "line2" },
    { dataId: "retest-app.toml", marker: "port = 8080" },
  ];

  for (const { dataId, marker } of cases) {
    await page.locator(".browser-item", { hasText: dataId }).first().click();
    await expect(page.locator(".code-area")).toBeVisible({ timeout: 15_000 });

    // 详情头部元信息（group · configType）
    const headerText = await page.locator(".detail-header").first().innerText();
    console.log(`[T-BR-04] ${dataId} header = ${headerText.replace(/\n/g, " | ").slice(0, 120)}`);

    // 语法高亮：code-area 内应有语法标记 span
    const hasHighlight = await page.locator(".code-area span").count();
    console.log(`[T-BR-04] ${dataId} highlight spans = ${hasHighlight}`);
    expect(hasHighlight).toBeGreaterThan(0);

    // 复制按钮（fmt-bar 内的 CopyButton）
    const copyBtn = page.locator(".browser-detail .fmt-bar button", { hasText: "复制" }).first();
    await expect(copyBtn).toBeVisible({ timeout: 5_000 });
    await copyBtn.click();
    await expect(copyBtn).toHaveText(/已复制/, { timeout: 5_000 });
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    console.log(`[T-BR-04] ${dataId} clipboard len = ${clip.length}`);
    expect(clip.length).toBeGreaterThan(0);
    expect(clip).toContain(marker);
  }
  await page.screenshot({ path: "results/br04-formats.png", fullPage: true });
});

// T-BR-07: 内容搜索 → 勾选 → 批量替换 → 选择目标 → 生成变更计划 → 进入 ApplyPlan
// 只验证计划生成与进入 ApplyPlan 视图（不执行，避免污染 B 侧数据）
test("T-BR-07 内容搜索: 批量替换生成变更计划进入 ApplyPlan", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");

  // 内容搜索 8080（先选「全部」分组：命名空间下 7 个数据源里 5 个含 8080：
  // yaml/json/properties/app.toml/pair.toml 的 port，retest_group 的 txt 无命中）
  const groupSelect = page.locator(".browser-group-select .sel-trigger");
  await groupSelect.click();
  await page.locator(".sel-menu-portal .sel-option", { hasText: "全部分组" }).last().click();
  await page.getByRole("button", { name: "内容" }).click();
  const search = page.locator(".browser-search-input, .search-input.wide").first();
  await search.fill("8080");
  await search.press("Enter");
  await expect(page.locator(".browser-item-id", { hasText: "retest-app.yaml" })).toBeVisible({ timeout: 30_000 });

  // 内容搜索全量扫描（逐个 GetConfig），等待扫描完成
  const scanStatus = page.locator(".browser-content-search-status").filter({ hasText: /已读取/ }).first();
  await expect(scanStatus).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".browser-count", { hasText: /匹配 5 项/ })).toBeVisible({ timeout: 30_000 });

  // 勾选所有命中项（retest-app.yaml + retest-app.properties）
  const checks = page.locator(".browser-result-check input");
  const checkCount = await checks.count();
  expect(checkCount).toBeGreaterThanOrEqual(2);
  for (let i = 0; i < checkCount; i++) await checks.nth(i).check();

  // 批量替换按钮
  const replaceBtn = page.locator(".browser-replace-btn, button", { hasText: "批量替换" }).first();
  await expect(replaceBtn).toBeVisible({ timeout: 5_000 });
  await replaceBtn.click();

  // 替换弹窗：查找文本应已预填 8080，替换为 8081
  const modal = page.locator(".browser-replace-modal, .modal:has-text('批量替换')").first();
  await expect(modal).toBeVisible({ timeout: 10_000 });
  const findInput = modal.locator("input").first();
  expect(await findInput.inputValue()).toBe("8080");
  const replaceInput = modal.locator("#config-replace-text");
  await replaceInput.fill("8081");
  // 影响面应非零（yaml 的 port: 8080 与 properties 的 8080）
  await expect(modal.locator(".browser-replace-summary", { hasText: /共 [1-9]/ })).toBeVisible({ timeout: 10_000 });

  // 选择应用目标
  const chooseBtn = modal.locator("button", { hasText: "选择应用目标" }).first();
  await chooseBtn.click();

  // 目标选择器：选 Retest Nacos B + retest-qa
  // 自绘 Select 的菜单由 portal 渲染，选项选择绑在 onMouseDown 上；
  // Playwright 的 click() 先发 mousedown 会触发 Select 的 window 外部点击监听先关掉菜单，
  // 因此用 hover + mouse.down()/up() 直接合成一次干净的 mousedown。
  const targetModal = page.locator(".browser-target-modal").first();
  await expect(targetModal).toBeVisible({ timeout: 10_000 });
  const envTrigger = targetModal.locator(".sel-trigger").first();
  await envTrigger.click();
  const targetOption = page.locator(".sel-menu-portal .sel-option", { hasText: "Nacos B" }).last();
  await expect(targetOption).toBeVisible({ timeout: 10_000 });
  await targetOption.hover();
  await page.mouse.down();
  await page.mouse.up();
  // 选择后触发收起菜单，目标来源应显示 Nacos B
  await expect(targetModal.locator(".sel-value").first()).toContainText("Nacos B", { timeout: 10_000 });
  const nsInput = targetModal.locator("#config-target-namespace");
  await nsInput.fill("retest-qa");

  // 生成变更计划
  const genBtn = targetModal.locator("button", { hasText: "生成变更计划" }).first();
  await expect(genBtn).toBeEnabled({ timeout: 5_000 });
  await genBtn.click();

  // 进入 ApplyPlan 视图（草稿先生成，随后出现工作区）
  await expect(page.locator(".apply-workspace")).toBeVisible({ timeout: 30_000 });
  const ledger = page.locator(".apply-ledger");
  await expect(ledger).toBeVisible();
  const ledgerText = await ledger.innerText();
  console.log(`[T-BR-07] ledger = ${ledgerText.replace(/\n/g, " | ")}`);
  expect(ledgerText).toContain("Retest Nacos B");
  expect(ledgerText).toContain("retest-qa");
  await page.screenshot({ path: "results/br07-replace-plan.png", fullPage: true });

  // 验证计划条目（不执行）：8080 命中 5 个配置文件（yaml/json/properties/app.toml/pair.toml）
  const itemMains = page.locator(".apply-item-main");
  const itemCount = await itemMains.count();
  console.log(`[T-BR-07] 计划条目数 = ${itemCount}`);
  expect(itemCount).toBe(5);
});

// T-BR-08: 删除配置（retest-only-a.yaml）→ 确认弹窗输入 dataId → 确认
// 注意：当前实现删除走 doDelete → 抛"直接发布被阻断"错误（安全模型），
// 所以这里验证错误路径 + 配置仍在 Nacos（未真正删除）
test("T-BR-08 删除: 删除确认弹窗被阻断（安全模型）", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");

  // 打开 retest-only-a.yaml
  await page.locator(".browser-item", { hasText: "retest-only-a.yaml" }).first().click();
  await expect(page.locator(".code-area")).toBeVisible({ timeout: 15_000 });

  // 点击删除按钮
  const delBtn = page.locator(".detail-header button, .browser-detail button").filter({ hasText: /删除/ }).first();
  await expect(delBtn).toBeVisible({ timeout: 5_000 });
  await delBtn.click();

  // 删除确认弹窗
  const modal = page.locator(".modal:has-text('删除配置'), .modal:has-text('此操作不可恢复')").first();
  await expect(modal).toBeVisible({ timeout: 10_000 });
  // 输入 dataId 确认
  const input = modal.locator("input").first();
  await input.fill("retest-only-a.yaml");
  // 确认删除
  const confirmBtn = modal.locator("button.btn-danger, button", { hasText: /删除/ }).last();
  await confirmBtn.click();
  await page.waitForTimeout(1500);

  // 应显示错误（直接发布被阻断）
  const errMsg = await page.locator(".test-msg.err, .inline-error-body").first().innerText().catch(() => "");
  console.log(`[T-BR-08] 删除错误 = ${errMsg.slice(0, 200)}`);
  expect(errMsg).toMatch(/阻断|必须通过|ApplyPlan|变更计划/);
  await page.screenshot({ path: "results/br08-delete-blocked.png", fullPage: true });

  // Nacos 配置仍在（未真正删除）
  const after = await fetchNacosContent(A.baseUrl, A.namespace, "retest-only-a.yaml", "DEFAULT_GROUP");
  expect(after).toContain("仅存在于 A 侧");
});

// T-BR-09: 新建配置（ConfigEditor 弹窗）→ 发布被阻断（安全模型）
test("T-BR-09 新建: ConfigEditor 发布被阻断（安全模型）", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");

  // 点击新建配置按钮
  const newBtn = page.locator(".browser-tool-btn, button[aria-label='新建配置'], button[title='新建配置']").first();
  await expect(newBtn).toBeVisible({ timeout: 5_000 });
  await newBtn.click();

  // ConfigEditor 弹窗
  const modal = page.locator(".modal:has-text('新建配置'), .modal-lg").first();
  await expect(modal).toBeVisible({ timeout: 10_000 });

  // 填写 Data ID / group / 格式 / 内容
  const dataIdInput = modal.locator("input").first();
  await dataIdInput.fill("retest-new-t09.yaml");
  const groupInput = modal.locator("input").nth(1);
  await groupInput.fill("DEFAULT_GROUP");
  // 格式选择（Select）
  const fmtSelect = modal.locator(".sel-trigger, select").first();
  await fmtSelect.click();
  await page.locator(".sel-menu-portal .sel-option, select option", { hasText: "YAML" }).last().click();
  // 内容
  const contentEditor = modal.locator(".code-editor-ta, textarea").first();
  await contentEditor.fill("key: value\n");

  // 发布
  const publishBtn = modal.locator("button.btn-primary, button", { hasText: /发布/ }).last();
  await publishBtn.click();
  await page.waitForTimeout(1500);

  // 应显示错误（直接发布被阻断）：弹窗内 .test-msg.err + reportError toast
  const errMsg = await page.locator(".modal .test-msg.err").first().innerText({ timeout: 10_000 });
  console.log(`[T-BR-09] 新建错误 = ${errMsg.slice(0, 200)}`);
  expect(errMsg).toMatch(/直接配置写入已禁用|变更计划/);
  await expect(page.locator(".toast", { hasText: "新建配置失败" }).first()).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: "results/br09-new-blocked.png", fullPage: true });

  // Nacos 未创建新配置
  const created = await page.evaluate(async () => {
    const res = await fetch("http://127.0.0.1:19848/nacos/v1/cs/configs?dataId=retest-new-t09.yaml&group=DEFAULT_GROUP&tenant=retest-dev");
    return res.status;
  });
  expect(created).toBe(404);
});

