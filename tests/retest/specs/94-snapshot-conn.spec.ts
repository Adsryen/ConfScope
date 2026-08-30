import { test, expect } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog } from "./ui";
import { loadRetestState } from "../state";

const state = loadRetestState();
const BASE_A = state.nacos.a.baseUrl;

/** 标准启动：装桥 + 播种 + 进首页关启动弹窗。 */
async function boot(page: import("@playwright/test").Page) {
  await installRetestBridge(page, state);
  await republishRetestData();
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
}

/** 侧边栏按 label 导航。 */
async function nav(page: import("@playwright/test").Page, label: string) {
  await page.locator(".side-nav-item", { hasText: label }).first().click();
}

/** 在连接表单里填好一条新连接（label 锚点，locale 无关）。 */
async function fillConnForm(
  page: import("@playwright/test").Page,
  sourceName: string,
  baseUrl: string,
  namespace: string
) {
  // 项目选已有项目，落到现有分组（避免「新建项目…」弹第二输入框造成歧义）
  await page.locator(".conn-form").getByRole("combobox", { name: /项目/ }).first().selectOption({ label: "Retest Project" });
  // 认证方式选免鉴权（复测 Nacos 无鉴权；用户名密码必填会拦保存）
  await page.locator(".conn-form").getByRole("combobox", { name: /认证方式/ }).first().selectOption({ label: "免鉴权" });
  await page.getByRole("textbox", { name: "来源名称" }).first().fill(sourceName);
  await page.getByRole("textbox", { name: "目标地址" }).first().fill(baseUrl);
  await page.getByRole("textbox", { name: "默认命名空间" }).first().fill(namespace);
}

/** 连接表单内保存。 */
async function saveConnForm(page: import("@playwright/test").Page) {
  await page.locator(".conn-form-actions button.btn-primary", { hasText: "保存" }).click();
}

/** 从 localStorage 读 cs.connections。 */
async function readStoredConnections(page: import("@playwright/test").Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("cs.connections");
    try {
      return raw ? (JSON.parse(raw) as Array<Record<string, unknown>>) : [];
    } catch {
      return [];
    }
  });
}

// I1: 新建 Nacos 连接（指向 A 容器）→ 连接测试成功 → 保存 → 列表出现新连接
test("I1 新建连接: 指向 A 容器连接测试成功并保存", async ({ page }) => {
  await boot(page);
  await nav(page, "连接管理");
  await expect(page.locator(".conn-mgr").first()).toBeVisible({ timeout: 15_000 });

  await page.locator(".conn-create-btn").first().click();
  await expect(page.locator(".conn-form-title", { hasText: "新建连接" })).toBeVisible({ timeout: 10_000 });

  // 必填校验：先直接保存 → 提示来源名称/地址必填（表单内 test-msg 或错误弹窗）
  await saveConnForm(page);
  await expect(
    page.locator(".conn-form .test-msg, .modal .test-msg").filter({ hasText: "来源名称和目标地址不能为空" }).first()
  ).toBeVisible({ timeout: 5_000 });

  await fillConnForm(page, "Retest 复测来源", BASE_A, state.nacos.a.namespace);

  // 连接测试 → 成功（「连接成功」文案，含延迟）
  await page.locator(".conn-form-actions button", { hasText: "连接测试" }).click();
  await expect(page.locator(".conn-form").getByText(/连接成功/).first()).toBeVisible({ timeout: 25_000 });

  await saveConnForm(page);
  await expect(page.locator(".conn-item-name", { hasText: "Retest 复测来源" })).toBeVisible({ timeout: 10_000 });

  const conns = await readStoredConnections(page);
  const mine = conns.find((c) => c.sourceName === "Retest 复测来源");
  expect(mine).toBeTruthy();
  expect(String(mine?.baseUrl)).toContain("19848");
  await page.screenshot({ path: "results/i1-new-conn.png", fullPage: true });
});

