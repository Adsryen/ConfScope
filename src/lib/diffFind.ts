// 并排差异正文的查找命中枚举（轮48）。
//
// 为什么不能直接用 lib/codeLines 的 `findCodeHits`：那个函数把一整份文本当成**一个文本流**，
// 命中编号 = 它在下标数组里的位置。并排 diff 的一行是**两格**（左 = 旧值，右 = 新值），
// 两格各自还要能标红、各自要能算「这一行的哪一侧命中」，整份文本流这个前提不成立。
// 这里只做一件它自己能证明的事：在「可见行 × 左右侧」这个二维表上扫命中，
// 标红仍交给 `markHighlightedHtml`（单一标记实现，守卫见 tests/ux/findBarSingleImplementation
// 与 diffFindReusesSharedHitLayer），匹配口径仍交给 `textMatch`（大小写 / 全词只许有一份）。
//
// 步进单位是**行**而不是「处」：等行的左右两格逐字相同，按处步进时一次 Enter 只把高亮从左格
// 挪到右格 —— 垂直方向零位移、计数却 +1，用户读到的是「按了回车屏幕没动」（轮29 F-18 的原样复现），
// 分母还虚增一倍。行才是并排视图里用户实际读的单位。

import { findCodeHits, MAX_CODE_HITS, type CodeHit } from "./codeLines";
import type { MatchOptions } from "./textMatch";

export type DiffSide = "left" | "right";

/** 参与查找的一行差异（必须是**渲染出来的**那份行集：编号要与 DOM 里的 `data-hit` 对得上）。 */
export interface DiffFindRow {
  /** `diffLines` 结果里的原始下标，与 `.diff-row` 的 React key / `data-row-index` 同源。 */
  rowIndex: number;
  left: string | null;
  right: string | null;
}

/** 一处标红单元。`index` 全篇唯一，直接落进 `mark data-hit`。 */
export interface DiffMark {
  /** 全篇唯一编号（= `currentHitSelector` 的入参）。 */
  index: number;
  rowIndex: number;
  side: DiffSide;
  /** 相对**本行行首**的偏移（与 `markHighlightedHtml` 拿到的那段 HTML 的文本流同一口径）。 */
  column: number;
  length: number;
}

/** 一个步进单位：一处命中行。组内每格里的每一处标红都同时是「当前命中」。 */
export interface DiffHitGroup {
  rowIndex: number;
  /** 组内标红单元的编号，顺序 = 左侧在前、右侧在后、行内按列升序。 */
  markIndexes: number[];
}

export interface DiffFindResult {
  /** 全篇标红单元，顺序 = 行 → 侧 → 列。只用于总量与触顶判断，导航不读它。 */
  marks: DiffMark[];
  /** 步进序列。查找栏的「第 N/M 处」里 M 就是 `groups.length`。 */
  groups: DiffHitGroup[];
  /** `${rowIndex}:${side}` → 该格的全部标红（编号连续，见 `baseIndexForSide`）。 */
  marksByRowSide: Map<string, DiffMark[]>;
  /** 命中所在行（分侧）：行号变红只报给真的有命中的那一侧。 */
  hitRows: Record<DiffSide, Set<number>>;
  /**
   * 扫到 `limit` 被动停手：后面还有多少命中我们并不真的知道。
   * 计数文案的分母仍用 `groups.length`（见 `capped` 的两处取值），不拿 limit 冒充总数。
   */
  capped: boolean;
}

/** 没词 / 没行时共用这一份常量引用：DiffPanel 的 memo 不该因为空结果每次都是新对象而重算。 */
export const EMPTY_DIFF_FIND: DiffFindResult = {
  marks: [],
  groups: [],
  marksByRowSide: new Map(),
  hitRows: { left: new Set(), right: new Set() },
  capped: false,
};

/** 行 + 侧 → 查表键。 */
export function rowSideKey(rowIndex: number, side: DiffSide): string {
  return `${rowIndex}:${side}`;
}

/** 某格要打的标红。没有就返回同一个空数组常量（调用方可以安全地把它喂给 memo）。 */
const NO_MARKS: DiffMark[] = [];
export function marksForRowSide(result: DiffFindResult, rowIndex: number, side: DiffSide): DiffMark[] {
  return result.marksByRowSide.get(rowSideKey(rowIndex, side)) ?? NO_MARKS;
}

