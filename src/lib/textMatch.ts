// 字面文本匹配的基础工具：配置浏览的内容搜索、代码视图的命中高亮、批量替换
// 都要求「原文字面 + 大小写不敏感」这同一套语义，这里统一提供，避免各处各写一份
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

/**
 * 在一段原始文本里做字面、大小写不敏感的匹配，返回按原文索引定位的区间。
 * 用「转义后的正则 + i 修饰符」而不是「双方 toLowerCase 后 indexOf」，是因为
 * 少数字符（如 U+0130 İ）小写化后会变长，导致列号与原文错位。
 */
export function matchLiteral(text: string, term: string): MatchRange[] {
  const needle = term.trim();
  if (!needle) return [];
  const pattern = new RegExp(escapeRegex(needle), "gi");
  const out: MatchRange[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    if (m[0].length === 0) {
      pattern.lastIndex += 1; // 空匹配防御，避免死循环
      continue;
    }
    out.push({ index: m.index, length: m[0].length });
  }
  return out;
}
