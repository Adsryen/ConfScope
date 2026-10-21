import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../i18n";
import { type RowType, diffLines } from "../lib/diff";
import { Format } from "../lib/format";
import { highlightLine } from "../lib/highlight";
import { useWheelSurface } from "../lib/useWheelColumnResolver";
import { markHighlightedHtml } from "../lib/codeLines";
import {
  baseIndexForSide,
  marksForRowSide,
  toLineHits,
  type DiffFindRow,
  type DiffMark,
  type DiffSide,
} from "../lib/diffFind";
import { useScrollResetOnContentChange } from "../lib/useScrollResetOnContentChange";
import { useFindLayer } from "../lib/useFindLayer";
import FindBar, { FindOpenButton } from "./FindBar";

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
  /**
   * 箭头不可用时的理由（轮27 F-9）。
   *
   * 这颗箭头是 icon-only，禁用理由没有第二个可见渠道；而原生 `disabled` 按钮上 Blink 整段跳过
   * title（轮26 F-1 实测）⇒ 不可用时改挂 `aria-disabled` + 点击早退，把理由放进 title。
   * 不给理由时 title 退回动作名（行为同旧版，只是提示变得看得见）。
   */
  mergeActionUnavailableReason?: string;
  onMergeAction?: (rowIndex: number, direction: MergeActionDirection, rowIndexes?: number[]) => void;
  /** 展示在 diff 区顶部的警告条（如 duplicate key 提示）。 */
  warnings?: string[];
  /** 是否启用视图内 Ctrl+F 查找（轮48）。与浏览态 / 编辑态同一个条子、同一对口径开关。 */
  enableFind?: boolean;
  /**
   * 左侧「按内容搜索」的词（轮55 C线）。
   *
   * 语义与 CodeView 的 searchTerm 完全一致：查找栏没开时命中层接这个词，开栏后由栏内的词接管
   * —— 两边各标各的会让人以为搜索坏了。栏关闭 + 有词 = 整篇标红；清空词 = 标红一起退场。
   */
  searchTerm?: string;
  /**
   * 宿主页面当前是否可见可交互。被保活隐藏的页面里不能再挂全局 Ctrl+F 监听：
   * 隐藏时 document.activeElement 退回 body，本面板会把按键判给自己，劫持前台视图的查找
   * （与 CodeView / CodeEditor 同一口径）。
   */
  active?: boolean;
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

interface CellProps {
  text: string | null;
  side: DiffSide;
  format?: Format;
  /** 本格要标的命中（编号全篇连续，见 lib/diffFind 的 baseIndexForSide）。无命中时是同一个空数组常量。 */
  marks: DiffMark[];
}

/**
 * 渲染一个 diff 单元格：语法高亮 HTML + 查找命中标红。
 *
 * 两层 memo 是两笔钱，分开挡（轮28 F-14 在代码视图里挡过同一笔）：
 * - baseHtml 只跟「这一格的文本 + 格式」有关；
 * - markedHtml 只跟「本格分到哪几处命中」有关。
 * 「当前命中」不在这两层里 —— 它走 DOM 类（CURRENT_HIT_CLASS），
 * 所以按 Enter 换一处命中时既不重新高亮也不重新解析 HTML。
 *
 * 一律走 highlightLine(text, format ?? "TEXT")：TEXT 那条分支就是 escapeHtml，
 * 与 React 文本节点在 DOM 上逐字等价，而标红需要的是 HTML。
 */
function Cell({ text, side, format, marks }: CellProps) {
  const baseHtml = useMemo(() => (text == null ? null : highlightLine(text, format ?? "TEXT")), [text, format]);
  const markedHtml = useMemo(
    () => (baseHtml == null ? null : markHighlightedHtml(baseHtml, toLineHits(marks), baseIndexForSide(marks))),
    [baseHtml, marks]
  );
  if (markedHtml == null) return <pre className={`diff-cell ${side}`} />;
  return <pre className={`diff-cell ${side}`} dangerouslySetInnerHTML={{ __html: markedHtml }} />;
}

/**
 * 行号槽的命中态。指示只许走「号码变红」这一个通道：给整行叠背景会把
 * 「这行是新增/删除的」和「这行有命中」挤进同一个视觉通道，而 diff 行的语义底色本来就更响
 * （R41-3，与 .code-ln.is-hit / .udiff-gutter.is-hit 同口径）。
 */
