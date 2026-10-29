// r134 缺陷 B：编辑模式超长行的跨行光标异常（用户：「某一行文件超长的话，现在是有换行的情况」）。
//
// 这条和静态代码是矛盾的：textarea 写了 wrap="off"，.code-editor-pre/.code-editor-ta 共用
// white-space: pre（styles.css 共用几何规则，codeEditorLayerMetricsStayAligned 静态守卫盯着），
// 高亮输出是 inline span + 裸换行、没有逐行块。工单口径「和代码矛盾，必须先量」，本文件照办：
//   LONG-01 无长行基线：两层几何 sanity + 留痕；
//   LONG-02 末尾插入一条 4000 字符长行，量齐判别器（scrollWidth / 逻辑行数 vs 渲染行数 /
//           字形层该行 rect 的 top 集合 / 行顶网格 dy / 两层 scrollLeft 同步），全部 console 留痕；
//           这些 sanity 断言就是常驻判据：编辑态哪天真出现换行或横向不同步，这条当场红。
//   LONG-03 判据自证（CARET-04 同款结构）：把换行状态强制注进来（两层都折 = 用户可见的
//           「换行」；只折光标层 = 「跨行光标」本身），LONG-02 的判别器必须量出来；
//           还原后必须回到绿。量不出来 ⇒ 这套测量空转，判据作废。
//
// 判别器口径：不换行时 ta.scrollWidth ≈ 4000×字宽（≈30000px），换行时 ≈ clientWidth；
// scrollHeight 隐含行数（(scrollHeight-pad)/rowH）= 逻辑行数 ⇔ 没有长行被折；
// 字形层该行 Range.getClientRects() 的 distinct top 数 = 它被折成的行数；
// 行顶 dy ≈ 2px（墨迹盒恒定量，见 caret-alignment 文件头）⇒ 网格对齐，达行高量级 ⇒ 跨行分叉。
// 横向：ta.scrollLeft 赋值后 250ms，pre 必须跟手（onScroll→syncScroll），行号层 transform 同步。
//
// 真机结论（2026-10-29，chromium 1280x720）：LONG-01/02 全绿——
// 长行下 ta.scrollWidth=30169/expectedLongPx=30103（≪clientWidth 的反面）、隐含行数 355=逻辑行数、
// 字形层该行 1 行、gridDy=2.01、横向 pre 跟手 0px 差。编辑态在本机不换行、不错位。
// 且 white-space: pre 是确定性 CSS（不随机器/字体变），同一份 CSS 在任何引擎上都不折行——
// 用户看到的「换行」若真实存在，只可能来自别的视图（diff 视图 .diff-cell 是 pre-wrap，设计如此）
// 或旧构建；本文件留痕供 c 找用户复核时对照。
import { test, expect } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog } from "./ui";

/** 工单口径 3000～5000 字符，取 4000：@12.5px 等宽 ≈ 30000px，任何 1280 视口都远超可滚区。 */
const LONG_LINE = "L".repeat(4000);

async function openLegacyEditor(page: import("@playwright/test").Page) {
  await page.goto("/");
  await dismissStartupDialog(page);
  await navigate(page, "配置浏览");
  await expect(page.locator(".browse-page")).toBeVisible({ timeout: 15_000 });
  const item = page.locator(".browser-item", { hasText: "svc-legacy-prod.yaml" }).first();
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator(".code-area")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "编辑" }).first().click();
  const ta = page.locator(".code-editor-ta").first();
  await expect(ta).toBeVisible({ timeout: 15_000 });
  return ta;
}