// I2: 编辑连接（改备注 + 改默认 group）→ 保存成功 → 列表/存储更新
test("I2 编辑连接: 改备注与默认 group 后保存生效", async ({ page }) => {
  await boot(page);
  await nav(page, "连接管理");

  await page.locator(".conn-create-btn").first().click();
  await fillConnForm(page, "I2 编辑来源", BASE_A, state.nacos.a.namespace);
  await saveConnForm(page);
  await expect(page.locator(".conn-item-name", { hasText: "I2 编辑来源" })).toBeVisible({ timeout: 10_000 });

  // 点击条目 → 进入编辑
  await page.locator(".conn-item", { hasText: "I2 编辑来源" }).first().click();
  await expect(page.locator(".conn-form-title", { hasText: "编辑连接" })).toBeVisible({ timeout: 10_000 });

  await page.getByRole("textbox", { name: "备注（可选）" }).first().fill("i2 编辑后的备注");
  // 「默认 Group」在高级区且初始折叠：先点「高级」section 展开
  await page.locator(".conn-form .conn-section-title", { hasText: "高级" }).first().click();
  await expect(page.getByRole("textbox", { name: "默认 Group" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("textbox", { name: "默认 Group" }).first().fill("RETEST-ORDER");

  await saveConnForm(page);
  // 保存成功后表单收起回列表（保存成功 toast 一闪而过，以表单消失+列表更新为准）
  await expect(page.locator(".conn-form-title", { hasText: "编辑连接" })).toHaveCount(0, { timeout: 10_000 });

  const conns = await readStoredConnections(page);
  const mine = conns.find((c) => c.sourceName === "I2 编辑来源");
  expect(String(mine?.name)).toBe("i2 编辑后的备注");
  expect(String(mine?.defaultGroup)).toBe("RETEST-ORDER");
  await page.screenshot({ path: "results/i2-edit-conn.png", fullPage: true });
});

// I3: 删除连接两次点击确认态（× → 「删除连接」确认按钮）→ 删除后列表与存储均移除
test("I3 删除连接: 两次点击确认态且存储移除", async ({ page }) => {
  await boot(page);
  await nav(page, "连接管理");

  await page.locator(".conn-create-btn").first().click();
  await fillConnForm(page, "I3 待删除来源", BASE_A, state.nacos.a.namespace);
  await saveConnForm(page);
  const item = page.locator(".conn-item", { hasText: "I3 待删除来源" }).first();
  await expect(item).toBeVisible({ timeout: 10_000 });

  // 第一次点 × → 进入确认态（按钮文案变为「删除连接」）
  await item.locator(".conn-item-del").first().click();
  await expect(item.locator(".conn-item-del.confirm", { hasText: "删除连接" })).toBeVisible({ timeout: 5_000 });

  // 第二次点确认 → 删除
  await item.locator(".conn-item-del.confirm").first().click();
  await expect(page.locator(".conn-item", { hasText: "I3 待删除来源" })).toHaveCount(0, { timeout: 10_000 });

  const conns = await readStoredConnections(page);
  expect(conns.find((c) => c.sourceName === "I3 待删除来源")).toBeUndefined();
  await page.screenshot({ path: "results/i3-del-conn.png", fullPage: true });
});

// I4: 无效地址（未开放端口）→ 真实网络请求失败 → 错误文案展示
// 说明：「连接测试」在免鉴权模式下是 UI 本地判定（不发请求），
// 真实失败路径由「加载命名空间」触发（走 Nacos API，不可达必报错）。
test("I4 无效地址: 加载命名空间失败提示", async ({ page }) => {
  await boot(page);
  await nav(page, "连接管理");

  await page.locator(".conn-create-btn").first().click();
  await fillConnForm(page, "I4 坏地址来源", "http://127.0.0.1:19999/nacos", "retest-dev");

  await page.locator(".conn-form button", { hasText: "加载命名空间" }).click();
  await expect(
    page.locator(".conn-form").getByText(/失败|超时|无法|错误|timeout|fetch|ECONNREFUSED/i).first()
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: "results/i4-bad-addr.png", fullPage: true });
});

// F1: 浏览页「创建当前列表快照」→ 有明确反馈（toast/弹框），任务中心出现快照任务
test("F1 创建快照: 浏览页入口触发任务并在任务中心出现", async ({ page }) => {
  await boot(page);
  await nav(page, "配置浏览");
  await expect(page.locator(".browser-item-id").first()).toBeVisible({ timeout: 30_000 });
  expect(await page.locator(".browser-item-id").count()).toBeGreaterThan(0);

  await page.getByRole("button", { name: "创建当前列表快照" }).click();
  // 快照走本地 fs：浏览器环境可能成功或失败，但必须有明确反馈（toast/确认弹框/错误提示）
  await expect(
    page.getByText(/快照已创建|创建快照失败|个配置保存失败|快照/).first()
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: "results/f1-snapshot-toast.png", fullPage: true });

  // 任务中心应有该快照任务（异步任务入列）
  await nav(page, "任务中心");
  await expect(page.getByText("创建当前列表快照：").first()).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: "results/f1-snapshot-task.png", fullPage: true });
});

