import { useMemo } from "react";
import { Format } from "../lib/format";
import { highlightCode } from "../lib/highlight";

import { highlightSearchTerm } from "../lib/configContentSearch";

interface Props {
  code: string;
  format: Format;
  /** 内容搜索词：在已转义的高亮 HTML 文本上二次标记命中词（大小写不敏感）。 */
  searchTerm?: string;
}

/** IDE 风格的只读代码展示：按格式做语法高亮，沿用 .code-area 的滚动/字体。
 *  注意：HTML 解析会把“片段末尾的换行”再补一个换行（<div>x\n</div> 解析后
 *  textContent 为 x\n\n），为保持渲染文本与原文严格一致（行高、选区、复制），
 *  末尾换行不用裸 "\n" 表示，而是附加一个空 span（解析后不产生额外文本）。 */
export default function CodeView({ code, format, searchTerm }: Props) {
  const html = useMemo(() => {
    const base = highlightCode(code, format);
    // 末尾换行的安全表示：不依赖 HTML 解析行为
    const withTail = code.endsWith("\n") ? base + "<span></span>" : base;
    const term = searchTerm?.trim();
    // 只在已转义的 HTML 的“文本区”做标记：跳过 <...> 标签内部，避免破坏标记结构
    if (!term) return withTail;
    const pattern = new RegExp("(<[^>]*>)|([^<]+)", "g");
    let out = "";
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(withTail)) !== null) {
      out += m[1] ?? highlightSearchTerm(m[2] ?? "", term);
    }
    return out;
  }, [code, format, searchTerm]);
  return (
    <pre className="code-area mono hljs">
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}
