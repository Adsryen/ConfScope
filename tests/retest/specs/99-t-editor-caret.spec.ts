// 诊断（未定稿，先取证）：编辑态「光标/选区与可见文字对不上」的量化证据。
// CodeEditor 是透明 textarea 叠高亮 <pre>：光标与选区画在 textarea 层，看到的字在 pre 层。
// 只要 pre 层的水平度量与 textarea 不一致（斜体字宽、命中词 padding），
// 用户就会看到「光标在一个字上，选中的是另一个字」。
import { test, expect } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { loadRetestState } from "../state";
import { navigate, dismissStartupDialog } from "./ui";

async function openEditor(page: import("@playwright/test").Page) {
  await installRetestBridge(page, loadRetestState());
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

/** 逐行比对 pre 层实际渲染宽度与 textarea 字体下的纯文本宽度。 */
async function measureDrift(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const el = document.querySelector(".code-editor-ta") as HTMLTextAreaElement;
    const code = document.querySelector(".code-editor-pre code") as HTMLElement;
    const st = getComputedStyle(el);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    ctx.font = `${st.fontSize} ${st.fontFamily}`;

    const nodes: Text[] = [];
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);

    const locate = (globalOffset: number) => {
      let acc = 0;
      for (const n of nodes) {
        const len = n.data.length;
        if (globalOffset <= acc + len) return { node: n, offset: globalOffset - acc };
        acc += len;
      }
      const last = nodes[nodes.length - 1];
      return { node: last, offset: last.data.length };
    };

    const rectOf = (from: number, to: number) => {
      const a = locate(from);
      const b = locate(to);
      const r = document.createRange();
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset);
      const rects = Array.from(r.getClientRects());
      if (rects.length === 0) return null;
      const left = Math.min(...rects.map((x) => x.left));
      const right = Math.max(...rects.map((x) => x.right));
      return { left, right, width: right - left, rects: rects.length };
    };

    const lines = el.value.split("\n");
    const out: Array<{ line: number; text: string; want: number; got: number; drift: number; rects: number }> = [];
    let start = 0;
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      if (text.length > 0) {
        const got = rectOf(start, start + text.length);
        const want = ctx.measureText(text).width;
        if (got) {
          const drift = got.width - want;
          if (Math.abs(drift) > 0.5)
            out.push({
              line: i + 1,
              text: text.slice(0, 46),
              want: +want.toFixed(2),
              got: +got.width.toFixed(2),
              drift: +drift.toFixed(2),
              rects: got.rects,
            });
        }
      }
      start += text.length + 1;
    }
    const italicSpans = Array.from(code.querySelectorAll("span")).filter((s) => getComputedStyle(s).fontStyle === "italic");
    const commentSample = italicSpans[0]?.textContent ?? "";
    return {
      totalLines: lines.length,
      driftedLines: out.length,
      worst: out
        .slice()
        .sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift))
        .slice(0, 6),
      first: out.slice(0, 4),
      italicSpanCount: italicSpans.length,
      italicClasses: Array.from(new Set(italicSpans.slice(0, 60).map((s) => s.className))).join(","),
      // 注意：合成斜体要看的是「同一字体换 italic 轴后的 advance」，
      // 不是把 "italic" 这个单词拼进被测串里（那量到的是 7 个字母的宽度，纯假数）。
      italicAdvanceDelta: (() => {
        const upright = ctx.measureText(commentSample).width;
        ctx.font = `italic ${st.fontSize} ${st.fontFamily}`;
        const slanted = ctx.measureText(commentSample).width;
        ctx.font = `${st.fontSize} ${st.fontFamily}`;
        return +(slanted - upright).toFixed(2);
      })(),
      commentSample: commentSample.slice(0, 40),
    };
  });
}

test("T-CARET-01 高亮层与 textarea 的水平度量差（斜体 token）", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const ta = await openEditor(page);
  const r = await measureDrift(page);
  console.log("[T-CARET-01] " + JSON.stringify(r, null, 1));
  await page.screenshot({ path: "results/caret01-editor.png" });
  expect(r.totalLines).toBeGreaterThan(10);
  expect(ta).toBeTruthy();
});

test("T-CARET-02 查找命中词 padding 造成的额外偏移", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const ta = await openEditor(page);
  const before = await measureDrift(page);
  await ta.click();
  await page.keyboard.press("Control+f");
  await expect(page.locator(".code-find")).toBeVisible({ timeout: 5_000 });
  const term = await ta.evaluate((el) => {
    const lines = (el as HTMLTextAreaElement).value.split("\n");
    for (const l of lines) {
      const m = l.match(/([A-Za-z][A-Za-z0-9_-]{4,})/g);
      if (m && m.length >= 3 && l.length > 24) return m[1];
    }
    return "timeout";
  });
  await page.locator(".code-find input").fill(term);
  await page.waitForTimeout(400);
  const after = await measureDrift(page);
  const hitPad = await page.evaluate(() => {
    const hit = document.querySelector(".code-editor-pre .search-hit") as HTMLElement | null;
    if (!hit) return null;
    const s = getComputedStyle(hit);
    return { paddingLeft: s.paddingLeft, paddingRight: s.paddingRight };
  });
  console.log(
    "[T-CARET-02] term=" +
      term +
      " before=" +
      JSON.stringify({ drifted: before.driftedLines, worst: before.worst.slice(0, 3) }) +
      " after=" +
      JSON.stringify({ drifted: after.driftedLines, worst: after.worst.slice(0, 3), hitPad })
  );
  await page.screenshot({ path: "results/caret02-find-hit.png" });
  expect(after).toBeTruthy();
});

