import { useMemo } from "react";
import { diffLines } from "../lib/diff";
import { Format } from "../lib/format";
import { highlightLine } from "../lib/highlight";

interface Props {
  /** 上一版内容（无上一版时传空串，整体视为新增）。 */
  oldText: string;
  /** 当前查看版本的内容。 */
  newText: string;
  /** 提供时按该格式做语法高亮（TEXT 不高亮）。 */
  format?: Format;
}

type LineType = "ctx" | "add" | "del";

/** 统一（单列）差异视图：以「当前版本」为主，改动行用背景色高亮——
 *  新增绿、删除红、修改展开为红(旧)+绿(新)。用于「这一版改了哪些」。 */
export default function UnifiedDiff({ oldText, newText, format }: Props) {
  const hl = format && format !== "TEXT";
  const { rows, added, removed, modified } = useMemo(
    () => diffLines(oldText, newText),
    [oldText, newText]
  );

  const lines = useMemo(() => {
    const out: { type: LineType; no: number | null; text: string }[] = [];
    for (const r of rows) {
      switch (r.type) {
        case "equal":
          out.push({ type: "ctx", no: r.rightNo, text: r.right ?? "" });
          break;
        case "add":
          out.push({ type: "add", no: r.rightNo, text: r.right ?? "" });
          break;
        case "del":
          out.push({ type: "del", no: r.leftNo, text: r.left ?? "" });
          break;
        case "modify":
          out.push({ type: "del", no: r.leftNo, text: r.left ?? "" });
          out.push({ type: "add", no: r.rightNo, text: r.right ?? "" });
          break;
      }
    }
    return out;
  }, [rows]);

  const identical = added === 0 && removed === 0 && modified === 0;

  return (
    <div className="diff-panel">
      <div className="diff-stats">
        {identical ? (
          <span className="diff-same">✓ 与上一版无差异</span>
        ) : (
          <>
            <span className="stat stat-add">+{added} 新增</span>
            <span className="stat stat-del">−{removed} 删除</span>
            <span className="stat stat-mod">~{modified} 修改</span>
          </>
        )}
      </div>
      <div className="udiff mono">
        {lines.map((l, i) => (
          <div className={`udiff-row ${l.type}`} key={i}>
            <span className="udiff-gutter">{l.no ?? ""}</span>
            <span className="udiff-mark">
              {l.type === "add" ? "+" : l.type === "del" ? "−" : " "}
            </span>
            {hl ? (
              <pre
                className="udiff-text"
                dangerouslySetInnerHTML={{ __html: highlightLine(l.text, format!) }}
              />
            ) : (
              <pre className="udiff-text">{l.text}</pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
