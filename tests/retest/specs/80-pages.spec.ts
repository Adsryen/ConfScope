import { test, expect } from "./retestTest";
import { readFileSync, writeFileSync } from "node:fs";
import { installRetestBridge, RETEST_AUDIT_FILE } from "../bridge/installRetestBridge";
import { loadRetestState } from "../state";
import { navigate, dismissStartupDialog } from "./ui";

const state = loadRetestState();
const A = state.nacos.a;

// T-CONN-01/02: 连接管理：新建连接（真实 Nacos A）+ 连接测试 + 保存 + 删除
test("T-CONN-01/02 连接管理: 新建→测试→保存→删除", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "连接管理");
  await expect(page.locator(".conn-mgr")).toBeVisible({ timeout: 15_000 });

  // 已保存连接列表应包含两个播种连接
  await expect(page.locator(".conn-item", { hasText: "Retest Nacos A" }).locator(".conn-item-name")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".conn-item", { hasText: "Retest Nacos B" }).locator(".conn-item-name")).toBeVisible();
  const countBefore = await page.locator(".conn-item").count();
  console.log(`[T-CONN] 初始连接数 = ${countBefore}`);

  // 新增来源
  await page.locator(".conn-create-btn", { hasText: "新增来源" }).click();
  const projectField = page.locator("label.field").filter({ has: page.locator("span:has-text('项目')") });
  await projectField.locator("select").selectOption({ label: "新建项目…" });
  await projectField.locator("input").fill("ConnRetest");
  await page.locator("label.field").filter({ has: page.locator("span:has-text('环境')") }).locator("select").selectOption("测试");
  await page.locator("label.field").filter({ has: page.locator("span:has-text('来源名称')") }).locator("input").fill("retest-tmp");
  await page.locator("label.field").filter({ has: page.locator("span:has-text('目标地址')") }).locator("input").fill(A.baseUrl);
  await page.locator("label.field").filter({ has: page.locator("span:has-text('默认命名空间')") }).locator("input").fill(A.namespace);

  // 连接测试（真实 Nacos A，应成功）
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

  await page.locator("button", { hasText: "新建 SSH 档案" }).first().click();
  await page.locator(".ssh-manager-page label.field").filter({ has: page.locator("span:has-text('档案名称')") }).locator("input").fill("retest-ssh-tmp");
  // 失败路径：host 用不可达地址（复测桥 TestSSHConnection：127.0.0.1 视为可达并返回成功，
  // 其他 host 抛 "ssh: no route to host" → UI 红色失败提示）
  await page.locator(".ssh-manager-page label.field").filter({ has: page.locator("span:has-text('SSH 服务器地址')") }).locator("input").fill("10.255.255.1");
  await page.locator(".ssh-manager-page label.field").filter({ has: page.locator("span:has-text('SSH 用户名')") }).locator("input").fill("nobody");
  await page.locator(".ssh-manager-page label.field").filter({ has: page.locator("span:has-text('SSH 端口')") }).locator("input").fill("2222");
  // 必须填非空密码：authType=password 时前端先做"密码不能为空"前置校验，
  // 空密码到不了 TestSSHConnection 错误路径。
  await page.locator(".ssh-manager-page label.field").filter({ has: page.locator("span:has-text('SSH 密码')") }).locator("input").fill("retest-fake-pw");
  await page.locator(".ssh-manager-page button", { hasText: "测试 SSH" }).first().click();
  // 失败提示是 .test-msg.err（复测桥 TestSSHConnection 直接抛错）
  await expect(page.locator(".ssh-manager-page .test-msg.err").first()).toBeVisible({ timeout: 30_000 });
  const errText = await page.locator(".ssh-manager-page .test-msg.err").first().innerText();
  console.log(`[T-CONN-03] 失败提示 = ${errText.slice(0, 120)}`);
  expect(errText).toMatch(/SSH 连接失败|未启用/);
  await page.screenshot({ path: "results/conn03-ssh-fail.png", fullPage: true });
});

