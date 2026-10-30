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
        url += (url.includes("?") ? "&" : "?") + "retestBust=" + (window as unknown as Record<string, number>).__retestBust;
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
  // 候选为空时先等一会儿再判死：连接刚换上的那一瞬，命名空间还在路上（实测过一侧下拉里
  // 只有 "public（默认）"），真人会等列表长出来再点，测试也必须等得起。
  // 注意这条重试只在「本来要抛错」的路径上发生，成功路径一个字节没变。
  let optionCount = await menu.locator(".sel-option", { hasText: optionText }).count();
  let all: string[] = [];
  for (let attempt = 0; optionCount === 0 && attempt < 10; attempt += 1) {
    await page.waitForTimeout(500);
    if ((await menu.count()) === 0) {
      await trigger.click({ force: true, timeout: 5_000 }).catch(() => undefined);
      if ((await menu.count()) === 0) await trigger.evaluate((el) => (el as HTMLElement).click()).catch(() => undefined);
      await expect(menu).toBeVisible({ timeout: 10_000 });
    }
    optionCount = await menu.locator(".sel-option", { hasText: optionText }).count();
  }
  if (optionCount === 0) {
    all = await menu.locator(".sel-option").allInnerTexts();
    throw new Error(`selectSel: 菜单中无选项 "${optionText}"（全部选项=${JSON.stringify(all)}，已等 5s 仍没有）`);
  }
  await expect(option).toBeVisible({ timeout: 10_000 });
  await option.click({ force: true, timeout: 10_000 }).catch(async (e) => {
    // 兜底：菜单被覆盖层拦截时直接原生 click
    await option.evaluate((el) => (el as HTMLElement).click());
    void e;
  });
}

/** 点来源面板的折叠/展开边条。
 *  轮44 R90：这里绝不能用 `force: true`。force 点击跳过命中校验、按元素中心坐标派发鼠标事件，
 *  而边条是 `position:absolute; bottom:-12px` 跨在面板边缘上的 36x24 小块，折叠动画期间面板高度
 *  在变（max-height 200ms），坐标一旦落到边条外面就会被下面的加载条接走——真机实测堆栈
 *  （`loadBoth <- HTMLUnknownElement.callCallback2`）证明点边条点出了「加载并对比」，
 *  一条用例里凭空多出一趟完整对比（两趟 compare_start、左右各多取一次正文），
 *  还把「取数次数」类断言（DK-03、AC3）的判据污染成不可信。
 *  探针实测（1280x720）：折叠态边条中心 (732,140) 的 `elementFromPoint` 就是边条自己，
 *  普通点击（带命中校验）直接成功，所以正常点就好；被过渡/遮罩挡住时退到 DOM click。
 */
export async function clickSourcesToggle(toggle: Locator): Promise<void> {
  await toggle.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
  const err = await toggle.click({ timeout: 5_000 }).then(() => null).catch((e) => String(e));
  if (err) {
    await toggle.evaluate((el) => (el as HTMLElement).click()).catch(() => undefined);
  }
}

/** 确保对比页来源面板处于展开状态（折叠时点「展开来源」），并等 CSS 过渡（约 200ms）稳定。 */
export async function ensureSourcesPanelExpanded(page: Page): Promise<void> {
  const panels = page.locator(".diff-source-panel");
  if ((await panels.count()) === 0) return;
  const panel = panels.first();
  const toggle = page.locator(".diff-source-toggle-edge").first();
  const isCollapsed = () => panel.evaluate((el) => el.classList.contains("collapsed"));
  /**
   * 轮44 R90：「展开」在这里不是一个动作，而是一个收敛过程。
   * 来源面板有两条自动收起的路径（启动自动对比成功、智能匹配成功，见 DiffView 的
   * setSourcesCollapsed），它们都可能在「刚点完展开」之后才落地：retest 种子的 cs.ui 是
   * mode:"diff"，左右来源齐全地住在 cs.diffViewPreferences 里（轮46 R01 起只有一个主人；
   * 「这一次要不要自动比」= 启动就落在对比页 + 这一对齐全，不再存标志位），每次加载都会自动比一轮，慢机上这一轮要 400ms+，
   * 实测把 S13 打成 22s 红（展开→被收起→断言 not.toHaveClass(/collapsed/) 一直不满足）。
   * 所以点开后必须再观察一个窗口，确认它仍然是开的才算数；被自动收起了就再点一次。
   */
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await isCollapsed()) {
      await clickSourcesToggle(toggle);
    }
    // 覆盖折叠/展开过渡（max-height 200ms + 内部 padding 200ms）与后到的自动收起
    await page.waitForTimeout(600);
    if (!(await isCollapsed())) return;
  }
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
  opts: DiffSourceOptions,
  locale: "zh-CN" | "en-US" = "zh-CN"
): Promise<void> {
  const panel = await pickDiffSourcePanel(page, side, locale);
  await expect(panel).toBeVisible({ timeout: 15_000 });
  // 面板折叠时 diff-sources 不可交互，且过渡期间摘要条会覆盖字段行；
  // 首次操作前先确保展开并等过渡稳定，避免卡死（此前 8 分钟级重试的根因）。
  await ensureSourcesPanelExpanded(page);
  if (opts.connection) await selectSel(page, panel, "来源", opts.connection);
  // 命名空间：播种数据里 ns 下拉显示 "retest-dev（15）"（带计数后缀），
  // 用 hasText 子串匹配而非精确文本。
  if (opts.namespace) await selectSel(page, panel, "命名空间", opts.namespace);
  // group 先选（过滤 dataId 候选），再填 dataId。
  // 字段名一律走「候选标签依次探测」：zh「分组」/en「Group」、dataId span 形如 "Data ID (N)"，
  // 两套语言都要能落地，否则英文 locale 下深状态直接跑不到。
  if (opts.group !== undefined) await fillDiffGroup(page, panel, opts.group);
  if (opts.dataId !== undefined) await fillDiffDataId(page, panel, opts.dataId);
}