function gutterClass(marks: DiffMark[], isCurrentRow: boolean, currentMarkIndexes: Set<number>): string {
  if (!marks.length) return "diff-gutter";
  const current = isCurrentRow && marks.some((mark) => currentMarkIndexes.has(mark.index));
  return `diff-gutter is-hit${current ? " is-current" : ""}`;
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
  mergeActionUnavailableReason,
  onMergeAction,
  warnings,
  enableFind = true,
  searchTerm,
  active = true,
}: Props) {
  const { t } = useTranslation();
  /** Ctrl+F / F3 的所有权根（轮39 R39-3）：条子、浮标、正文选区都在这棵树里。 */
  const rootRef = useRef<HTMLDivElement>(null);
  const [localOnlyChanges, setLocalOnlyChanges] = useState(false);
  const onlyChanges = controlledOnlyChanges ?? localOnlyChanges;
  const setOnlyChanges = (value: boolean) => {
    if (controlledOnlyChanges === undefined) setLocalOnlyChanges(value);
    onOnlyChangesChange?.(value);
  };
  /**
   * `.diff-body` 是本面板唯一的滚动容器，登记给页面级滚轮兜底当靶子（轮33 F-34）。
   * 兄弟节点 `.diff-warnings` / `.diff-stats` / `.diff-head` 的祖先链里一个可滚容器都没有
   * （research/p3_batch_match_chrome.txt），单文件态那 5 条死区就在这一块；批量态
   * `.diff-stats` / `.diff-head` 还被复用进左列列表项里，所以只能按几何选，不能按 class 选。
   */
  const bodyRef = useRef<HTMLDivElement>(null);
  useWheelSurface(bodyRef);
  const result = useMemo(() => diffLines(leftText, rightText), [leftText, rightText]);

  const rows = useMemo(
    () => result.rows.map((row, rowIndex) => ({ row, rowIndex })).filter((entry) => !onlyChanges || entry.row.type !== "equal"),
    [result, onlyChanges]
  );

  const identical = result.added === 0 && result.removed === 0 && result.modified === 0;

  /* ── 视图内查找（轮48 接入，轮49 交给共享层）─────────────────────────────────
   * 条子是 src/components/FindBar.tsx 那唯一一份，状态与副作用编排是
   * src/lib/useFindLayer.ts 那唯一一份。本面板只剩宿主自己才有的三样东西：
   * 1. `findRows` —— 编号的事实源必须是**渲染出来的**行集；
   * 2. 几何出口 —— `.diff-body` 同时是滚动容器、定位坐标系、关栏后归还焦点的那一层。
   *    为什么这一派不能套代码视图的行号公式：`.diff-cell` 是 pre-wrap + break-all，
   *    一行长 JSON 能在视口里占十几屏，「行 i 的 top = padTop + i * ROW_H」在这里根本不成立
   *    ⇒ 定位必须量 DOM（lib/codeScroll 的 revealRowVertically），净空仍是一个数。
   * 3. 两条标记出口与 sticky 锚点的 JSX。
   */
  const findBarRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  /** ⌕ 浮标的 ref 只服务于本文件的 JSX，共享层不读它（见 useFindLayer 入参处的说明）。 */
  const findOpenBtnRef = useRef<HTMLButtonElement>(null);

  /**
   * 行集必须是渲染出来的 `rows` 而不是 `result.rows`：勾上「仅显示变更」后，
   * 被隐藏的行仍留在编号里，Enter 就会落到 DOM 里根本不存在的 <mark> 上（当场失联）。
   */
  const findRows = useMemo<DiffFindRow[]>(
    () => rows.map(({ row, rowIndex }) => ({ rowIndex, left: row.left, right: row.right })),
    [rows]
  );

  // 批量对比的左右正文现在也参与左侧的跨项内容搜索（轮55 C线）：有词就把整篇标红，
  // 没词（单文件对比、或词被清空）传空串就等于「栏一关没词」，标红与命中表一起清空。
  const find = useFindLayer({
    rows: findRows,
    externalTerm: searchTerm ?? "",
    active,
    enableFind,
    rootRef,
    bodyRef,
    findBarRef,
    findInputRef,
  });
  const {
    findOpen,
    findTerm,
    changeTerm,
    effectiveTerm,
    caseSensitive,
    wholeWord,
    toggleCaseSensitive,
    toggleWholeWord,
    result: findResult,
    hitCount,
    activeIdx,
    currentGroup,
    currentMarkIndexes,
    padTop,
    openFind,
    closeFind,
    navigate,
    onFindKeyDown,
    resetFindForNewContent,
  } = find;

  // 换内容把滚动位置拉回起点（R9）。这条是轮48 顺手修的真 bug：本面板此前根本没接这个 hook，
  // 批量态点下一个 dataId 之后正文仍停在上一份文件的偏移处，看起来像「内容没换」。
  //
  // onReset 是轮56 加的第二件事，顺序由 hook 保证（先归零再回调）：外部搜索词下传时，
  // 归零之后紧接着把首个命中行拉进视口——否则左栏写着「第 25 行」，点进来却永远停在文件开头。
  // 定位口径整个待在 useFindLayer 里（与改词那条出口同一出处），本文件不许自己写 scrollTop。
  useScrollResetOnContentChange(bodyRef, [leftText, rightText], find.locateFirstExternalHit);

  // 换内容同时收起查找栏，防止旧关键词污染新内容。
  // 这里**不许**改成调用 closeFind：换文件是用户在列表里点出来的，焦点该留在他点的位置；
  // closeFind 的语义是「我刚结束查找，把焦点还给正文」，两条出口别混（R62 口径）。
  useEffect(() => {
    resetFindForNewContent();
  }, [leftText, rightText, resetFindForNewContent]);

  return (
    <div className="diff-panel" ref={rootRef}>
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

      <div className="diff-body mono" ref={bodyRef} tabIndex={0} role="region" aria-label={t("config.content")}>
        {/*
          查找条的锚点（轮48）：`.diff-body` 是本面板唯一的滚动容器，只有它自己的**在流子元素**
          能被 sticky 钉在可见顶缘——条子于是跟着正文滚到哪儿都悬在最上。
          锚点的高度就是净空（padTopForFindBar 那一个数）：开栏时第一行让到条子下面、关栏时归零，
          不需要给 `.diff-panel` 加 position:relative，也不需要动 `.diff-body` 的 padding / overflow
          （那条 overflow 上还钉着 overscroll 守卫）。锚点自己不吃鼠标，免得这条带子挡住行上的
          选区与滚轮；条子与按钮各自吃回去（见 styles.css 的 `.diff-find-anchor > *`）。
        */}
        {enableFind && (
          <div className="diff-find-anchor" style={{ height: `${padTop}px` }}>
            {findOpen ? (
              <FindBar
                term={findTerm}
                hasTerm={Boolean(effectiveTerm)}
                hitCount={hitCount}
                currentHit={activeIdx}
                capped={findResult.capped}
                cappedMax={hitCount}
                caseSensitive={caseSensitive}
                wholeWord={wholeWord}
                onTermChange={changeTerm}
                onInputKeyDown={onFindKeyDown}
                onToggleCaseSensitive={toggleCaseSensitive}
                onToggleWholeWord={toggleWholeWord}
                onNavigate={navigate}
                onClose={closeFind}
                barRef={findBarRef}
                inputRef={findInputRef}
              />
            ) : (
              <FindOpenButton onOpen={openFind} btnRef={findOpenBtnRef} />
            )}
          </div>
        )}
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
            // 点不动时 title 换成理由：这颗箭头是 icon-only，理由看不见就等于没修（轮27 F-9）。
            // 宿主没给理由则退回动作名，不留空提示。
            const leftToRightTitle = (!canMergeLeftToRight && mergeActionUnavailableReason) || mergeActionLabels?.leftToRight || "";
            // 左右两格各自分到哪些命中（无命中的格子拿到同一个空数组常量 ⇒ memo 不重算）
            const leftMarks = marksForRowSide(findResult, rowIndex, "left");
            const rightMarks = marksForRowSide(findResult, rowIndex, "right");
            const isCurrentRow = currentGroup?.rowIndex === rowIndex;
            return (
              <div
                className={`diff-row ${r.type}${onMergeAction ? " with-merge" : ""}${mergeState ? ` merge-${mergeState.direction}` : ""}`}
                key={rowIndex}
                // 步进与定位都按行算，这一颗属性就是「序号 → DOM 那一行」的唯一出口，
                // 由 lib/codeScroll 的 revealRowVertically 拿去量矩形（不许在组件里换成公式近似）。
                data-row-index={rowIndex}
              >
                <span className={gutterClass(leftMarks, isCurrentRow, currentMarkIndexes)}>{r.leftNo ?? ""}</span>
                <Cell text={r.left} side="left" format={format} marks={leftMarks} />
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
                        // 旧版这里写着 disabled={!canMergeRightToLeft}，但本行的渲染条件已经要求
                        // canMergeRightToLeft 为真才画这颗箭头 ⇒ 那个表达式永远取 false，是死代码。
                      >
                        {"\u2190"}
                      </button>
                    )}
                    {showMergeActions && mergeActionLabels && (
                      <button
                        type="button"
                        className={mergeActionClass("left-to-right", mergeState)}
                        onClick={() => {
                          // 不可用时照样响应点击（原生 disabled 会把事件整颗吞掉，提示也就没处显示），
                          // 所以这道早退闸就是「点不动」的实现本身。
                          if (!canMergeLeftToRight) return;
                          onMergeAction(rowIndex, "left-to-right", mergeTargetRows);
                        }}
                        aria-label={mergeActionLabels.leftToRight}
                        // 键盘 Enter / Space 在原生 button 上会合成一次 click ⇒ 这道闸同时护住键盘路径。
                        aria-disabled={!canMergeLeftToRight || undefined}
                        title={leftToRightTitle}
                      >
                        {"\u2192"}
                      </button>
                    )}
                  </span>
                )}
                <span className={gutterClass(rightMarks, isCurrentRow, currentMarkIndexes)}>{r.rightNo ?? ""}</span>
                <Cell text={r.right} side="right" format={format} marks={rightMarks} />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