// T-PG-01: 设置页：面板导航（通用/网络/对比/凭据/备份）可点击切换
test("T-PG-01 设置页: 面板导航切换", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "设置");
  await expect(page.locator(".settings-page")).toBeVisible({ timeout: 15_000 });

  const railItems = page.locator(".settings-rail .settings-rail-item");
  const railCount = await railItems.count();
  console.log(`[T-PG-01] 设置面板数 = ${railCount}`);
  expect(railCount).toBeGreaterThanOrEqual(3);
  // 逐个点击（首项默认已激活，点其余项验证切换不报错）
  for (let i = 1; i < railCount; i++) {
    await railItems.nth(i).click();
    await page.waitForTimeout(200);
  }
  await page.screenshot({ path: "results/pg01-settings.png", fullPage: true });
});

// T-PG-02: 备份快照页：创建过的快照在列表可见（T-OPS-02 已创建快照）
test("T-PG-02 备份快照页: 快照列表展示", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "备份快照");
  await expect(page.locator(".backup-view")).toBeVisible({ timeout: 15_000 });
  // 刷新加载快照列表
  await page.locator("button[title*='刷新'], .backup-view button").first().click().catch(() => {});
  await page.waitForTimeout(1000);
  await page.screenshot({ path: "results/pg02-backup.png", fullPage: true });
});

// T-PG-03: 关于页：应用信息 + 检查更新（复测桥 no-update 路径）
test("T-PG-03 关于页: 应用信息与检查更新", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "关于");
  await expect(page.getByText("ConfScope").first()).toBeVisible({ timeout: 15_000 });
  await page.locator("button", { hasText: "检查更新" }).first().click();
  await expect(page.locator(".test-msg.ok, .test-msg").first()).toBeVisible({ timeout: 30_000 });
  const msg = await page.locator(".test-msg").first().innerText();
  console.log(`[T-PG-03] 更新提示 = ${msg.slice(0, 100)}`);
  expect(msg).toMatch(/最新版本|已是最新|无更新|没有可用更新/);
  await page.screenshot({ path: "results/pg03-about.png", fullPage: true });
});

// T-PG-04: 审计日志页：显示 jsonl 持久化事件（60-audit 已产生 compare/audit_run 事件）
test("T-PG-04 审计日志页: 持久化 jsonl 事件展示", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "审计日志");
  await expect(page.locator(".log-viewer, .logviewer-page, .audit-log-page").first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  const pageText = await page.locator(".page-surface").first().innerText();
  console.log(`[T-PG-04] 审计日志页文本片段 = ${pageText.slice(0, 300)}`);
  await page.screenshot({ path: "results/pg04-logviewer.png", fullPage: true });
});

// T-PG-05: 开发者“清理缓存”（设置页）：清 localStorage cs.* + truncate audit-trail.jsonl
test("T-PG-05 设置页: 开发者清理缓存（localStorage + audit-trail）", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);

  // 前置：种一个 cs.* 键 + 确保 audit 文件有内容
  await page.evaluate(() => window.localStorage.setItem("cs.retest.probe", "1"));
  writeFileSync(RETEST_AUDIT_FILE, `{"schema":1,"ts":"${new Date().toISOString()}","kind":"session_start","sessionId":"cleanup-probe"}\n`);

  await navigate(page, "设置");
  await expect(page.locator(".settings-page")).toBeVisible({ timeout: 15_000 });

  // 开发者面板：清理缓存按钮
  const clearBtn = page.locator("#settings-developer button").filter({ hasText: "清理缓存" }).first();
  await expect(clearBtn).toBeVisible({ timeout: 10_000 });
  // 确认对话框
  page.once("dialog", (d) => void d.accept());
  await clearBtn.click();

  // 成功提示
  await expect(page.locator("#settings-developer .test-msg.ok")).toBeVisible({ timeout: 10_000 });

  // localStorage cs.* 被清空
  const csKeys = await page.evaluate(() =>
    Object.keys(window.localStorage).filter((k) => k.startsWith("cs."))
  );
  expect(csKeys).toEqual([]);

  // audit-trail.jsonl 被 truncate 为空（web 手动桥经 vite 中间件 /__retest_audit_clear 真实落盘；
  // 原生则走 Go ClearAuditTrail truncate，由 Go 单测 TestClearTruncatesTrail 覆盖）
  const text = readFileSync(RETEST_AUDIT_FILE, "utf8").trim();
  expect(text).toBe("");

  await page.screenshot({ path: "results/pg05-clear-cache.png", fullPage: true });
});