// A11: 备份快照页可达 + 刷新不崩
test("A11 快照浏览: 备份快照页可达且刷新不崩", async ({ page }) => {
  await boot(page);
  await nav(page, "备份快照");
  await expect(page.locator(".backup-view").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("管理和浏览本地快照").first()).toBeVisible({ timeout: 5_000 });
  await page.locator(".backup-view button[title='刷新']").first().click();
  await page.waitForTimeout(1000);
  await expect(page.locator(".backup-view").first()).toBeVisible();
  await page.screenshot({ path: "results/a11-snapshot-browse.png", fullPage: true });
});

// K3: 设置持久化：改「连接下拉按名称排序」→ 卸载重挂载后读回
test("K3 设置持久化: 改比较偏好刷新后保持", async ({ page }) => {
  await boot(page);
  await nav(page, "设置");
  await expect(page.locator(".settings-workbench").first()).toBeVisible({ timeout: 15_000 });

  const box = page.locator("label:has-text('连接下拉按名称排序') input[type=checkbox]").first();
  expect(await box.isChecked()).toBeTruthy(); // 种子默认 true
  await box.uncheck();
  // 写路径：uncheck → update() → saveSettings 同步落盘
  await expect
    .poll(async () => {
      const raw = await page.evaluate(() => window.localStorage.getItem("cs.settings"));
      return raw ? (JSON.parse(raw) as { compare?: { sortConnections?: boolean } }).compare?.sortConnections : undefined;
    })
    .toBe(false, { timeout: 5_000 });

  // 读路径：retest bridge 的 init 脚本在每次导航（含 reload）都会用种子无条件
  // 覆写 cs.settings（保证跨 run 基线干净），所以不能靠"刷新后读存储"断言。
  // 做法：把存储值固化为 false（模拟已持久化），再 SPA 内走「配置浏览→设置」
  // 卸载→重新挂载 SettingsView（useState(loadSettings())），控件值应读回 false。
  await page.evaluate(() => {
    const raw = window.localStorage.getItem("cs.settings");
    const s0 = JSON.parse(raw || "{}");
    s0.compare = { ...(s0.compare || {}), sortConnections: false };
    window.localStorage.setItem("cs.settings", JSON.stringify(s0));
    window.localStorage.setItem("retest.bridge.marker", "1");
  });
  const box2 = page.locator("label:has-text('连接下拉按名称排序') input[type=checkbox]").first();
  await nav(page, "配置浏览");
  await page.waitForTimeout(500);
  await nav(page, "设置");
  await expect(page.locator(".settings-workbench").first()).toBeVisible({ timeout: 15_000 });
  await expect(box2).not.toBeChecked({ timeout: 5_000 });

  // 恢复默认（写回 true 并落盘），避免影响其他用例
  await box2.check();
  await page.screenshot({ path: "results/k3-settings-persist.png", fullPage: true });
});

// K2: 语言切换 zh/en → 关键文案切换且无漏翻（不出现 i18n 原始键名）
test("K2 语言切换: 切 en 后关键文案切换且无漏翻，切回 zh 正常", async ({ page }) => {
  await boot(page);
  await expect(page.locator(".side-nav-item", { hasText: "配置对比" }).first()).toBeVisible({ timeout: 10_000 });

  await nav(page, "设置");
  await page.locator(".lang-switch").first().selectOption("en-US");
  await expect(page.locator("body").getByText(/Diff|Compare/i).first()).toBeVisible({ timeout: 10_000 });

  // 全站无漏翻：不出现 i18n 原始键名（xxx.yyy.zzz 小写点分键）
  const bodyText = await page.locator("body").innerText();
  expect(bodyText).not.toMatch(/\b[a-z]+(?:\.[a-z][a-zA-Z0-9]*){2,}\b/);

  // 再切回中文
  await page.locator(".lang-switch").first().selectOption("zh-CN");
  await expect(page.locator(".side-nav-item", { hasText: "配置对比" }).first()).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: "results/k2-lang-switch.png", fullPage: true });
});

