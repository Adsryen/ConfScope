/**
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { highlightCode } from "./highlight";
import {
  activeLineOf,
  activeOffsetOf,
  buildMinimapRows,
  findCodeHits,
  hitLines,
  lineOffsets,
  markHighlightedHtml,
  normalizeLineEndings,
  splitLines,
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
    const marked = markHighlightedHtml(html, hits, hits[0]?.offset ?? null);
    expect(textContent(marked)).toBe(code);
  });

  it("never produces double-escaped entities (the historical &amp;amp; bug)", () => {
    const code = "a & b < c > \"d\" 'e'\nport 8080\n";
    const html = baseHtml(code, "XML");
    const marked = markHighlightedHtml(html, findCodeHits(code, "port"), null);
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
    const marked = markHighlightedHtml(html, hits, hits[0].offset);
    expect(marked).not.toMatch(/&amp;(amp|lt|gt|quot|#)/);
    const marks = [...marked.matchAll(/<mark[^>]*>([\s\S]*?)<\/mark>/g)].map((m) => m[1]);
    expect(marks.length).toBeGreaterThan(0);
    const decoded = marks.map((m) => m.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")).join("");
    expect(decoded).toBe(term);
    expect(textContent(marked)).toBe(code);
  });
  it('wraps every hit in <mark class="search-hit"> and marks the active one', () => {
    const code = "8080 and 18080\nx 8080";
    const html = baseHtml(code, "TEXT");
    const hits = findCodeHits(code, "8080");
    expect(hits).toHaveLength(3);
    const marked = markHighlightedHtml(html, hits, hits[1].offset);
    expect((marked.match(/<mark class="search-hit">/g) || []).length).toBe(2);
    expect((marked.match(/<mark class="search-hit search-hit-current">/g) || []).length).toBe(1);
    expect(textContent(marked)).toBe(code);
  });

  it("returns html untouched when there are no hits", () => {
    const html = baseHtml("abc", "TEXT");
    expect(markHighlightedHtml(html, [], null)).toBe(html);
  });
});

describe("hitLines / active*Of", () => {
  it("collects distinct hit lines", () => {
    const code = "k=v\nz\nk=v\n";
    expect([...hitLines(findCodeHits(code, "k=v"))]).toEqual([0, 2]);
  });

  it("clamps the active index for offset and line", () => {
    const code = "=1\n=1\n=1";
    const hits = findCodeHits(code, "=1");
    expect(activeLineOf(hits, 1)).toBe(1);
    expect(activeLineOf(hits, 99)).toBe(0);
    expect(activeOffsetOf(hits, -1)).toBe(hits[0].offset);
    expect(activeOffsetOf([], 0)).toBeNull();
    expect(activeLineOf([], 0)).toBeNull();
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
