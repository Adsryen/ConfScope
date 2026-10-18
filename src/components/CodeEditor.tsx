import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Format } from "../lib/format";
import { EscapePriority, isImeComposing, useEscape } from "../lib/useEscape";
import { isSaveShortcutKey } from "../lib/saveShortcut";
import { highlightCode } from "../lib/highlight";
import {
  activeLineOf,
  CURRENT_HIT_CLASS,
  currentHitSelector,
  findCodeHits,
  hitLines,
  hitLinesInRange,
  isHitScanCapped,
  MAX_CODE_HITS,
  lineOffsets,
  markHighlightedHtml,
  normalizeLineEndings,
  splitLines,
  type CodeHit,
} from "../lib/codeLines";
import CodeMinimap, { MINIMAP_RESERVED_RIGHT } from "./CodeMinimap";
import { useTranslation } from "../i18n";
import { useRememberedState } from "../lib/viewState";
import { pickFindTermOnOpen, textareaSelectionText } from "../lib/findSelection";
import { useDebouncedFindTerm } from "../lib/findInput";
import { measureFindBarHeight, padTopForFindBar, revealMarkHorizontally } from "../lib/codeScroll";
import { useWheelScrollsContainer } from "../lib/useWheelScrollsContainer";
import type { MatchOptions } from "../lib/textMatch";

interface Props {
  value: string;
  onChange: (v: string) => void;
  format: Format;
  placeholder?: string;
  /** 可访问名兜底：正文编辑器常被单独放置（变更计划的目标内容、配置浏览的编辑抽屉），
   *  没有包裹式 label 时读屏只能念出「编辑框」。优先取调用方给的名字，退而用 placeholder。 */
  ariaLabel?: string;
  /** 外部内容搜索词：进入编辑态后仍保持标红，与浏览态一致。 */
  searchTerm?: string;
  /** 是否启用编辑态视图内查找（Ctrl+F / F3）。 */
  enableFind?: boolean;
  /** 是否显示右侧缩略图。与浏览态同一个默认值、同一份实现（CodeMinimap，轮30 F-24）。 */
  showMinimap?: boolean;
  /**
   * 宿主页面是否在前台。被保活隐藏的页面里的编辑器不能再挂全局 Ctrl+F 监听，
   * 否则隐藏的查找栏会抢走前台页面的快捷键。
   */
  active?: boolean;
  /**
   * Ctrl/Cmd+S 的出口（R47）。焦点在编辑区内时「保存」指的就是这份内容，不能让按键漏出去。
   * 不传表示宿主没有保存动作（变更计划的目标内容编辑器）：编辑器不装作拥有这个语义，
   * 交给 App 的全局兜底把原生「保存网页」对话框吞掉。
   */
  onSave?: () => void;
}

/** 对外暴露的编辑器命令式入口（父组件用它打开查找、跳到指定行）。 */
export interface CodeEditorHandle {
  openFind: () => void;
  /** 跳到 1 基行号：选区落到该行并把焦点交回编辑区。校验错误「跳到第 N 行」用它。 */
  revealLine: (lineOneBased: number) => void;
}

// 几何常量：与 styles.css 里 .code-editor 的 CSS 变量严格同源（读磁盘静态守卫盯着）。
// 行 i 在滚动内容中的 top = PAD_TOP + i * ROW_H 是行号、命中行底色、跳转定位共同的依据。
const ROW_H = 20;
const GUTTER_W = 52;
const PAD_TOP = 12;
const PAD_LEFT_EXTRA = 14;
/** 正文右侧的基础留白（px）：不缩进来给缩略图让位时就是它，与 CSS 的 --code-pad-right 同源。 */
const PAD_RIGHT = 14;
const MAX_FALLBACK_ROWS = 200; // clientHeight 未知（首帧 / jsdom）时兜底渲染的行数

/**
 * 查找栏选项的模块级常量：与 CodeView 同一口径。
 * 复用同一个引用，非查找态时 hits 的 useMemo 才不会每渲染重算一次。
 */
const NEUTRAL_MATCH_OPTIONS: MatchOptions = {};

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

