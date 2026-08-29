import { useMemo, useState } from "react";
import { useTranslation } from "../i18n";
import { type RowType, diffLines } from "../lib/diff";
import { Format } from "../lib/format";
import { highlightLine } from "../lib/highlight";

export type MergeActionDirection = "left-to-right" | "right-to-left";
export type MergeActionScope = "row" | "block";

export interface MergeActionLabels {
  leftToRight: string;
  rightToLeft?: string;
}

export interface MergeActionState {
  direction: MergeActionDirection;
}

export type MergeActionAvailability = Partial<Record<MergeActionDirection, boolean>>;

interface Props {
  leftLabel: string;
  rightLabel: string;
  leftText: string;
  rightText: string;
  /** 提供时按该格式做语法高亮（TEXT 不高亮）。 */
  format?: Format;
  onlyChanges?: boolean;
  onOnlyChangesChange?: (value: boolean) => void;
  hideOnlyChangesToggle?: boolean;
  mergeActionLabels?: MergeActionLabels;
  getMergeActionState?: (rowIndex: number) => MergeActionState | undefined;
  mergeActionScope?: MergeActionScope;
  mergeActionAvailability?: MergeActionAvailability;
  onMergeAction?: (rowIndex: number, direction: MergeActionDirection, rowIndexes?: number[]) => void;
  /** 展示在 diff 区顶部的警告条（如 duplicate key 提示）。 */
  warnings?: string[];
}

function mergeActionClass(direction: MergeActionDirection, state?: MergeActionState): string {
  return `diff-merge-btn ${direction}${state?.direction === direction ? " active" : ""}`;
}

function rowHasMergeActions(type: RowType): boolean {
  return type !== "equal";
}

function changeBlockIndexes(rows: { type: RowType }[], rowIndex: number): number[] {
  const indexes: number[] = [];
  for (let i = rowIndex; i >= 0 && rowHasMergeActions(rows[i].type); i--) {
    indexes.unshift(i);
  }
  for (let i = rowIndex + 1; i < rows.length && rowHasMergeActions(rows[i].type); i++) {
    indexes.push(i);
  }
  return indexes;
}
function changeBlockPosition(blockIndexes: number[], rowIndex: number): "single" | "first" | "middle" | "last" | null {
  if (blockIndexes.length === 0) return null;
  if (blockIndexes.length === 1 && blockIndexes[0] === rowIndex) return "single";
  if (blockIndexes[0] === rowIndex) return "first";
  if (blockIndexes[blockIndexes.length - 1] === rowIndex) return "last";
  return blockIndexes.includes(rowIndex) ? "middle" : null;
}

function mergeCenterClass(
  blockMode: boolean,
  blockPosition: ReturnType<typeof changeBlockPosition>,
  showActions: boolean
): string {
  const classes = ["diff-merge-center"];
  if (blockMode && blockPosition) {
    classes.push("block-mode");
    classes.push(`block-${blockPosition}`);
    if (blockPosition === "single") classes.push("block-first", "block-last");
  }
  if (showActions) classes.push("has-actions");
  return classes.join(" ");
}

/** 渲染一个 diff 单元格：有可高亮格式时输出语法高亮 HTML，否则纯文本。 */
function Cell({ text, side, format }: { text: string | null; side: string; format?: Format }) {
  if (text == null) return <pre className={`diff-cell ${side}`} />;
  if (format && format !== "TEXT") {
    return <pre className={`diff-cell ${side}`} dangerouslySetInnerHTML={{ __html: highlightLine(text, format) }} />;
  }
  return <pre className={`diff-cell ${side}`}>{text}</pre>;
}

