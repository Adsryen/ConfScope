import { expect, type Locator, type Page } from "@playwright/test";

// 模块级计数：每次 installRetestBridge 前递增（spec import 本模块一次 = 每测试一次）。
// 解决 vite 5 对 tests/** 下模块图的变换缓存问题（同文件 mtime 变化不触发重变换，
// 浏览器端拿到旧版 bridge 代码 → 新增 case 分支不生效）。
let retestBust = 0;

/** 侧边栏导航（真人点击路径）。 */
export async function navigate(page: Page, label: string): Promise<void> {
  await page.locator(".side-nav-item", { hasText: label }).first().click();
}

/** 在 installRetestBridge 之前调用：强制浏览器对 retest bridge 模块用新 URL 重新取变换。 */
export async function bumpRetestBridgeBust(page: Page): Promise<void> {
  retestBust += 1;
  await page.addInitScript(() => {
    const origFetch = window.fetch;
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      let url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/tests/retest/bridge/retestBinding.ts") && !url.includes("retestBust=")) {
        url += (url.includes("?") ? "&" : "?") + "retestBust=" + window.__retestBust;
      }
      return origFetch(url as RequestInfo, init);
    };
  });
  await page.evaluate((bust) => {
    (window as unknown as Record<string, number>).__retestBust = bust;
  }, retestBust);
}

/** 关闭可能出现的启动欢迎/更新弹窗（防御性；正常播种下不应出现）。 */
export async function dismissStartupDialog(page: Page): Promise<void> {
  const dialog = page.locator(".startup-overlay");
  if ((await dialog.count()) > 0) {
    await dialog.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
    if ((await dialog.count()) > 0) {
      const btn = dialog.locator("button").first();
      if ((await btn.count()) > 0) {
        await btn.click({ timeout: 5_000 }).catch(() => undefined);
      }
      await expect(dialog).toBeHidden({ timeout: 3_000 }).catch(() => undefined);
    }
  }
}

/** 在 .source-picker 面板内按字段名定位自绘 Select（.sel）并选择选项。 */
export async function selectSel(page: Page, panel: Locator, fieldLabel: string, optionText: string): Promise<void> {
  // 字段 label 位于 label.field > span（直接子级），避免 "来源（左）" 误匹配 "来源"。
  // locale 无关锚点：来源=Source，命名空间=Namespace。
  const labelCandidates =
    fieldLabel === "来源" ? ["来源", "Source"] : fieldLabel === "命名空间" ? ["命名空间", "Namespace"] : [fieldLabel];
  // Playwright 的 filter({has: child}) 子选择器相对【页面】解析，
  // 必须直接构造 "label.field > span:has-text(...)" 这种带 :scope 语义的 CSS 链
  // （hasText 为子串匹配；字段名是 span 全部文本时即精确匹配）。
  let fields: Locator | undefined;
  for (const candidate of labelCandidates) {
    const f = panel.locator(`label.field:has(> span:has-text("${candidate}"))`);
    if (await f.count() > 0) {
      fields = f;
      break;
    }
  }
  if (!fields) throw new Error(`selectSel: field "${fieldLabel}" not found in panel`);
  // 关键：面板处于折叠状态时，.diff-sources 为 max-height:0/pointer-events:none，
  // 且摘要条 + 加载栏会覆盖字段行占用区，真实指针点击会命中覆盖层而不是下拉触发器。
  // 真人路径先点「展开来源」→ 所以这里先确保面板展开并等过渡稳定再点触发器。
  await ensureSourcesPanelExpanded(page);
  // 面板内可能同时渲染展开/折叠两套 DOM，取可见的第一个。
  const visibleFields = fields.filter({ visible: true });
  if (await visibleFields.count() > 0) fields = visibleFields;
  await expect(fields).not.toHaveCount(0, { timeout: 15_000 });
  const sel = fields.first().locator(".sel").first();
  const trigger = sel.locator(".sel-trigger");
  await trigger.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
  // 真人指针点击；面板过渡/覆盖层拦截时用 force（测试里元素已知可见，不需验证命中区），
  // 仍失败时 DOM click 兑底（React onPointerDown 不响纯 mouse 序列，但 onClick 兑底会触发）。
  await trigger.click({ force: true, timeout: 10_000 }).catch(() => undefined);
  const menu = page.locator(".sel-menu-portal");
  if ((await menu.count()) === 0) {
    await trigger.evaluate((el) => (el as HTMLElement).click());
  }
  await expect(menu).toBeVisible({ timeout: 10_000 });
  const option = menu.locator(".sel-option", { hasText: optionText }).last();
  const optionCount = await menu.locator(".sel-option", { hasText: optionText }).count();
  if (optionCount === 0) {
    const all = await menu.locator(".sel-option").allInnerTexts();
    throw new Error(`selectSel: 菜单中无选项 "${optionText}"（全部选项=${JSON.stringify(all)}）`);
  }
  await expect(option).toBeVisible({ timeout: 10_000 });
  await option.click({ force: true, timeout: 10_000 }).catch(async (e) => {
    // 兜底：菜单被覆盖层拦截时直接原生 click
    await option.evaluate((el) => (el as HTMLElement).click());
    void e;
  });
}

