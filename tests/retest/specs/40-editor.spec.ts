import { test, expect } from "./retestTest";
import { installRetestBridge, RETEST_BRIDGE_MARKER } from "../bridge/installRetestBridge";
import { loadRetestState } from "../state";
import { navigate, dismissStartupDialog } from "./ui";

// 用户报告:在代码框里用鼠标拖拽选取中间范围再复制,会把两端(整段)代码块都选中。
// 根因(已修复):CodeEditor 的透明 textarea 叠在 <pre> 高亮层之上,旧实现对高亮层
// 无条件追加末尾换行(pre 比 textarea 多出一行空行),两层行数/渲染高度不一致,
// 拖拽坐标映射到 textarea 行位置时发生偏移,选区越过预期范围。
// 修复:高亮层末尾换行仅在原文以换行结尾时补(与 textarea 严格一致)。

/** 在透明 textarea 上模拟真人鼠标拖拽:按下 → 分步移动 → 释放。 */
async function dragSelect(page: import("@playwright/test").Page, x1: number, y1: number, x2: number, y2: number, steps = 14) {
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
}

/** 把“行偏移+列偏移”换算成 textarea 的视口坐标(等宽字体按字符格计算)。
 *  行首 = yFrac 0.25(行高上沿 1/4 处),行尾 = yFrac 0.75。 */
async function coordFor(page: import("@playwright/test").Page, lineOffset: number, colOffset: number, atLineEnd: boolean) {
  return page.evaluate(({ lineOffset, colOffset, atLineEnd }) => {
    const el = document.querySelector(".code-editor-ta") as HTMLTextAreaElement;
    const style = getComputedStyle(el);
    const lineHeight = Number.parseFloat(style.lineHeight) || 19.375;
    const padTop = Number.parseFloat(style.paddingTop) || 0;
    const padLeft = Number.parseFloat(style.paddingLeft) || 0;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    ctx.font = style.font;
    const charW = ctx.measureText("0").width;
    const lines = el.value.split("\n");
    let start = 0;
    for (let i = 0; i < lineOffset; i++) start += lines[i].length + 1;
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left + padLeft + colOffset * charW,
      y: rect.top + el.scrollTop + padTop + lineOffset * lineHeight + lineHeight * (atLineEnd ? 0.75 : 0.25),
      expectedStart: start,
      expectedEnd: start + colOffset - 1,
    };
  }, { lineOffset, colOffset, atLineEnd });
}

// T-ED-01: 真人鼠标拖拽:浏览页打开 txt → 编辑 → 拖拽选取第 5~7 整行 → Ctrl+C,
// 剪贴板必须恰好等于所选三行,不能把文档两端/末尾代码块带入(复现并锁定用户报告 bug)。
test("T-ED-01 编辑器: 鼠标拖拽复制中间范围,选区精确不含两端", async ({ page }) => {
  await installRetestBridge(page, loadRetestState());
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");
  await page.locator(".browser-item", { hasText: "retest-plain.txt" }).first().click();
  await expect(page.locator(".code-area")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "编辑" }).first().click();
  const ta = page.locator(".code-editor-ta").first();
  await expect(ta).toBeVisible({ timeout: 15_000 });

  // line5 行首 → line7 行尾(1-based)
  const a = await coordFor(page, 4, 0, false);
  const b = await coordFor(page, 6, 6, true); // line7 = "line7" 6 字符
  const expected = await ta.evaluate((el) => {
    const lines = el.value.split("\n");
    return lines.slice(4, 7).join("\n");
  });
  console.log(`[T-ED-01] start=${JSON.stringify(a)} end=${JSON.stringify(b)} expected=${JSON.stringify(expected)}`);

  await dragSelect(page, a.x + 2, a.y, b.x, b.y);
  const sel = await ta.evaluate((el) => ({
    start: el.selectionStart,
    end: el.selectionEnd,
    text: el.value.slice(el.selectionStart, el.selectionEnd),
  }));
  console.log(`[T-ED-01] selection=${JSON.stringify(sel)}`);

  await page.keyboard.press("Control+c");
  await page.waitForTimeout(400);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  console.log(`[T-ED-01] clipboard=${JSON.stringify(clip)}`);
  await page.screenshot({ path: "results/ed01-drag-copy.png", fullPage: true });

  // 选区范围正确(允许起点 ±1 个字符的命中误差,终点容差 1)
  expect(Math.abs(sel.start - a.expectedStart)).toBeLessThanOrEqual(1);
  expect(Math.abs(sel.end - b.expectedEnd)).toBeLessThanOrEqual(1);
  expect(sel.text).toBe(expected);
  expect(clip).toBe(expected);
});

// T-ED-02: 根因回归:高亮层渲染与 textarea 严格一致 —— 滚动内容高度相等、
// 高亮层最后一行与原文最后一行一致、且末尾不多出可见空行;输入后即时同步。
test("T-ED-02 编辑器: 高亮层与 textarea 渲染严格一致且随输入同步", async ({ page }) => {
  await installRetestBridge(page, loadRetestState());
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");
  await page.locator(".browser-item", { hasText: "retest-plain.txt" }).first().click();
  await expect(page.locator(".code-area")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "编辑" }).first().click();
  const ta = page.locator(".code-editor-ta").first();
  await expect(ta).toBeVisible({ timeout: 15_000 });

  const parity = () => page.evaluate(() => {
    const el = document.querySelector(".code-editor-ta") as HTMLTextAreaElement;
    const pre = document.querySelector(".code-editor-pre") as HTMLPreElement;
    const code = pre?.querySelector("code") as HTMLElement | null;
    const text = code?.textContent ?? "";
    // 值行数:末尾换行不产生额外空行
    const vLines = el.value.split("\n").length - (el.value.endsWith("\n") ? 1 : 0);
    const tLines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    // 末尾是否多出“空行”:高亮层最后一段非空内容之后是否还有空白行
    const trailingBlank = text.replace(/\n$/, "").split("\n").filter((l) => l.trim() === "").length;
    return {
      vLen: el.value.length,
      vLines,
      preLen: text.length,
      preLines: tLines,
      preScroll: pre?.scrollHeight ?? -1,
      taScroll: el.scrollHeight,
      lastLine: text.replace(/\n$/, "").split("\n").pop() ?? "",
      vLastLine: el.value.replace(/\n$/, "").split("\n").pop() ?? "",
      trailingBlank,
    };
  });

  const v0 = await ta.inputValue();
  const p0 = await parity();
  console.log(`[T-ED-02] before valueLines=${p0.vLines} rawLen=${v0.length} pre=${JSON.stringify(p0)}`);
  expect(p0.vLines).toBe(12);
  // 核心:两层行数一致(旧 bug 下 pre 会多 1 行空行)
  expect(p0.preLines).toBe(p0.vLines);
  // 核心:渲染高度一致(拖拽坐标映射的基准)
  expect(p0.preScroll).toBe(p0.taScroll);
  // 末尾行内容一致且无多余空行
  expect(p0.lastLine).toBe(p0.vLastLine);
  expect(p0.trailingBlank).toBe(0);

  // 输入后即时同步
  await ta.click();
  await ta.press("Control+End");
  await ta.type(" appended");
  const p1 = await parity();
  console.log(`[T-ED-02] after pre=${JSON.stringify(p1)}`);
  expect(p1.vLines).toBe(13);
  expect(p1.preLines).toBe(p1.vLines);
  expect(p1.preScroll).toBe(p1.taScroll);
  expect(p1.lastLine).toBe(p1.vLastLine);
  expect(p1.trailingBlank).toBe(0);
});
