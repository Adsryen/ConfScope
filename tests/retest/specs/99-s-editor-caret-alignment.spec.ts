// 编辑态「光标/选区指的字」与「看到的字」必须落在同一字符上。
//
// CodeEditor 的编辑态是两层：透明 textarea（画光标与选区）叠在高亮 <pre>（画字形）之上。
// 两层靠同一份字体/字号/行高/内边距对齐，任何只作用于字形层的布局属性都会让它们逐字符错位。
// 轮107 实测就是这条被打断：命中词带上 padding: 0 1px 以后，
// 单行 4 处命中最坏把字形推右 8.07px（12.5px 等宽字体 7.53px/字符 ≈ 一个多字符），
// 用户看到光标停在 e 上、删掉的却是 r。这里跑真机把「最坏偏移」直接判死，不再只取证。
//
// 阈值 0.6px 的来由：一个字符宽 7.53px，0.6px 是它的 8%，肉眼不会把光标认成隔壁那个字；
// 而来自 padding 的位移 2px 起跳（左右各 1px），真出问题一定远超这条线，不会因为亚像素抖动误红。
// 斜体不在这条判据里：等宽字体没有真斜体面，Chromium 用合成倾斜，advance 宽度实测差 0，
// CARET-01 把这个量出来钉住，哪天换成真斜体字体面就会由它报警。
//
// 垂直方向不能拿「字形 rect 顶 vs 行盒顶」的绝对差当判据：range 的 rect 是墨迹盒，
// 比行盒顶低约 2px（行高 20 / 字号 12.5 的半行距），这是个恒定量、跟对齐无关（实测 354 行全是 2.00）。
// 真正会害死光标的是「行间不一致」，所以判两件：各行行顶基线的极差、相邻行距与行高的偏差。
import { test, expect } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { loadRetestState } from "../state";
import { navigate, dismissStartupDialog } from "./ui";

/** 两层错位的最坏允许值（px）。见文件头。 */
const MAX_DRIFT_PX = 0.6;

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

/**
 * 逐行比对两层：字形层实际渲染出的行宽/行顶 vs textarea 自己算出来的行宽/行顶。
 * term 给了就按当前查找词量（命中词越多、旧 bug 的累积位移越大）。
 */