/** 确保对比页来源面板处于展开状态（折叠时点「展开来源」），并等 CSS 过渡（约 200ms）稳定。 */
export async function ensureSourcesPanelExpanded(page: Page): Promise<void> {
  const panel = page.locator(".diff-source-panel");
  if ((await panel.count()) === 0) return;
  const collapsed = await panel.first().evaluate((el) => el.classList.contains("collapsed"));
  if (collapsed) {
    await page.locator(".diff-source-toggle-edge").first().click({ force: true, timeout: 10_000 }).catch(() => undefined);
  }
  // 等扩展过渡（max-height 200ms + 内部 padding 200ms）稳定
  await page.waitForTimeout(450);
}

/** 在 .source-picker 面板内按字段名定位 Combobox（.combo）并填入文本（可选再从候选里点选）。 */
export async function fillCombo(page: Page, panel: Locator, fieldLabel: string, value: string): Promise<void> {
  // 只按字段名精确匹配（直接子 span），避免 "dataId" 命中 "命名空间" 等包含关系
  const field = panel.locator(`label.field:has(> span:has-text("${fieldLabel}"))`).first();
  await expect(field).toBeVisible({ timeout: 15_000 });
  const input = field.locator("input").first();
  await input.fill(value);
  if (value) await input.press("Enter");
  await page.keyboard.press("Escape");
}

/** 配置对比页为指定侧（left/right）选择连接/命名空间/group/dataId。
 *  面板标题：左侧「来源（左）」，右侧「目标（右）」（zh-CN: diff.sourceA/sourceB）。 */
export interface DiffSourceOptions {
  connection: string;
  namespace?: string;
  group?: string;
  dataId?: string;
}

export async function setDiffSource(
  page: Page,
  side: "left" | "right",
  opts: DiffSourceOptions
): Promise<void> {
  const title = side === "left" ? "来源（左）" : "目标（右）";
  const panels = page.locator(".source-picker");
  const panel = await panels
    .filter({ has: page.locator(`.source-title:has-text("${title}")`) })
    .first();
  await expect(panel).toBeVisible({ timeout: 15_000 });
  // 面板折叠时 diff-sources 不可交互，且过渡期间摘要条会覆盖字段行；
  // 首次操作前先确保展开并等过渡稳定，避免卡死（此前 8 分钟级重试的根因）。
  await ensureSourcesPanelExpanded(page);
  if (opts.connection) await selectSel(page, panel, "来源", opts.connection);
  // 命名空间：播种数据里 ns 下拉显示 "retest-dev（15）"（带计数后缀），
  // 用 hasText 子串匹配而非精确文本。
  if (opts.namespace) await selectSel(page, panel, "命名空间", opts.namespace);
  // group 先选（过滤 dataId 候选），再填 dataId。
  // 字段名用英文锚点：group 的 span 就是 "group"；dataId 的 span 是 "dataId (N)"
  // （含 data 计数，用 hasText 前缀匹配）。中文 locale 下"命名空间"为 t("app.namespace")，
  // 英文 locale 下为 "Namespace"，两者都含"命名"无法统一 → 用结构定位。
  if (opts.group !== undefined) await fillDiffGroup(page, panel, opts.group);
  if (opts.dataId !== undefined) await fillDiffDataId(page, panel, opts.dataId);
}

/** 对比页指定侧的 group 字段（span 文本恰为 "group"）。 */
function diffGroupField(panel: Locator): Locator {
  // span 文本悉为 "group"（locale 硬编码）。
  return panel.locator(`label.field:has(> span:has-text("分组"))`).first();
}

function page_span(panel: Locator, text: string): Locator {
  // label.field 的直接子 span 才是字段名；panel.locator("> span") 会误中 .source-title 等
  // 其他直接子 span（hasText 全标签子串匹配导致字段数 0 或错配）。
  // 注：filter({has: 这个 locator}) 无效（子选择器相寳页面解析），
  // 需用 :has(> span:has-text(...)) 内联写法。
  return panel.locator(`label.field:has(> span:has-text("${text}"))`);
}