/** 走真实输入路径在文末追加一条长行（与用户粘贴一整条超长值同路径：聚焦 → 光标文末 → insertText）。 */
async function appendLongLine(page: import("@playwright/test").Page) {
  const ta = page.locator(".code-editor-ta").first();
  await ta.focus();
  await page.evaluate(() => {
    const el = document.querySelector(".code-editor-ta") as HTMLTextAreaElement;
    el.setSelectionRange(el.value.length, el.value.length);
  });
  await page.keyboard.insertText("\n" + LONG_LINE);
  await page.waitForFunction(
    (len) => {
      const el = document.querySelector(".code-editor-ta") as HTMLTextAreaElement;
      const code = document.querySelector(".code-editor-pre code") as HTMLElement;
      return el.value.endsWith("L".repeat(len)) && code.textContent === el.value;
    },
    LONG_LINE.length,
    { timeout: 30_000 }
  );
  // 光标挪到长行中部（第 2000 列）：量「跨行」用的是它所在行的网格
  await page.evaluate((len) => {
    const el = document.querySelector(".code-editor-ta") as HTMLTextAreaElement;
    const off = el.value.length - len + Math.floor(len / 2);
    el.setSelectionRange(off, off);
  }, LONG_LINE.length);
}

/** 两层文字不变式 + 几何 sanity（与长行无关的公共读数）。 */
async function readTwoLayers(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const el = document.querySelector(".code-editor-ta") as HTMLTextAreaElement;
    const pre = document.querySelector(".code-editor-pre") as HTMLElement;
    const code = document.querySelector(".code-editor-pre code") as HTMLElement;
    const st = getComputedStyle(el);
    const stPre = getComputedStyle(pre);
    const stCode = getComputedStyle(code);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    ctx.font = `${st.fontSize} ${st.fontFamily}`;
    return {
      whiteSpace: { ta: st.whiteSpace, pre: stPre.whiteSpace, code: stCode.whiteSpace },
      wordBreak: { ta: st.wordBreak, code: stCode.wordBreak },
      overflowWrap: { ta: st.overflowWrap, code: stCode.overflowWrap },
      taWrapAttr: el.getAttribute("wrap"),
      fontSize: st.fontSize,
      charW: +ctx.measureText("L").width.toFixed(3),
      logicalLines: el.value.split("\n").length,
      glyphTextEqualsTa: code.textContent === el.value,
      taClientWidth: el.clientWidth,
      taScrollWidth: el.scrollWidth,
      preScrollWidth: pre.scrollWidth,
      taScrollHeight: el.scrollHeight,
      preScrollHeight: pre.scrollHeight,
      padTop: parseFloat(st.paddingTop),
      rowH: parseFloat(st.lineHeight),
    };
  });
}