async function measureLayer(page: import("@playwright/test").Page, term?: string) {
  return page.evaluate((t: string | undefined) => {
    const el = document.querySelector(".code-editor-ta") as HTMLTextAreaElement;
    const code = document.querySelector(".code-editor-pre code") as HTMLElement;
    const st = getComputedStyle(el);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    const font = `${st.fontSize} ${st.fontFamily}`;
    ctx.font = font;
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
    const top0 = el.getBoundingClientRect().top;
    let start = 0;
    let worstX = 0;
    let worstXLine = 0;
    let worstXText = "";
    let hitsOnWorstLine = 0;
    let minDy = Number.POSITIVE_INFINITY;
    let maxDy = Number.NEGATIVE_INFINITY;
    let maxDyLine = 0;
    let worstPitchDelta = 0;
    let worstPitchLine = 0;
    let prevTop: number | null = null;
    let prevIndex = -1;
    let measured = 0;
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      if (text.length) {
        const got = rectOf(start, start + text.length);
        if (got) {
          measured += 1;
          const dx = +(got.right - got.left - ctx.measureText(text).width).toFixed(2);
          if (Math.abs(dx) > Math.abs(worstX)) {
            worstX = dx;
            worstXLine = i + 1;
            worstXText = text.slice(0, 46);
            hitsOnWorstLine = t ? (text.match(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length : 0;
          }
          const dy = +(got.top - (top0 + padTop + i * rowH)).toFixed(2);
          if (dy < minDy) minDy = dy;
          if (dy > maxDy) {
            maxDy = dy;
            maxDyLine = i + 1;
          }
          // 空行拿不到 rect 会被跳过，pitch 必须按真实行号差折算，否则空行下面那行看起来像两倍行高。
          if (prevTop !== null) {
            const pitch = +(got.top - prevTop).toFixed(2);
            const delta = +(pitch - (i - prevIndex) * rowH).toFixed(2);
            if (Math.abs(delta) > Math.abs(worstPitchDelta)) {
              worstPitchDelta = delta;
              worstPitchLine = i + 1;
            }
          }
          prevTop = got.top;
          prevIndex = i;
        }
      }
      start += text.length + 1;
    }

    const italicSpans = Array.from(code.querySelectorAll("span")).filter((s) => getComputedStyle(s).fontStyle === "italic");
    const commentSample = italicSpans[0]?.textContent ?? "";
    let italicAdvanceDelta = 0;
    if (commentSample) {
      const upright = ctx.measureText(commentSample).width;
      ctx.font = `italic ${font}`;
      const slanted = ctx.measureText(commentSample).width;
      ctx.font = font;
      // 量的是同一串字换斜体轴后的 advance，不是把 "italic" 拼进被测串里（那量到 7 个字母宽度，纯假数）。
      italicAdvanceDelta = +(slanted - upright).toFixed(2);
    }

    // 命中词自身：布局属性必须全 0，底色与描边靠 background 和 inset box-shadow 表达。
    const hit = document.querySelector(".code-editor-pre .search-hit") as HTMLElement | null;
    const hitSt = hit ? getComputedStyle(hit) : null;

    return {
      term: t ?? null,
      totalLines: lines.length,
      measuredLines: measured,
      hitCount: document.querySelectorAll(".code-editor-pre .search-hit").length,
      worstX,
      worstXLine,
      worstXText,
      hitsOnWorstLine,
      dySpread: measured ? +(maxDy - minDy).toFixed(2) : 0,
      dyBase: +minDy.toFixed(2),
      maxDyLine,
      worstPitchDelta,
      worstPitchLine,
      rowH,
      padTop,
      charW: +ctx.measureText("m").width.toFixed(2),
      italicSpanCount: italicSpans.length,
      italicAdvanceDelta,
      hitPaddingLeft: hitSt?.paddingLeft ?? null,
      hitPaddingRight: hitSt?.paddingRight ?? null,
      hitMarginLeft: hitSt?.marginLeft ?? null,
      hitBorderLeftWidth: hitSt?.borderLeftWidth ?? null,
      hitLetterSpacing: hitSt?.letterSpacing ?? null,
      hitBackground: hitSt?.backgroundColor ?? null,
      hitBoxShadow: hitSt?.boxShadow ?? null,
    };
  }, term);
}

type Layer = Awaited<ReturnType<typeof measureLayer>>;

/** 把最坏偏移与判据一起打出来，红的时候直接能看出是哪一行、几个命中。 */
function assertAligned(r: Layer, label: string) {
  console.log(
    `[${label}] lines=${r.totalLines} measured=${r.measuredLines} hits=${r.hitCount} charW=${r.charW} ` +
      `worstDx=${r.worstX}(L${r.worstXLine}, ${r.hitsOnWorstLine} 处命中, "${r.worstXText}") ` +
      `dySpread=${r.dySpread}(基线 ${r.dyBase}, 最大 L${r.maxDyLine}) pitchΔ=${r.worstPitchDelta}(L${r.worstPitchLine}) ` +
      `rowH=${r.rowH} padTop=${r.padTop} hitPadding=${r.hitPaddingLeft}/${r.hitPaddingRight} ` +
      `hitBg=${r.hitBackground} hitShadow=${r.hitBoxShadow}`
  );
  expect(r.measuredLines, "编辑区没量到行，前置条件就不成立").toBeGreaterThan(10);
  expect(Math.abs(r.worstX), `${label}：字形层比光标层宽 ${r.worstX}px（L${r.worstXLine}），光标会指错字`).toBeLessThanOrEqual(
    MAX_DRIFT_PX
  );
  expect(r.dySpread, `${label}：各行行顶基线不一致，极差 ${r.dySpread}px（最大 L${r.maxDyLine}），光标会跑到别的行`).toBeLessThanOrEqual(
    MAX_DRIFT_PX
  );
  expect(
    Math.abs(r.worstPitchDelta),
    `${label}：相邻行距与行高不符，差 ${r.worstPitchDelta}px（L${r.worstPitchLine}），光标会跑到别的行`
  ).toBeLessThanOrEqual(MAX_DRIFT_PX);
}

test("CARET-01 未搜索时两层逐行对齐，斜体 token 不改变字宽", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openEditor(page);
  const plain = await measureLayer(page);
  assertAligned(plain, "CARET-01 未搜索");
  expect(plain.italicSpanCount, "这份配置里没有斜体 token，这条判据空转了").toBeGreaterThan(0);
  expect(Math.abs(plain.italicAdvanceDelta), `斜体 advance 宽度差 ${plain.italicAdvanceDelta}px，两层会错位`).toBeLessThanOrEqual(
    MAX_DRIFT_PX
  );
  await page.screenshot({ path: "results/caret01-editor.png" });
});

