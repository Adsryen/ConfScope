import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "../i18n";
import { type RowType, diffLines } from "../lib/diff";
import { Format } from "../lib/format";
import { highlightLine } from "../lib/highlight";
import { useWheelSurface } from "../lib/useWheelColumnResolver";
import { CURRENT_HIT_CLASS, currentHitSelector, markHighlightedHtml } from "../lib/codeLines";
import {
  baseIndexForSide,
  currentDiffGroup,
  findDiffHits,
  marksForRowSide,
  toLineHits,
  type DiffFindRow,
  type DiffMark,
  type DiffSide,
} from "../lib/diffFind";
import type { MatchOptions } from "../lib/textMatch";
import { EscapePriority, isImeComposing, useEscape } from "../lib/useEscape";
import { FIND_KEY_OWNER_ATTR, takesFindKeyOwnership } from "../lib/findKeyOwnership";
import { pickFindTermOnOpen, selectionTextWithin } from "../lib/findSelection";
import { useDebouncedFindTerm } from "../lib/findInput";
import { useRememberedState } from "../lib/viewState";
import { useScrollResetOnContentChange } from "../lib/useScrollResetOnContentChange";
import { measureFindBarHeight, padTopForFindBar, revealRowVertically } from "../lib/codeScroll";
import FindBar, { FindOpenButton } from "./FindBar";

/**
 * 关栏时的中性口径常量（必须是模块级同一份引用）：命中层 memo 依赖它，
 * 写成对象字面量会让每次渲染都重算一遍 diff 命中表。
 * diff 正文没有「外部内容搜索词」那条路径（左右两侧是取来的原文，不参与左侧列表搜索），
 * 栏一关就等于没词 —— 这份常量存在的意义是让三个宿主的口径形状完全一致。
 */
