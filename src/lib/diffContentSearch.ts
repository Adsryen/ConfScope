// 批量对比结果里的跨项内容搜索（轮55 C线）。
//
// 为什么单独一个 lib 而不是复用 configContentSearch：那边是「按 dataId 拉正文再搜」，
// 输入是 item + document，还要管替换；这边数据早就在内存里（batchResults 的左右正文），
// 要的只是「这批已加载的对比项里，哪几项的哪一侧写着这个词、在第几行」。
// 两边共用同一套匹配口径（lib/textMatch 的 matchLiteral），所以不会出现
// 「列表说命中了、diff 里标不出来」的老偏差。
import { matchLiteral } from "./textMatch";

/** 命中片段在命中点前后各取多少字符（与配置浏览的内容摘要同窗口，两处读起来该一样长）。 */
const SNIPPET_BEFORE = 28;
const SNIPPET_AFTER = 48;

/**
 * 一次列出的命中配置上限。
 *
 * 截断发生在扫描循环里（攒够就 break，后面的配置不再扫），不是扫完再 slice——
 * 后者一毫秒都省不下。代价是「命中处数」只统计**列出来的**这些配置，
 * 所以 capped 必须落到可见文案上，不能让用户把「前 100 个」读成「一共 100 个」。
 */
export const MAX_DIFF_SEARCH_ITEMS = 100;

export interface DiffSearchableItem {
  dataId: string;
  leftText: string;
  rightText: string;
}

export interface DiffSearchSideHit {
  /** 该侧命中处数，0 表示这一侧没有。 */
  count: number;
  /** 首个命中所在行号（1 起，按该侧正文原始行序）；无命中为 0。 */
  line: number;
  /** 首个命中所在的行片段（已按窗口裁剪，未转义）。无命中为空串。 */
  snippet: string;
}

export interface DiffSearchHit {
  dataId: string;
  left: DiffSearchSideHit;
  right: DiffSearchSideHit;
  /** 左右两侧之和。 */
  total: number;
}

export interface DiffSearchResult {
  /** 真正参与匹配的搜索词（已 trim）。空串表示没在搜。 */
  term: string;
  hits: DiffSearchHit[];
  /** 命中的配置数（未触顶时等于 hits.length）。 */
  matchedItemCount: number;
  /** **已列出**这些配置里的命中处数之和。capped 时它不是全局总数。 */
  listedMatches: number;
  /** 扫过的配置数（触顶时小于输入条数），文案要说清搜了多大范围。 */
  scannedItems: number;
  /** 输入条数，即作用域（用户得知道搜的是哪些东西）。 */
  scopeItems: number;
  /** 是否因上限被动停止扫描。 */
  capped: boolean;
}

const NO_SIDE_HIT: DiffSearchSideHit = { count: 0, line: 0, snippet: "" };

/** 命中点之前的换行数 + 1 = 该侧正文里的行号。 */
function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

/**
 * 取命中点所在的整行，再按窗口裁一刀并压掉首尾空白。
 *
 * `\r` 一并去掉：CRLF 正文里行尾的 `\r` 会被当成可见空白，片段末尾多出个怪字符。
 */
function snippetAtLine(text: string, index: number, length: number): string {
  let start = index;
  while (start > 0 && text[start - 1] !== "\n") start -= 1;
  let end = index + length;
  while (end < text.length && text[end] !== "\n") end += 1;
  const line = text.slice(start, end).replace(/\r/g, "");
  const offset = index - start;
  const from = Math.max(0, offset - SNIPPET_BEFORE);
  const to = Math.min(line.length, offset + length + SNIPPET_AFTER);
  const prefix = from > 0 ? "..." : "";
  const suffix = to < line.length ? "..." : "";
  return `${prefix}${line.slice(from, to).trim()}${suffix}`;
}

function sideHit(text: string, term: string): DiffSearchSideHit {
  const matches = matchLiteral(text, term);
  if (!matches.length) return NO_SIDE_HIT;
  const first = matches[0];
  return {
    count: matches.length,
    line: lineNumberAt(text, first.index),
    snippet: snippetAtLine(text, first.index, first.length),
  };
}

/**
 * 在已加载的批量对比结果里按正文搜一个词。
 *
 * 空词（或全空格）⇒ 空结果：输入框清空时列表要回到「没有搜索态」，
 * 而不是「搜了个空串、把所有配置都算命中」。
 */
export function searchDiffContent(items: DiffSearchableItem[], term: string): DiffSearchResult {
  const needle = term.trim();
  const scopeItems = items.length;
  if (!needle) {
    return { term: "", hits: [], matchedItemCount: 0, listedMatches: 0, scannedItems: 0, scopeItems, capped: false };
  }

  const hits: DiffSearchHit[] = [];
  let scanned = 0;
  let capped = false;
  for (let i = 0; i < items.length; i += 1) {
    scanned += 1;
    const item = items[i];
    const left = sideHit(item.leftText, needle);
    const right = sideHit(item.rightText, needle);
    if (left.count || right.count) {
      hits.push({ dataId: item.dataId, left, right, total: left.count + right.count });
    }
    if (hits.length >= MAX_DIFF_SEARCH_ITEMS) {
      // 攒够就收手：后面还有多少配置没看，必须让人知道（capped）。
      // 「刚好凑满上限且已扫到最后一条」不算触顶——那时数字是真总数，
      // 却会多挂一句「仅列出前 100 个」，把用户引到一个不存在的截断上。
      capped = i + 1 < items.length;
      break;
    }
  }

  return {
    term: needle,
    hits,
    matchedItemCount: hits.length,
    listedMatches: hits.reduce((sum, hit) => sum + hit.total, 0),
    scannedItems: scanned,
    scopeItems,
    capped,
  };
}
