// CodeView 的行号 / 命中定位 / 搜索标记 / 缩略图分桶逻辑，全部为纯函数，
// 便于在 jsdom 之外单测。核心不变式：markHighlightedHtml 产出的 HTML，
// 剥离标签并反转义后必须与原始代码逐字符相等（保证 .code-area 的
// textContent 契约不被破坏，retest 用它读取文件内容）。

import { escapeHtml } from "./highlight";
import { matchLiteral, type MatchOptions, type MatchRange } from "./textMatch";

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

/**
 * textarea 的 value getter 会把 \r\n 和孤立 \r 归一成 \n（Chromium 与 jsdom 实测一致），
 * 所以 DOM 侧的偏移只能在归一后的字符串上算：否则「跳到第 N 行」「选中命中」会整体后移
 * “该位置之前的 \r 个数”个字符，Tab 缩进也会插错位置。
 */
export function normalizeLineEndings(code: string): string {
  return code.includes("\r") ? code.replace(/\r\n?/g, "\n") : code;
}

/** 按 \n 切行，保留每行原有的 \r（浏览态 <pre> 不走 DOM 归一，行尾偏移仍按原文还原）。 */
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
 * 一次查找最多物化多少处命中。
 *
 * 为什么必须有上限（轮28 F-10，实测）：20 万行 / 10MB 的配置里搜「e」有 80 万处，
 * find 464ms、mark 1956ms、产出 47.7MB HTML、80 万个 `<mark>` 节点；2 万行 / 1MB
 * （网关路由表这种日常大小）就有 8 万命中 / 4.7MB。命中是「每按一次 Enter 都要重新消费」
 * 的数据，不设上限等于把整份文件搬进 DOM。
 *
 * 5000 的取值依据：提前停扫后 find 从 581ms 降到 211ms，5000 个 `<mark>` 对浏览器无压力；
 * 再往上（2 万）HTML 体积已经开始随命中数膨胀，而人不可能逐个看完第 5000 处之后的命中。
 *
 * 上限必须让用户看见——见 isHitScanCapped 与查找栏的「第 x/5000+ 处」文案，
 * 悄悄少标几处等于「列表说命中了、代码里标不出来」那类偏差的又一实例。
 */
export const MAX_CODE_HITS = 5000;

/**
 * 在整段代码里查找搜索词的全部字面命中，返回带行/列/偏移的结果。
 * 直接在原始文本上匹配（而非高亮后的 HTML），这样跨语法 token 的命中
 * 也能被找到（例如 properties 里被 hljs 拆成两段的 server.port=8080），
 * 与列表端的字面搜索保持完全一致。
 *
 * options 只服务查找栏（区分大小写 / 全词）；外部内容搜索词必须留空，
 * 否则代码里的标红会和左侧列表的命中数分叉（见 configContentSearch.test.ts）。
 * 上限只截断**数量**，不改匹配语义。
 */
export function findCodeHits(code: string, term: string, options: MatchOptions = {}, limit = MAX_CODE_HITS): CodeHit[] {
  const needle = term.trim();
  if (!needle) return [];
  const lines = splitLines(code);
  const offsets = lineOffsets(lines);
  const hits: CodeHit[] = [];
  for (const { index, length } of matchLiteral(code, needle, options)) {
    const line = lineIndexOfOffset(offsets, index);
    const lineStart = offsets[line] ?? 0;
    hits.push({ line, column: index - lineStart, offset: index, length });
    // 提前停扫（不是扫完再截断）：扫到底才是那 581ms 的来源，截断必须发生在扫描侧。
    if (hits.length >= limit) break;
  }
  return hits;
}

/**
 * 命中数组「长满到上限」＝ 扫描是被动停的，文件里很可能还有更多命中。
 * 恰好只有 limit 处命中时会多报一个「+」，但这句话本身依旧成立：我们确实没看完剩下的部分。
 */
export function isHitScanCapped(hits: CodeHit[], limit = MAX_CODE_HITS): boolean {
  return hits.length >= limit;
}

