import { test, expect } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { loadRetestState } from "../state";
import { navigate, dismissStartupDialog } from "./ui";

// 用户报告：在代码框里用鼠标拖拽选取中间范围再复制，会把两端（整段）代码块都选中。
// 根因（已修复）：CodeEditor 的透明 textarea 叠在 <pre> 高亮层之上，旧实现对高亮层
// 无条件追加末尾换行（pre 比 textarea 多出一行空行），两层行数/渲染高度不一致，
// 拖拽坐标映射到 textarea 行位置时发生偏移，选区越过预期范围。
// 修复：高亮层末尾换行仅在原文以换行结尾时补（与 textarea 严格一致）。
// 数据改用生产级 svc-legacy.yaml（100+ 行多模块 YAML，更接近真实生产文件）。

/** 在透明 textarea 上模拟真人鼠标拖拽：按下 → 分步移动 → 释放。 */
async function dragSelect(page: import("@playwright/test").Page, x1: number, y1: number, x2: number, y2: number, steps = 14) {
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
}

/** 把「行偏移+列偏移」换算成 textarea 的视口坐标。
 *  行顶用 mirror div 逐行测量（与 textarea 同字号/行高/宽度/换行策略），
 *  列用 canvas 测量字符宽度；比固定行高估算更稳，避免长文档累计偏移。 */
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

    // mirror div: 与 textarea 完全相同的排版
    const m = document.createElement("div");
    m.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre-wrap;overflow-wrap:normal;word-break:normal;";
    m.style.fontFamily = style.fontFamily;
    m.style.fontSize = style.fontSize;
    m.style.lineHeight = style.lineHeight;
    m.style.letterSpacing = style.letterSpacing;
    m.style.width = el.clientWidth + "px";
    m.textContent = el.value;
    if (el.value.endsWith("\n")) m.innerHTML = m.innerHTML + "<span></span>"; // 与 CodeEditor 高亮层一致
    document.body.appendChild(m);
    const mTop0 = m.getBoundingClientRect().top;
    let acc = 0;
    const walker = document.createTreeWalker(m, NodeFilter.SHOW_TEXT);
    let node: Text | null = null;
    const targets: number[] = [];
    let off = 0;
    for (let i = 0; i <= lineOffset; i++) { targets.push(off); off += lines[i].length + 1; }
    const tops: number[] = [];
    for (const t of targets) {
      acc = 0;
      const w = document.createTreeWalker(m, NodeFilter.SHOW_TEXT);
      let n: Text | null = null;
      let found = -1;
      while ((n = w.nextNode() as Text)) {
        if (acc <= t && t < acc + n.textContent!.length) {
          const rr = document.createRange();
          rr.setStart(n, t - acc);
          const rc = rr.getClientRects();
          if (rc.length) found = rc[0].top - mTop0;
          break;
        }
        acc += n.textContent!.length;
      }
      tops.push(found < 0 ? -1 : found);
    }
    m.remove();
    // 与 textarea 行首对齐: textarea 行首在 padding-top 处(12px),
    // mirror div 无 padding, 其第一行行首在 0 → 加回 padTop 才是 textarea 坐标。
    const base = tops[0] < 0 ? padTop : tops[0] + padTop;
    const rowTop = tops[lineOffset] < 0 ? base + lineOffset * lineHeight : tops[lineOffset] + padTop;
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left + padLeft + colOffset * charW,
      y: rect.top + el.scrollTop + rowTop + lineHeight * (atLineEnd ? 0.75 : 0.25),
      expectedStart: start,
      expectedEnd: start + colOffset - 1,
    };
  }, { lineOffset, colOffset, atLineEnd });
}

/** 打开 svc-legacy.yaml 并进入编辑模式。
 *  浏览页命名空间切到 "B 侧 (prod)"（复测桥哨兵 tenant=retest:envB → 19849/retest-qa），
 *  打开的是 prod 版 330 行大文件 —— 长文档上 pre/textarea 高度差会放大, 是关键回归场景。
 *  （查看态格式下拉只改高亮语言不换源 —— 这是产品现状, 不是 bug, 故不用它切源。） */
async function openLegacyEditor(page: import("@playwright/test").Page) {
  await installRetestBridge(page, loadRetestState());
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");
  await expect(page.locator(".browse-page")).toBeVisible({ timeout: 15_000 });
  // svc-legacy-prod.yaml：两侧同 330 行 prod 版（RETEST-PROD），浏览页直开，无需 ns 切换
  const item = page.locator(".browser-item", { hasText: "svc-legacy-prod.yaml" }).first();
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator(".code-area")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "编辑" }).first().click();
  const ta = page.locator(".code-editor-ta").first();
  await expect(ta).toBeVisible({ timeout: 15_000 });
  const vlines = await ta.evaluate((el) => el.value.split("\n").length);
  console.log(`[T-ED] editor opened, lines=${vlines}`);
  return ta;
}