/**
 * 把标红单元换成 `markHighlightedHtml` 吃的 `CodeHit` 形状。
 *
 * 偏移口径必须自洽：`markHighlightedHtml` 数的是「它拿到的那一份 HTML 的解码文本流」，
 * 而我们喂给它的是**这一行**的高亮 HTML ⇒ offset 从 0 起算，就是行内列号。
 * 与 `markLineSearchHits`（UnifiedDiff）用的是同一条换算，没有第二套规则。
 */
export function toLineHits(marks: DiffMark[]): CodeHit[] {
  return marks.map((mark) => ({ line: 0, column: mark.column, offset: mark.column, length: mark.length }));
}

/**
 * 本格第一处在**全篇**里的编号 ⇒ 交给 `markHighlightedHtml` 的 `hitIndexBase`。
 * 组内编号按构造就是连号的（同一格内按列升序、一处接着一处分配），这条不变式由
 * `diffFind.test.ts` 钉着：它一旦破了，`currentHitSelector` 会选出别的行的同名编号。
 */
export function baseIndexForSide(marks: DiffMark[]): number {
  return marks.length ? marks[0].index : 0;
}

/** 当前步进的组（越界自动夹回来：换词 / 换口径后旧序号可能越过新的末尾）。 */
export function currentDiffGroup(result: DiffFindResult, activeIdx: number): DiffHitGroup | null {
  if (!result.groups.length) return null;
  const idx = Math.min(Math.max(activeIdx, 0), result.groups.length - 1);
  return result.groups[idx];
}

/**
 * 在可见差异行里查找一个词：逐行、每行先左格后右格，命中编号全篇唯一。
 *
 * 三条口径写在这里，因为它们都会被「顺手改一下」破坏：
 * 1. **只扫传进来的行集**。`onlyChanges` 勾掉等行后，被隐藏的行不许留在编号里 ——
 *    否则「第 3 处」落在 DOM 里根本没有的 `<mark>` 上，Enter 当场失联。
 * 2. **上限按标红单元计**（与 CodeView 同一个 `MAX_CODE_HITS`）：一行左侧可能有几百处
 *    （单行长 JSON 挤在同一格），停在「格」这一层就止不住 DOM 膨胀。
 *    停在某格中间时，那一行的组只收下已经分配出去的那几个编号——宁可少标，不可重号。
 * 3. 大小写 / 全词只经 `textMatch`（`options` 原样透传），与浏览态查找栏同一把尺子。
 */
export function findDiffHits(
  rows: readonly DiffFindRow[],
  term: string,
  options: MatchOptions = {},
  limit = MAX_CODE_HITS
): DiffFindResult {
  const needle = term.trim();
  if (!needle || rows.length === 0) return EMPTY_DIFF_FIND;

  const marks: DiffMark[] = [];
  const groups: DiffHitGroup[] = [];
  const marksByRowSide = new Map<string, DiffMark[]>();
  const hitRows: Record<DiffSide, Set<number>> = { left: new Set(), right: new Set() };
  let capped = false;

  for (const row of rows) {
    const groupMarkIndexes: number[] = [];
    for (const side of ["left", "right"] as const) {
      const text = side === "left" ? row.left : row.right;
      if (text == null || text === "") continue;
      if (marks.length >= limit) {
        capped = true;
        break;
      }
      const found = findCodeHits(text, needle, options, limit - marks.length);
      if (!found.length) continue;
      const bucket: DiffMark[] = [];
      for (const hit of found) {
        const index = marks.length;
        const mark: DiffMark = { index, rowIndex: row.rowIndex, side, column: hit.column, length: hit.length };
        marks.push(mark);
        bucket.push(mark);
        groupMarkIndexes.push(index);
      }
      marksByRowSide.set(rowSideKey(row.rowIndex, side), bucket);
      hitRows[side].add(row.rowIndex);
    }
    if (groupMarkIndexes.length) groups.push({ rowIndex: row.rowIndex, markIndexes: groupMarkIndexes });
    if (marks.length >= limit) {
      capped = true;
      break;
    }
  }

  return { marks, groups, marksByRowSide, hitRows, capped };
}