/** 对比页指定侧的 group 字段（zh「分组」/ en「Group」，即 t("config.groupFilter")）。 */
async function diffGroupField(panel: Locator): Promise<Locator> {
  return fieldByAnyLabel(panel, ["分组", "Group"]);
}

/** 按候选字段名依次定位 label.field（直接子 span 才是字段名），返回第一个真实存在的。
 *  不能写成一串逗号选择器：元素作用域下逗号列表在跨引擎版本上的相对语义不稳，
 *  逐个候选 count() 判定最直白，也便于报错时把试过的字段名带出来。
 *  注：filter({has: child}) 的子选择器相对【页面】解析，所以用 :has(> span:has-text(...)) 内联写法。 */
async function fieldByAnyLabel(panel: Locator, labels: string[]): Promise<Locator> {
  for (const label of labels) {
    const candidate = panel.locator(`label.field:has(> span:has-text("${label}"))`).first();
    if ((await candidate.count()) > 0) return candidate;
  }
  throw new Error(`fieldByAnyLabel: 字段都不存在，试过的字段名=${JSON.stringify(labels)}`);
}

/** 填对比页指定侧的 group（先清空，再输入，等待候选出现后回车确认）。 */
async function fillDiffGroup(page: Page, panel: Locator, value: string): Promise<void> {
  const field = await diffGroupField(panel);
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
  const target = await diffDataIdField(panel);
  const input = target.locator("input").first();
  await expect(input).toBeVisible({ timeout: 15_000 });
  await input.fill(value);
  if (value) await input.press("Enter");
  await page.keyboard.press("Escape");
}

/** 对比页指定侧的 dataId 字段（span 文本以 "dataId" 开头，含 "(N)" 计数）。 */
async function diffDataIdField(panel: Locator): Promise<Locator> {
  // span 文本形如 "dataId (12)"；zh/en 都含 "dataId"，再兜底 "Data ID"
  return fieldByAnyLabel(panel, ["dataId", "Data ID"]);
}

/** 指定侧面板标题（zh-CN: diff.sourceA/sourceB；en-US: Source (Left) / Target (Right)）。
 *  按 locale 取标题；万一应用 locale 与传入不一致，再用另一套语言兜底，
 *  这样 3 参老调用方（zh）行为完全不变，普查这类双 locale 用例也能跑通。 */
const SIDE_TITLES: Record<"left" | "right", Record<"zh-CN" | "en-US", string>> = {
  left: { "zh-CN": "来源（左）", "en-US": "Source (Left)" },
  right: { "zh-CN": "目标（右）", "en-US": "Target (Right)" },
};

async function pickDiffSourcePanel(page: Page, side: "left" | "right", locale: "zh-CN" | "en-US"): Promise<Locator> {
  const order = locale === "zh-CN" ? (["zh-CN", "en-US"] as const) : (["en-US", "zh-CN"] as const);
  for (const lang of order) {
    const candidate = page
      .locator(".source-picker")
      .filter({ has: page.locator(`.source-title:has-text("${SIDE_TITLES[side][lang]}")`) })
      .first();
    if ((await candidate.count()) > 0) return candidate;
  }
  throw new Error(`pickDiffSourcePanel: 找不到 ${side} 侧来源面板（zh/en 标题都没命中）`);
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
  const field = await diffGroupField(panel);
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

/**
 * 把审计条件区展开（轮142 A4 之后，凡「跑完审计还要读环境卡」的用例都必须先走这一步）。
 *
 * A4 的默认行为是「审计跑完自动收起条件区」——条件已无用，让位给矩阵本体，折叠态只剩摘要 chips。
 * 于是旧写法「点执行审计 → 直接 .audit-env-card 里改筛选」会点到一个根本不存在的节点。
 * 判状态一律读 aria-expanded，不靠按钮文案（zh/en 两套 label 会变）；展开后必须真的等到环境卡出现，
 * 否则后续断言会在过渡帧里读到空集合，红成「布局问题」而不是「没展开」。
 */
export async function ensureAuditConditionsExpanded(page: Page): Promise<void> {
  const toggle = page.locator(".audit-cond-toggle").first();
  await expect(toggle, "轮142 A4：审计跑完条件区自动收起，折叠/展开的入口必须一直在").toBeVisible({ timeout: 15_000 });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await expect(page.locator(".audit-env-card").first()).toBeVisible({ timeout: 15_000 });
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