/** 行首偏移表 → 某偏移所在行（0 基），二分查找。 */
export function lineIndexOfOffset(offsets: number[], offset: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * 把整文档偏移换算成 1 基行列号，供校验报错定位（R28）与「跳到第 N 行」使用。
 * 口径与 splitLines/lineOffsets 一致：CRLF 文件行尾的 \r 记在本行内，
 * 因此列号与用户在编辑器里数出来的位置一致。偏移越界按末尾夹取，
 * 空文档返回 null（V8 偶尔会报出大于长度的 position）。
 */
export function offsetToLineColumn(code: string, offset: number): { line: number; column: number } | null {
  if (!Number.isFinite(offset) || offset < 0) return null;
  const lines = splitLines(code);
  if (!lines.length) return null;
  const offsets = lineOffsets(lines);
  const clamped = Math.min(offset, code.length);
  const line = lineIndexOfOffset(offsets, clamped);
  return { line: line + 1, column: clamped - (offsets[line] ?? 0) + 1 };
}

/**
 * 命中行集合（用于行高亮 / 缩略图标记）。
 *
 * 集合按插入顺序迭代，而 findCodeHits 是从左到右扫的 ⇒ 这份顺序**天然升序**。
 * hitLinesInRange 的二分依赖这条，改动 findCodeHits 的扫描方向时必须一起改。
 */
export function hitLines(hits: CodeHit[]): Set<number> {
  const set = new Set<number>();
  for (const hit of hits) set.add(hit.line);
  return set;
}

/**
 * 从升序的命中行表里取出落在 [start, end) 窗口内的行（轮28 F-15）。
 *
 * 缺陷长什么样：原先两个视图算「可视区内的命中行」都是 `for (const hit of hits)` 线性扫全量，
 * 而且这条计算挂在 visibleRange 上——**每滚一格重扫一遍**。5000 处命中 × 每格一次，
 * 加上命中本来就分布在整篇文档里，滚动时主线程被这份无用重复吃掉一截（实测 20k 行窗口外
 * 占比 99% 以上，扫到的全是白扫）。
 *
 * 输入必须是升序数组（hitLines 的迭代序保证，见其注释）；返回新数组，调用方可直接改。
 */
export function hitLinesInRange(sortedHitLines: number[], start: number, end: number): number[] {
  if (!sortedHitLines.length || end <= start) return [];
  // 二分找第一个 >= start 的下标
  let lo = 0;
  let hi = sortedHitLines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedHitLines[mid] < start) lo = mid + 1;
    else hi = mid;
  }
  const out: number[] = [];
  for (let i = lo; i < sortedHitLines.length && sortedHitLines[i] < end; i += 1) out.push(sortedHitLines[i]);
  return out;
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
 * 当前命中的类名。轮28 F-14 起它**不再由本模块产出**：视图在提交后往对应 <mark> 上切换这个类，
 * 「整篇高亮」与「现在看第几处」于是分成两个成本层——跳一次命中不该重画整篇文档。
 * CSS（styles.css 的 .search-hit.search-hit-current）与 codeScroll 的测量选择器都指向这个名字。
 */
export const CURRENT_HIT_CLASS = "search-hit-current";

/**
 * 第 hitIndex 处命中在 DOM 里的节点选择器。
 * data-hit 由 markHighlightedHtml 打进每个 <mark>，同一处命中被语法 token 切开时
 * 几个 <mark> 共用同一个编号，所以选择器要拿去 querySelectorAll 而不是 querySelector。
 */
export function currentHitSelector(hitIndex: number): string {
  return `mark[data-hit="${hitIndex}"]`;
}

/**
 * 在已转义的高亮 HTML 文本区里，把命中区间包进 <mark class="search-hit" data-hit="编号">。
 * 做法：把 HTML 拆成「标签」与「文本」两类片段，只对文本片段按其解码后的
 * 整文档偏移做切分，再逐段用 escapeHtml 重新转义输出——标签结构原样保留，
 * 文本经过一次「解码→再转义」回到与输入等价的形态。搜索词因此能正确标红，
 * 且不会再出现历史版本里 &amp;amp; 这样的二次转义。
 * 命中跨越标签边界时，会在两侧各产出一个 <mark>（视觉上仍是连续标红）。
 *
 * 编号就是 hits 里的下标：视图靠它把「当前命中」落到 DOM 类上（见 CURRENT_HIT_CLASS），
 * 这样换当前命中时这个函数完全不用重跑。data-hit 是属性，不进 textContent，
 * 「剥离标签后逐字等于原文」这条契约不受影响。
 */
export function markHighlightedHtml(html: string, hits: CodeHit[]): string {
  if (!hits.length) return html;
  const ranges: Array<{ start: number; end: number; hitIndex: number }> = hits
    .map((hit, hitIndex) => ({ start: hit.offset, end: hit.offset + hit.length, hitIndex }))
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
        out +=
          `<mark class="search-hit" data-hit="${range.hitIndex}">` +
          escapeHtml(decoded.slice(cursor - segStart, clipEnd - segStart)) +
          "</mark>";
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

/** 由命中列表得到「当前命中」所在行。 */
export function activeLineOf(hits: CodeHit[], activeIdx: number): number | null {
  if (!hits.length) return null;
  const idx = activeIdx >= 0 && activeIdx < hits.length ? activeIdx : 0;
  return hits[idx].line;
}

export type { MatchRange };
