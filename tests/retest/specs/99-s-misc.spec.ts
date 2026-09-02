// S 组补充场景（批次 9 差集分析）：边缘交互 + 设置/备份辅助路径。
// S12  侧边栏收起/展开：toggle → 收起 → 导航仍可用 → 展开（sidebarCollapsed）
// S13  对比页来源面板折叠/展开：收起来源 → 摘要条 → 展开来源 → 字段可操作（sourcesCollapsed）
// S16  配置浏览新建配置「直接写入禁用」契约：发布被拦截且 Nacos 未新增（A7 延伸，锁死开关语义）
// S5   设置/SSH 隧道档案 CRUD：新建（必填校验+保存落盘）→ 测试 SSH（成功+失败路径）→ 编辑 → 删除
// S6   备份快照「与云端对比」：快照条目 → 跳转对比页（快照来源 + autoCompare）→ 对比面板出现
// S7   备份快照 WebDAV 同步：填地址 → 测试 → 上传当前快照 → 刷新远端列表 → 导入远端快照包
import { test, expect, fetchNacosContent } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog, ensureSourcesPanelExpanded } from "./ui";
import { loadRetestState } from "../state";

const state = loadRetestState();
const BASE_A = state.nacos.a.baseUrl;
const NS_A = state.nacos.a.namespace;
const GROUP = "RETEST-PROD";

async function bootstrap(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
}

// S12: 侧边栏收起/展开
test("S12 侧边栏收起/展开: toggle→收起→导航可用→展开", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);

  // 初始展开：标签可见
  expect(await page.locator(".sidebar.collapsed").count()).toBe(0);
  await expect(page.locator(".side-nav-item .side-label", { hasText: "配置浏览" }).first()).toBeVisible();

  // 收起
  await page.locator(".sidebar-toggle").click();
  await expect(page.locator(".sidebar.collapsed").first()).toBeVisible({ timeout: 5_000 });
  // 收起后标签隐藏，但导航按钮仍可点击（title 提示存在）
  await page.locator(".side-nav-item", { has: page.locator("span.side-label", { hasText: "配置对比" }) }).first().click();
  await expect(page.locator(".diff-view, .diff-source-panel, .diff-panel").first()).toBeVisible({ timeout: 30_000 });

  // 展开
  await page.locator(".sidebar-toggle").click();
  await expect(page.locator(".sidebar.collapsed")).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator(".side-nav-item .side-label", { hasText: "配置对比" }).first()).toBeVisible();
  await page.screenshot({ path: "results/s12-sidebar-toggle.png", fullPage: true });
});

// S13: 对比页来源面板折叠/展开
test("S13 对比页来源面板折叠/展开: 收起→摘要条→展开→字段可操作", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);

  await navigate(page, "配置对比");
  const panel = page.locator(".diff-source-panel").first();
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await ensureSourcesPanelExpanded(page);
  // 确保未折叠
  await expect(panel).not.toHaveClass(/collapsed/);

  const toggle = page.locator(".diff-source-toggle-edge").first();
  // 收起
  await toggle.click({ force: true });
  await expect(panel).toHaveClass(/collapsed/, { timeout: 5_000 });

  // 展开：点击 toggle 后轮询确认展开（折叠/展开是同一按钮的 toggle 语义）
  for (let i = 0; i < 3 && (await panel.first().evaluate((el) => el.classList.contains("collapsed"))); i++) {
    await toggle.click({ force: true });
    await page.waitForTimeout(300);
  }
  await expect(panel).not.toHaveClass(/collapsed/, { timeout: 5_000 });

  // 字段可操作：来源（左）的连接下拉可打开（展开态才有 .sel-trigger）
  const panelLeft = page
    .locator(".source-picker")
    .filter({ has: page.locator('.source-title:has-text("来源（左）")') })
    .first();
  const trigger = panelLeft.locator("label.field:has(> span:has-text(\"来源\")) .sel-trigger").first();
  await expect(trigger).toBeVisible({ timeout: 10_000 });
  await trigger.click({ force: true });
  await expect(page.locator(".sel-menu-portal").first()).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  await page.screenshot({ path: "results/s13-sources-collapse.png", fullPage: true });
});