test("T-CARET-03 选区可见性与 ::selection 样式", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const ta = await openEditor(page);
  await ta.click();
  await page.keyboard.press("Control+a");
  const sel = await page.evaluate(() => {
    const el = document.querySelector(".code-editor-ta") as HTMLTextAreaElement;
    const rules: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let list: CSSRuleList;
      try {
        list = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(list)) {
        if (rule instanceof CSSStyleRule && rule.selectorText.includes("::selection")) rules.push(rule.cssText.slice(0, 140));
      }
    }
    const st = getComputedStyle(el);
    return {
      selectionRules: rules,
      taColor: st.color,
      caretColor: st.caretColor,
      selectionStart: el.selectionStart,
      selectionEnd: el.selectionEnd,
    };
  });
  console.log("[T-CARET-03] " + JSON.stringify(sel, null, 1));
  await page.screenshot({ path: "results/caret03-selectall.png" });
  expect(sel.selectionEnd).toBeGreaterThan(sel.selectionStart);
});

/** 逐行同时量水平宽度差与垂直行顶差（垂直差 = 光标跑到别的行）。 */
async function measureGrid(page: import("@playwright/test").Page, term?: string) {
  return page.evaluate(async (t: string | undefined) => {
    const el = document.querySelector(".code-editor-ta") as HTMLTextAreaElement;
    const code = document.querySelector(".code-editor-pre code") as HTMLElement;
    const st = getComputedStyle(el);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    ctx.font = `${st.fontSize} ${st.fontFamily}`;
    const padTop = parseFloat(st.paddingTop);
    const rowH = parseFloat(st.lineHeight);
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
    const rectOf = (from: number, to: number) => {
      const a = locate(from);
      const b = locate(to);
      const r = document.createRange();
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset);
      const rs = Array.from(r.getClientRects());
      if (!rs.length) return null;
      return {
        left: Math.min(...rs.map((x) => x.left)),
        top: Math.min(...rs.map((x) => x.top)),
        right: Math.max(...rs.map((x) => x.right)),
      };
    };
    const lines = el.value.split("\n");
    let start = 0;
    let worstX = 0;
    let worstXLine = 0;
    let worstY = 0;
    let worstYLine = 0;
    let maxHitsBefore = 0;
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      if (text.length) {
        const got = rectOf(start, start + text.length);
        if (got) {
          const dx = got.right - got.left - ctx.measureText(text).width;
          if (Math.abs(dx) > Math.abs(worstX)) {
            worstX = +dx.toFixed(2);
            worstXLine = i + 1;
          }
          const dy = got.top - (el.getBoundingClientRect().top + padTop + i * rowH);
          if (Math.abs(dy) > Math.abs(worstY)) {
            worstY = +dy.toFixed(2);
            worstYLine = i + 1;
          }
        }
      }
      if (t) {
        const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
        maxHitsBefore = Math.max(maxHitsBefore, (text.match(re) || []).length);
      }
      start += text.length + 1;
    }
    const hitCount = document.querySelectorAll(".code-editor-pre .search-hit").length;
    return {
      term: t ?? null,
      hitCount,
      maxHitsOnOneLine: maxHitsBefore,
      worstXDx: worstX,
      worstXLine,
      worstYDy: worstY,
      worstYLine,
      rowH,
      padTop,
      taScrollWidth: el.scrollWidth,
      preScrollWidth: (el.closest(".code-editor") as HTMLElement).querySelector(".code-editor-pre")!.scrollWidth,
    };
  }, term);
}

test("T-CARET-04 高频短词的最坏水平偏移 + 逐行垂直网格", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const ta = await openEditor(page);
  const plain = await measureGrid(page);
  await ta.click();
  await page.keyboard.press("Control+f");
  await expect(page.locator(".code-find")).toBeVisible({ timeout: 5_000 });
  const rows: unknown[] = [{ term: null, ...plain }];
  for (const t of ["#", "e", "a", "r"]) {
    await page.locator(".code-find input").fill(t);
    await page.waitForTimeout(350);
    rows.push({ term: t, ...(await measureGrid(page, t)) });
  }
  console.log("[T-CARET-04] " + JSON.stringify(rows, null, 1));
  await page.screenshot({ path: "results/caret04-worst.png" });
  expect(rows.length).toBeGreaterThan(1);
});
