import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Format } from "../lib/format";
import { highlightCode } from "../lib/highlight";
import {
  activeLineOf,
  activeOffsetOf,
  buildMinimapRows,
  findCodeHits,
  hitLines,
  isHitScanCapped,
  markHighlightedHtml,
  MAX_CODE_HITS,
  splitLines,
} from "../lib/codeLines";
import { useTranslation } from "../i18n";
import { EscapePriority, isImeComposing, useEscape } from "../lib/useEscape";
import { useScrollResetOnContentChange } from "../lib/useScrollResetOnContentChange";
import { useRememberedState } from "../lib/viewState";
import { pickFindTermOnOpen, selectionTextWithin } from "../lib/findSelection";
import { measureFindBarHeight, padTopForFindBar, revealMarkHorizontally } from "../lib/codeScroll";
import type { MatchOptions } from "../lib/textMatch";

interface Props {
  code: string;
  format: Format;
  /** 内容搜索词：在已转义的高亮 HTML 文本上二次标记命中词（大小写不敏感）。 */
  searchTerm?: string;
  /** 是否显示右侧缩略图（VSCode 风格的 minimap）。 */
  showMinimap?: boolean;
  /** 是否启用视图内 Ctrl+F 查找。 */
  enableFind?: boolean;
  /**
   * 视图当前是否可见可交互。宿主页面被保活隐藏（配置浏览切到其他模式）时传 false：
   * 隐藏后 document.activeElement 会退回 body，本视图的 Ctrl+F 全局监听会把按键
   * 判给「当前文件」，从而劫持其他模式里的查找。
   */
  active?: boolean;
  /**
   * 内容身份键：同一实例换正文时必须变（如「命名空间/分组/dataId + 历史版本 id」）。
   * 缺省时退回 code 本身。存在的原因：相邻历史版本正文可能逐字相同，
   * 只按 code 判断不会触发滚动重置，用户会看到视图停在上一版的偏移处。
   */
  contentKey?: string;
}

// 几何常量：CSS 与 TS 必须共用同一套数值，行号、命中行高亮、缩略图跳转
// 全靠「行 i 在滚动内容中的 top = PAD_TOP + i * ROW_H」这条公式对齐。
const ROW_H = 20;
const GUTTER_W = 52;
const PAD_TOP = 6;
const MM_ROW_H = 2.5;
const MM_MIN_ROWS = 8;
const MAX_FALLBACK_ROWS = 200; // clientHeight 未知（首帧 / jsdom）时兜底渲染的行数

/**
 * 查找栏选项的模块级常量：非浏览态必须复用同一个引用，
 * 否则 hits 的 useMemo 每次渲染都会重算（对象字面量每次都是新 identity）。
 */
const NEUTRAL_MATCH_OPTIONS: MatchOptions = {};

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

/** IDE 风格的只读代码展示：语法高亮 + 行号 + 搜索词标红与命中行高亮 +
 *  右侧 VSCode 式缩略图 + 视图内 Ctrl+F 查找。
 *
 *  关键不变式（retest / 单测依赖）：.code-area 里的文本 blob 其 textContent
 *  必须恒等于原始代码（换行保留、可复制），命中用 <mark class="search-hit">
 *  内联在 blob 内。因此行号、命中行底色都放在 .code-area 之外的独立层
 *  （.code-gutter / .code-lines），绝不作为 .code-area 的文本节点存在。 */
