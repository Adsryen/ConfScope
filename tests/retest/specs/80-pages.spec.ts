import { test, expect } from "./retestTest";
import { readFileSync, writeFileSync } from "node:fs";
import { installRetestBridge, RETEST_AUDIT_FILE } from "../bridge/installRetestBridge";
import { RETEST_DATA_ROOT_BASE, setRetestSelectDataRootTarget } from "../bridge/retestBinding";
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

  // 刷新加载快照列表。选择器必须限定在 .backup-view 内：`button[title*='刷新']` 是全站匹配，
  // 而配置浏览页是保活的（App.tsx .browse-cache 切走只 display:none），它的「刷新列表」按钮
  // title 同样含「刷新」且在 DOM 里更靠前——first() 命中的是那个看不见按钮，
  // Playwright 没有配 actionTimeout，会一路等到 test 超时（480s）才红。轮43 实测就是这形态。
  const refresh = page.locator(".backup-view .page-actions button").filter({ visible: true }).first();
  await expect(refresh).toBeVisible({ timeout: 10_000 });
  await refresh.click({ timeout: 10_000 });

  // 刷新后必须给出可判定的呈现：有快照就列出来，没有就走空态，两者都不出现 = 卡住/白屏。
  const snapshotItems = page.locator(".backup-view .backup-item");
  await expect
    .poll(async () => (await snapshotItems.count()) + (await page.locator(".backup-view .data-empty-state").count()), {
      timeout: 15_000,
      message: "刷新后既没有快照条目也没有空态提示",
    })
    .toBeGreaterThan(0);
  console.log(`[T-PG-02] 快照条目数 = ${await snapshotItems.count()}`);
  await page.screenshot({ path: "results/pg02-backup.png", fullPage: true });
});

// T-PG-03: 关于页：应用信息 + 检查更新（复测桥 no-update 路径）
test("T-PG-03 关于页: 应用信息与检查更新", async ({ page, retest }) => {
  await installRetestBridge(page, retest);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "关于");
  // 轮44 起浏览页/对比页常驻挂载（切走只 hidden、不卸载），整份 DOM 里会同时存在别的视图的正文：
  // 播种配置正文里那句「# 注意: 本文件由 ConfScope 管理」就在隐藏子树里，全页 getByText("ConfScope").first()
  // 按文档顺序先命中它 ⇒ 判 hidden 直接红（真机实测 16.3s 超时，基线 1.4s 绿）。
  // 断言一律限定在当前这页的 .page-surface 根里——保活之后这才是「这一页」的定义。
  const about = page.locator(".page-surface.about-page");
  await expect(about.getByText("ConfScope").first()).toBeVisible({ timeout: 15_000 });
  await about.locator("button", { hasText: "检查更新" }).first().click();
  await expect(about.locator(".test-msg.ok, .test-msg").first()).toBeVisible({ timeout: 30_000 });
  const msg = await about.locator(".test-msg").first().innerText();
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
  // 二次确认走应用内 ConfirmModal，不是原生 confirm()（WebView2 里原生框跟随系统浅色、
  // 还同步阻塞主线程）。断言锁结构不锁文案：role=dialog + 危险按钮，文案改了也不会红。
  await clearBtn.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.locator(".modal-footer .btn-danger-fill").click({ timeout: 10_000 });

  // 成功提示
  await expect(page.locator("#settings-developer .test-msg.ok")).toBeVisible({ timeout: 10_000 });

  // 清的是本机缓存：种下去的探针键必须消失。
  // 不再断言「cs.* 全空」——AGENTS.md 第 6 条 + src/lib/cacheCleanup.ts 的既定合同是
  // 「清理后从主数据文件重新水合」，装了 Go 绑定时 cs.connections 等键会立刻回来，
  // 那才是正确行为（用户数据不能因为清缓存而丢）。
  const csKeys = await page.evaluate(() =>
    Object.keys(window.localStorage).filter((k) => k.startsWith("cs."))
  );
  console.log(`[T-PG-05] 清理后残留 cs.* = ${JSON.stringify(csKeys)}`);
  expect(csKeys).not.toContain("cs.retest.probe");

  // audit-trail.jsonl 里的历史被 truncate 掉（web 手动桥经 vite 中间件 /__retest_audit_clear 真实落盘；
  // 原生则走 Go ClearAuditTrail truncate，由 Go 单测 TestClearTruncatesTrail 覆盖）。
  // 判据钉「种下去的探针行必须消失」，不是「文件为空」：审计文件是追加式的，
  // 清理后应用照常记录新事件才是正确行为。真机全量实测到竞争窗口（workers:1 也躲不开）：
  // 本页挂载时 autoCompareOnRestore 比了一轮（轮46 的一次性意图 + 种子带的 prefs），
  // 它的 compare_result / session_end 两条 POST 恰好在 truncate 之后才落到中间件——
  // truncate 本身是好的（探针行没了），是旧断言把「清理后没人再写盘」当成了合同。
  // 变异自检：truncate 中间件失效 ⇒ 探针行残留 ⇒ 判红。
  const text = readFileSync(RETEST_AUDIT_FILE, "utf8");
  console.log(`[T-PG-05] 清理后审计文件残留 ${text.split("\n").filter((l) => l.trim()).length} 行（晚到的本页会话事件允许存在）`);
  expect(text).not.toContain("cleanup-probe");

  await page.screenshot({ path: "results/pg05-clear-cache.png", fullPage: true });
});

