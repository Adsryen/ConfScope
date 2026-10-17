// CodeView 的行号 / 命中定位 / 搜索标记 / 缩略图分桶逻辑，全部为纯函数，
// 便于在 jsdom 之外单测。核心不变式：markHighlightedHtml 产出的 HTML，
// 剥离标签并反转义后必须与原始代码逐字符相等（保证 .code-area 的
// textContent 契约不被破坏，retest 用它读取文件内容）。

import { escapeHtml } from "./highlight";
import { matchLiteral, type MatchRange } from "./textMatch";

/** 代码在整体文本空间里的一次命中。 */
export interface CodeHit {
  /** 0 基行号。 */
  line: number;
  /** 0 基列号（相对该行行首）。 */
  column: number;
  /** 0 基偏移（相对整个文档原始文本）。 */
  offset: number;
  /** 命中文本长度（按原文计）。 */
  length: number;
}

/** 按 \n 切行，保留每行原有的 \r（CRLF 文件行尾偏移才能还原）。 */
export function splitLines(code: string): string[] {
  if (code === "") return [];
  return code.split("\n");
}

/** 每行行首在整文档中的偏移（splitLines 口径，行间以单个 \n 相隔）。 */
export function lineOffsets(lines: string[]): number[] {
  const offsets: number[] = [];
  let acc = 0;
  for (const line of lines) {
    offsets.push(acc);
    acc += line.length + 1; // +1 对应分隔的 \n
  }
  return offsets;
}

/**
 * 在整段代码里查找搜索词的全部字面命中，返回带行/列/偏移的结果。
 * 直接在原始文本上匹配（而非高亮后的 HTML），这样跨语法 token 的命中
 * 也能被找到（例如 properties 里被 hljs 拆成两段的 server.port=8080），
 * 与列表端的字面搜索保持完全一致。
 */
export function findCodeHits(code: string, term: string): CodeHit[] {
  const needle = term.trim();
  if (!needle) return [];
  const lines = splitLines(code);
  const offsets = lineOffsets(lines);
  const hits: CodeHit[] = [];
  for (const { index, length } of matchLiteral(code, needle)) {
    const line = lineIndexOfOffset(offsets, index);
    const lineStart = offsets[line] ?? 0;
    hits.push({ line, column: index - lineStart, offset: index, length });
  }
  return hits;
}

function lineIndexOfOffset(offsets: number[], offset: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 命中行集合（用于行高亮 / 缩略图标记）。 */
export function hitLines(hits: CodeHit[]): Set<number> {
  const set = new Set<number>();
  for (const hit of hits) set.add(hit.line);
  return set;
}

const HLJS_TOKEN = /(<[^>]*>)|([^<]+)/g;
const COMMENT_PREFIXES = ["#", "//", "/*", "*", ";", "--", "<!--"];

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  if (!trimmed) return false;
  return COMMENT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function isBlankLine(line: string): boolean {
  return line.trim() === "";
}

/**
 * 在已转义的高亮 HTML 文本区里，把命中区间包进 <mark class="search-hit">。
 * 做法：把 HTML 拆成「标签」与「文本」两类片段，只对文本片段按其解码后的
 * 整文档偏移做切分，再逐段用 escapeHtml 重新转义输出——标签结构原样保留，
 * 文本经过一次「解码→再转义」回到与输入等价的形态。搜索词因此能正确标红，
 * 且不会再出现历史版本里 &amp;amp; 这样的二次转义。
 * 命中跨越标签边界时，会在两侧各产出一个 <mark>（视觉上仍是连续标红）。
 */
export function markHighlightedHtml(html: string, hits: CodeHit[], activeOffset: number | null): string {
  if (!hits.length) return html;
  const ranges: Array<{ start: number; end: number; active: boolean }> = hits
    .map((hit) => ({
      start: hit.offset,
      end: hit.offset + hit.length,
      active: activeOffset !== null && hit.offset === activeOffset,
    }))
    .sort((a, b) => a.start - b.start);

  let out = "";
  let pos = 0; // 当前文本片段起点在整文档解码文本中的偏移
  let rangeCursor = 0;
  HLJS_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HLJS_TOKEN.exec(html)) !== null) {
    const tag = match[1];
    if (tag !== undefined) {
      out += tag; // 标签内部不标记，避免破坏结构
      continue;
    }
    const raw = match[2];
    const decoded = decodeHljsText(raw);
    const segStart = pos;
    const segEnd = pos + decoded.length;

    let cursor = segStart;
    // 前进到可能覆盖本片段的第一个 range
    while (rangeCursor < ranges.length && ranges[rangeCursor].end <= segStart) rangeCursor += 1;
    let probe = rangeCursor;
    while (probe < ranges.length && ranges[probe].start < segEnd) {
      const range = ranges[probe];
      if (range.end > cursor) {
        if (range.start > cursor) {
          out += escapeHtml(decoded.slice(cursor - segStart, range.start - segStart));
          cursor = range.start;
        }
        const clipEnd = Math.min(range.end, segEnd);
        const cls = range.active ? "search-hit search-hit-current" : "search-hit";
        out += `<mark class="${cls}">` + escapeHtml(decoded.slice(cursor - segStart, clipEnd - segStart)) + "</mark>";
        cursor = clipEnd;
      }
      probe += 1;
    }
    if (cursor < segEnd) {
      out += escapeHtml(decoded.slice(cursor - segStart));
    }
    pos = segEnd;
  }
  return out;
}

