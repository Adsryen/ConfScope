import { useMemo } from "react";
import { Format } from "../lib/format";
import { highlightCode } from "../lib/highlight";

interface Props {
  code: string;
  format: Format;
}

/** IDE 风格的只读代码展示：按格式做语法高亮，沿用 .code-area 的滚动/字体。 */
export default function CodeView({ code, format }: Props) {
  const html = useMemo(() => highlightCode(code, format), [code, format]);
  return (
    <pre className="code-area mono hljs">
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}