const NEUTRAL_MATCH_OPTIONS: MatchOptions = {};

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

  /* ── 视图内查找（轮48）────────────────────────────────────────────────────────
   * 条子本身是三个视图共用的一份 FindBar，这里只放状态与几何。
   * 几何与代码视图差在一点上，这一点决定了不能用那一套公式：
   * `.diff-cell` 是 pre-wrap + break-all，一行长 JSON 能在视口里占十几屏行，
   * 「行 i 的 top = padTop + i * ROW_H」在这里根本不成立 ⇒ 定位必须量 DOM
   * （lib/codeScroll 的 revealRowVertically），净空则仍是一个数（padTopForFindBar）。
   */
  const [findOpen, setFindOpen] = useState(false);
  const [findTerm, setFindTerm] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  /**
   * 「我又跳了一次」的纯计数器（轮29 F-18）：命中只剩一行时 `(0+1+1)%1 === 0`，
   * activeIdx 值没变、React 连重渲染都省了，用户连按 Enter 屏幕一动不动。
   */
  const [navTick, setNavTick] = useState(0);
  const [findBarHeight, setFindBarHeight] = useState(0);
  const findBarRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const findOpenBtnRef = useRef<HTMLButtonElement>(null);
  /** 上一轮打上 current 类的 <mark>：换当前命中前逐个摘掉，保证 DOM 里恒有一颗「当前」。 */
  const currentHitMarksRef = useRef<HTMLElement[]>([]);
  // 两个匹配开关与代码视图共用同一对记忆键：切视图不丢口径，且不落 localStorage。
  const [caseSensitive, setCaseSensitive] = useRememberedState<boolean>("codeFind.caseSensitive", false);
  const [wholeWord, setWholeWord] = useRememberedState<boolean>("codeFind.wholeWord", false);

  /**
   * 命中表。行集必须是渲染出来的 `rows` 而不是 `result.rows`：勾上「仅显示变更」后，
   * 被隐藏的行留在编号里，Enter 就会落到 DOM 里根本不存在的 <mark> 上（当场失联）。
   * 输入延迟的入参也按可见行数取——隐藏掉等行之后，这份工作量的确变小了。
   */
  const findRows = useMemo<DiffFindRow[]>(
    () => rows.map(({ row, rowIndex }) => ({ rowIndex, left: row.left, right: row.right })),
    [rows]
  );
  const {
    term: committedFindTerm,
    isPending: findTermPending,
    flush: flushFindTerm,
  } = useDebouncedFindTerm(findTerm, rows.length);
  // diff 正文没有「外部内容搜索词」那条路径（左右是取来的原文，不参与左侧列表搜索）：
  // 栏一关就等于没词，标红与命中表一起清空。
  const effectiveTerm = findOpen ? committedFindTerm : "";
  const matchOptions = useMemo<MatchOptions>(
    () => (findOpen ? { caseSensitive, wholeWord } : NEUTRAL_MATCH_OPTIONS),
    [findOpen, caseSensitive, wholeWord]
  );
  const findResult = useMemo(() => findDiffHits(findRows, effectiveTerm.trim(), matchOptions), [findRows, effectiveTerm, matchOptions]);
  /** 步进单位 = **行**而不是「处」（理由见 lib/diffFind 开头）：等行左右两格逐字相同，
   * 按处步进时一次 Enter 只把高亮从左格挪到右格——垂直零位移、计数却 +1，分母还虚增一倍。 */
  const hitCount = findResult.groups.length;
  const currentGroup = useMemo(() => currentDiffGroup(findResult, activeIdx), [findResult, activeIdx]);
  const currentMarkIndexes = useMemo(() => new Set(currentGroup?.markIndexes ?? []), [currentGroup]);
  /** 顶部净空：关栏 0，开栏 = 条子上缘 8 + 实测条高 + 8，与代码视图同一个公式、同一个出口。 */
  const padTop = padTopForFindBar(0, findOpen, findBarHeight);

  const openFind = useCallback(() => {
    // 选区 > 栏内旧词（轮26 F-3）：按 Ctrl+F 前选中一段配置名，要的就是搜它。
    // 必须在这个函数里、setState 之前同步读：查找输入框一拿到焦点，文档级选区就被清掉了。
    const selectionRaw = selectionTextWithin(bodyRef.current);
    setFindOpen(true);
    setFindTerm((prev) => pickFindTermOnOpen({ previous: prev, selectionRaw }));
    const focusInput = () => {
      const input = findInputRef.current;
      if (input) {
        input.focus();
        input.select();
      }
    };
    // 等查找条挂载后再聚焦；rAF 不可用（如 jsdom 首帧）时退到微任务。
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(focusInput);
    else setTimeout(focusInput, 0);
  }, []);

  const navigate = useCallback(
    (delta: number) => {
      // 输入框里还有没落进命中层的字符：这次按键只负责提交，新词的命中表到位后由落地效应落第一处。
      if (findTermPending) {
        flushFindTerm();
        return;
      }
      const total = findResult.groups.length;
      if (!total) return;
      // updater 只算序号、不滚动（轮29 F-17）：滚动是副作用，写在 updater 里等于交给 React 决定跑几次
      // ——StrictMode 每次更新把 updater 调两遍，一次 Enter 就给 scrollTop 赋值两次。
      setActiveIdx((prev) => (prev + delta + total) % total);
      setNavTick((tick) => tick + 1);
    },
    [findTermPending, flushFindTerm, findResult]
  );

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindTerm("");
    setActiveIdx(0);
    // 归还焦点给正文这一层（tabIndex=0 + role="region"）：少了这一步，条子随卸载一起消失、
    // activeElement 掉回 body，用户接着按方向键 / PageUp 一动不动，必须先用鼠标点一下正文（R62）。
    bodyRef.current?.focus({ preventScroll: true });
  }, []);

  // 查找栏是页面内的瞬时层，必须自己登记 Esc，否则被宿主弹层吃掉（R61）。
  // 两道门：宿主页面被保活隐藏、以及栏没开时都不参与，免得看不见的层抢走按键。
  useEscape(active && findOpen, closeFind, EscapePriority.find);

  // 换词 / 换口径：序号归零。口径必须进依赖——勾上全词后命中会变少，
  // 旧的 activeIdx 可能已经越过新的末尾，计数会显示成一个不存在的位置。
  useEffect(() => {
    setActiveIdx(0);
  }, [effectiveTerm, matchOptions]);

  // 换内容把滚动位置拉回起点（R9）。这条是轮48 顺手修的真 bug：本面板此前根本没接这个 hook，
  // 批量态点下一个 dataId 之后正文仍停在上一份文件的偏移处，看起来像「内容没换」。
  useScrollResetOnContentChange(bodyRef, [leftText, rightText]);

  // 换内容同时收起查找栏，防止旧关键词污染新内容。
  // 这里**不许**改成调用 closeFind：换文件是用户在列表里点出来的，焦点该留在他点的位置；
  // closeFind 的语义是「我刚结束查找，把焦点还给正文」，两条出口别混（R62 口径）。
  useEffect(() => {
    setFindOpen(false);
    setFindTerm("");
    setActiveIdx(0);
  }, [leftText, rightText]);

  // Ctrl+F / Cmd+F / F3：所有权判定收在 lib/findKeyOwnership，与浏览态、编辑态共用一份。
  // 根取 `.diff-panel`：⌕ 浮标、查找条、正文选区都在这棵树里；焦点落在输入框时绝不抢走原生查找。
  useEffect(() => {
    if (!enableFind || !active) return;
    const root = rootRef.current;
    // 注册表与监听同生同灭：摘掉属性就等于「本面板不再认领 Ctrl+F」，
    // 兄弟视图据此（而不是按类名猜）决定该不该让位。
    root?.setAttribute(FIND_KEY_OWNER_ATTR, "1");
    const handler = (e: KeyboardEvent) => {
      // 输入法组合态期间不劫持：此刻按键属于候选词
      if (isImeComposing(e)) return;
      const key = e.key;
      const isFindKey = (e.ctrlKey || e.metaKey) && (key === "f" || key === "F");
      const isF3 = key === "F3";
      if (!isFindKey && !isF3) return;
      // F3 只在查找栏已打开时导航，否则把原生行为留给系统
      if (isF3 && !findOpen) return;
      if (!takesFindKeyOwnership({ target: e.target, root: rootRef.current })) return;
      e.preventDefault();
      if (isF3) {
        navigate(e.shiftKey ? -1 : 1);
        return;
      }
      openFind();
    };
    window.addEventListener("keydown", handler, true);
    return () => {
      root?.removeAttribute(FIND_KEY_OWNER_ATTR);
      window.removeEventListener("keydown", handler, true);
    };
  }, [active, enableFind, findOpen, navigate, openFind]);

  /**
   * 当前命中行的落地：先摘掉上一轮的 current 类，再给这一行**每一格的每一处**标红打上 current，
   * 最后按量出来的矩形居中。
   *
   * 顺序不能反：标记层重建后 DOM 里的 current 类不会自己挪位置，先量就量到上一处；
   * 而行要先进了视口，它里面 <mark> 的矩形才量得准。
   * 依赖里不许出现滚动位置：用户自己拖走之后，只要当前命中没变就不许再把他拽回来。
   * 「当前是哪一组」只读 currentGroup 这一个出处（含越界夹取，见 lib/diffFind），
   * 这里再 clamp 一次就是第二套编号语义——行号变红与 <mark> 打类会各说各话。
   */
  useLayoutEffect(() => {
    const body = bodyRef.current;
    for (const mark of currentHitMarksRef.current) mark.classList.remove(CURRENT_HIT_CLASS);
    currentHitMarksRef.current = [];
    if (!body || !findOpen || !currentGroup) return;
    const picked: HTMLElement[] = [];
    for (const markIndex of currentGroup.markIndexes) {
      for (const mark of body.querySelectorAll<HTMLElement>(currentHitSelector(markIndex))) {
        mark.classList.add(CURRENT_HIT_CLASS);
        picked.push(mark);
      }
    }
    currentHitMarksRef.current = picked;
    revealRowVertically(body, body.querySelector(`[data-row-index="${currentGroup.rowIndex}"]`));
  }, [currentGroup, findOpen, navTick]);

  /** Enter / Shift+Enter 步进。Esc 不在这里处理：查找栏已登记为 find 优先级的瞬时层（R61），
   *  分派器在捕获阶段就把按键吃掉，这里的裸分支是跑不到的死代码。 */
  const onFindKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(e)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      navigate(e.shiftKey ? -1 : 1);
    }
  };

  /** 开栏后在绘制前量条高（窄栏 flex-wrap 成两行时净空要跟着长，轮27 F-8）；关栏清零。 */
  useLayoutEffect(() => {
    if (!findOpen) {
      setFindBarHeight(0);
      return;
    }
    const measure = () => setFindBarHeight(measureFindBarHeight(findBarRef.current));
    measure();
    const el = findBarRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [findOpen]);

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
                onTermChange={(value) => {
                  setFindTerm(value);
                  setActiveIdx(0);
                }}
                onInputKeyDown={onFindKeyDown}
                onToggleCaseSensitive={() => setCaseSensitive((v) => !v)}
                onToggleWholeWord={() => setWholeWord((v) => !v)}
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