/** 并排展示两段文本的智能行级差异：增/删/改高亮 + 变更统计，可只看变更行。 */
export default function DiffPanel({
  leftLabel,
  rightLabel,
  leftText,
  rightText,
  format,
  onlyChanges: controlledOnlyChanges,
  onOnlyChangesChange,
  hideOnlyChangesToggle = false,
  mergeActionLabels,
  getMergeActionState,
  mergeActionScope = "block",
  mergeActionAvailability,
  onMergeAction,
  warnings,
}: Props) {
  const { t } = useTranslation();
  const [localOnlyChanges, setLocalOnlyChanges] = useState(false);
  const onlyChanges = controlledOnlyChanges ?? localOnlyChanges;
  const setOnlyChanges = (value: boolean) => {
    if (controlledOnlyChanges === undefined) setLocalOnlyChanges(value);
    onOnlyChangesChange?.(value);
  };
  const result = useMemo(() => diffLines(leftText, rightText), [leftText, rightText]);

  const rows = useMemo(
    () => result.rows.map((row, rowIndex) => ({ row, rowIndex })).filter((entry) => !onlyChanges || entry.row.type !== "equal"),
    [result, onlyChanges]
  );

  const identical = result.added === 0 && result.removed === 0 && result.modified === 0;

  return (
    <div className="diff-panel">
      {warnings && warnings.length > 0 && (
        <div className="diff-warnings" role="status">
          {warnings.map((warning, index) => (
            <div className="diff-warning" key={index}>
              {"\u26A0"} {warning}
            </div>
          ))}
        </div>
      )}
      <div className="diff-stats">
        {identical ? (
          <span className="diff-same">{t("diff.sideBySideIdentical")}</span>
        ) : (
          <>
            <span className="stat stat-add">{t("diff.statAdded", { count: result.added })}</span>
            <span className="stat stat-del">{t("diff.statDeleted", { count: result.removed })}</span>
            <span className="stat stat-mod">{t("diff.statModified", { count: result.modified })}</span>
          </>
        )}
        {!hideOnlyChangesToggle && (
          <label className="diff-toggle">
            <input type="checkbox" checked={onlyChanges} onChange={(e) => setOnlyChanges(e.target.checked)} />
            {t("diff.onlyChanges")}
          </label>
        )}
      </div>

      <div className={`diff-head${onMergeAction ? " with-merge" : ""}`}>
        <div className="diff-head-cell" title={leftLabel}>
          {leftLabel}
        </div>
        {onMergeAction && <div className="diff-head-merge" aria-hidden="true" />}
        <div className="diff-head-cell" title={rightLabel}>
          {rightLabel}
        </div>
      </div>

      <div className="diff-body mono">
        {rows.length === 0 ? (
          <div className="diff-empty">{t("diff.noDiffRows")}</div>
        ) : (
          rows.map(({ row: r, rowIndex }) => {
            const mergeState = getMergeActionState?.(rowIndex);
            const canMerge = Boolean(onMergeAction && mergeActionLabels && rowHasMergeActions(r.type));
            const canMergeLeftToRight = mergeActionAvailability?.["left-to-right"] ?? true;
            const canMergeRightToLeft = mergeActionAvailability?.["right-to-left"] ?? true;
            const blockMode = mergeActionScope === "block";
            const mergeTargetRows = canMerge && blockMode ? changeBlockIndexes(result.rows, rowIndex) : [rowIndex];
            const blockPosition = canMerge && blockMode ? changeBlockPosition(mergeTargetRows, rowIndex) : null;
            const showMergeActions = canMerge && (!blockMode || mergeTargetRows[0] === rowIndex);
            const showBlockBrace = canMerge && blockMode && blockPosition !== null && blockPosition !== "single";
            return (
              <div
                className={`diff-row ${r.type}${onMergeAction ? " with-merge" : ""}${mergeState ? ` merge-${mergeState.direction}` : ""}`}
                key={rowIndex}
              >
                <span className="diff-gutter">{r.leftNo ?? ""}</span>
                <Cell text={r.left} side="left" format={format} />
                {onMergeAction && (
                  <span className={mergeCenterClass(blockMode, blockPosition, showMergeActions)}>
                    {showBlockBrace && <span className="diff-merge-block-brace" aria-hidden="true" />}
                    {showMergeActions && mergeActionLabels?.rightToLeft && canMergeRightToLeft && (
                      <button
                        type="button"
                        className={mergeActionClass("right-to-left", mergeState)}
                        onClick={() => onMergeAction(rowIndex, "right-to-left", mergeTargetRows)}
                        aria-label={mergeActionLabels.rightToLeft}
                        title={mergeActionLabels.rightToLeft}
                        disabled={!canMergeRightToLeft}
                      >
                        {"\u2190"}
                      </button>
                    )}
                    {showMergeActions && mergeActionLabels && (
                      <button
                        type="button"
                        className={mergeActionClass("left-to-right", mergeState)}
                        onClick={() => onMergeAction(rowIndex, "left-to-right", mergeTargetRows)}
                        aria-label={mergeActionLabels.leftToRight}
                        title={mergeActionLabels.leftToRight}
                        disabled={!canMergeLeftToRight}
                      >
                        {"\u2192"}
                      </button>
                    )}
                  </span>
                )}
                <span className="diff-gutter">{r.rightNo ?? ""}</span>
                <Cell text={r.right} side="right" format={format} />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