export default function CodeView({ code, format, searchTerm, showMinimap = true, enableFind = true, active = true, contentKey }: Props) {
  const { t } = useTranslation();

  const rootRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLPreElement>(null);
  const gutterInnerRef = useRef<HTMLDivElement>(null);
  const linesInnerRef = useRef<HTMLDivElement>(null);
  const minimapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const draggingRef = useRef(false);
  const findBarRef = useRef<HTMLDivElement | null>(null);

  const [findOpen, setFindOpen] = useState(false);
  // 查找栏打开期间实测的条高（px）。窄容器里条子会 flex-wrap 成两行（轮26 F-4 量到 60），
  // 照常量留净空照样盖住正文，所以量得到就按量的算，量不到退到兜底常量。
  const [findBarHeight, setFindBarHeight] = useState(0);
  const [findTerm, setFindTerm] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  // 查找栏的两个匹配开关：浏览态与编辑态共用同一对记忆键（切视图不丢口径）。
  // 走 viewState 唯一实现、不落 localStorage——用户要的是「这台机器这次会话里记住」，
  // 不是「重启后所有文件都按全词搜」。
  const [caseSensitive, setCaseSensitive] = useRememberedState<boolean>("codeFind.caseSensitive", false);
  const [wholeWord, setWholeWord] = useRememberedState<boolean>("codeFind.wholeWord", false);

  const [metrics, setMetrics] = useState({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 });
  const [minimapSize, setMinimapSize] = useState({ width: 0, height: 0 });

  const lines = useMemo(() => splitLines(code), [code]);
  const totalLines = lines.length;

  // 查找栏打开时以查找词为准；否则沿用外部内容搜索词（整体标红，不区分当前命中）。
  const effectiveTerm = findOpen ? findTerm : (searchTerm ?? "");
  // 开关只作用于查找栏自己输入的词。栏一关就退回中性口径：外部内容搜索词必须继续
  // 「大小写不敏感子串」，否则代码里的标红会和左侧列表的命中数分叉
  // （configContentSearch.test.ts 钉着这条跨模块不变式）。
  const matchOptions = useMemo<MatchOptions>(
    () => (findOpen ? { caseSensitive, wholeWord } : NEUTRAL_MATCH_OPTIONS),
    [findOpen, caseSensitive, wholeWord]
  );
  const hits = useMemo(() => findCodeHits(code, effectiveTerm.trim(), matchOptions), [code, effectiveTerm, matchOptions]);
  const hitSet = useMemo(() => hitLines(hits), [hits]);
  // 扫到上限就停 ⇒ 「还有多少处」我们并不真的知道，只能告诉用户「至少 5000 处」（轮28 F-10）。
  const hitsCapped = isHitScanCapped(hits);

  const activeOffset = findOpen ? activeOffsetOf(hits, activeIdx) : null;
  const currentLine = findOpen ? activeLineOf(hits, activeIdx) : null;

  const html = useMemo(() => {
    const base = highlightCode(code, format);
    // 末尾换行的安全表示：不依赖 HTML 解析行为（详见 highlight.ts 注释）。
    const withTail = code.endsWith("\n") ? base + "<span></span>" : base;
    // 只在已转义 HTML 的文本区按整文档偏移插标记，标签结构原样保留。
    return markHighlightedHtml(withTail, hits, activeOffset);
  }, [code, format, hits, activeOffset]);

  /**
   * 滚动内容顶部的净空（轮27 F-8）：查找条浮在正文之上，开栏期间必须把第一行让到条子下面。
   * 关栏回到 CSS 里的基础值，别把净空留在原地让正文凭空矮一截。
   */
  const padTop = padTopForFindBar(PAD_TOP, findOpen, findBarHeight);

  const syncScroll = useCallback(() => {
    const el = areaRef.current;
    if (!el) return;
    const top = el.scrollTop;
    // 行号 / 命中行用 transform 直接跟手，不等 React 重渲染。
    const transform = `translateY(${-top}px)`;
    if (gutterInnerRef.current) gutterInnerRef.current.style.transform = transform;
    if (linesInnerRef.current) linesInnerRef.current.style.transform = transform;
    setMetrics({ scrollTop: top, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
  }, []);

  const scrollLineIntoView = useCallback(
    (line: number) => {
      const el = areaRef.current;
      if (!el) return;
      const y = padTop + line * ROW_H;
      el.scrollTop = clamp(y - el.clientHeight / 2, 0, Math.max(0, el.scrollHeight - el.clientHeight));
      // 程序化滚动当帧补一次同步（与 CodeEditor 同一口径）：真机靠 scroll 事件回来自愈，
      // 但净空随查找栏开合变化时根本没有滚动事件，行号层/命中行层会按旧 scrollTop 排。
      syncScroll();
    },
    [padTop, syncScroll]
  );

  /**
   * 外部内容搜索词（查找栏没开）时的定位：把首个命中拉进视口中间。
   *
   * 缺陷长什么样（R74）：内容搜索点开结果后，命中词整篇标红、命中行有底色，但视图永远停在
   * 文件开头——红字得用户自己滚过去找。原先唯一的「滚动到命中」出口被 `findOpen` 门掉了，
   * 而外部 searchTerm 从不打开查找栏，于是这条路径上没人定位。
   *
   * 三重门控各有原因，少一个就会误伤别的口径：
   * - `findOpen` 为真时不插手：查找栏有自己的当前命中语义（Enter / F3 导航），不许被拽回第一处；
   * - 没有命中不插手：用户就该看到文件开头；
   * - `clientHeight <= 0` 不插手：视图被保活隐藏（active=false 那类宿主页面）或首帧还没布局时
   *   量不到高度，此时 clamp 的结果恒等于 0，"跳一次"等于没跳，还会把波29
   *   「同一内容重复渲染不许误触滚动重置」的口径冒充成"定位成功"。
   */
  const locateFirstExternalHit = useCallback(() => {
    if (findOpen) return false;
    const el = areaRef.current;
    if (!el || el.clientHeight <= 0) return false;
    const first = hits[0];
    if (!first) return false;
    scrollLineIntoView(first.line);
    // 只滚垂直不够（轮27 F-7）：单行长 JSON 里命中可能在第 4000 列的屏幕外。
    // 这条路径查找栏没开，DOM 里没有 .search-hit-current，lib 内退到第一处 .search-hit，
    // 正是 hits[0] 自己，量的就是刚滚过去的那一行。
    revealMarkHorizontally(el, el);
    return true;
  }, [findOpen, hits, scrollLineIntoView]);

  /**
   * 打开查找栏，并按 **选区 > 栏内旧词 > 外部搜索词** 决定初值（轮26 F-3，VSCode 口径）。
   *
   * 为什么要在这个函数里读选区、而且是 setState 之前同步读：查找输入框一拿到焦点，
   * 文档级选区就被清掉了，等渲染完再读只剩空串。用户「选中一段配置名再按 Ctrl+F」
   * 要的就是搜它，旧词压在上面等于把这次按键变成"什么也没发生"。
   * 选区必须落在本视图 .code-area 内才算（见 ../lib/findSelection），
   * 否则用户在左侧列表搜索框里选几个字，也会把这里的查找词劫持走。
   */
  const openFind = useCallback(() => {
    const selectionRaw = selectionTextWithin(areaRef.current);
    setFindOpen(true);
    setFindTerm((prev) => pickFindTermOnOpen({ previous: prev, selectionRaw, external: searchTerm ?? "" }));
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

  const navigate = useCallback(
    (delta: number) => {
      if (!hits.length) return;
      setActiveIdx((prev) => {
        const next = (prev + delta + hits.length) % hits.length;
        scrollLineIntoView(hits[next].line);
        return next;
      });
    },
    [hits, scrollLineIntoView]
  );

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindTerm("");
    setActiveIdx(0);
    // 查找结束，焦点回到被查找的那一层：归还给滚动容器 .code-area（它是 tabIndex=0 + role="region"
    // 的键盘可达层）。少了这一步，查找输入框随卸载一起消失、activeElement 掉回 body，
    // 用户接着按方向键 / PageUp / PageDown 代码一动不动，必须先拿鼠标点一下正文（R62）。
    // preventScroll：这一层可能只露出半截，聚焦不该顺手把整页滚动条拽过来。
    areaRef.current?.focus({ preventScroll: true });
  }, []);

  // 查找栏是宿主弹层内部的瞬时层，必须自己登记，否则 Esc 会被外层吃掉、连带取消编辑（R61）。
  // 门控两条：视图被保活隐藏（active=false）与查找栏没开时都不参与，免得看不见的层抢走按键。
  useEscape(active && findOpen, closeFind, EscapePriority.find);

  // 搜索词 / 匹配口径 / 文件变化：重置当前命中序号，避免越界或指向上一份文件。
  // 口径必须进依赖：勾上「全词」后命中会变少，旧的 activeIdx 可能已经越过新的末尾，
  // 计数「第 N/M 处」会显示成不存在的位置。
  useEffect(() => {
    setActiveIdx(0);
  }, [effectiveTerm, matchOptions, code]);

  // 换内容时把滚动位置拉回起点（R9）：正文变了要归零；正文逐字相同但版本（contentKey）
  // 变了也要归零，否则相邻无差异版本之间会保留上一版的偏移，看起来像"莫名停在中间"。
  // 口径与实现见 ../lib/useScrollResetOnContentChange。
  //
  // 这里的 onReset 干两件事，顺序不能反（R74）：先把内容搜索的首个命中拉进视口，
  // 再 syncScroll 一次——行号层 / 命中行层 / 缩略图视口全靠 transform 跟手，
  // 不同步就会侧栏停在开头、正文停在命中行，整屏错位。
  // 定位必须待在这个回调里（即 hook 的 useLayoutEffect，绘制前）：挪到绘制后的 useEffect
  // 会先闪一帧文件开头，用户读到的仍是"点了结果没反应"。
  const handleContentReset = useCallback(() => {
    locateFirstExternalHit();
    syncScroll();
  }, [locateFirstExternalHit, syncScroll]);

  useScrollResetOnContentChange(areaRef, [code, contentKey], handleContentReset);

  // 切换文件时收起查找栏，防止旧关键词污染新内容。
  // 这里**不许**改成调用 closeFind：换文件是用户在左侧列表里点出来的，焦点该留在他点的位置；
  // closeFind 的语义是「我刚结束查找，把焦点还给正文」，两条出口别混（R62 口径）。
  useEffect(() => {
    setFindOpen(false);
    setFindTerm("");
  }, [code]);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    syncScroll();
    const raf = (window as unknown as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
    const onScroll = () => (raf ? raf(syncScroll) : syncScroll());
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [syncScroll]);

  // 容器尺寸变化（含首次布局）刷新视口高度。
  useEffect(() => {
    const area = areaRef.current;
    if (!area || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => syncScroll());
    ro.observe(area);
    return () => ro.disconnect();
  }, [syncScroll]);

  useEffect(() => {
    const mm = minimapRef.current;
    if (!mm || typeof ResizeObserver === "undefined") return;
    const measure = () => setMinimapSize({ width: mm.clientWidth, height: mm.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(mm);
    return () => ro.disconnect();
  }, [showMinimap]);

  // Ctrl+F / Cmd+F / F3：仅在焦点落在本视图、或没有任何输入框持有焦点时接管，
  // 绝不从其他输入框（如配置列表搜索框）抢走原生查找。
  useEffect(() => {
    // 视图被保活隐藏时不挂全局监听：避免隐藏的查找栏抢走 Ctrl+F / F3
    if (!enableFind || !active) return;
    const takesThisView = (target: EventTarget | null): boolean => {
      const root = rootRef.current;
      // 事件源在本视图内（含查找输入框）→ 接管；Node 判定避免 window/document 触发 contains 抛错
      if (root && target instanceof Node && root.contains(target)) return true;
      const active = document.activeElement as HTMLElement | null;
      const editable = !!active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
      // 焦点在别处的可编辑控件上 → 让给它，不劫持
      if (editable) return false;
      // 没有焦点 / 焦点在 body → 视为针对当前文件
      return !active || active === document.body || active === document.documentElement;
    };
    const handler = (e: KeyboardEvent) => {
      // 组合态期间不劫持 Ctrl+F / F3：此刻按键属于输入法候选，不该被查找栏抢走
      if (isImeComposing(e)) return;
      const target = e.target as EventTarget | null;
      const key = e.key;
      const isFindKey = (e.ctrlKey || e.metaKey) && (key === "f" || key === "F");
      const isF3 = key === "F3";
      if (!isFindKey && !isF3) return;
      // F3 只有在查找栏已打开时才导航，否则把浏览器原生查找/其它行为留给系统
      if (isF3 && !findOpen) return;
      if (!takesThisView(target)) return;
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

  // 打开 / 改变查找词后，滚动到首个命中（导航本身在 navigate 内即时滚动）。
  useEffect(() => {
    if (!findOpen || !hits.length) return;
    scrollLineIntoView(hits[clamp(activeIdx, 0, hits.length - 1)].line);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, effectiveTerm, matchOptions]);

  /**
   * 当前命中变化后补上水平定位（轮27 F-7，长行里的命中不能只滚垂直）。
   *
   * 为什么不能像垂直定位那样写在 navigate 里：navigate 在 setActiveIdx 的 updater 内同步滚动，
   * 那一刻 DOM 里的 .search-hit-current 仍是上一处命中，量矩形会量到旧位置。
   * 旧的列宽算式没有这个时序问题（它不读 DOM），换成矩形测量就必须等提交之后——
   * useLayoutEffect 在绘制前跑完，用户看不到中间那帧偏移。
   *
   * 依赖只写 activeOffset：横向偏移被用户自己拖走之后，只要当前命中没变就不许再把他拽回来
   * （metrics 每滚一格都变，进依赖就成了「一改口径就抖动」的第二份实现）。
   */
  useLayoutEffect(() => {
    if (!findOpen || !hits.length) return;
    revealMarkHorizontally(areaRef.current, areaRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, activeOffset]);

  /**
   * 开栏后实测查找条的高度（轮27 F-8）。
   *
   * 绘制前量：净空公式在首次开栏那一帧用兜底常量（单行态实测就是 34），
   * 真量出别的高度（换行 / 别的语言文案更高）再改，用户看不到中间那帧跳动。
   */
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

  // 净空变了但没有滚动事件（padding 变化不触发 scroll）：补一次同步，
  // 否则缩略图的视口比例还按旧 scrollHeight 算，点缩略图会跳偏。
  useLayoutEffect(() => {
    syncScroll();
  }, [padTop, syncScroll]);

  // 同一份正文里改外部搜索词（没开查找栏）：也跟着定位新词的首个命中。
  // 依赖数组**只许写 searchTerm**：closeFind 只动 findOpen / findTerm，用户主动关栏后
  // 刚看的那处命中该留在屏幕上，不许被这条拽回第一处（CodeView.test.tsx R74 钉住）。
  // 换正文那条路径由 handleContentReset 在绘制前处理，这里重复执行也只是跳到同一行。
  useEffect(() => {
    if (locateFirstExternalHit()) syncScroll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm]);

  const onFindKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // 组合态回车是「上屏候选词」，不是「跳到下一个命中」
    if (isImeComposing(e)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      navigate(e.shiftKey ? -1 : 1);
    }
    // Esc 不在这里处理：查找栏已登记为 find 优先级的瞬时层（R61），
    // 分派器在捕获阶段就吃掉按键，裸分支是永远跑不到的死代码，留着只会误导下一个改这里的人。
  };

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

  const hitRows = useMemo(() => {
    const seen = new Set<number>();
    const out: number[] = [];
    const { start, end } = visibleRange;
    for (const hit of hits) {
      if (hit.line >= start && hit.line < end && !seen.has(hit.line)) {
        seen.add(hit.line);
        out.push(hit.line);
      }
    }
    out.sort((a, b) => a - b);
    return out;
  }, [hits, visibleRange]);

  const rowLimit = Math.max(MM_MIN_ROWS, Math.floor(minimapSize.height / MM_ROW_H));
  const minimapRows = useMemo(() => buildMinimapRows(lines, hitSet, currentLine, rowLimit), [lines, hitSet, currentLine, rowLimit]);

  // 画缩略图：命中行用红色覆盖，当前命中更亮。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { width, height } = minimapSize;
    // 未测量出尺寸（首帧 / jsdom）时先跳过，顺带避免无谓地调用 getContext。
    if (width <= 0 || height <= 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = (window as unknown as { devicePixelRatio?: number }).devicePixelRatio ?? 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const n = Math.max(1, lines.length);
    for (const row of minimapRows) {
      if (row.kind === "blank") continue;
      const y = (row.startLine / n) * height;
      const h = Math.max(1, ((row.endLine - row.startLine) / n) * height - 0.5);
      const barWidth = Math.max(3, row.widthRatio * (width - 8));
      ctx.fillStyle = row.kind === "comment" ? "rgba(180, 180, 180, 0.16)" : "rgba(220, 220, 220, 0.24)";
      ctx.fillRect(4, y, barWidth, h);
      if (row.hasHit) {
        ctx.fillStyle = row.isCurrent ? "#ff6b6b" : "rgba(244, 71, 71, 0.9)";
        ctx.fillRect(4, y, barWidth, h);
      }
    }
  }, [minimapRows, minimapSize, lines.length]);

  const jumpFromPointer = useCallback((clientY: number) => {
    const mm = minimapRef.current;
    const el = areaRef.current;
    if (!mm || !el || el.scrollHeight <= 0) return;
    const rect = mm.getBoundingClientRect();
    const ratio = clamp((clientY - rect.top) / Math.max(1, rect.height), 0, 1);
    el.scrollTop = clamp(ratio * el.scrollHeight - el.clientHeight / 2, 0, el.scrollHeight);
  }, []);

  const hasMinimap = showMinimap && totalLines > 0;

  const viewport = useMemo(() => {
    const { scrollTop, scrollHeight, clientHeight } = metrics;
    if (scrollHeight <= 0 || clientHeight <= 0 || totalLines <= 0) return null;
    const contentH = padTop * 2 + totalLines * ROW_H;
    const topPct = clamp((scrollTop / scrollHeight) * 100, 0, 100);
    const heightPct = clamp((clientHeight / scrollHeight) * 100, (ROW_H / contentH) * 100, 100 - topPct);
    return { topPct, heightPct };
  }, [metrics, totalLines, padTop]);

  const padRight = hasMinimap ? GUTTER_W + 24 : GUTTER_W + 16;
  const padRightVar = { "--code-pad-right": `${padRight}px`, "--code-find-right": `${hasMinimap ? GUTTER_W + 24 : 16}px` } as CSSProperties;

  return (
    <div className="code-view" ref={rootRef} tabIndex={-1} style={{ "--code-pad-top": `${padTop}px` } as CSSProperties}>
      <div className="code-body">
        <div className="code-lines" aria-hidden="true">
          <div className="code-lines-layer" ref={linesInnerRef}>
            {hitRows.map((line) => (
              <div
                key={`hit-${line}`}
                className={`code-line${line === currentLine ? " is-current" : " is-hit"}`}
                style={{ top: padTop + line * ROW_H }}
              />
            ))}
          </div>
        </div>

        <pre
          ref={areaRef}
          className="code-area mono hljs"
          tabIndex={0}
          role="region"
          aria-label={t("config.content")}
          onScroll={syncScroll}
          style={padRightVar}
        >
          <code dangerouslySetInnerHTML={{ __html: html }} />
        </pre>

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

        {hasMinimap && (
          <div
            className="code-minimap"
            ref={minimapRef}
            title={t("config.minimap")}
            onPointerDown={(e) => {
              draggingRef.current = true;
              e.currentTarget.setPointerCapture?.(e.pointerId);
              jumpFromPointer(e.clientY);
            }}
            onPointerMove={(e) => {
              if (draggingRef.current) jumpFromPointer(e.clientY);
            }}
            onPointerUp={(e) => {
              draggingRef.current = false;
              e.currentTarget.releasePointerCapture?.(e.pointerId);
            }}
            onPointerCancel={() => {
              draggingRef.current = false;
            }}
          >
            <canvas className="code-minimap-canvas" ref={canvasRef} />
            {viewport && <div className="code-minimap-viewport" style={{ top: `${viewport.topPct}%`, height: `${viewport.heightPct}%` }} />}
          </div>
        )}

        {enableFind && !findOpen && (
          <button
            type="button"
            className="code-find-open"
            onClick={openFind}
            title={t("config.openFind")}
            aria-label={t("config.openFind")}
            aria-keyshortcuts="Control+F"
            style={padRightVar}
          >
            ⌕
          </button>
        )}

        {enableFind && findOpen && (
          <div className="code-find" ref={findBarRef} role="search" style={padRightVar}>
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
                setActiveIdx(0);
              }}
              onKeyDown={onFindKeyDown}
            />
            {/* 匹配口径开关。onMouseDown preventDefault：按钮默认会夺走焦点，
                点一下开关就得再点一次输入框才能继续改词——查找栏的老毛病，这里挡住。 */}
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
            <button
              type="button"
              className="code-find-btn"
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
    </div>
  );
}
