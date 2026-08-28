import { test, expect } from "./retestTest";
import { installRetestBridge, RETEST_BRIDGE_MARKER } from "../bridge/installRetestBridge";
import { loadRetestState } from "../state";
import { navigate, dismissStartupDialog } from "./ui";

const state = loadRetestState();
const A = state.nacos.a;

// T-CONN-01/02: 连接管理：新建连接（真实 Nacos A）+ 连接测试 + 保存 + 删除（两次点击确认）
test("T-CONN-01/02 连接管理: 新建→测试→保存→删除", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "连接管理");
  await expect(page.locator(".conn-mgr")).toBeVisible({ timeout: 15_000 });

  // 已保存连接列表应包含两个播种连接（连接名在备注列，.conn-item 为整行）
  // 播种连接名带 "Retest Nacos " 前缀，hasText 用无空格前缀匹配
  await expect(page.locator(".conn-item", { hasText: "Retest Nacos A" }).locator(".conn-item-name")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".conn-item", { hasText: "Retest Nacos B" }).locator(".conn-item-name")).toBeVisible();
  const countBefore = await page.locator(".conn-item").count();
  console.log(`[T-CONN] 初始连接数 = ${countBefore}`);

  // 新增来源
  await page.locator(".conn-create-btn", { hasText: "新增来源" }).click();
  // 表单：项目（新建项目… → 输入新项目）/ 环境（选 测试）/ 来源名称 / 目标地址
  const projectField = page.locator("label.field").filter({ has: page.locator("span:has-text('项目')") });
  await projectField.locator("select").selectOption({ label: "新建项目…" });
  await projectField.locator("input").fill("ConnRetest");
  await page.locator("label.field").filter({ has: page.locator("span:has-text('环境')") }).locator("select").selectOption("测试");
  await page.locator("label.field").filter({ has: page.locator("span:has-text('来源名称')") }).locator("input").fill("retest-tmp");
  await page.locator("label.field").filter({ has: page.locator("span:has-text('目标地址')") }).locator("input").fill(A.baseUrl);
  await page.locator("label.field").filter({ has: page.locator("span:has-text('默认命名空间')") }).locator("input").fill(A.namespace);

  // 连接测试（真实 Nacos A，应成功）：新版 UI 用 TestTraceView 展示结果（成功为 .test-trace.ok，
  //  且不再渲染 .test-msg，两者互斥）
  await page.locator("button", { hasText: "连接测试" }).first().click();
  await expect(page.locator(".conn-mgr .test-trace.ok").first()).toBeVisible({ timeout: 60_000 });
  const testMsg = await page.locator(".conn-mgr .test-trace.ok .test-trace-summary").first().innerText();
  console.log(`[T-CONN] 连接测试 = ${testMsg.slice(0, 120)}`);
  expect(testMsg).toMatch(/连接成功|未配置账号|免鉴权|接口通过/);
  await page.screenshot({ path: "results/conn01-test.png", fullPage: true });

  // 保存
  await page.locator("button", { hasText: "保存" }).last().click();
  await expect(page.locator(".conn-item", { hasText: "retest-tmp" }).locator(".conn-item-name")).toBeVisible({ timeout: 15_000 });
  expect(await page.locator(".conn-item").count()).toBe(countBefore + 1);

  // 删除：第一次点击进入确认态，第二次点击真正删除
  const delBtn = page.locator(".conn-item", { hasText: "retest-tmp" }).locator(".conn-item-del");
  await delBtn.click();
  await delBtn.click();
  await page.waitForTimeout(800);
  expect(await page.locator(".conn-item", { hasText: "retest-tmp" }).count()).toBe(0);
  expect(await page.locator(".conn-item").count()).toBe(countBefore);
  await page.screenshot({ path: "results/conn01-deleted.png", fullPage: true });
});

// T-CONN-03: SSH 隧道页：新建档案 → 测试 SSH（复测桥无真实 sshd，必须走错误路径）
test("T-CONN-03 SSH 隧道: 测试失败错误路径展示", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "SSH 隧道");
  await expect(page.locator(".ssh-manager-page")).toBeVisible({ timeout: 15_000 });

  // 新建 SSH 档案
  await page.locator("button", { hasText: "新建 SSH 档案" }).first().click();
  // 档案名称
  await page.locator("label.field").filter({ has: page.locator("span:has-text('档案名称')") }).locator("input").fill("retest-ssh-tmp");
  // SSH 服务器地址 / 用户名 / 密码
  await page.locator("label.field").filter({ has: page.locator("span:has-text('SSH 服务器地址')") }).locator("input").fill("127.0.0.1");
  await page.locator("label.field").filter({ has: page.locator("span:has-text('SSH 用户名')") }).locator("input").fill("nobody");
  const pwdField = page.locator("label.field").filter({ has: page.locator("span:has-text('SSH 密码')") });
  if (await pwdField.count()) {
    await pwdField.locator("input").fill("secret");
  } else {
    // 可能默认是密钥认证，切到密码认证
    await page.locator("select").filter({ has: page.locator("option", { hasText: "密码认证" }) }).first().selectOption("password");
    await page.locator("label.field").filter({ has: page.locator("span:has-text('SSH 密码')") }).locator("input").fill("secret");
  }

  // 测试 SSH → 桥抛错，界面应显示失败消息而非崩溃
  await page.locator("button", { hasText: "测试 SSH" }).click();
  await expect(page.locator(".ssh-manager-page .test-msg.err, .ssh-manager-page .ssh-message.err").first()).toBeVisible({ timeout: 30_000 });
  const errText = await page.locator(".ssh-manager-page .test-msg.err, .ssh-manager-page .ssh-message.err").first().innerText();
  console.log(`[T-CONN-03] SSH 测试错误 = ${errText.slice(0, 160)}`);
  expect(errText).toMatch(/SSH 连接失败|retest bridge/);
  await page.screenshot({ path: "results/conn03-ssh-fail.png", fullPage: true });

  // 保存档案（应成功，档案仅本地保存）
  await page.locator("button", { hasText: "保存" }).last().click();
  await expect(page.locator(".ssh-profile-name", { hasText: "retest-ssh-tmp" })).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: "results/conn03-ssh-saved.png", fullPage: true });

  // 清理：删除档案（无引用，直接删）
  await page.locator(".ssh-profile-item", { hasText: "retest-ssh-tmp" }).locator(".conn-item-del").click();
  await page.waitForTimeout(600);
  expect(await page.locator(".ssh-profile-name", { hasText: "retest-ssh-tmp" }).count()).toBe(0);
});

