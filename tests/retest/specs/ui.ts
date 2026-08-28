import { expect, type Locator, type Page } from "@playwright/test";

/** 侧边栏导航（真人点击路径）。 */
export async function navigate(page: Page, label: string): Promise<void> {
  await page.locator(".side-nav-item", { hasText: label }).first().click();
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
  // 字段 label 位于 label.field > span（直接子级），避免 "来源（左）" 误匹配 "来源"
  const fields = panel.locator("label.field").filter({ has: page.locator(`> span:has-text("${fieldLabel}")`) });
  await expect(fields).not.toHaveCount(0, { timeout: 15_000 });
  const sel = fields.first().locator(".sel").first();
  await sel.locator(".sel-trigger").click();
  const menu = page.locator(".sel-menu-portal");
  await expect(menu).toBeVisible({ timeout: 10_000 });
  const option = menu.locator(".sel-option", { hasText: optionText }).last();
  await expect(option).toBeVisible({ timeout: 10_000 });
  await option.click();
}

/** 在 .source-picker 面板内按字段名定位 Combobox（.combo）并填入文本（可选再从候选里点选）。 */
export async function fillCombo(page: Page, panel: Locator, fieldLabel: string, value: string): Promise<void> {
  // 只按字段名精确匹配，避免 "dataId" 命中 "命名空间" 等包含关系
  const field = panel.locator("label.field", { has: page.locator(`span:has-text("${fieldLabel}")`) }).first();
  await expect(field).toBeVisible({ timeout: 15_000 });
  const input = field.locator("input").first();
  await input.fill(value);
  if (value) await input.press("Enter");
  await page.keyboard.press("Escape");
}

/** 配置对比页为指定侧（left/right）选择连接/命名空间/group/dataId。
 *  面板标题：左侧「来源（左）」，右侧「目标（右）」（zh-CN: diff.sourceA/sourceB）。 */
export async function setDiffSource(
  page: Page,
  side: "left" | "right",
  opts: { connection: string; namespace?: string; group?: string; dataId?: string }
): Promise<void> {
  const title = side === "left" ? "来源（左）" : "目标（右）";
  const panels = page.locator(".source-picker");
  const panel = await panels
    .filter({ has: page.locator(`.source-title:has-text("${title}")`) })
    .first();
  await expect(panel).toBeVisible({ timeout: 15_000 });
  if (opts.connection) await selectSel(page, panel, "来源", opts.connection);
  if (opts.namespace) await selectSel(page, panel, "命名空间", opts.namespace);
  if (opts.dataId !== undefined) await fillCombo(page, panel, "dataId", opts.dataId);
  if (opts.group !== undefined) await fillCombo(page, panel, "group", opts.group);
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