/**
 * 反转 highlight.js 在文本节点里可能产出的实体：&amp; &lt; &gt; &quot; &#39;
 * 以及 &#xHH;/&#DDD; 数字实体。highlight.js 会按语言把 " 转成 &quot;、
 * 把 ' 转成 &#x27;（TEXT 只转 & < >），若只反转 & < > 就会让解码后的文本长度
 * 与原文错开，命中偏移随之失真。这里做「单次左到右扫描」：每消费一个实体就整体
 * 跳过其源码，绝不二次解码，因此原文里字面出现的 &amp; 不会被误还原。
 */
function decodeHljsText(raw: string): string {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch !== "&") {
      out += ch;
      i += 1;
      continue;
    }
    if (raw.startsWith("&amp;", i)) {
      out += "&";
      i += 5;
      continue;
    }
    if (raw.startsWith("&lt;", i)) {
      out += "<";
      i += 4;
      continue;
    }
    if (raw.startsWith("&gt;", i)) {
      out += ">";
      i += 4;
      continue;
    }
    if (raw.startsWith("&quot;", i)) {
      out += '"';
      i += 6;
      continue;
    }
    if (raw.startsWith("&#39;", i)) {
      out += "'";
      i += 5;
      continue;
    }
    if (raw.startsWith("&apos;", i)) {
      out += "'";
      i += 6;
      continue;
    }
    // 数字实体 &#DDD; / &#xHH;（大小写 x 均可）
    const semi = raw.indexOf(";", i + 1);
    if (semi > i && semi - i <= 10) {
      const body = raw.slice(i + 1, semi);
      if (body[0] === "#") {
        const hex = body[1] === "x" || body[1] === "X";
        const digits = hex ? body.slice(2) : body.slice(1);
        const code = digits ? parseInt(digits, hex ? 16 : 10) : NaN;
        if (!Number.isNaN(code) && code >= 0 && code <= 0x10ffff) {
          out += String.fromCodePoint(code);
          i = semi + 1;
          continue;
        }
      }
    }
    // 未知或残缺的 &：原样保留
    out += "&";
    i += 1;
  }
  return out;
}

/** 缩略图中一行的抽象（多个真实行分桶到一行）。 */
export interface MinimapRow {
  startLine: number;
  endLine: number; // 不含
  /** 该行桶内最长行相对全文最长行的比例（0~1），用于条宽。 */
  widthRatio: number;
  kind: "blank" | "comment" | "code";
  hasHit: boolean;
  isCurrent: boolean;
}

/**
 * 把所有行分桶到固定 rowLimit 行，供 canvas 缩略图逐行画条。
 * 命中行标 hasHit，当前命中行标 isCurrent。
 */
export function buildMinimapRows(lines: string[], hits: Set<number>, currentLine: number | null, rowLimit: number): MinimapRow[] {
  const total = lines.length;
  if (!total) return [];
  const limit = Math.max(1, Math.min(rowLimit, total));
  const perRow = Math.ceil(total / limit);
  const rows = Math.ceil(total / perRow);

  let maxLen = 1;
  for (const line of lines) {
    const len = line.replace(/\t/g, "  ").length;
    if (len > maxLen) maxLen = len;
  }

  const out: MinimapRow[] = [];
  for (let r = 0; r < rows; r += 1) {
    const startLine = r * perRow;
    const endLine = Math.min(startLine + perRow, total);
    let longest = 0;
    let kind: MinimapRow["kind"] = "blank";
    let hasHit = false;
    let isCurrent = false;
    for (let li = startLine; li < endLine; li += 1) {
      const line = lines[li];
      const len = line.replace(/\t/g, "  ").length;
      if (len > longest) longest = len;
      if (hits.has(li)) hasHit = true;
      if (li === currentLine) isCurrent = true;
      if (kind === "blank" && !isBlankLine(line)) {
        kind = isCommentLine(line) ? "comment" : "code";
      }
    }
    out.push({ startLine, endLine, widthRatio: longest / maxLen, kind, hasHit, isCurrent });
  }
  return out;
}

/** 由命中列表得到「当前命中」的偏移（activeIdx 越界时回退到首个命中）。 */
export function activeOffsetOf(hits: CodeHit[], activeIdx: number): number | null {
  if (!hits.length) return null;
  const idx = activeIdx >= 0 && activeIdx < hits.length ? activeIdx : 0;
  return hits[idx].offset;
}

/** 由命中列表得到「当前命中」所在行。 */
export function activeLineOf(hits: CodeHit[], activeIdx: number): number | null {
  if (!hits.length) return null;
  const idx = activeIdx >= 0 && activeIdx < hits.length ? activeIdx : 0;
  return hits[idx].line;
}

export type { MatchRange };