/** 长行状态判别器（LONG-02 的判据 + LONG-03 的自证共用同一份量法）。 */
async function measureLongLineState(page: import("@playwright/test").Page) {
  return page.evaluate((longLen) => {
    const el = document.querySelector(".code-editor-ta") as HTMLTextAreaElement;
    const pre = document.querySelector(".code-editor-pre") as HTMLElement;
    const code = document.querySelector(".code-editor-pre code") as HTMLElement;
    const st = getComputedStyle(el);
    const padTop = parseFloat(st.paddingTop);
    const padBottom = parseFloat(st.paddingBottom);
    const rowH = parseFloat(st.lineHeight);
    const value = el.value;
    const logicalLines = value.split("\n").length;
    const longLineStart = value.length - longLen;
    const longLineIdx = logicalLines - 1;

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    ctx.font = `${st.fontSize} ${st.fontFamily}`;
    const charW = ctx.measureText("L").width;

    // 字形层里这一整行 Range 的 rect 集合：distinct top 数 = 它被折成的行数
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    const locate = (off: number) => {
      let acc = 0;
      for (const n of nodes) {
        if (off <= acc + n.data.length) return { node: n, offset: off - acc };
        acc += n.data.length;
      }
      const last = nodes[nodes.length - 1];
      return { node: last, offset: last.data.length };
    };
    const range = document.createRange();
    range.setStart(locate(longLineStart + 1).node, locate(longLineStart + 1).offset);
    range.setEnd(locate(longLineStart + longLen).node, locate(longLineStart + longLen).offset);
    const rects = Array.from(range.getClientRects());
    const tops = Array.from(new Set(rects.map((x) => +x.top.toFixed(1)))).sort((a, b) => a - b);

    const taBox = el.getBoundingClientRect();
    const expectedTop = taBox.top + padTop + longLineIdx * rowH - el.scrollTop;
    const caretOff = longLineStart + Math.floor(longLen / 2);
    // 光标层若折行，光标落在长行内第几折（0 基）：按内容宽度/字宽折算
    const contentW = el.clientWidth - parseFloat(st.paddingLeft) - parseFloat(st.paddingRight);
    const charsPerRow = contentW / charW;
    const caretTaWrapRow = Math.max(0, Math.floor((caretOff - longLineStart) / charsPerRow));

    return {
      logicalLines,
      longLineIdx,
      taScrollTop: el.scrollTop,
      taScrollHeight: el.scrollHeight,
      preScrollHeight: pre.scrollHeight,
      scrollHeightImpliedLines: +((el.scrollHeight - padTop - padBottom) / rowH).toFixed(1),
      taLongLineRows: +((el.scrollHeight - padTop - padBottom) / rowH - (logicalLines - 1)).toFixed(1),
      taScrollWidth: el.scrollWidth,
      preScrollWidth: pre.scrollWidth,
      taClientWidth: el.clientWidth,
      expectedLongPx: +(longLen * charW).toFixed(0),
      glyphLongLineRows: tops.length,
      glyphLongLineTop: tops[0] ?? null,
      expectedGridTop: +expectedTop.toFixed(2),
      gridDy: tops.length ? +(tops[0] - expectedTop).toFixed(2) : null,
      caretOffset: caretOff,
      charsPerRow: +charsPerRow.toFixed(1),
      caretTaWrapRow,
      charW: +charW.toFixed(3),
      rowH,
    };
  }, LONG_LINE.length);
}

type LongLineState = Awaited<ReturnType<typeof measureLongLineState>>;

/** 把「换行」状态强制注进编辑态（自证用）：both=两层都折（用户可见换行）；taOnly=只折光标层（跨行光标本身）。 */
async function setWrapState(page: import("@playwright/test").Page, mode: "both" | "taOnly" | "none") {
  await page.evaluate((m) => {
    const el = document.querySelector(".code-editor-ta") as HTMLTextAreaElement;
    const code = document.querySelector(".code-editor-pre code") as HTMLElement;
    const apply = (target: HTMLElement | HTMLTextAreaElement, on: boolean) => {
      if (on) {
        target.style.setProperty("white-space", "pre-wrap", "important");
        target.style.setProperty("word-break", "break-all", "important");
        target.style.setProperty("overflow-wrap", "break-word", "important");
      } else {
        target.style.removeProperty("white-space");
        target.style.removeProperty("word-break");
        target.style.removeProperty("overflow-wrap");
      }
    };
    apply(el, m === "both" || m === "taOnly");
    apply(code, m === "both");
    el.setAttribute("wrap", m === "none" ? "off" : "soft");
  }, mode);
  await page.waitForTimeout(150);
}

/** 「没在换行」的判据：隐含行数=逻辑行数、长行只占 1 行、横向滚得动。 */
function assertNotWrapped(m: LongLineState, label: string) {
  expect(
    Math.abs(m.scrollHeightImpliedLines - m.logicalLines),
    `${label}：textarea 渲染高度隐含 ${m.scrollHeightImpliedLines} 行 ≠ 逻辑 ${m.logicalLines} 行：长行被折了`
  ).toBeLessThanOrEqual(0.6);
  expect(m.glyphLongLineRows, `${label}：字形层把长行折成了 ${m.glyphLongLineRows} 行`).toBe(1);
  expect(
    m.taScrollWidth,
    `${label}：ta.scrollWidth=${m.taScrollWidth} ≪ 长行应有宽度 ${m.expectedLongPx}px——长行没横向铺开，是在折`
  ).toBeGreaterThan(m.expectedLongPx * 0.9);
}