/** 带语法高亮的可编辑代码框:透明 textarea 叠在高亮 <pre> 之上,
 *  光标/选区来自 textarea,着色来自下层 pre,滚动同步。配色与 CodeView 一致。
 *
 *  与浏览态对齐的三件事（R22）：行号槽、搜索词标红与命中行高亮、视图内 Ctrl+F 查找。
 *  另有一条编辑态专属快捷键（R47）：Ctrl/Cmd+S 走宿主的 onSave，保存的是这份内容而不是整个网页。
 *  右侧缩略图与浏览态共用同一份实现（CodeMinimap，轮30 F-24）：这条控件原先只有浏览态有，
 *  同一个详情面板切到「编辑」，红条、视口框、点击跳转整条消失，几万行只能拖滚动条。
 *  「编辑态正文一直在变，重算不划算」是当初不做的理由，现在两阶段拆分（轮28 F-12）把账算清了：
 *  贵的一趟线性扫正文（20 万行实测 21-46ms）只在正文变时跑，而编辑态每敲一个字本来就要重跑
 *  highlightCode（同规模实测 300ms+）——桶表那一趟是它的零头，红条与视口框则完全不重算正文。
 *  不变式：查找定位只改 textarea 的选区与滚动，绝不改 value。 */
const CodeEditor = forwardRef<CodeEditorHandle, Props>(function CodeEditor(
  { value, onChange, format, placeholder, ariaLabel, searchTerm = "", enableFind = true, showMinimap = true, active = true, onSave }: Props,
  ref
) {
  const { t } = useTranslation();

  const rootRef = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const gutterInnerRef = useRef<HTMLDivElement>(null);
  const linesInnerRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const findBarRef = useRef<HTMLDivElement | null>(null);
  /** 关栏状态下的 ⌕ 入口浮标：和查找条同一块死区（轮32 F-33），也要接滚轮。 */
  const findOpenBtnRef = useRef<HTMLButtonElement | null>(null);

  const [findOpen, setFindOpen] = useState(false);
  // 查找栏打开期间实测的条高（px）：与浏览态同一口径，量不到退到兜底常量。
  const [findBarHeight, setFindBarHeight] = useState(0);
  const [findTerm, setFindTerm] = useState("");
  /**
   * 「当前在第几处」连着它所属的查找口径存（轮30 F-22）。
   *
   * 缺陷长什么样：归零原先挂在一条 useEffect 上，跑在落地**之后**。跳完第六处再勾「区分大小写」，
   * 同一次提交里落地读到的还是旧序号 → 视图跳到新表的第六处，计数与当前命中类却已经写到第一处；
   * 紧跟着的第二次重渲染只换类 + 水平定位，垂直不再补——用户读到"红字在第一处，屏幕停在别处"。
   * 渲染期就把"不属于当前口径的序号"读成 0：口径变化的那一次提交里落地、换类、计数用的是同一份，
   * 那条归零 effect 也就不需要了。
   */
  const [idxScope, setIdxScope] = useState<{ open: boolean; term: string; opts: MatchOptions; doc: string; idx: number } | null>(null);
  // 查找栏的两个匹配开关：与浏览态（CodeView）共用同一对记忆键，
  // 浏览态勾了「区分大小写」再进编辑态不必重勾一遍。
  const [caseSensitive, setCaseSensitive] = useRememberedState<boolean>("codeFind.caseSensitive", false);
  const [wholeWord, setWholeWord] = useRememberedState<boolean>("codeFind.wholeWord", false);

  const [metrics, setMetrics] = useState({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 });
  /** 带着「当前命中」类的那批 <mark>：html 不变时 React 不重建它们，类只能由这里显式收回。 */
  const currentHitMarksRef = useRef<HTMLElement[]>([]);
  // 「跳到第 N 行」落点：不在查找态时也要能高亮那一行
  const [pinnedLine, setPinnedLine] = useState<number | null>(null);

  // 归一到 DOM 真正承载的文本（textarea.value 会吃掉 \r），后续所有偏移、行数组、高亮层都用它，
  // 保证选区、Tab 缩进、高亮标记落在同一套坐标上（R28 修正）。
  const doc = useMemo(() => normalizeLineEndings(value), [value]);
  const lines = useMemo(() => splitLines(doc), [doc]);
  const totalLines = lines.length;

  /**
   * 查找词输入的延迟（轮29 F-16，与浏览态同一份策略）：编辑态的正文同样能到几万行，
   * 阈值以下这个 hook 直接透传、不建定时器，小文件保持逐字实时。
   * `term` 必须就是 `effectiveTerm`：标红、命中行、计数、跳下一处全靠这一份，分叉就看得见摸得着。
   */
  const { term: committedFindTerm, isPending: findTermPending, flush: flushFindTerm } = useDebouncedFindTerm(findTerm, totalLines);
  // 查找栏打开时以查找词为准；否则沿用外部内容搜索词（只标红，不区分当前命中）。
  const effectiveTerm = findOpen ? committedFindTerm : searchTerm;
  // 开关只作用于查找栏自己输入的词。栏一关就退回中性口径：外部内容搜索词必须继续
  // 「大小写不敏感子串」，否则编辑态的标红会和左侧列表的命中数分叉。
  const matchOptions = useMemo<MatchOptions>(
    () => (findOpen ? { caseSensitive, wholeWord } : NEUTRAL_MATCH_OPTIONS),
    [findOpen, caseSensitive, wholeWord]
  );
  const hits = useMemo(() => findCodeHits(doc, effectiveTerm.trim(), matchOptions), [doc, effectiveTerm, matchOptions]);
  const hitSet = useMemo(() => hitLines(hits), [hits]);
  // 扫到上限就停 ⇒ 「还有多少处」我们并不真的知道，只能告诉用户「至少 5000 处」（轮28 F-10）。
  const hitsCapped = isHitScanCapped(hits);

  // 命中行表（升序）：二分取可视区窗口用得上这份序，见 hitLinesInRange。
  const hitLineArray = useMemo(() => Array.from(hitSet), [hitSet]);

  // 口径（开栏状态 / 查找词 / 匹配开关 / 正文）逐位对得上才认这个序号，否则按第一处读。
  // 比的是身份而不是拼字符串：正文可能几十万行，每渲染拼一份 `${doc}` 是白扔的钱（轮29 刚为这个打过架）。
  const inScope =
    idxScope !== null &&
    idxScope.open === findOpen &&
    idxScope.term === effectiveTerm &&
    idxScope.opts === matchOptions &&
    idxScope.doc === doc;
  const activeIdx = inScope ? idxScope.idx : 0;
  const commitActiveIdx = useCallback(
    (idx: number) => setIdxScope({ open: findOpen, term: effectiveTerm, opts: matchOptions, doc, idx }),
    [findOpen, effectiveTerm, matchOptions, doc]
  );

  const currentLine = findOpen ? activeLineOf(hits, activeIdx) : pinnedLine;

  /**
   * 右侧留白的依据（与浏览态同一条口径，轮28 F-13）：设置开着且有正文就留位。
   * **不许**跟着缩略图的实际显隐变——「收起缩略图 ⇒ 正文变宽 ⇒ 可能不再需要滚 ⇒ 又该收起」是自激振荡。
   * 显隐本身（能不能滚）归 CodeMinimap 自己判。
   */
  const minimapReserved = showMinimap && totalLines > 0;

  // 末尾只在原文本身以换行结尾时才补一个换行,保证高亮层与 textarea 行数严格一致
  // (无条件补 "\n" 会让高亮层多出一行空行,拖拽选区/滚动同步在长文档上发生偏移)
  // 高亮层用 HTML 表示,而 HTML 解析会把“片段末尾的换行”再补一个换行
  // (<div>x\n</div> 解析后 textContent 为 x\n\n),导致 pre 比 textarea 多一行、
  // 拖拽选区/滚动同步偏移。因此末尾换行不用裸 "\n" 表示,而是放在一个空 span 里
  // (解析后不产生额外文本),保证高亮层文本与 textarea 值严格一致。
  const baseHtml = useMemo(() => {
    const base = highlightCode(doc, format);
    return doc.endsWith("\n") ? base + "<span></span>" : base;
  }, [doc, format]);
  /**
   * 命中层单独一层，且**不跟着「当前在第几处」重算**（轮28 F-14）。
   *
   * 原先 html 的依赖里圈着 activeOffset：每按一次 Enter 换一处命中，整篇文档重新
   * highlightCode + 重新标记 + 重新解析。实测每次 Enter 的代价 2k 行 25-45ms /
   * 20k 行（约 1MB）235-342ms / 200k 行（约 10MB）1586-3136ms——编辑态里翻页就是等白屏。
   * 当前命中改由视图在提交后往 <mark> 上切类，这条依赖本来就不该存在。
   * 标签结构原样保留，高亮层的 textContent 仍与 textarea 的值逐字相等（retest 依赖这条）。
   */
  const html = useMemo(() => markHighlightedHtml(baseHtml, hits), [baseHtml, hits]);

  /**
   * 滚动内容顶部的净空（轮27 F-8）：查找条浮在正文之上，开栏期间把第一行让到条子下面。
   * 编辑态的 pre / textarea 共用同一条 CSS 变量，改这一处三层（文本 / 行号 / 命中底色）一起走。
   */
  const padTop = padTopForFindBar(PAD_TOP, findOpen, findBarHeight);

  const syncScroll = useCallback(() => {
    const ta = taRef.current;
    const pre = preRef.current;
    if (!ta) return;
    const top = ta.scrollTop;
    if (pre) {
      pre.scrollTop = top;
      pre.scrollLeft = ta.scrollLeft;
    }
    // 行号 / 命中行用 transform 直接跟手，不等 React 重渲染。
    const transform = `translateY(${-top}px)`;
    if (gutterInnerRef.current) gutterInnerRef.current.style.transform = transform;
    if (linesInnerRef.current) linesInnerRef.current.style.transform = transform;
    setMetrics({ scrollTop: top, scrollHeight: ta.scrollHeight, clientHeight: ta.clientHeight });
  }, []);

  const scrollLineIntoView = useCallback(
    (line: number) => {
      const ta = taRef.current;
      if (!ta) return;
      const y = padTop + line * ROW_H;
      ta.scrollTop = clamp(y - ta.clientHeight / 2, 0, Math.max(0, ta.scrollHeight - ta.clientHeight));
      // 直接调一次同步：程序化滚动在 jsdom 里不触发 scroll 事件，真机也要保证当帧对齐
      syncScroll();
    },
    [padTop, syncScroll]
  );

  /** 把选区与滚动落到一次命中上。注意：只动选区，不动 value。 */
  const revealHit = useCallback(
    (hit: CodeHit) => {
      const ta = taRef.current;
      if (ta) {
        // 未聚焦时选区不渲染，靠 <mark class="search-hit-current"> 和命中行底色表达当前位置；
        // 关闭查找栏后用户接着输入/替换时，这个选区已经就位。
        ta.setSelectionRange(hit.offset, hit.offset + hit.length);
      }
      setPinnedLine(hit.line);
      scrollLineIntoView(hit.line);
      // 水平定位改在命中提交后按 <mark> 矩形做（轮27 F-7，与浏览态同一份实现）：
      // 这里同步读 DOM 只能读到上一处命中的矩形。
    },
    [scrollLineIntoView]
  );

  /**
   * 打开查找栏，初值口径与浏览态 CodeView 完全一致：
   * **选区 > 栏内旧词 > 外部搜索词**（轮26 F-3，见 ../lib/findSelection）。
   *
   * 编辑态的选中内容不走 window.getSelection()，必须读 textarea 的 selectionStart/End；
   * 同样要在 setState 前同步读，输入框聚焦后 textarea 的选区就没了。
   * 注意 Enter/F3 导航会经 revealHit 把选区落在当前命中上，所以「栏已开时再按 Ctrl+F」
   * 读到的是上一处命中——旧词本就与它相同，行为天然延续，不需要额外区分。
   */
  const openFind = useCallback(() => {
    const selectionRaw = textareaSelectionText(taRef.current);
    setPinnedLine(null);
    setFindOpen(true);
    setFindTerm((prev) => pickFindTermOnOpen({ previous: prev, selectionRaw, external: searchTerm }));
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
  }, [searchTerm]);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindTerm("");
    // 关栏把「刚看过第几处」一起收回（轮30 F-23）：pinnedLine 是「跳到第 N 行」的落点专用层，
    // revealHit 每次跳转都往里写，不清就会在 Esc 之后留一整行底色，用户以为那行有什么特殊含义。
    // 浏览态同样是 findOpen 一关 currentLine 就归 null（currentMustNotPersistAfterClose 钉着）。
    // 序号不用在这里归零：开栏状态与查找词都变了，派生口径自己读成第一处。
    setPinnedLine(null);
    // 查找结束回到编辑：把焦点还给文本区，用户不用重新点一下才能继续打字
    taRef.current?.focus();
  }, []);

  // 查找栏是弹层内部的瞬时层，必须自己登记：ConfigEditor 以 overlay 优先级注册，
  // 裸 onKeyDown 的 Esc 在捕获阶段就被吃掉，一次 Esc 会直接关掉整个弹层（R61）。
  useEscape(active && findOpen, closeFind, EscapePriority.find);

  const navigate = useCallback(
    (delta: number) => {
      // 有字符还没落进命中层：这一次只提交，别拿旧词的命中表跳格子（轮29 F-16 AC3）。
      if (findTermPending) {
        flushFindTerm();
        return;
      }
      if (!hits.length) return;
      const next = (activeIdx + delta + hits.length) % hits.length;
      commitActiveIdx(next);
      revealHit(hits[next]);
    },
    [activeIdx, commitActiveIdx, findTermPending, flushFindTerm, hits, revealHit]
  );

  const revealLine = useCallback(
    (lineOneBased: number) => {
      if (!totalLines) return;
      const line = clamp(lineOneBased - 1, 0, totalLines - 1);
      const start = lineOffsets(lines)[line] ?? 0;
      // doc 已归一，行内不再有 \r，选区长度就是这一行可见文本的长度
      const textLength = lines[line].length;
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(start, start + textLength);
      }
      setFindOpen(false);
      setFindTerm("");
      setPinnedLine(line);
      scrollLineIntoView(line);
    },
    [lines, scrollLineIntoView, totalLines]
  );

  useImperativeHandle(ref, () => ({ openFind, revealLine }), [openFind, revealLine]);

  /**
   * 开栏 / 改词 / 改口径后，把选区与滚动落到当前命中（前后导航在 navigate 里即时做）。
   *
   * 绘制前落地（轮30 F-22，与浏览态同一条口径）：这条原先是 useEffect，先画一帧旧位置再跳，
   * 用户读到的是"改了词屏幕闪一下才动"；两条出口各写一次滚动还会互相覆盖。
   *
   * 依赖里**不许**出现 doc / lines / hits / html：编辑态的字是用户自己敲的，正文一变就落回第一处，
   * 下一个字符就会被塞进第一条命中那一行——配置直接被改到别的行上去。浏览态的落地依赖里有 html
   * 没有这个问题（那边正文只读），这条分叉是有意的，由「开着查找栏打字」那条用例钉住。
   * 旧序号读错的问题也不在这里补，由上面的 idxScope 派生负责。
   */
  useLayoutEffect(() => {
    if (!findOpen || !hits.length) return;
    revealHit(hits[clamp(activeIdx, 0, hits.length - 1)]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, effectiveTerm, matchOptions]);

  /**
   * 当前命中的落地：先给高亮层里这一处的 <mark> 换上 current 类，再把水平位置带过去
   * （轮28 F-14 + 轮27 F-7）。长行 JSON 里的命中只滚垂直照样在屏幕外。
   *
   * 量的不是「列 × 字宽」而是高亮层里 <mark> 的实际矩形——那一层与 textarea 逐字同格
   * （透明 textarea 叠在 pre 上，同一套 padding / line-height / tab-size），
   * Tab 的两列宽与中日韩的两倍字宽浏览器已经算好，不必再近似。
   *
   * 换类必须排在量矩形之前：html 不再随当前命中变化（省下来的正是这份重算），
   * DOM 里的 current 类不会自己挪位置，先量就是量上一处。两步也必须在同一个
   * useLayoutEffect 里：navigate 在 setState 之后同步滚了垂直，等提交才能读到新的节点。
   * 依赖里**不许**出现 metrics：用户自己把横向偏移拖走之后，当前命中没变就不许再把他拽回来。
   */
  useLayoutEffect(() => {
    const pre = preRef.current;
    for (const mark of currentHitMarksRef.current) mark.classList.remove(CURRENT_HIT_CLASS);
    currentHitMarksRef.current = [];
    if (!findOpen || !hits.length) return;
    if (pre) {
      const marks = pre.querySelectorAll<HTMLElement>(currentHitSelector(clamp(activeIdx, 0, hits.length - 1)));
      if (marks.length) {
        for (const mark of marks) mark.classList.add(CURRENT_HIT_CLASS);
        currentHitMarksRef.current = Array.from(marks);
      }
    }
    // 改了 textarea 的横向偏移必须立刻同步高亮层：程序化赋值在 jsdom 里不触发 scroll 事件，
    // 真机上晚一帧也让着色层与选区错开一格。
    if (revealMarkHorizontally(taRef.current, pre)) syncScroll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, findOpen, hits, activeIdx]);

  /** 开栏后实测查找条高度（轮27 F-8，与浏览态同一份公式）。 */
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

  /**
   * 滚轮落在查找条 / ⌕ 浮标上 ⇒ 滚正文（轮32 F-33，与浏览态同一份出口）。
   *
   * 取证 research/wheelbar_probe.txt + wheelopen_probe.txt：浮层完全压在正文之上，滚一格
   * 正文停在原值、外层也始终 0 —— 纯死区。编辑态里更贵：正文是 textarea，指针从条子上挪回来
   * 继续滚却不动，用户只会觉得「编辑器卡住了」。
   * reattachKey 递 findOpen：两个元素互斥渲染且每次都是新节点，不重挂就等于静默失活。
   */
  useWheelScrollsContainer(findBarRef, { containerRef: taRef, syncScroll, rowHeight: ROW_H, reattachKey: findOpen });
  useWheelScrollsContainer(findOpenBtnRef, { containerRef: taRef, syncScroll, rowHeight: ROW_H, reattachKey: findOpen });

  // 净空变化不触发 scroll 事件，补一次同步让高亮层与行号网格跟上新 padding。
  useLayoutEffect(() => {
    syncScroll();
  }, [padTop, syncScroll]);

  // 内容整体换掉（切文件/切草稿）时收起查找栏，防止旧关键词污染新内容。
  useEffect(() => {
    setFindOpen(false);
    setFindTerm("");
    setPinnedLine(null);
  }, [format]);

  useEffect(() => {
    syncScroll();
    // 挂载后尺寸才稳定，再测一次，保证首屏行号不是兜底的那几十行
    const raf = (window as unknown as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
    if (raf) raf(syncScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 容器尺寸变化（含首次布局）刷新视口高度（轮30 F-21，与浏览态同一口径）。
   *
   * 缺陷长什么样：行号与命中行底色按 `visibleRange = f(clientHeight)` 虚拟化，而 clientHeight 只由
   * scroll 事件和挂载时那两次同步更新。把详情面板拉高、缩放浏览器、收起左侧列表都**不会**派发 scroll
   * 事件 ⇒ clientHeight 停在旧值 ⇒ 下半截既没有行号也没有命中行底色，得手动滚一下才补齐。
   */
  useEffect(() => {
    const ta = taRef.current;
    if (!ta || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => syncScroll());
    ro.observe(ta);
    return () => ro.disconnect();
  }, [syncScroll]);

  const visibleRange = useMemo(() => {
    const { scrollTop, clientHeight } = metrics;
    if (clientHeight <= 0) return { start: 0, end: Math.min(totalLines, MAX_FALLBACK_ROWS) };
    const start = clamp(Math.floor((scrollTop - padTop) / ROW_H) - 1, 0, totalLines);
    const end = clamp(Math.ceil((scrollTop + clientHeight - padTop) / ROW_H) + 1, 0, totalLines);
    return { start, end };
  }, [metrics, totalLines, padTop]);

  const lineNumbers = useMemo(() => {
    const out: number[] = [];
    for (let i = visibleRange.start; i < visibleRange.end; i += 1) out.push(i);
    return out;
  }, [visibleRange]);

  /**
   * 可视区内的命中行（轮28 F-15）：二分取窗口，不再线性扫全量命中。
   * 「跳到第 N 行」的落点单独补进来——它不是命中，但同样要画命中行底色。
   */
  const hitRows = useMemo(() => {
    const { start, end } = visibleRange;
    const rows = hitLinesInRange(hitLineArray, start, end);
    if (pinnedLine !== null && pinnedLine >= start && pinnedLine < end && !rows.includes(pinnedLine)) {
      rows.push(pinnedLine);
      rows.sort((a, b) => a - b);
    }
    return rows;
  }, [hitLineArray, pinnedLine, visibleRange]);

  // Ctrl+F / Cmd+F / F3：编辑态必须自己接管。浏览态 CodeView 的监听在焦点落到
  // textarea 这类可编辑控件时故意不接管（不抢输入框的查找），所以光脚按 Ctrl+F 以前是死键。
  useEffect(() => {
    if (!enableFind || !active) return;
    const handler = (e: KeyboardEvent) => {
      // 组合态期间不劫持 Ctrl+F / F3：此刻按键属于输入法候选，不该被查找栏抢走
      if (isImeComposing(e)) return;
      const key = e.key;
      const isFindKey = (e.ctrlKey || e.metaKey) && (key === "f" || key === "F");
      const isF3 = key === "F3";
      if (!isFindKey && !isF3) return;
      // F3 只有在查找栏已打开时才导航，否则把系统原生行为留给调用方
      if (isF3 && !findOpen) return;

      const root = rootRef.current;
      const target = e.target as EventTarget | null;
      const inRoot = !!root && target instanceof Node && root.contains(target);
      const focused = document.activeElement as HTMLElement | null;
      const onBody = !focused || focused === document.body || focused === document.documentElement;
      // 焦点在本编辑器内 → 接管；焦点在别处的输入框 → 让给它。
      const mine = inRoot || focused === taRef.current;
      // 没有焦点时也要能按出来，但页面里存在浏览态 CodeView（它自己监听 Ctrl+F）就不抢，
      // 避免同一快捷键被两个视图同时接管。
      const fallback = onBody && !document.querySelector(".code-view");
      if (!mine && !fallback) return;

      e.preventDefault();
      if (isF3) {
        navigate(e.shiftKey ? -1 : 1);
        return;
      }
      openFind();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [active, enableFind, findOpen, navigate, openFind]);

  const onFindKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // 组合态回车是「上屏候选词」，不是「跳到下一个命中」
    if (isImeComposing(e)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      navigate(e.shiftKey ? -1 : 1);
    }
    // Esc 不在这里处理：查找栏已登记为 find 优先级的瞬时层（R61），裸分支跑不到。
  };

  // Tab 键插入两个空格而不是切换焦点
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 组合态的 Tab 属于输入法（部分输入法用 Tab 做整句/候选页切换），不能拦成插空格
    if (isImeComposing(e)) return;
    // Ctrl/Cmd+S：焦点在编辑区里，保存的就是这份内容（R47）。
    // 只在 textarea 本地拦——查找栏里的 Ctrl+S 不该被当成保存，浏览态也不归这里管。
    if (onSave && isSaveShortcutKey(e)) {
      e.preventDefault();
      onSave();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = e.currentTarget;
      const { selectionStart: s, selectionEnd: end } = ta;
      const next = doc.slice(0, s) + "  " + doc.slice(end);
      onChange(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = s + 2;
      });
    }
  };

  const vars = {
    "--code-row-h": `${ROW_H}px`,
    "--code-gutter-w": `${GUTTER_W}px`,
    "--code-pad-top": `${padTop}px`,
    "--code-pad-left": `${GUTTER_W + PAD_LEFT_EXTRA}px`,
    // 两条右向留白一起让位：正文不被 66px 的缩略图盖住，查找条也不压在它上面
    "--code-pad-right": `${minimapReserved ? MINIMAP_RESERVED_RIGHT : PAD_RIGHT}px`,
    "--code-find-right": `${minimapReserved ? MINIMAP_RESERVED_RIGHT : 16}px`,
  } as CSSProperties;

  return (
    <div className="code-editor" ref={rootRef} style={vars}>
      {/* 命中行底色层：与文本共享同一 ROW_H 网格，位于文本之下 */}
      <div className="code-lines" aria-hidden="true">
        <div className="code-lines-layer" ref={linesInnerRef}>
          {hitRows.map((line) => (
            <div
              key={`line-${line}`}
              className={`code-line${line === currentLine ? " is-current" : " is-hit"}`}
              style={{ top: padTop + line * ROW_H }}
            />
          ))}
        </div>
      </div>

      <pre ref={preRef} className="code-editor-pre mono hljs" aria-hidden="true">
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>

      <textarea
        ref={taRef}
        className="code-editor-ta mono"
        value={doc}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        onKeyDown={onKeyDown}
      />

      {/* 右侧缩略图：与浏览态同一份实现（轮30 F-24），递进去的只有数据与几何 */}
      {minimapReserved && (
        <CodeMinimap
          containerRef={taRef}
          syncScroll={syncScroll}
          lines={lines}
          hitLineArray={hitLineArray}
          currentLine={currentLine}
          metrics={metrics}
          rowHeight={ROW_H}
          padTop={padTop}
        />
      )}

      {/* 行号槽：与浏览态复用同一套 .code-gutter/.code-ln 与 CSS 变量 */}
      {totalLines > 0 && (
        <div className="code-gutter" aria-hidden="true">
          <div className="code-gutter-layer" ref={gutterInnerRef}>
            {lineNumbers.map((i) => (
              <div
                key={`ln-${i}`}
                className={`code-ln${i === currentLine ? " is-current" : hitSet.has(i) ? " is-hit" : ""}`}
                style={{ top: padTop + i * ROW_H }}
              >
                {i + 1}
              </div>
            ))}
          </div>
        </div>
      )}

      {enableFind && !findOpen && (
        <button
          type="button"
          className="code-find-open"
          ref={findOpenBtnRef}
          onClick={openFind}
          title={t("config.openFind")}
          aria-label={t("config.openFind")}
          aria-keyshortcuts="Control+F"
        >
          ⌕
        </button>
      )}

      {enableFind && findOpen && (
        <div className="code-find" ref={findBarRef} role="search">
          <input
            ref={findInputRef}
            className="code-find-input mono"
            spellCheck={false}
            type="text"
            value={findTerm}
            placeholder={t("config.findPlaceholder")}
            aria-label={t("config.findPlaceholder")}
            onChange={(e) => {
              setFindTerm(e.target.value);
              commitActiveIdx(0);
            }}
            onKeyDown={onFindKeyDown}
          />
          {/* 匹配口径开关。onMouseDown preventDefault：按钮默认会夺走焦点，
              点一下开关就得再点一次输入框才能继续改词；编辑态里更糟——
              焦点离开 textarea 会让当前选区一起消失。 */}
          <button
            type="button"
            className={`code-find-toggle${caseSensitive ? " is-on" : ""}`}
            aria-pressed={caseSensitive}
            aria-label={t("config.findCaseSensitive")}
            title={t("config.findCaseSensitive")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setCaseSensitive((v) => !v)}
          >
            Aa
          </button>
          <button
            type="button"
            className={`code-find-toggle${wholeWord ? " is-on" : ""}`}
            aria-pressed={wholeWord}
            aria-label={t("config.findWholeWord")}
            title={t("config.findWholeWord")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setWholeWord((v) => !v)}
          >
            ab|
          </button>
          {/* 命中触顶时必须说出来（轮28 F-10）：只写「第 1/5000 处」用户会以为文件里一共就 5000 处。
              「+」进可见文案，解释挂 title——这是 span，title 正常显示，不受轮26 F-1（disabled 控件的 title 不弹）影响。 */}
          <span
            className="code-find-count"
            aria-live="polite"
            title={hitsCapped ? t("config.findCountCappedHint", { max: MAX_CODE_HITS }) : undefined}
          >
            {hits.length
              ? hitsCapped
                ? t("config.findCountCapped", { current: clamp(activeIdx, 0, hits.length - 1) + 1, max: MAX_CODE_HITS })
                : t("config.findCount", { current: clamp(activeIdx, 0, hits.length - 1) + 1, total: hits.length })
              : effectiveTerm
                ? t("config.findNone")
                : t("config.findHint")}
          </span>
          {/* ↑↓ 与上面两个开关同一口径（轮32 F-29）：编辑态里代价更高——焦点离开 textarea
              连当前选区一起消失，接着打字全不见，Ctrl+S 也不再被编辑区接管。
              下面的 ✕ 不挡：它 onClick 里就是 taRef.focus()，归还焦点靠这次点击。 */}
          <button
            type="button"
            className="code-find-btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => navigate(-1)}
            disabled={!hits.length}
            title={t("config.findPrevKey")}
            aria-label={t("config.findPrev")}
            aria-keyshortcuts="Shift+Enter Shift+F3"
          >
            ↑
          </button>
          <button
            type="button"
            className="code-find-btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => navigate(1)}
            disabled={!hits.length}
            title={t("config.findNextKey")}
            aria-label={t("config.findNext")}
            aria-keyshortcuts="Enter F3"
          >
            ↓
          </button>
          <button
            type="button"
            className="code-find-btn"
            onClick={closeFind}
            title={t("config.findCloseKey")}
            aria-label={t("config.findClose")}
            aria-keyshortcuts="Escape"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
});

export default CodeEditor;
