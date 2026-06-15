import { useRef } from "react";
import { Format } from "../lib/format";
import { highlightCode } from "../lib/highlight";

interface Props {
  value: string;
  onChange: (v: string) => void;
  format: Format;
  placeholder?: string;
}

/** 带语法高亮的可编辑代码框:透明 textarea 叠在高亮 <pre> 之上,
 *  光标/选区来自 textarea,着色来自下层 pre,滚动同步。配色与 CodeView 一致。 */
export default function CodeEditor({ value, onChange, format, placeholder }: Props) {
  const preRef = useRef<HTMLPreElement>(null);
  // 末尾补一个换行,保证最后一行(及 textarea 末尾空行)与高亮层高度对齐
  const html = highlightCode(value, format) + "\n";

  const syncScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    const pre = preRef.current;
    if (pre) {
      pre.scrollTop = e.currentTarget.scrollTop;
      pre.scrollLeft = e.currentTarget.scrollLeft;
    }
  };

  // Tab 键插入两个空格而不是切换焦点
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = e.currentTarget;
      const { selectionStart: s, selectionEnd: end } = ta;
      const next = value.slice(0, s) + "  " + value.slice(end);
      onChange(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = s + 2;
      });
    }
  };

  return (
    <div className="code-editor">
      <pre ref={preRef} className="code-editor-pre mono hljs" aria-hidden="true">
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
      <textarea
        className="code-editor-ta mono"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
