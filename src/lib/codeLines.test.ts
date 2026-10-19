/**
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { escapeHtml, highlightCode, highlightLine } from "./highlight";
import {
  activeLineOf,
  buildMinimapRows,
  CURRENT_HIT_CLASS,
  currentHitSelector,
  decorateMinimapRows,
  findCodeHits,
  MINIMAP_WIDTH_RULER_PERCENTILE,
  prepareMinimapBuckets,
  hitLines,
  hitLinesInRange,
  lineOffsets,
  markHighlightedHtml,
  markLineSearchHits,
  normalizeLineEndings,
  splitLines,
  MAX_CODE_HITS,
  isHitScanCapped,
} from "./codeLines";

/** 模拟浏览器解析：剥离标签 + 反转义 &amp;/&lt;/&gt;（&quot;/&#x27; 已被重新转义为原字符）。 */
function textContent(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function baseHtml(code: string, fmt: Parameters<typeof highlightCode>[1]): string {
  const base = highlightCode(code, fmt);
  return code.endsWith("\n") ? base + "<span></span>" : base;
}

describe("normalizeLineEndings", () => {
  it("CRLF 与孤立 CR 都归一成 LF，与 textarea.value 的口径一致", () => {
    expect(normalizeLineEndings("a\r\nb\rc\n")).toBe("a\nb\nc\n");
  });

  it("纯 LF 内容原样返回，不额外改动文本", () => {
    expect(normalizeLineEndings("a\nb\n")).toBe("a\nb\n");
  });
});

describe("splitLines / lineOffsets", () => {
  it("splits on \\n and keeps \\r, reconstructing whole-doc offsets", () => {
    const code = "a\r\nbb\r\nc";
    const lines = splitLines(code);
    expect(lines).toEqual(["a\r", "bb\r", "c"]);
    expect(lineOffsets(lines)).toEqual([0, 3, 7]);
    expect(code[lineOffsets(lines)[1]]).toBe("b");
    expect(splitLines("")).toEqual([]);
  });
});

describe("findCodeHits", () => {
  it("locates hits across syntax tokens (properties server.port=8080)", () => {
    const code = "server.port=8080\nname=x\n";
    const hits = findCodeHits(code, "port=8080");
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(0);
    expect(hits[0].offset).toBe(7);
    expect(code.slice(hits[0].offset, hits[0].offset + hits[0].length)).toBe("port=8080");
  });

  it("is case-insensitive and matches multiple occurrences with correct lines", () => {
    const code = "PORT\nport\nx\nPORT";
    const hits = findCodeHits(code, "port");
    expect(hits).toHaveLength(3);
    expect(hits.map((h) => h.line)).toEqual([0, 1, 3]);
    for (const h of hits) expect(code.slice(h.offset, h.offset + h.length)).toMatch(/port/i);
  });

  it("按字面匹配搜索词，绝不当正则解释", () => {
    const code = "a=xzy\nb=x.y\nc=(a|b)+ [c]* ?\nd=C:\\tmp\\a\n";
    expect(findCodeHits(code, "x.y")).toHaveLength(1);
    expect(findCodeHits(code, "(a|b)+ [c]* ?")).toHaveLength(1);
    expect(findCodeHits(code, "C:\\tmp\\a")).toHaveLength(1);
    // 单个点号只匹配真正的点号，不匹配任意字符
    expect(findCodeHits("axb", ".")).toHaveLength(0);
    expect(findCodeHits("a.b", ".")).toHaveLength(1);
  });

  it("returns nothing for blank / no-match terms", () => {
    expect(findCodeHits("abc", "   ")).toEqual([]);
    expect(findCodeHits("abc", "zzz")).toEqual([]);
  });
});

describe("markHighlightedHtml", () => {
  it("keeps .code-area textContent identical to the original code", () => {
    const code = 'name = "a<b&c>"\nport: 8080\n';
    const html = baseHtml(code, "Properties");
    const hits = findCodeHits(code, "8080");
    const marked = markHighlightedHtml(html, hits);
    expect(textContent(marked)).toBe(code);
  });

  it("never produces double-escaped entities (the historical &amp;amp; bug)", () => {
    const code = "a & b < c > \"d\" 'e'\nport 8080\n";
    const html = baseHtml(code, "XML");
    const marked = markHighlightedHtml(html, findCodeHits(code, "port"));
    expect(marked).not.toContain("&amp;amp;");
    expect(marked).not.toContain("&amp;lt;");
    expect(textContent(marked)).toBe(code);
  });

  it("命中词自带 HTML 实体时不破坏转义，且拼接后逐字等于搜索词", () => {
    const code = 'url = "http://h/p?a=1&b=2&c=<x>" # tag\n';
    const html = baseHtml(code, "Properties");
    const term = "a=1&b=2&c=<x>";
    const hits = findCodeHits(code, term);
    expect(hits).toHaveLength(1);
    const marked = markHighlightedHtml(html, hits);
    expect(marked).not.toMatch(/&amp;(amp|lt|gt|quot|#)/);
    const marks = [...marked.matchAll(/<mark[^>]*>([\s\S]*?)<\/mark>/g)].map((m) => m[1]);
    expect(marks.length).toBeGreaterThan(0);
    const decoded = marks.map((m) => m.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")).join("");
    expect(decoded).toBe(term);
    expect(textContent(marked)).toBe(code);
  });
  it("每处命中标上自己的编号，产出 HTML 里不再有「当前命中」的类（轮28 F-14）", () => {
    const code = "8080 and 18080\nx 8080";
    const html = baseHtml(code, "TEXT");
    const hits = findCodeHits(code, "8080");
    expect(hits).toHaveLength(3);
    const marked = markHighlightedHtml(html, hits);
    expect((marked.match(/<mark class="search-hit" data-hit="\d+">/g) || []).length).toBe(3);
    expect([...marked.matchAll(/data-hit="(\d+)"/g)].map((m) => Number(m[1]))).toEqual([0, 1, 2]);
    // 当前命中改由视图在提交后切类：写进 HTML 就等于每按一次 Enter 重画整篇
    expect(marked).not.toContain(CURRENT_HIT_CLASS);
    expect(textContent(marked)).toBe(code);
  });

  it("returns html untouched when there are no hits", () => {
    const html = baseHtml("abc", "TEXT");
    expect(markHighlightedHtml(html, [])).toBe(html);
  });
});

describe("hitLines / active*Of", () => {
  it("collects distinct hit lines", () => {
    const code = "k=v\nz\nk=v\n";
    expect([...hitLines(findCodeHits(code, "k=v"))]).toEqual([0, 2]);
  });

  it("clamps the active index for line", () => {
    const code = "=1\n=1\n=1";
    const hits = findCodeHits(code, "=1");
    expect(activeLineOf(hits, 1)).toBe(1);
    expect(activeLineOf(hits, 99)).toBe(0);
    expect(activeLineOf([], 0)).toBeNull();
  });
});

describe("当前命中的落地方式（轮28 F-14）", () => {
  it("类名只有一份定义，选择器按命中编号取节点", () => {
    expect(CURRENT_HIT_CLASS).toBe("search-hit-current");
    expect(currentHitSelector(0)).toBe('mark[data-hit="0"]');
    expect(currentHitSelector(4999)).toBe('mark[data-hit="4999"]');
  });

  it("同一处命中被语法 token 切开时，几个 <mark> 共用同一个编号", () => {
    // hljs 把 properties 的键与值拆成不同 token，跨 token 的命中会被切成相邻的几个 <mark>
    const code = "server.port=8080\n";
    const hits = findCodeHits(code, "server.port=8080");
    expect(hits).toHaveLength(1);
    const marked = markHighlightedHtml(baseHtml(code, "Properties"), hits);
    const indices = [...marked.matchAll(/data-hit="(\d+)"/g)].map((m) => Number(m[1]));
    expect(indices.length).toBeGreaterThanOrEqual(1);
    expect(new Set(indices)).toEqual(new Set([0]));
    expect(textContent(marked)).toBe(code);
  });

  it("命中不变、只换当前序号时，产出的 HTML 逐字相同（这才省得下重画整篇的钱）", () => {
    const code = "port\nport\nport\n";
    const html = baseHtml(code, "TEXT");
    const hits = findCodeHits(code, "port");
    expect(hits).toHaveLength(3);
    expect(markHighlightedHtml(html, hits)).toBe(markHighlightedHtml(html, hits));
  });
});

describe("hitLinesInRange（轮28 F-15：命中行窗口要二分，不再线性扫全量）", () => {
  const lines = Array.from({ length: 500 }, (_, i) => (i % 10 === 0 ? "port=1" : "x")).join("\n");
  const sorted = Array.from(hitLines(findCodeHits(lines, "port")));

  it("命中行表天然升序——二分的唯一前提", () => {
    expect(sorted).toEqual([...sorted].sort((a, b) => a - b));
    expect(sorted.length).toBeGreaterThan(0);
  });

  it("窗口结果与线性扫全量逐字等价（夹住边界与空窗）", () => {
    for (const [start, end] of [
      [0, 1],
      [0, 500],
      [10, 11],
      [11, 19],
      [9, 21],
      [499, 500],
      [500, 600],
      [-5, 3],
    ]) {
      const linear = sorted.filter((line) => line >= start && line < end);
      expect(hitLinesInRange(sorted, start, end), `窗口 ${start}..${end}`).toEqual(linear);
    }
  });

  it("空表、倒窗口、窗口在表外都返回空数组而不是抛错", () => {
    expect(hitLinesInRange([], 0, 10)).toEqual([]);
    expect(hitLinesInRange(sorted, 20, 20)).toEqual([]);
    expect(hitLinesInRange(sorted, 30, 10)).toEqual([]);
    expect(hitLinesInRange(sorted, 900, 1000)).toEqual([]);
  });

  it("返回新数组，调用方 push 自己的落点不会污染命中行表", () => {
    const rows = hitLinesInRange(sorted, 0, 25);
    const before = [...sorted];
    rows.push(999);
    expect(sorted).toEqual(before);
  });
});

describe("buildMinimapRows", () => {
  const code = "# comment\nport=8080\n\nserver=1";
  const lines = splitLines(code);

  it("buckets all lines and never exceeds the row limit", () => {
    const rows = buildMinimapRows(lines, hitLines(findCodeHits(code, "port")), 1, 12);
    const covered = rows.reduce((n, r) => n + (r.endLine - r.startLine), 0);
    expect(covered).toBe(lines.length);
    expect(rows.length).toBeLessThanOrEqual(12);
    expect(rows.some((r) => r.kind === "comment")).toBe(true);
    expect(rows.some((r) => r.kind === "blank")).toBe(true);
    expect(rows.some((r) => r.hasHit)).toBe(true);
    expect(rows.some((r) => r.isCurrent)).toBe(true);
  });

  it("compresses long files into the requested number of rows", () => {
    const many = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const rows = buildMinimapRows(many, new Set(), null, 40);
    expect(rows).toHaveLength(40);
    expect(rows[0].startLine).toBe(0);
    expect(rows[rows.length - 1].endLine).toBe(200);
  });

  it("handles empty input", () => {
    expect(buildMinimapRows([], new Set(), null, 12)).toEqual([]);
  });

  it("normalises widthRatio against the longest line, tabs counted as two spaces", () => {
    const rows = buildMinimapRows(["\tshort", "much_longer_line_here"], new Set(), null, 1);
    expect(rows[0].widthRatio).toBeCloseTo(1, 5);
  });

  // 薄封装必须与两阶段同源：口径只有一份，否则画布侧与视图侧会分叉。
  it("buildMinimapRows 是 prepare + decorate 的薄封装（逐字等价）", () => {
    const doc = "# c\nport=8080\n\nserver=1\nname=x\n";
    const lines = splitLines(doc);
    const hits = hitLines(findCodeHits(doc, "port"));
    for (const rowLimit of [1, 2, 3, 5, 12, 40]) {
      expect(decorateMinimapRows(prepareMinimapBuckets(lines, rowLimit), Array.from(hits), 3), `rowLimit=${rowLimit}`).toEqual(
        buildMinimapRows(lines, hits, 3, rowLimit)
      );
    }
  });
});

describe("prepareMinimapBuckets 的条宽标尺（轮28 F-11）", () => {
  const CANVAS_W = 66;
  const CANVAS_PAD = 8;
  /** 画布侧的条宽公式（CodeView 画缩略图那段），拿来把 ratio 换算成像素。 */
  const barWidth = (ratio: number) => Math.max(3, ratio * (CANVAS_W - CANVAS_PAD));

  it("一行超长值不许把整张图压扁：800 行正常配置 + 1 行 60000 字符", () => {
    const lines = Array.from({ length: 800 }, (_, i) => `key${(i % 40) + 1}=value`).concat(["crt=" + "A".repeat(60000)]);
    const buckets = prepareMinimapBuckets(lines, 267).buckets;
    const widths = buckets.map((b) => barWidth(b.widthRatio));
    const p50 = widths.slice().sort((a, b) => a - b)[Math.floor(widths.length / 2)];
    // 旧口径（全文 maxLen 归一）实测 p50 = 3.0px、266/267 个桶塌到下限
    expect(p50, "p50 还在下限附近说明标尺仍是全文 maxLen").toBeGreaterThan(50);
    expect(widths.filter((w) => w <= 3.001).length, "塌到 3px 下限的桶").toBe(0);
    // 超长那行仍画满宽（它确实是最长的一行，信息没丢）
    expect(Math.max(...widths)).toBeCloseTo(CANVAS_W - CANVAS_PAD, 5);
  });

  it("标尺是桶最长行的 p95：多数桶仍按相对长度分层，离群值只触顶", () => {
    const lines = [...Array.from({ length: 10 }, () => "a".repeat(5)), ...Array.from({ length: 9 }, () => "a".repeat(10)), "a".repeat(60)];
    const { buckets, perRow } = prepareMinimapBuckets(lines, lines.length);
    expect(perRow).toBe(1);
    expect(buckets.length).toBe(20);
    // 桶数 20 时 p95 的秩 = ceil(0.95*20) = 19 ⇒ 标尺取到 10，最长的 60 被压掉
    const short = buckets.filter((b) => b.endLine - b.startLine === 1).slice(0, 10);
    const mid = buckets.slice(10, 19);
    expect(short.every((b) => b.widthRatio < mid[0].widthRatio)).toBe(true);
    expect(mid.every((b) => b.widthRatio === 1)).toBe(true);
    expect(buckets[19].widthRatio).toBe(1); // 离群桶触顶，不越界
    // 短桶按比例存活：旧口径下 5/60 = 0.083 ⇒ 条宽塌到 3px
    expect(barWidth(short[0].widthRatio)).toBeGreaterThan(3);
    expect(short[0].widthRatio).toBeCloseTo(0.5, 5);
  });

  it("ratio 永远不超过 1，空正文不炸", () => {
    expect(prepareMinimapBuckets([], 40)).toEqual({ perRow: 1, totalLines: 0, buckets: [] });
    const allBlank = prepareMinimapBuckets(["", "  ", ""], 8);
    expect(allBlank.buckets.every((b) => b.kind === "blank")).toBe(true);
    expect(allBlank.buckets.every((b) => b.widthRatio >= 0 && b.widthRatio <= 1)).toBe(true);
  });

  it("桶边界覆盖全部行且不超过 rowLimit，Tab 按两格算", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `\tline ${i}`);
    const { perRow, buckets } = prepareMinimapBuckets(lines, 40);
    expect(perRow).toBe(5);
    expect(buckets.length).toBe(40);
    expect(buckets[0].startLine).toBe(0);
    expect(buckets[buckets.length - 1].endLine).toBe(200);
    expect(buckets.reduce((n, b) => n + (b.endLine - b.startLine), 0)).toBe(200);
    // "\tline 0" → "  line 0" 共 8 字符；每桶最长随序号递增，但都被同一把标尺归一
    expect(buckets[0].widthRatio).toBeLessThanOrEqual(1);
    expect(buckets[39].widthRatio).toBe(1);
  });

  it("p95 常量是 0.95（改它要一起改单测的秩）", () => {
    expect(MINIMAP_WIDTH_RULER_PERCENTILE).toBe(0.95);
  });
});

describe("decorateMinimapRows 只贴命中（轮28 F-12）", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line${i}`);

  it("命中行按 floor(line / perRow) 落桶，越界的命中忽略", () => {
    const buckets = prepareMinimapBuckets(lines, 4); // perRow = 5
    expect(buckets.perRow).toBe(5);
    // 0 与 4 同属桶 0（去重后仍只亮一次），5 → 桶 1，19 → 桶 3，20 / -1 越界忽略
    const rows = decorateMinimapRows(buckets, [0, 4, 5, 19, 20, -1], null);
    expect(rows.map((r) => r.hasHit)).toEqual([true, true, false, true]);
    expect(rows.filter((r) => r.hasHit).length).toBe(3);
  });

  it("当前命中落在包含它的那一桶，null / 越界时一桶都不亮", () => {
    const buckets = prepareMinimapBuckets(lines, 4);
    // perRow = 5 ⇒ 第 12 行属于桶 2（10~14）
    expect(decorateMinimapRows(buckets, [], 12).map((r) => r.isCurrent)).toEqual([false, false, true, false]);
    expect(decorateMinimapRows(buckets, [], null).some((r) => r.isCurrent)).toBe(false);
    expect(decorateMinimapRows(buckets, [], 999).some((r) => r.isCurrent)).toBe(false);
  });

  it("静态部分逐字来自桶：不重算行长、也不改 kind", () => {
    const buckets = prepareMinimapBuckets(lines, 4);
    const rows = decorateMinimapRows(buckets, [], null);
    expect(rows.map((r) => [r.startLine, r.endLine, r.widthRatio, r.kind])).toEqual(
      buckets.buckets.map((b) => [b.startLine, b.endLine, b.widthRatio, b.kind])
    );
  });

  it("可反复调用：不吃掉桶，也不因第二次调用少标命中", () => {
    const buckets = prepareMinimapBuckets(lines, 4);
    const first = decorateMinimapRows(buckets, [0], 3);
    const second = decorateMinimapRows(buckets, [0], 3);
    expect(second).toEqual(first);
    expect(buckets.buckets.every((b) => !("hasHit" in b))).toBe(true);
  });

  it("空桶表返回空行（画布侧据此跳过绘制）", () => {
    expect(decorateMinimapRows(prepareMinimapBuckets([], 40), [], null)).toEqual([]);
  });
});

describe("findCodeHits 查找栏匹配选项（R75）", () => {
  const code = "PORT\nport\nx\nPORT\nexport const port = 8080;\nports=1\n";

  it("不带选项与空选项完全等价（外部搜索词口径不被动过）", () => {
    expect(findCodeHits(code, "port", {})).toEqual(findCodeHits(code, "port"));
  });

  it("caseSensitive 后行列按真命中的那一行重算", () => {
    const hits = findCodeHits(code, "port", { caseSensitive: true });
    // 大写 PORT 两行退出，export / ports 里的小写 port 仍按子串命中
    expect(hits.map((h) => h.line)).toEqual([1, 4, 4, 5]);
    expect(hits[0].offset).toBe(code.indexOf("port"));
    expect(hits[0].column).toBe(0);
    const line4 = code.split("\n")[4];
    expect(hits[1].column).toBe(line4.indexOf("port")); // export 内部那个
    expect(hits[2].column).toBe(line4.lastIndexOf("port")); // const port
  });

  it("wholeWord 不会把 export 里的 port、ports 也算成命中", () => {
    const hits = findCodeHits(code, "port", { wholeWord: true, caseSensitive: true });
    expect(hits).toHaveLength(2);
    expect(code.slice(hits[0].offset, hits[0].offset + hits[0].length)).toBe("port");
    expect(hits.map((h) => h.line)).toEqual([1, 4]);
    expect(code.slice(hits[1].offset, hits[1].offset + hits[1].length)).toBe("port");
  });

  it("选项改变命中集合后，hitLines / activeLineOf 跟着变（行高亮与缩略图同源）", () => {
    const plain = hitLines(findCodeHits(code, "port"));
    const ww = hitLines(findCodeHits(code, "port", { wholeWord: true }));
    expect([...ww].every((line) => plain.has(line))).toBe(true);
    expect(ww.size).toBeLessThan(plain.size);
    expect(activeLineOf(findCodeHits(code, "port", { caseSensitive: true }), 0)).toBe(1);
    expect(activeLineOf(findCodeHits(code, "port"), 0)).toBe(0);
  });
});

describe("findCodeHits 命中上限（轮28 F-10）", () => {
  // 一行一处命中，第 i 处命中在第 i 行，便于逐处核对偏移/行列没有因为截断而漂移
  const many = Array.from({ length: MAX_CODE_HITS + 300 }, (_, i) => `k${i} = needle-${i}`).join("\n");
  const uncapped = () => findCodeHits(many, "needle", {}, Number.MAX_SAFE_INTEGER);

  it("默认扫到 MAX_CODE_HITS 就停，且 isHitScanCapped 报得出「被动停的」", () => {
    const hits = findCodeHits(many, "needle");
    expect(hits).toHaveLength(MAX_CODE_HITS);
    expect(isHitScanCapped(hits)).toBe(true);
    expect(isHitScanCapped(uncapped())).toBe(true); // 远超上限时同样只能说「还有更多」
    expect(isHitScanCapped(findCodeHits("needle\nneedle", "needle"))).toBe(false);
    expect(isHitScanCapped([])).toBe(false);
  });

  it("截断只是少取，不改前缀的顺序 / 行 / 列 / 偏移口径", () => {
    const capped = findCodeHits(many, "needle");
    const full = uncapped();
    expect(capped).toEqual(full.slice(0, MAX_CODE_HITS));
    expect(capped.map((h) => h.line)).toEqual(capped.map((_, i) => i));
    const rowTexts = many.split("\n");
    expect(capped.map((h) => h.column)).toEqual(capped.map((h) => rowTexts[h.line].indexOf("needle")));
    for (const hit of capped) expect(many.slice(hit.offset, hit.offset + hit.length)).toBe("needle");
  });

  it("自定义 limit 同样提前停：只要前 N 处就不该看到第 N+1 处", () => {
    const hits = findCodeHits(many, "needle", {}, 3);
    expect(hits).toHaveLength(3);
    expect(hits[2]).toEqual(uncapped()[2]);
    expect(isHitScanCapped(hits, 3)).toBe(true);
    // 上限小于命中数时不该把「刚好等于 limit」当成完整结果误报为未截断
    expect(isHitScanCapped(findCodeHits(many, "needle", {}, 4), 3)).toBe(true);
  });

  it("匹配语义不受上限影响（大小写 / 全词 / 外部搜索词中性口径）", () => {
    const code = Array.from({ length: 20000 }, (_, i) => (i % 2 ? "PORT" : "port")).join("\n");
    expect(findCodeHits(code, "port", { caseSensitive: true })).toHaveLength(MAX_CODE_HITS);
    expect(findCodeHits(code, "port", { wholeWord: true })).toHaveLength(MAX_CODE_HITS);
    expect(findCodeHits(code, "port", { wholeWord: true })).toEqual(findCodeHits(code, "port"));
  });

  it("空词 / 无命中 / 纯空白词不会被上限逻辑误判成截断", () => {
    expect(findCodeHits(many, "   ")).toEqual([]);
    expect(findCodeHits(many, "zzz")).toEqual([]);
    expect(isHitScanCapped(findCodeHits(many, "zzz"))).toBe(false);
  });
});

describe("markLineSearchHits（轮41：逐行视图复用同一套标记层）", () => {
  // UnifiedDiff 每行单独产 HTML（highlightLine 或 escapeHtml），偏移只能在这一行自己的文本流上算。
  // 这几条断言钉的是「复用之后文本契约不破」：剥标签 + 反转义必须逐字等于原行。
  const lines: Array<[string, Parameters<typeof highlightCode>[1]]> = [
    ['  url: "http://a.com?x=1&y=2" # enabled', "YAML"],
    ["  key: it's enabled & <b>", "YAML"],
    ['{"enabled":true,"html":"<i>&amp;</i>"}', "JSON"],
    ["plain enabled & <tag>", "TEXT"],
    ["&amp; 字面实体也在 enabled 这行", "YAML"],
  ];

  function lineBase(line: string, fmt: Parameters<typeof highlightCode>[1]): string {
    return fmt === "TEXT" ? escapeHtml(line) : highlightLine(line, fmt);
  }

  it("标完后剥标签逐字等于原行，且命中真的被 <mark> 包住", () => {
    for (const [line, fmt] of lines) {
      const { html, isHit } = markLineSearchHits(lineBase(line, fmt), line, "enabled");
      expect(isHit, `该行应有命中：${line}`).toBe(true);
      expect(textContent(html), `文本契约被破坏：${line}`).toBe(line);
      expect(html).toContain('class="search-hit"');
    }
  });

  it("无词 / 纯空白词 / 词不在本行 ⇒ 原样返回且 isHit=false", () => {
    for (const term of ["", "   ", "zzz-not-here"]) {
      for (const [line, fmt] of lines) {
        const base = lineBase(line, fmt);
        const { html, isHit } = markLineSearchHits(base, line, term);
        expect(isHit, `词「${term}」不该判成命中`).toBe(false);
        expect(html).toBe(base);
      }
    }
  });

  it("口径固定中性：大小写不敏感的子串照标（与外部搜索词一致）", () => {
    const line = "Enabled: true";
    const { html, isHit } = markLineSearchHits(escapeHtml(line), line, "enabled");
    expect(isHit).toBe(true);
    expect(textContent(html)).toBe(line);
    expect(html).toContain(">Enabled</mark>");
  });

  it("一行多处全部标出；data-hit 只是行内下标（跨行重号是既定口径）", () => {
    const a = "enabled enabled";
    const b = "enabled";
    const markedA = markLineSearchHits(escapeHtml(a), a, "enabled");
    const markedB = markLineSearchHits(escapeHtml(b), b, "enabled");
    expect((markedA.html.match(/<mark /g) ?? []).length).toBe(2);
    expect((markedA.html.match(/data-hit="0"/g) ?? []).length).toBe(1);
    expect((markedA.html.match(/data-hit="1"/g) ?? []).length).toBe(1);
    // 下一行的第一处又回到 0 ⇒ 这条路径拿 data-hit 当全局编号就会跳错位置（守卫测试钉住）
    expect(markedB.html).toContain('data-hit="0"');
  });

  it("跨语法 token 的命中也能标（与整篇管线同一能力）", () => {
    // properties 把 server.port=8080 拆成 attr + string 两个 token，搜 port=8080 会跨过去，
    // 这正是「在原文上匹配、在 HTML 上切分」这套口径存在的理由（整篇管线同款能力）。
    const line = "server.port=8080";
    const { html, isHit } = markLineSearchHits(highlightLine(line, "Properties"), line, "port=8080");
    expect(isHit).toBe(true);
    expect(textContent(html)).toBe(line);
    expect(html.match(/<mark /g)?.length).toBeGreaterThan(1);
  });
});
