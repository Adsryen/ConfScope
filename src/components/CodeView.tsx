import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Format } from "../lib/format";
import { highlightCode } from "../lib/highlight";
import {
  activeLineOf,
  CURRENT_HIT_CLASS,
  currentHitSelector,
  findCodeHits,
  hitLines,
  hitLinesInRange,
  isHitScanCapped,
  markHighlightedHtml,
  MAX_CODE_HITS,
  splitLines,
} from "../lib/codeLines";
import CodeMinimap, { MINIMAP_RESERVED_RIGHT } from "./CodeMinimap";
import { useWheelScrollsContainer } from "../lib/useWheelScrollsContainer";
import { useTranslation } from "../i18n";
import { EscapePriority, isImeComposing, useEscape } from "../lib/useEscape";
import { useScrollResetOnContentChange } from "../lib/useScrollResetOnContentChange";
import { useRememberedState } from "../lib/viewState";
import { pickFindTermOnOpen, selectionTextWithin } from "../lib/findSelection";
import { useDebouncedFindTerm } from "../lib/findInput";
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
  const findInputRef = useRef<HTMLInputElement>(null);
  const findBarRef = useRef<HTMLDivElement | null>(null);
  /** 关栏状态下的 ⌕ 入口浮标：和查找条同一块死区（轮32 F-33），也要接滚轮。 */
  const findOpenBtnRef = useRef<HTMLButtonElement | null>(null);
  /** 带着「当前命中」类的那批 <mark>：html 不变时 React 不重建它们，类只能由这里显式收回。 */
  const currentHitMarksRef = useRef<HTMLElement[]>([]);

  const [findOpen, setFindOpen] = useState(false);
  // 查找栏打开期间实测的条高（px）。窄容器里条子会 flex-wrap 成两行（轮26 F-4 量到 60），
  // 照常量留净空照样盖住正文，所以量得到就按量的算，量不到退到兜底常量。
  const [findBarHeight, setFindBarHeight] = useState(0);
  const [findTerm, setFindTerm] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  /**
   * 跳转计数（轮29 F-18）。
   *
   * 这是把滚动挪出 setState updater（F-17）之后**立刻**暴露的下一条：全文只有 1 处命中时
   * `(0 + 1 + 1) % 1 === 0`，activeIdx 值没变，React 连重渲染都省了，落地效果根本不跑——
   * 用户连按 Enter / F3，计数一直是「第 1/1 处」，屏幕一动不动，看起来像快捷键失效。
   * 旧实现在这里"能用"靠的正是 updater 里那句副作用，等于拿脏写法把这条盖住了。
   * 修法是用一个纯计数器表达「我又跳了一次」，序号不变也照样把那一处再送进视口。
   * 编辑态没这个毛病（它在 updater 之外自己调 revealHit，见 CodeEditor.navigate）。
   */
  const [navTick, setNavTick] = useState(0);
  // 查找栏的两个匹配开关：浏览态与编辑态共用同一对记忆键（切视图不丢口径）。
  // 走 viewState 唯一实现、不落 localStorage——用户要的是「这台机器这次会话里记住」，
  // 不是「重启后所有文件都按全词搜」。
  const [caseSensitive, setCaseSensitive] = useRememberedState<boolean>("codeFind.caseSensitive", false);
  const [wholeWord, setWholeWord] = useRememberedState<boolean>("codeFind.wholeWord", false);

  const [metrics, setMetrics] = useState({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 });

  const lines = useMemo(() => splitLines(code), [code]);
  const totalLines = lines.length;

  /**
   * 右侧留白按设置预留（轮28 F-13）。
   *
   * 这个条件**不许**跟着缩略图的显隐变：「隐藏缩略图 ⇒ 正文宽 8px ⇒ 可能不再需要横向滚动条
   * ⇒ clientHeight 变 ⇒ 又该显示缩略图」是一个自激振荡，留白跟着抖就是抖动本身。
   */
  const minimapReserved = showMinimap && totalLines > 0;
  /**
   * 缩略图表面本身交给共享组件 CodeMinimap（轮30 F-24），「内容到底能不能滚」由它自己判。
   * 视图这里只留**留白**的依据：设置开着且有正文就留位，不跟着显隐抖（轮28 F-13 那条自激振荡）。
   */

  /**
   * 查找词输入的延迟（轮29 F-16）：正文够大时把「每敲一个字重标记整篇 + 重新解析」并成「停顿一次」。
   *
   * 实测每键成本 2 000 行 26ms / 20 000 行 177ms / 200 000 行 ≈1 800ms，输入一个六字母的词
   * 在 10MB 文件里要卡 10.8 秒（`research/bench_f16_keystroke_cost.log`）。阈值以下这个 hook 直接透传、
   * 不建定时器 ⇒ 小文件仍是逐字实时，既有同步断言的测试一条都不必改成异步。
   *
   * `term` 必须就是 `effectiveTerm`：hits / 命中行底色 / 计数 / 缩略图红条全靠这一份，
   * 另起一个变量标红与行号就会分叉（`findBarMatchOptionsArePaired` 钉的也是这个形状）。
   */
  const { term: committedFindTerm, isPending: findTermPending, flush: flushFindTerm } = useDebouncedFindTerm(findTerm, totalLines);
  // 查找栏打开时以查找词为准；否则沿用外部内容搜索词（整体标红，不区分当前命中）。
  // 外部搜索词那条路径不进延迟（见 ../lib/findInput 的口径 2）。
  const effectiveTerm = findOpen ? committedFindTerm : (searchTerm ?? "");
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

  // 命中行表（升序）：二分取可视区窗口用得上这份序，见 hitLinesInRange。
  const hitLineArray = useMemo(() => Array.from(hitSet), [hitSet]);

  const currentLine = findOpen ? activeLineOf(hits, activeIdx) : null;

  /**
   * 语法高亮只跟「正文 + 格式」有关（轮28 F-14）。
   *
   * 缺陷长什么样：原先 html 的依赖里圈着 activeOffset，于是每按一次 Enter 换一处命中，
   * 整篇文档都要重新 highlightCode + 重新标记 + 重新交给浏览器解析。实测每次 Enter 的代价
   * 2k 行 25-45ms / 20k 行（约 1MB）235-342ms / 200k 行（约 10MB）1586-3136ms——
   * 用户按回车翻页，等到的是一秒以上的白屏。当前命中改到 DOM 类上之后，这条依赖本来就不该存在。
   */
  const baseHtml = useMemo(() => {
    const base = highlightCode(code, format);
    // 末尾换行的安全表示：不依赖 HTML 解析行为（详见 highlight.ts 注释）。
    return code.endsWith("\n") ? base + "<span></span>" : base;
  }, [code, format]);
  // 命中层单独一层：换「当前在第几处」不动这里，只有命中集合变了才重算。
  const html = useMemo(() => markHighlightedHtml(baseHtml, hits), [baseHtml, hits]);

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
      // 输入框里还有没落进命中层的字符：这次按键只负责提交，新词的 hits 到位后由定位效果落到第一处。
      // 用它跳等于拿旧词的命中表数格子（轮29 F-16 AC3）。
      if (findTermPending) {
        flushFindTerm();
        return;
      }
      if (!hits.length) return;
      // updater 只算序号，不滚动（轮29 F-17）：滚动是副作用，写在 updater 里等于把它交给
      // React 决定跑几次——StrictMode 每次更新都把 updater 调两遍，一次 Enter 就给 scrollTop
      // 赋值两次。真正的落地排在下面的 useLayoutEffect（提交后、绘制前）。
      setActiveIdx((prev) => (prev + delta + hits.length) % hits.length);
      setNavTick((tick) => tick + 1);
    },
    [findTermPending, flushFindTerm, hits]
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

  /**
   * 当前命中的落地：垂直（把所在行送进视口中线）→ 给这一处的 <mark> 换 current 类 → 水平定位。
   * 三步同一条 useLayoutEffect（轮28 F-14 + 轮27 F-7 + 轮29 F-17/F-18）。
   *
   * 为什么顺序不能反：html 不再随当前命中变化（那正是轮28 省下来的钱），DOM 里的 current 类
   * 因此不会自己挪位置，先量矩形就量到上一处。垂直排最前还有一层原因：长行里 <mark> 的矩形
   * 要等到它所在行进了视口才量得准。
   *
   * 垂直原先散在两条出口：navigate 的 setState updater（副作用，StrictMode 下被重复执行）和一条
   * 只管「开栏 / 改词」的 useEffect（绘制后才跑，会闪一帧旧位置）。合并到这里之后，
   * 开栏、改词、改口径、Enter / F3 导航共用同一次「提交后、绘制前」的落地。
   *
   * 依赖里**不许**出现 metrics：横向偏移被用户自己拖走之后，只要当前命中没变就不许再把他拽回来
   * （metrics 每滚一格都变，进依赖就成了「一改口径就抖动」的第二份实现）。
   * navTick 是 F-18 的补丁：命中只有一处时 activeIdx 不变，靠它把「再跳一次」这件事传进来。
   */
  useLayoutEffect(() => {
    const root = areaRef.current;
    for (const mark of currentHitMarksRef.current) mark.classList.remove(CURRENT_HIT_CLASS);
    currentHitMarksRef.current = [];
    if (!root || !findOpen || !hits.length) return;
    const idx = clamp(activeIdx, 0, hits.length - 1);
    scrollLineIntoView(hits[idx].line);
    const marks = root.querySelectorAll<HTMLElement>(currentHitSelector(idx));
    if (marks.length) {
      for (const mark of marks) mark.classList.add(CURRENT_HIT_CLASS);
      currentHitMarksRef.current = Array.from(marks);
    }
    revealMarkHorizontally(root, root);
  }, [html, findOpen, hits, activeIdx, navTick, scrollLineIntoView]);

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

  /**
   * 滚轮落在查找条 / ⌕ 浮标上 ⇒ 滚正文（轮32 F-33）。
   *
   * 取证 research/wheelbar_probe.txt + wheelopen_probe.txt：条子 532×38（窄容器换行 418×38）、
   * 浮标 26×26，都完全压在正文之上；正文偏移 120 时滚一格，计数上 / 条内空隙 / 空隙偏左 / 浮标上
   * 四个落点全部停在 120，外层面板也始终 0 —— 不是双滚，是纯死区。换算与放手条件在
   * src/lib/useWheelScrollsContainer.ts，与缩略图共用同一份（轮31 F-25 那条）。
   *
   * reattachKey 都递 findOpen：两个元素互斥渲染且每次都是新节点，
   * 关栏再开栏时不重挂监听就等于这条出口静默失活。
   */
  useWheelScrollsContainer(findBarRef, { containerRef: areaRef, syncScroll, rowHeight: ROW_H, reattachKey: findOpen });
  useWheelScrollsContainer(findOpenBtnRef, { containerRef: areaRef, syncScroll, rowHeight: ROW_H, reattachKey: findOpen });

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

  /**
   * 可视区内的命中行（轮28 F-15）：二分取窗口，不再线性扫全量命中。
   *
   * 原先这里是 `for (const hit of hits)`，而这条 memo 挂在 visibleRange 上——每滚一格
   * 都把 5000 处命中从头扫一遍，绝大多数还在窗口外白扫。命中行表天然升序，二分定位起点
   * 之后只走窗口内那几行。
   */
  const hitRows = useMemo(() => hitLinesInRange(hitLineArray, visibleRange.start, visibleRange.end), [hitLineArray, visibleRange]);

  const padRight = minimapReserved ? MINIMAP_RESERVED_RIGHT : GUTTER_W + 16;
  const padRightVar = {
    "--code-pad-right": `${padRight}px`,
    "--code-find-right": `${minimapReserved ? MINIMAP_RESERVED_RIGHT : 16}px`,
  } as CSSProperties;

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

        {minimapReserved && (
          <CodeMinimap
            containerRef={areaRef}
            syncScroll={syncScroll}
            lines={lines}
            hitLineArray={hitLineArray}
            currentLine={currentLine}
            metrics={metrics}
            rowHeight={ROW_H}
            padTop={padTop}
          />
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
            {/* ↑↓ 与上面两个开关同一口径（轮32 F-29）：点跳转不许把焦点从查找输入框 / textarea 上抢走——
                抢走之后接着敲的字符哪儿都不去（真机取证见任务目录 research/focus_probe.txt）。
                下面的 ✕ 反过来：它的语义是「结束查找，把焦点还给正文」，onClick 里那句 focus 依赖这次点击，别照抄。 */}
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
    </div>
  );
}
