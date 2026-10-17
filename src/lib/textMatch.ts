// 字面文本匹配的基础工具：配置浏览的内容搜索、代码视图的命中高亮、批量替换
// 都要求「原文字面」这同一套语义，这里统一提供，避免各处各写一份
// 而出现「列表说命中了、代码里标不出来」的偏差。

/** 转义正则元字符，使输入按字面量匹配。 */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface MatchRange {
  /** 在原始文本中的起点（含）。 */
  index: number;
  /** 命中长度（按原始文本计，非小写化之后的长度）。 */
  length: number;
}

/** 查找的匹配口径。省略即「大小写不敏感的子串」，与列表内容搜索同源。 */
export interface MatchOptions {
  /** 区分大小写（默认 false）。 */
  caseSensitive?: boolean;
  /** 全词匹配（默认 false）：命中两侧不许紧贴词字符。 */
  wholeWord?: boolean;
}

/**
 * 词字符：字母、数字、下划线（含 CJK），与用户直觉里的「一个词」一致。
 *
 * 为什么不用正则 \b：JS 的 \b 永远按 ASCII \w 判定，加 u 也不变（实测
 * /\b端\b/u 对 "端" 返回 false）。于是「贴 \b」会让中文搜索词变成死条件
 * —— 搜「端口」开了全词，在任何文本里都是 0 命中。所以边界改成匹配之后
 * 用码点直接看左右邻居，语义只由这里定义一次。
 */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWordCodePoint(char: string | undefined): boolean {
  return !!char && WORD_CHAR.test(char);
}

/** 取搜索词首/尾码点（Array.from 按码点迭代，代理对不会被劈开）。 */
function firstCodePoint(text: string): string {
  const it = Array.from(text);
  return it[0] ?? "";
}

function lastCodePoint(text: string): string {
  const it = Array.from(text);
  return it[it.length - 1] ?? "";
}

/** 命中位置左侧紧邻的是一个词字符吗（跨代理对取整个码点）。 */
function isWordBefore(text: string, index: number): boolean {
  if (index <= 0) return false;
  let start = index - 1;
  const unit = text.charCodeAt(start);
  if (unit >= 0xdc00 && unit <= 0xdfff && start > 0) start -= 1; // 低代理：再带上它的高代理
  return isWordCodePoint(text.slice(start, index));
}

/** 命中位置右侧紧邻的是一个词字符吗。 */
function isWordAfter(text: string, end: number): boolean {
  if (end >= text.length) return false;
  let stop = end + 1;
  const unit = text.charCodeAt(end);
  if (unit >= 0xd800 && unit <= 0xdbff && stop < text.length) stop += 1; // 高代理：把低代理一起带上
  return isWordCodePoint(text.slice(end, stop));
}

function compileLiteral(needle: string, { caseSensitive = false }: MatchOptions): RegExp {
  // 转义后的字面量：与改动前逐字符相同（全词不参与正则，见上方注释）。
  return new RegExp(escapeRegex(needle), `g${caseSensitive ? "" : "i"}`);
}

/**
 * 在一段原始文本里做字面匹配，返回按原文索引定位的区间。
 * 用「转义后的正则」而不是「双方 toLowerCase 后 indexOf」，是因为
 * 少数字符（如 U+0130 İ）小写化后会变长，导致列号与原文错位。
 *
 * 默认口径是「大小写不敏感子串」—— 左侧内容搜索的命中数与结果摘要用的就是它，
 * 代码视图在查找栏关闭时必须跟着它走（跨模块不变式，见 configContentSearch.test.ts）。
 * 查找栏自己的选项（区分大小写 / 全词）只在栏打开时参与，见 CodeView / CodeEditor。
 */
export function matchLiteral(text: string, term: string, options: MatchOptions = {}): MatchRange[] {
  const needle = term.trim();
  if (!needle) return [];
  const pattern = compileLiteral(needle, options);
  // 全词边界只在该侧真的是词字符时才要求：
  // 「server.port=」尾部是 =，硬要求右侧非词字符等于要求它后面紧跟词字符再紧跟非词字符，
  // 对 server.port=8080 这种命中永远不成立 —— 开关会把常用搜索词变成死条件。
  const requireHead = options.wholeWord === true && isWordCodePoint(firstCodePoint(needle));
  const requireTail = options.wholeWord === true && isWordCodePoint(lastCodePoint(needle));
  const out: MatchRange[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    if (m[0].length === 0) {
      pattern.lastIndex += 1; // 空匹配防御，避免死循环
      continue;
    }
    const end = m.index + m[0].length;
    if ((requireHead && isWordBefore(text, m.index)) || (requireTail && isWordAfter(text, end))) {
      continue;
    }
    out.push({ index: m.index, length: m[0].length });
  }
  return out;
}