// T-PG-06: 设置页·数据位置：运行形态可见 + 换根迁移/回退（桥内替身，轮62）
// 为什么要真机跑：Go 侧的解析档位、复制校验、指针写入都有单测，但「设置页有没有把
// 档位讲清楚、迁移确认后要不要重启、回退入口什么时候出现」只有浏览器里才对得上。
// 桥里的数据根是内存替身（不碰任何真实目录），文件复制由 internal/portabledata 的单测负责。
test("T-PG-06 设置页: 数据位置换根迁移与回退", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  setRetestSelectDataRootTarget(`${RETEST_DATA_ROOT_BASE}-moved`);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "设置");
  await expect(page.locator(".settings-page")).toBeVisible({ timeout: 15_000 });

  const panel = page.locator("#settings-data-locations");
  await panel.scrollIntoViewIfNeeded();
  // ① 运行形态与命中档位必须写在界面上（出问题时第一件要看的就是它）
  await expect(panel.locator(".settings-data-root-row")).toBeVisible({ timeout: 10_000 });
  await expect(panel.getByText("便携版（数据随程序目录走）")).toBeVisible();
  await expect(panel.getByText("环境变量 CONFSCOPE_DATA_DIR")).toBeVisible();
  await expect(panel.getByRole("button", { name: "更改位置…" })).toBeVisible();
  // 还没有旧位置：不提供回退入口
  await expect(panel.getByRole("button", { name: "回退到旧位置" })).toHaveCount(0);

  // ② 更改位置 → 确认框必须摆出「从哪到哪 / 复制多少 / 旧位置不删 / 要重启」
  await panel.getByRole("button", { name: "更改位置…" }).click();
  const dialog = page.locator(".modal");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByText(`从 ${RETEST_DATA_ROOT_BASE} 复制到 ${RETEST_DATA_ROOT_BASE}-moved`)).toBeVisible();
  await expect(dialog.getByText(/待复制 5 个文件/)).toBeVisible();
  await expect(dialog.getByText(/旧位置的数据不删除/)).toBeVisible();
  await expect(dialog.getByText(/需要重启一次应用/)).toBeVisible();
  await expect(panel.locator(".test-msg.warn")).toHaveCount(0);
  await dialog.locator(".modal-footer .btn-primary").click({ timeout: 10_000 });

  // ③ 迁移写完指针：出现待重启横幅（不是成功绿），列表与档位跟着变
  await expect(panel.locator(".test-msg.warn")).toBeVisible({ timeout: 10_000 });
  await expect(panel.locator(".test-msg.warn")).toContainText("重启");
  await expect(panel.locator(".settings-setting-row").filter({ hasText: "数据根目录" })).toContainText(`${RETEST_DATA_ROOT_BASE}-moved`);
  await expect(panel.getByText("应用内选定的数据位置")).toBeVisible();
  await expect(panel.getByText(new RegExp(`MIGRATED:${RETEST_DATA_ROOT_BASE}`))).toBeVisible();
  // 有了旧位置，回退入口才出现
  await expect(panel.getByRole("button", { name: "回退到旧位置" })).toBeVisible();

  // ④ 回退：只改指针，确认框要把两侧主数据文件摆出来供人比对
  await panel.getByRole("button", { name: "回退到旧位置" }).click();
  await expect(dialog.getByText(/只把数据位置指回上一次的位置/)).toBeVisible();
  await expect(dialog.getByText(/当前位置主数据文件/)).toBeVisible();
  await expect(dialog.getByText(/旧位置主数据文件/)).toBeVisible();
  await dialog.locator(".modal-footer .btn-primary").click({ timeout: 10_000 });
  await expect(panel.locator(".settings-setting-row").filter({ hasText: "数据根目录" })).toContainText(RETEST_DATA_ROOT_BASE, { timeout: 10_000 });
  await expect(panel.getByRole("button", { name: "回退到旧位置" })).toHaveCount(0);

  // ⑤ 目标非法（选了当前根）：Go 侧判据拒绝，原地报错且不弹确认框、更不写指针
  setRetestSelectDataRootTarget(RETEST_DATA_ROOT_BASE);
  await panel.getByRole("button", { name: "更改位置…" }).click();
  await expect(panel.locator(".inline-error")).toBeVisible({ timeout: 10_000 });
  await expect(panel.locator(".inline-error")).toContainText("目标目录与当前数据根相同");
  await expect(page.locator(".modal")).toHaveCount(0);

  await page.screenshot({ path: "results/pg06-data-root.png", fullPage: true });
});