test("CARET-02 查找命中词不再推动字形", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const ta = await openEditor(page);
  await ta.click();
  await page.keyboard.press("Control+f");
  await expect(page.locator(".code-find")).toBeVisible({ timeout: 5_000 });

  // 高频短词最划算：一行里命中越多，旧 bug 的累积位移越大（# / e / r 曾测到 4.02 / 7.07 / 8.07px）。
  const readings: string[] = [];
  for (const term of ["#", "e", "r"]) {
    await page.locator(".code-find input").fill(term);
    await page.waitForTimeout(400);
    const r = await measureLayer(page, term);
    assertAligned(r, `CARET-02 term=${term}`);
    readings.push(`${term}: ${r.worstX}px/${r.worstPitchDelta}px`);
    expect(r.hitCount, `搜 ${term} 却没有命中词节点，判据会空转`).toBeGreaterThan(0);
    // 直接钉住「命中词没吃任何布局属性」，宽度对齐只是它的结果。
    ["hitPaddingLeft", "hitPaddingRight", "hitMarginLeft", "hitBorderLeftWidth"].forEach((key) => {
      expect(r[key as keyof Layer], `命中词的 ${key} 不为 0px，两层就会错位`).toBe("0px");
    });
    // letter-spacing 的「没加宽」在计算值里是 normal，写成 0px 也算，别按字符串 0px 死判。
    expect(["normal", "0px"], `命中词的 letter-spacing = ${r.hitLetterSpacing}，两层会逐字符累积错位`).toContain(r.hitLetterSpacing);
    expect(r.hitBackground, "命中词没有底色，标红就只剩文字色").not.toBe("rgba(0, 0, 0, 0)");
    expect(String(r.hitBoxShadow)).toContain("inset");
  }
  console.log(`[CARET-02] 读数 ${readings.join(" | ")}`);
  await page.screenshot({ path: "results/caret02-find-hit.png" });
});

test("CARET-03 命中行上划选，字形不被选区刷掉", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const ta = await openEditor(page);
  await ta.click();
  await page.keyboard.press("Control+f");
  await expect(page.locator(".code-find")).toBeVisible({ timeout: 5_000 });
  await page.locator(".code-find input").fill("e");
  await page.waitForTimeout(400);

  // 在命中词中间按下鼠标，再按住 Shift 向右把它整词多拖几个字符。
  // 查找条保持打开：命中底一直在，截图才看得出选区缘是不是压在所见字形上。
  const hitBox = await page
    .locator(".code-editor-pre .search-hit")
    .first()
    .evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, len: (el.textContent ?? "").length };
    });
  await page.mouse.click(hitBox.x, hitBox.y);
  await page.keyboard.down("Shift");
  for (let i = 0; i < Math.min(hitBox.len + 3, 12); i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  await expect(page.locator(".code-find")).toBeVisible({ timeout: 5_000 });
  const hitCountNow = await page.locator(".code-editor-pre .search-hit").count();

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
        if (rule instanceof CSSStyleRule && rule.selectorText.includes("::selection")) rules.push(rule.cssText.slice(0, 160));
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
  console.log("[CARET-03] " + JSON.stringify({ ...sel, hitCountNow, selectionOnHits: hitCountNow }));
  expect(hitCountNow, "查找条还开着但命中词没了，这张截图说明不了问题").toBeGreaterThan(0);
  expect(sel.selectionEnd, "没有划出选区，这条判据空转").toBeGreaterThan(sel.selectionStart);
  expect(sel.taColor, "textarea 的文字必须是透明的，字形由字形层画，否则两层会重影").toBe("rgba(0, 0, 0, 0)");
  expect(
    sel.selectionRules.some((rule) => rule.includes("code-editor-ta::selection")),
    `找不到编辑态自己的选区规则，浏览器默认实心蓝会把字形层的字刷成白板：${sel.selectionRules.join(" | ")}`
  ).toBe(true);
  await page.screenshot({ path: "results/caret03-selection-on-hit.png" });
});