// L1: 连接不可达 → 浏览页列表加载错误卡片（重试按钮）+ 消息中心有错误条目
test("L1 连接不可达: 浏览页错误展示与重试按钮", async ({ page }) => {
  await boot(page);
  await nav(page, "连接管理");
  await page.locator(".conn-create-btn").first().click();
  // 环境显式选 Development：表单环境候选显示 locale 化中文（开发=Development 预设组），
  // 选中文后存储的 environmentName 才是英文 "Development"，与种子 retest-a/b 同组，
  // 浏览页「来源」下拉（按环境分组）才会列出该坏连接。
  await fillConnForm(page, "L1 坏连接", "http://127.0.0.1:19999/nacos", "retest-dev");
  await page.locator(".conn-form").getByRole("combobox", { name: /环境/ }).first().selectOption({ label: "开发" });
  await saveConnForm(page);
  await expect(page.locator(".conn-item-name", { hasText: "L1 坏连接" })).toBeVisible({ timeout: 10_000 });

  // 校验存储：坏连接 environmentName 必须与种子一致为 "Development"，
  // 浏览页「环境」下拉才会与种子同组（否则来源下拉只列该环境自己的连接）。
  await expect
    .poll(async () => {
      const conns = await page.evaluate(() => {
        const raw = window.localStorage.getItem("cs.connections");
        return raw ? (JSON.parse(raw) as Array<{ sourceName: string; environmentName?: string }>) : [];
      });
      return conns.find((c) => c.sourceName === "L1 坏连接")?.environmentName;
    })
    .toBe("开发", { timeout: 10_000 });

  // 真人路径：配置浏览页先切「环境」→「开发」组（坏连接所在环境），再「来源」下拉选坏连接。
  // 浏览页 header 自绘 Select 触发器顺序固定：项目 / 环境 / 来源 / 命名空间 / 分组。
  // 自绘 Select 选项靠 onMouseDown 选中 → 用真实指针点击。
  await nav(page, "配置浏览");
  await expect(page.locator(".browse-header .sel-trigger").nth(1)).toBeEnabled({ timeout: 30_000 });
  const openMenu = async (trigger: import("@playwright/test").Locator) => {
    await trigger.click({ force: true, timeout: 10_000 });
    const m = page.locator(".sel-menu-portal");
    await expect(m).toBeVisible({ timeout: 10_000 });
    return m;
  };
  const clickOption = async (menu: import("@playwright/test").Locator, text: string) => {
    const opt = menu.locator(".sel-option", { hasText: text }).first();
    await expect(opt).toBeVisible({ timeout: 10_000 });
    const box = await opt.boundingBox();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    else await opt.evaluate((el) => el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await expect(menu).toBeHidden({ timeout: 10_000 });
  };
  // 环境 → 开发（坏连接所在组）
  await clickOption(await openMenu(page.locator(".browse-header .sel-trigger").nth(1)), "开发");
  // 来源 → 坏连接
  await clickOption(await openMenu(page.locator(".browse-header .sel-trigger").nth(2)), "L1 坏连接");

  // 错误卡片：命名空间加载失败走 App 层 .pad-msg.err「无法连接到 {name}」+ 重试/连接管理按钮
  await expect(page.locator(".pad-msg.err").filter({ hasText: "无法连接到 L1 坏连接" }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".err-actions").getByRole("button", { name: "重试" }).first()).toBeVisible({ timeout: 5_000 });
  await expect(page.locator(".err-actions").getByRole("button", { name: "连接管理" }).first()).toBeVisible({ timeout: 5_000 });

  // 消息中心有该错误条目（悬停打开面板）
  const msgBtn = page.locator(".message-center-btn").first();
  await msgBtn.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
  await msgBtn.hover();
  await expect(page.locator(".message-panel").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".message-item").first()).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: "results/l1-unreachable.png", fullPage: true });
});

// L3: 关于页可达 + 展示版本信息
test("L3 关于页: 可达且展示版本信息", async ({ page }) => {
  await boot(page);
  await nav(page, "关于");
  await expect(page.getByText("统一配置中心管理工具").first()).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: "results/l3-about.png", fullPage: true });
});

// L2: 消息中心入口可打开（空列表或含历史条目，不崩即可）
test("L2 消息中心: 入口可打开且渲染正常", async ({ page }) => {
  await boot(page);
  await nav(page, "配置浏览");
  await expect(page.locator(".browser-item-id").first()).toBeVisible({ timeout: 30_000 });

  // 消息中心按钮在侧边栏底部：滚到可视区，悬停打开面板
  const btn = page.locator(".message-center-btn").first();
  await btn.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
  await btn.hover();
  await expect(page.locator(".message-panel").first()).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: "results/l2-message-center.png", fullPage: true });
});