// S16: 配置浏览新建配置 → 发布被「直接写入禁用」拦截且 Nacos 未新增
// （产品契约：浏览页发布必须走变更计划；本用例锁死该开关语义，防止回归成静默放行）
test("S16 新建配置: 发布被直接写入禁用拦截且 Nacos 未新增", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);
  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item-id").first()).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "新建配置" }).click();
  await expect(page.getByRole("heading", { name: "新建配置" })).toBeVisible({ timeout: 10_000 });

  const dataId = "ux99-new-check.properties";
  await page.getByPlaceholder("请输入 Data ID").fill(dataId);
  await page.locator(".modal .code-editor-ta, .modal textarea").first().fill("a=1\n# ux99 new config\n");
  await page.getByRole("button", { name: "发布" }).click();
  await expect(page.getByText("直接配置写入已禁用").first()).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // Nacos 侧未新增（404）
  const res = await fetch(
    `${BASE_A}/v1/cs/configs?dataId=${encodeURIComponent(dataId)}&group=${encodeURIComponent(GROUP)}&tenant=${encodeURIComponent(NS_A)}`
  );
  expect(res.status).not.toBe(200);
  await page.screenshot({ path: "results/s16-new-config-blocked.png", fullPage: true });
});

// S5: SSH 隧道档案 CRUD + 测试 SSH（成功/失败）
test("S5 SSH 档案: 新建(必填校验+落盘)→测试SSH成功/失败→编辑→删除", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);
  await navigate(page, "SSH 隧道");
  await expect(page.locator(".ssh-manager-page").first()).toBeVisible({ timeout: 30_000 });

  const profileName = "retest-ssh-profile";
  // 1) 新建：空表单点保存 → 必填校验
  await page.getByRole("button", { name: "新建 SSH 档案" }).click();
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.locator(".test-msg.err", { hasText: "不能为空" }).first()).toBeVisible({ timeout: 5_000 });

  // 2) 填写完整表单并保存（host 用 state.ssh.host → 测试 SSH 成功路径）
  const nameField = page.locator('label.field:has(> span:has-text("档案名称")) input').first();
  await nameField.fill(profileName);
  await page.locator('label.field:has(> span:has-text("SSH 服务器地址")) input').first().fill(state.ssh?.host ?? "127.0.0.1");
  await page.locator('label.field:has(> span:has-text("SSH 端口")) input').first().fill(String(state.ssh?.port ?? 2222));
  await page.locator('label.field:has(> span:has-text("SSH 用户名")) input').first().fill(state.ssh?.username ?? "root");
  await page.locator('label.field:has(> span:has-text("SSH 密码")) input').first().fill(state.ssh?.password ?? "ret-test");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.locator(".test-msg.ok", { hasText: "SSH 配置档案已保存" }).first()).toBeVisible({ timeout: 10_000 });
  // 落盘断言
  const stored = await page.evaluate(() => window.localStorage.getItem("cs.sshProfiles"));
  expect(stored).toContain(profileName);

  // 档案列表出现
  await expect(page.locator(".ssh-profile-name", { hasText: profileName }).first()).toBeVisible({ timeout: 5_000 });

  // 3) 测试 SSH 成功路径（host = 本地容器 sshd）
  await page.getByRole("button", { name: "测试 SSH" }).click();
  await expect(page.locator(".test-msg.ok", { hasText: "SSH 连接成功" }).first()).toBeVisible({ timeout: 15_000 });

  // 4) 测试 SSH 失败路径（改 host 为不可达地址）
  await page.locator('label.field:has(> span:has-text("SSH 服务器地址")) input').first().fill("10.255.255.1");
  await page.getByRole("button", { name: "测试 SSH" }).click();
  await expect(page.locator(".test-msg.err", { hasText: "SSH 连接失败" }).first()).toBeVisible({ timeout: 15_000 });

  // 5) 编辑：改回 host 并保存，档案仍存在（引用为 0，无需确认影响）
  await page.locator('label.field:has(> span:has-text("SSH 服务器地址")) input').first().fill(state.ssh?.host ?? "127.0.0.1");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.locator(".test-msg.ok", { hasText: "SSH 配置档案已保存" }).first()).toBeVisible({ timeout: 10_000 });

  // 6) 删除：无引用 → 直接删除成功
  await page.locator(".ssh-profile-item", { has: page.locator(".ssh-profile-name", { hasText: profileName }) })
    .locator("button[title='删除']").click();
  await expect(page.locator(".test-msg.ok", { hasText: "SSH 配置档案已删除" }).first()).toBeVisible({ timeout: 10_000 });
  const storedAfter = await page.evaluate(() => window.localStorage.getItem("cs.sshProfiles"));
  expect(storedAfter ?? "[]").not.toContain(profileName);
  await page.screenshot({ path: "results/s5-ssh-profile-crud.png", fullPage: true });
});