// T-SET-01: 设置页：代理输入持久化 + 智能对比开关切换后 localStorage 更新
test("T-SET-01 设置: 代理/对比偏好修改并持久化", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "设置");
  await expect(page.locator(".settings-page")).toBeVisible({ timeout: 15_000 });

  // 网络代理：HTTP 代理
  const httpProxy = page.locator("#settings-network input").first();
  await httpProxy.fill("http://127.0.0.1:7891");
  // 保存提示
  await expect(page.locator(".test-msg.ok", { hasText: "设置已保存" })).toBeVisible({ timeout: 10_000 });

  // 智能对比：切换「命名空间下拉按名称排序」
  const nsSort = page.locator("#settings-compare .settings-setting-row", { hasText: "命名空间" }).locator("input[type=checkbox]");
  const before = await nsSort.isChecked();
  await nsSort.click();
  const after = await nsSort.isChecked();
  expect(after).toBe(!before);

  // localStorage 校验
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("cs.settings") || "{}"));
  console.log(`[T-SET-01] 持久化 settings = ${JSON.stringify(stored.proxy)} / ${JSON.stringify(stored.compare)}`);
  expect(stored.proxy.httpProxy).toBe("http://127.0.0.1:7891");
  expect(stored.compare.sortNamespaces).toBe(after);
  await page.screenshot({ path: "results/set01-persisted.png", fullPage: true });

  // 恢复播种值，避免影响其他 spec（对比页排序行为）
  await page.evaluate((value) => {
    const s = JSON.parse(localStorage.getItem("cs.settings") || "{}");
    s.proxy = { ...s.proxy, httpProxy: "" };
    s.compare = { ...s.compare, sortConnections: true, sortNamespaces: true };
    localStorage.setItem("cs.settings", JSON.stringify(s));
  }, null);
});

// T-BACKUP-01: 备份快照页：浏览页创建快照 → 备份页展示 → 详情 → 删除
test("T-BACKUP-01 备份快照: 创建→列表→详情→删除", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);

  // 先在浏览页创建快照
  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item-id", { hasText: "retest-app.yaml" })).toBeVisible({ timeout: 30_000 });
  await page.locator(".snapshot-action-btn", { hasText: "创建当前列表快照" }).click();
  await expect(page.locator(".toast, [class*='toast']").first()).toBeVisible({ timeout: 60_000 });

  // 备份快照页
  await navigate(page, "备份快照");
  await expect(page.locator(".backup-view")).toBeVisible({ timeout: 15_000 });
  const items = page.locator(".backup-item");
  await expect(items.first()).toBeVisible({ timeout: 30_000 });
  expect(await items.count()).toBeGreaterThanOrEqual(1);
  await items.first().click();
  await expect(page.locator(".backup-detail")).toBeVisible({ timeout: 10_000 });
  const detail = await page.locator(".backup-detail").innerText();
  console.log(`[T-BACKUP] 快照详情 = ${detail.slice(0, 200)}`);
  expect(detail).toMatch(/5 个配置|配置/);
  await page.screenshot({ path: "results/bk01-detail.png", fullPage: true });

  // 删除快照（× → 确认弹窗）
  await items.first().locator(".backup-item-delete").click();
  const confirm = page.locator(".modal button.btn-danger, .modal button", { hasText: /确定|确认|删除/ }).last();
  await expect(confirm).toBeVisible({ timeout: 10_000 });
  await confirm.click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "results/bk01-deleted.png", fullPage: true });
});

// T-ABOUT: 关于页：版本信息 + 检查更新（无更新路径）
test("T-ABOUT 关于: 版本展示与检查更新", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "关于");
  await expect(page.locator(".about-page, .about")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".about-version", { hasText: "1.8.0" }).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".about-tagline").first()).toBeVisible();

  // 检查更新（桥返回 hasUpdate=false）
  await page.locator("button", { hasText: "检查更新" }).first().click();
  await expect(page.locator("text=当前已是最新版本").first()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: "results/about01-no-update.png", fullPage: true });
});