test("LONG-01 基线：无长行时两层几何与文字不变式", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await openLegacyEditor(page);
  const r = await readTwoLayers(page);
  console.log(`[LONG-01 基线] ${JSON.stringify(r)}`);
  expect(r.whiteSpace.ta, "编辑态光标层必须 white-space: pre（不许换行）").toBe("pre");
  expect(r.whiteSpace.code, "编辑态字形层必须 white-space: pre（不许换行）").toBe("pre");
  expect(r.taWrapAttr, "textarea 必须 wrap=off").toBe("off");
  expect(r.glyphTextEqualsTa, "两层文字必须逐字相等（retest 共同依赖的不变式）").toBe(true);
  expect(r.taScrollWidth, "基线（无长行）不该横向可滚").toBeLessThanOrEqual(r.taClientWidth + 40);
});

test("LONG-02 4000 字符长行：换行判别器 + 行顶网格 + 横向同步，全量留痕", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await openLegacyEditor(page);
  const baseline = await readTwoLayers(page);
  const baselineLines = baseline.logicalLines;

  await appendLongLine(page);

  const m = await measureLongLineState(page);
  console.log(`[LONG-02 长行测量] 基线 ${baselineLines} 行 → 插入后 ${JSON.stringify(m)}`);

  // —— 判据（编辑态不许换行、不许跨行、横向必须跟手）——
  expect(m.logicalLines, "长行插入后逻辑行数 = 基线 + 1").toBe(baselineLines + 1);
  const r = await readTwoLayers(page);
  expect(r.glyphTextEqualsTa, "长行插入后两层文字仍必须逐字相等").toBe(true);
  expect(r.whiteSpace.ta).toBe("pre");
  expect(r.whiteSpace.code).toBe("pre");
  expect(r.taWrapAttr).toBe("off");
  assertNotWrapped(m, "LONG-02");
  // 行顶网格：墨迹盒恒定位移 ≈2px（见文件头），达行高量级就是跨行分叉
  expect(
    Math.abs((m.gridDy ?? 0) - 2),
    `光标所在行的字形层行顶偏离网格 ${(m.gridDy ?? 0) - 2}px（行高 ${m.rowH}px）：两层行网格分叉，光标跨行`
  ).toBeLessThanOrEqual(4);

  // —— 横向同步：ta 是滚动主，pre/行号层靠 onScroll→syncScroll 跟手 ——
  const h1 = await page.evaluate((off) => {
    const el = document.querySelector(".code-editor-ta") as HTMLTextAreaElement;
    el.scrollTop = 0;
    el.scrollLeft = 0;
    el.scrollLeft = off;
    return { taLeft: el.scrollLeft };
  }, 3000);
  await page.waitForTimeout(250);
  const h2 = await page.evaluate(() => {
    const el = document.querySelector(".code-editor-ta") as HTMLTextAreaElement;
    const pre = document.querySelector(".code-editor-pre") as HTMLElement;
    const gutter = document.querySelector(".code-editor .code-gutter-layer") as HTMLElement;
    return {
      taLeft: el.scrollLeft,
      preLeft: pre.scrollLeft,
      gutterTransform: gutter ? gutter.style.transform : null,
    };
  });
  console.log(`[LONG-02 横向同步] ta.scrollLeft=${h1.taLeft} 赋值后 → pre.scrollLeft=${h2.preLeft} gutter=${h2.gutterTransform}`);
  expect(
    Math.abs(h2.preLeft - h2.taLeft),
    `横向滚动后 pre 没跟上（ta=${h2.taLeft} pre=${h2.preLeft}）：长行横滚时字形层与光标层会错开`
  ).toBeLessThanOrEqual(1);

  // 再验证纵向跟手（行号层 transform = -scrollTop）
  const h3 = await page.evaluate(() => {
    const el = document.querySelector(".code-editor-ta") as HTMLTextAreaElement;
    el.scrollTop = 100;
    return { taTop: el.scrollTop };
  });
  await page.waitForTimeout(250);
  const h4 = await page.evaluate(() => {
    const pre = document.querySelector(".code-editor-pre") as HTMLElement;
    const gutter = document.querySelector(".code-editor .code-gutter-layer") as HTMLElement;
    return { preTop: pre.scrollTop, gutterTransform: gutter ? gutter.style.transform : null };
  });
  console.log(`[LONG-02 纵向跟手] ta.scrollTop=${h3.taTop} → pre.scrollTop=${h4.preTop} gutter=${h4.gutterTransform}`);
  expect(Math.abs(h4.preTop - h3.taTop), "pre 纵向没跟上 textarea").toBeLessThanOrEqual(1);
  expect(h4.gutterTransform, "行号层 transform 没跟着滚动走").toBe("translateY(-100px)");
  await page.screenshot({ path: "results/long02-longline-caret.png" });
});