// S6: 备份快照 → 与云端对比（跳转对比页：快照来源 + autoCompare）
test("S6 备份快照与云端对比: 创建快照→与云端对比→对比页加载出差异面板", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);

  // 1) 浏览页创建当前列表快照（桥 CreateSnapshot → 内存缓存）
  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item-id").first()).toBeVisible({ timeout: 30_000 });
  const snapBtn = page.getByRole("button", { name: /创建.*快照/ }).first();
  await expect(snapBtn).toBeEnabled({ timeout: 10_000 });
  await snapBtn.click();
  await expect(page.getByText("快照已创建：").first()).toBeVisible({ timeout: 60_000 });

  // 2) 备份快照页：选中刚创建的快照（列表第一项），找到 svc-billing.yaml 条目 → 与云端对比
  await navigate(page, "备份快照");
  await expect(page.locator(".backup-view").first()).toBeVisible({ timeout: 15_000 });
  // 选中第一项快照（最新创建，列表倒序）
  const firstSnap = page.locator(".backup-item").first();
  await expect(firstSnap).toBeVisible({ timeout: 15_000 });
  await firstSnap.click();
  const compareBtn = page
    .locator(".backup-config-item", { has: page.locator(".backup-config-dataid", { hasText: "svc-billing.yaml" }) })
    .getByRole("button", { name: "与云端对比" })
    .first();
  await expect(compareBtn).toBeVisible({ timeout: 15_000 });
  await expect(compareBtn).toBeEnabled({ timeout: 5_000 });
  await compareBtn.click();

  // 3) 跳转到对比页：toast「已带入快照来源」+ 对比面板出现（autoCompare 自动加载两侧）
  await expect(page.locator(".toast", { hasText: "已带入快照来源" }).first()).toBeVisible({ timeout: 10_000 }).catch(() => undefined);
  await expect(page.locator(".diff-panel, .diff-view").first()).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: "results/s6-snapshot-compare.png", fullPage: true });
});

// S7: 备份快照 WebDAV 同步（mock WebDAV）：测试→上传→刷新远端→导入
test("S7 备份快照 WebDAV: 测试→上传当前快照→刷新远端列表→导入远端包", async ({ page, retest }) => {
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);

  // 1) 先创建一个本地快照（上传/导入都依赖 selectedSnapshot）
  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item-id").first()).toBeVisible({ timeout: 30_000 });
  const snapBtn7 = page.getByRole("button", { name: /创建.*快照/ }).first();
  await expect(snapBtn7).toBeEnabled({ timeout: 10_000 });
  await snapBtn7.click();
  await expect(page.getByText("快照已创建：").first()).toBeVisible({ timeout: 60_000 });

  // 2) 备份快照页 → 选中快照 → WebDAV 面板填地址
  await navigate(page, "备份快照");
  await expect(page.locator(".backup-view").first()).toBeVisible({ timeout: 15_000 });
  const firstSnap7 = page.locator(".backup-item").first();
  await expect(firstSnap7).toBeVisible({ timeout: 15_000 });
  await firstSnap7.click();

  const webdavPanel = page.locator(".backup-webdav-panel").first();
  await expect(webdavPanel).toBeVisible({ timeout: 15_000 });
  await webdavPanel.locator('label.field:has(> span:has-text("WebDAV 地址")) input').first().fill("https://webdav.retest.local/dav");
  await webdavPanel.locator('label.field:has(> span:has-text("WebDAV 用户名")) input').first().fill("retest");
  await webdavPanel.locator('label.field:has(> span:has-text("WebDAV 密码")) input').first().fill("retest-pass");
  await webdavPanel.locator('label.field:has(> span:has-text("快照包密码")) input').first().fill("pkg-pass");
  await webdavPanel.getByRole("button", { name: "保存 WebDAV 地址" }).click();
  await expect(page.locator(".toast", { hasText: "WebDAV 地址已保存" }).first()).toBeVisible({ timeout: 10_000 }).catch(() => undefined);

  // 3) 测试 WebDAV（mock：url 非空 → 通过）
  await webdavPanel.getByRole("button", { name: "测试 WebDAV" }).click();
  await expect(page.locator(".backup-webdav-status", { hasText: "WebDAV 连接通过" }).first()).toBeVisible({ timeout: 15_000 });

  // 4) 上传当前快照（mock 返回远端包 → 状态行「快照包已上传」）
  await webdavPanel.getByRole("button", { name: "上传当前快照" }).click();
  await expect(page.locator(".backup-webdav-status", { hasText: "快照包已上传" }).first()).toBeVisible({ timeout: 20_000 });

  // 5) 刷新远端快照（mock 返回 1 个远端包 → 列表渲染 + meta 文案）
  await webdavPanel.getByRole("button", { name: "刷新远端快照" }).click();
  await expect(page.locator(".backup-remote-item").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("个配置").first()).toBeVisible({ timeout: 5_000 });

  // 6) 导入远端快照包（mock 返回本地快照 → 状态行「快照已导入」）
  await page.locator(".backup-remote-item", { hasText: "retest-remote-snap.cssnapshot" })
    .getByRole("button", { name: /导入/ })
    .click();
  await expect(page.locator(".backup-webdav-status", { hasText: "快照已导入" }).first()).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: "results/s7-webdav-sync.png", fullPage: true });
});