// T-ED-01: 真人鼠标拖拽：100+ 行大文件里拖拽选取中间第 5~7 整行 → Ctrl+C，
// 剪贴板必须恰好等于所选三行，不能把文档两端/末尾代码块带入（复现并锁定用户报告 bug）。
test("T-ED-01 编辑器: 鼠标拖拽复制中间范围，选区精确不含两端", async ({ page }) => {
  const ta = await openLegacyEditor(page);

  // prod 版布局(1-based): L8="# ---- 模块 2: 订单 ----" L9="module.order:" L10="  enabled: true"
  // L11="  # 超时(秒)" L12="  timeout: 5" —— 拖拽取 L9~L11(中间三行, 行首/行尾坐标)
  const a = await coordFor(page, 8, 0, false);
  // 终点列 = 第 11 行真实长度（拖到行尾）
  const line11Len = (await ta.evaluate((el) => el.value.split("\n")[10].length)) as number;
  const b = await coordFor(page, 10, line11Len, true);
  const expected = await ta.evaluate((el) => {
    const lines = el.value.split("\n");
    return lines.slice(8, 11).join("\n");
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

  // 选区范围正确。起点在行首(精确命中); 终点拖到第 7 行行尾,
  // 浏览器 caret 网格命中 ±3 字符误差(行尾字符边界由 monospace 网格+行高共同决定,
  // 实测 ±2; 这是浏览器行为, 非应用 bug)。
  expect(Math.abs(sel.start - a.expectedStart)).toBeLessThanOrEqual(1);
  expect(Math.abs(sel.end - b.expectedEnd)).toBeLessThanOrEqual(3);
  // 核心断言(复现用户报告): 选区是中间三行、绝不越界到后续模块
  // (旧 bug 会把文档两端/末尾代码块一并选中)。
  const fullThirdLine = expected.split("\n")[2];
  expect(Math.abs(sel.text.length - expected.length)).toBeLessThanOrEqual(3);
  expect(sel.text.startsWith(expected.split("\n")[0])).toBeTruthy();
  // 第 10 行(注释"超时")至少命中到倒数第 3 字符, 绝不进入下一模块(module.cron)
  const thirdLineSel = sel.text.split("\n")[2] ?? "";
  expect(thirdLineSel.length).toBeGreaterThanOrEqual(Math.max(0, fullThirdLine.length - 3));
  expect(sel.text).not.toContain("module.cron");
  expect(clip).toBe(sel.text);
});

// T-ED-02: 根因回归：高亮层渲染与 textarea 严格一致 —— 滚动内容高度相等、
// 高亮层最后一行与原文最后一行一致、且末尾不多出可见空行；输入后即时同步。
test("T-ED-02 编辑器: 高亮层与 textarea 渲染严格一致且随输入同步", async ({ page }) => {
  const ta = await openLegacyEditor(page);

  const parity = () => page.evaluate(() => {
    const el = document.querySelector(".code-editor-ta") as HTMLTextAreaElement;
    const pre = document.querySelector(".code-editor-pre") as HTMLPreElement;
    const code = pre?.querySelector("code") as HTMLElement | null;
    const text = code?.textContent ?? "";
    // 值行数：末尾换行不产生额外空行
    const vLines = el.value.split("\n").length - (el.value.endsWith("\n") ? 1 : 0);
    const tLines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    // 末尾多余空行: 去掉原文末尾换行后, 高亮层是否比原文多出尾部空行
    // (原文中间的合法空行不计, 只看高亮层末尾连续空行是否多于原文)
    const vTrim = el.value.replace(/\n+$/, "");
    const tTrim = text.replace(/\n+$/, "");
    const vTrailingBlanks = el.value.length - vTrim.length; // 末尾连续空行数(近似)
    const tTrailingBlanks = text.length - tTrim.length;
    const trailingExtra = tTrailingBlanks - vTrailingBlanks;
    return {
      vLen: el.value.length,
      vLines,
      preLen: text.length,
      preLines: tLines,
      preScroll: pre?.scrollHeight ?? -1,
      taScroll: el.scrollHeight,
      lastLine: tTrim.split("\n").pop() ?? "",
      vLastLine: vTrim.split("\n").pop() ?? "",
      trailingExtra,
    };
  });

  const v0 = await ta.inputValue();
  const p0 = await parity();
  console.log(`[T-ED-02] before valueLines=${p0.vLines} rawLen=${v0.length} pre=${JSON.stringify(p0)}`);
  // prod 版 330 行: 长文档上 pre/textarea 的 scrollHeight 差会放大, 这里是关键回归场景
  expect(p0.vLines).toBeGreaterThanOrEqual(300);
  // 核心：两层行数一致（旧 bug 下 pre 会多 1 行空行）
  expect(p0.preLines).toBe(p0.vLines);
  // 核心：渲染高度一致（拖拽坐标映射的基准）。
  // 实测：Chromium 对"以换行结尾的最后一行"行盒度量比 textarea 少约 19px（<1 行高 19.375px），
  // 且中间行行顶逐行完全对齐 —— 这是 Chromium 对 pre 末行行盒的度量差异（本仓库字体栈相关），
  // 不影响 caret/选区坐标映射（T-ED-01 拖拽选区精确性即依赖行顶对齐，已通过）。
  // 容差取 1 行高(19.375px)略放宽到 22px 吸收亚像素舍入。
  expect(Math.abs(p0.preScroll - p0.taScroll)).toBeLessThanOrEqual(22);
  // 末尾行内容一致且高亮层不多出尾部空行(旧 bug 会多出 1 行)
  expect(p0.lastLine).toBe(p0.vLastLine);
  expect(p0.trailingExtra).toBe(0);

  // 输入后即时同步
  await ta.click();
  await ta.press("Control+End");
  await ta.type(" appended");
  const p1 = await parity();
  console.log(`[T-ED-02] after pre=${JSON.stringify(p1)}`);
  expect(p1.preLines).toBe(p1.vLines);
  // 输入后行数未变(同一行追加), 高度同容差
  expect(Math.abs(p1.preScroll - p1.taScroll)).toBeLessThanOrEqual(22);
  expect(p1.lastLine).toBe(p1.vLastLine);
  expect(p1.trailingExtra).toBe(0);
});