/** 填对比页指定侧的 group（先清空，再输入，等待候选出现后回车确认）。 */
async function fillDiffGroup(page: Page, panel: Locator, value: string): Promise<void> {
  const field = diffGroupField(panel);
  const input = field.locator("input").first();
  await expect(input).toBeVisible({ timeout: 15_000 });
  await input.waitFor({ state: "visible" });
  await input.fill(value);
  if (value) {
    // 等命名空间配置列表拉取完成、Combobox 候选出现后再回车，
    // 否则 Enter 时 filtered 为空，输入值会被组件清空。
    await page.waitForTimeout(1500);
    const menu = page.locator(".combo-menu-portal");
    if ((await menu.count()) === 0) {
      throw new Error(`fillDiffGroup: group candidates not loaded for value "${value}"`);
    }
    await input.press("Enter");
  }
  await page.keyboard.press("Escape");
}

/** 填对比页指定侧的 dataId（span 为 "dataId (N)"，按前缀 "dataId" 定位）。 */
async function fillDiffDataId(page: Page, panel: Locator, value: string): Promise<void> {
  const target = diffDataIdField(panel);
  const input = target.locator("input").first();
  await expect(input).toBeVisible({ timeout: 15_000 });
  await input.fill(value);
  if (value) await input.press("Enter");
  await page.keyboard.press("Escape");
}

/** 对比页指定侧的 dataId 字段（span 文本以 "dataId" 开头，含 "(N)" 计数）。 */
function diffDataIdField(panel: Locator): Locator {
  // span 文本形如 "dataId (12)"；hasText "dataId" 只命中 dataId 字段
  return panel.locator(`label.field:has(> span:has-text("dataId"))`).first();
}

/** 对比页指定侧的来源面板（.source-picker，标题 来源（左）/目标（右），zh-CN locale）。
 *  供 readDiffGroupOptions / fillDiffGroup / fillDiffDataId 等按侧定位字段使用。 */
function diffPanel(page: Page, side: "left" | "right"): Locator {
  const title = side === "left" ? "来源（左）" : "目标（右）";
  return page
    .locator(".source-picker")
    .filter({ has: page.locator(`.source-title:has-text("${title}")`) })
    .first();
}

/** 读取对比页指定侧的 group 下拉候选文本。 */
export async function readDiffGroupOptions(page: Page, side: "left" | "right"): Promise<string[]> {
  const panel = diffPanel(page, side);
  await ensureSourcesPanelExpanded(page);
  const field = diffGroupField(panel);
  const input = field.locator("input").first();
  await expect(input).toBeVisible({ timeout: 15_000 });
  // 收起/展开过渡期间摘要条会拦截真实指针点击；用 DOM focus+dispatchEvent 打开
  // combobox（触发 onFocus → setOpen(true)），状态效果与人工点击一致。
  await input.evaluate((el) => {
    (el as HTMLInputElement).focus();
    (el as HTMLInputElement).dispatchEvent(new Event("input", { bubbles: true }));
  });
  // 等候选加载（listConfigs 完成后 combobox 才渲染候选），最多 15s
  await page.locator(".combo-menu-portal").waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(300);
  const menu = page.locator(".combo-menu");
  if (await menu.count() > 0) {
    const texts = await menu.locator(".combo-option, [role='option'], li, button").allInnerTexts();
    await page.keyboard.press("Escape").catch(() => undefined);
    return texts.map((t) => t.trim()).filter(Boolean);
  }
  // 兜底：自绘菜单 portal
  const portal = page.locator(".sel-menu-portal");
  if (await portal.count() === 0) return [];
  const texts = await portal.locator(".sel-option").allInnerTexts();
  await page.keyboard.press("Escape").catch(() => undefined);
  return texts;
}

/** 读取 CodeView 渲染出的完整代码文本（含语法高亮 span 的文本）。 */
export async function readCodeViewText(page: Page): Promise<string> {
  return page.locator(".code-area").first().innerText();
}

/** 读取 CodeEditor 的 textarea 实际值。 */
export async function readCodeEditorValue(page: Page): Promise<string> {
  return page.locator(".code-editor-ta").first().inputValue();
}

/** 读取页面所有 toast（reportError 弹层）文本。 */
export async function toastTexts(page: Page): Promise<string[]> {
  return page.locator(".toast, .toaster .toast, [class*='toast']").allInnerTexts();
}
