import { useMemo, useState } from "react";
import { diffLines } from "../lib/diff";

interface Props {
  leftLabel: string;
  rightLabel: string;
  leftText: string;
  rightText: string;
}

/** 并排展示两段文本的智能行级差异：增/删/改高亮 + 变更统计，可只看变更行。 */
export default function DiffPanel({ leftLabel, rightLabel, leftText, rightText }: Props) {
  const [onlyChanges, setOnlyChanges] = useState(false);
  const result = useMemo(() => diffLines(leftText, rightText), [leftText, rightText]);

  const rows = useMemo(
    () => (onlyChanges ? result.rows.filter((r) => r.type !== "equal") : result.rows),
    [result, onlyChanges]
  );

  const identical = result.added === 0 && result.removed === 0 && result.modified === 0;

  return (
    <div className="diff-panel">
      <div className="diff-stats">
        {identical ? (
          <span className="diff-same">✓ 两侧内容完全一致</span>
        ) : (
          <>
            <span className="stat stat-add">+{result.added} 新增</span>
            <span className="stat stat-del">−{result.removed} 删除</span>
            <span className="stat stat-mod">~{result.modified} 修改</span>
          </>
        )}
        <label className="diff-toggle">
          <input
            type="checkbox"
            checked={onlyChanges}
            onChange={(e) => setOnlyChanges(e.target.checked)}
          />
          仅显示变更
        </label>
      </div>

      <div className="diff-head">
        <div className="diff-head-cell" title={leftLabel}>
          {leftLabel}
        </div>
        <div className="diff-head-cell" title={rightLabel}>
          {rightLabel}
        </div>
      </div>

      <div className="diff-body mono">
        {rows.length === 0 ? (
          <div className="diff-empty">无差异行</div>
        ) : (
          rows.map((r, idx) => (
            <div className={`diff-row ${r.type}`} key={idx}>
              <span className="diff-gutter">{r.leftNo ?? ""}</span>
              <pre className="diff-cell left">{r.left ?? ""}</pre>
              <span className="diff-gutter">{r.rightNo ?? ""}</span>
              <pre className="diff-cell right">{r.right ?? ""}</pre>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