test("LONG-03 判据自证：换行/跨行真出现时，LONG-02 的判别器必须当场量出来", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await openLegacyEditor(page);
  await appendLongLine(page);

  // 基线：当前代码状态下不许在折
  const clean = await measureLongLineState(page);
  assertNotWrapped(clean, "LONG-03 基线");
  console.log(`[LONG-03 基线] ${JSON.stringify(clean)}`);

  // 注行 1：两层都折 = 用户可见的「换行」。判别器必须报出折了多少行、横向不再铺开。
  await setWrapState(page, "both");
  const both = await measureLongLineState(page);
  console.log(`[LONG-03 两层折行] ${JSON.stringify(both)}`);
  expect(
    both.taScrollWidth,
    `两层折行后 ta.scrollWidth 应塌回视口宽（≈clientWidth=${both.taClientWidth}），实际 ${both.taScrollWidth}：量法抓不到折行`
  ).toBeLessThanOrEqual(both.taClientWidth + 40);
  expect(both.taLongLineRows, `两层折行后长行应占多行，量到 ${both.taLongLineRows} 行：量法抓不到折行`).toBeGreaterThan(5);
  expect(both.glyphLongLineRows, `两层折行后字形层长行应折成多行，量到 ${both.glyphLongLineRows} 行：量法抓不到折行`).toBeGreaterThan(5);

  // 注行 2：只折光标层 = 「跨行光标」本身（光标层第 N 折，字形层还在原行）。
  // 这是两层行网格分叉的最坏形态：光标画的行和字画的行差出整行。
  await setWrapState(page, "taOnly");
  const split = await measureLongLineState(page);
  console.log(`[LONG-03 只折光标层] ${JSON.stringify(split)}`);
  expect(split.glyphLongLineRows, "只折光标层时字形层应仍是 1 行").toBe(1);
  expect(
    split.taLongLineRows - split.glyphLongLineRows,
    `两层行数差 ${split.taLongLineRows - split.glyphLongLineRows}（ta ${split.taLongLineRows} vs glyph ${split.glyphLongLineRows}）：` +
      `跨行分叉没被量出来，LONG-02 的判据对「跨行光标」空转`
  ).toBeGreaterThan(5);
  expect(split.caretTaWrapRow, "光标应落在长行中段的某一折上（>0），否则注行没生效").toBeGreaterThan(0);

  // 还原后必须回到绿：证明上面两次数数不是被残留状态带偏的
  await setWrapState(page, "none");
  const restored = await measureLongLineState(page);
  assertNotWrapped(restored, "LONG-03 还原");
  console.log(`[LONG-03 还原] ${JSON.stringify(restored)}`);
  await page.screenshot({ path: "results/long03-wrap-selfproof.png" });
});
