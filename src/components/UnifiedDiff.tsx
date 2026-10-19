import { useMemo, useState } from "react";
import { useTranslation } from "../i18n";
import { markLineSearchHits } from "../lib/codeLines";
import { diffLines } from "../lib/diff";
import { Format } from "../lib/format";
import { escapeHtml, highlightLine } from "../lib/highlight";

interface Props {
  /** 上一版内容（无上一版时传空串，整体视为新增）。 */
  oldText: string;
  /** 当前查看版本的内容。 */
  newText: string;
  /** 提供时按该格式做语法高亮（TEXT 不高亮）。 */
  format?: Format;
  /**
   * 页面级正文搜索词（配置浏览「按内容搜索」模式的词）。
   *
   * 轮41 R41-1：`HistoryView` 的 `rawView` 初值是 `false`，用户点历史版本后**第一眼**看到的就是
   * 这块视图，词没传进来等于「搜完点开历史，默认这一屏一处都不标」。唯一来源仍是 ConfigBrowser
   * （经 HistoryView 透传），本组件不起第二份搜索状态、不复制 searchMode 判定、不读父级 DOM。
   * 缺省 / 空串 / 全空白 ⇒ 一处都不标（R41-4）。
   */
  searchTerm?: string;
}

type LineType = "ctx" | "add" | "del";

/** 统一（单列）差异视图：以「当前版本」为主，改动行用背景色高亮——
 *  新增绿、删除红、修改展开为红(旧)+绿(新)。用于「这一版改了哪些」。 */
export default function UnifiedDiff({ oldText, newText, format, searchTerm }: Props) {
  const { t } = useTranslation();
  const hl = format && format !== "TEXT";
  const [onlyChanges, setOnlyChanges] = useState(false);
  const { rows, added, removed, modified } = useMemo(
    () => diffLines(oldText, newText),
    [oldText, newText]
  );

  const allLines = useMemo(() => {
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

  const lines = useMemo(
    () => (onlyChanges ? allLines.filter((l) => l.type !== "ctx") : allLines),
    [allLines, onlyChanges]
  );

  /**
   * 每行一次「产 HTML → 叠搜索标记」，两者必须同源于这一行（轮41 R41-2/R41-5）。
   *
   * TEXT 档不再走第二个渲染出口（原先是 `<pre>{l.text}</pre>` 交给 React 转义）：
   * `escapeHtml` 的产物与 React 文本节点在 DOM 上等价，而 `markLineSearchHits` 需要拿到
   * 与偏移同一口径的 HTML 才能对齐 —— 两个出口就意味着「高亮档标得到、纯文本档标不到」。
   *
   * 命中指示只走行号变红：`.udiff-row.add/.del` 的背景是「新增/删除」的**语义色**，
   * 被搜索色盖掉就把两件事挤进同一个通道（R41-3）。
   */
  const markedLines = useMemo(
    () =>
      lines.map((l) => {
        const base = hl ? highlightLine(l.text, format!) : escapeHtml(l.text);
        const marked = markLineSearchHits(base, l.text, searchTerm ?? "");
        return { ...l, html: marked.html, isHit: marked.isHit };
      }),
    [lines, hl, format, searchTerm]
  );
  const identical = added === 0 && removed === 0 && modified === 0;

  return (
    <div className="diff-panel">
      <div className="diff-stats">
        {identical ? (
          <span className="diff-same">{t("diff.unifiedNoDiff")}</span>
        ) : (
          <>
            <span className="stat stat-add">{t("diff.statAdded", { count: added })}</span>
            <span className="stat stat-del">{t("diff.statDeleted", { count: removed })}</span>
            <span className="stat stat-mod">{t("diff.statModified", { count: modified })}</span>
          </>
        )}
        <label className="diff-toggle">
          <input type="checkbox" checked={onlyChanges} onChange={(e) => setOnlyChanges(e.target.checked)} />
          {t("diff.onlyChanges")}
        </label>
      </div>
      <div className="udiff mono">
        {markedLines.map((l, i) => (
          <div className={`udiff-row ${l.type}`} key={i}>
            <span className={`udiff-gutter${l.isHit ? " is-hit" : ""}`}>{l.no ?? ""}</span>
            <span className="udiff-mark">{l.type === "add" ? "+" : l.type === "del" ? "−" : " "}</span>
            <pre className="udiff-text" dangerouslySetInnerHTML={{ __html: l.html }} />
          </div>
        ))}
      </div>
    </div>
  );
}
