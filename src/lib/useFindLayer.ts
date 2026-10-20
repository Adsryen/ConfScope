// 文件内查找这一层的「本地状态 + 副作用编排」（轮49）。
//
// 为什么现在抽出来：条子本体在轮48 已经成唯一实现（src/components/FindBar.tsx），
// 但它两边的状态机还是每个宿主各抄一份——CodeView、CodeEditor、DiffPanel 三份，
// UnifiedDiff 是第四个宿主，再抄就是第四份。三份散装的后果不是"代码重复"这么轻：
// 步进单位、净空、关栏归还焦点、Ctrl+F 所有权、输入延迟这五件事每份都可能各说各话，
// 而六条守卫只能逐个文件去钉表达式，钉不住"同一件事只有一个出处"。
//
// 边界按**几何口径**切，不按宿主数量切：
// - 量 DOM 那一派（行高不固定、pre-wrap 自动换行）= DiffPanel / UnifiedDiff，本轮起共用本 hook；
// - 套行号公式那一派（定行高 + 还要 syncScroll() 把 transform 推给行号层与缩略图）= CodeView / CodeEditor，
//   本轮不动（它们与 minimap 的隐式契约不该埋进公共层），迁移列进任务 PRD 的后续。
//
// 本 hook **不拥有**命中算法与标记算法：findDiffHits / markHighlightedHtml / toLineHits /
// baseIndexForSide / currentHitSelector / revealRowVertically / padTopForFindBar 仍是各自那一个出处，
// 这里只负责把它们按正确的顺序编排起来（守卫：tests/ux/findBarSingleImplementation、
// tests/ux/diffFindReusesSharedHitLayer）。
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { CURRENT_HIT_CLASS, currentHitSelector } from "./codeLines";
import {
  currentDiffGroup,
  findDiffHits,
  type DiffFindResult,
  type DiffFindRow,
  type DiffHitGroup,
} from "./diffFind";
import type { MatchOptions } from "./textMatch";
import { EscapePriority, isImeComposing, useEscape } from "./useEscape";
import { FIND_KEY_OWNER_ATTR, takesFindKeyOwnership } from "./findKeyOwnership";
import { pickFindTermOnOpen, selectionTextWithin } from "./findSelection";
import { useDebouncedFindTerm } from "./findInput";
import { useRememberedState } from "./viewState";
import { measureFindBarHeight, padTopForFindBar, revealRowVertically } from "./codeScroll";

/**
 * 关栏时的中性口径常量（必须是模块级同一份引用）：命中层 memo 依赖它，
 * 写成对象字面量会让每次渲染都重算一遍命中表。三个未迁移宿主各自还有一份同形状的本地常量，
 * 迁移时一并收到这里。
 */
export const NEUTRAL_MATCH_OPTIONS: MatchOptions = {};

export interface UseFindLayerInput {
  /**
   * **渲染出来的**那份行集。传全量行集的后果在轮48 真机里钉过：勾上「仅显示变更」后
   * 被隐藏的行仍留在编号里，Enter 会落到 DOM 里根本不存在的 <mark> 上（当场失联）。
   */
  rows: DiffFindRow[];
  /**
   * 外部内容搜索词（浏览态由左侧列表的「按内容搜索」传进来）。查找栏没开时命中层接它，
   * 开栏后由栏内的词接管——与 CodeView 的 effectiveTerm 同一句话。
   * 没有这条路径的宿主（DiffPanel / 单文件对比）传空串：栏一关就等于没词。
   */
  externalTerm: string;
  /** 视图被保活隐藏时不参与：不挂全局按键监听、不抢 Esc、不开别人的查找栏。 */
  active: boolean;
  /** 关掉查找入口（变更计划预览这类只读小面板）。 */
  enableFind: boolean;
  /** 挂 / 摘 `data-find-key-owner` 的那棵树（宿主根节点）。 */
  rootRef: RefObject<HTMLElement | null>;
  /** 滚动容器 = 定位命中行的坐标系 = 关栏后归还焦点的那一层。 */
  bodyRef: RefObject<HTMLElement | null>;
  /** 条子本体，用来量高度（窄栏 flex-wrap 成两行时净空要跟着长）。 */
  findBarRef: RefObject<HTMLDivElement | null>;
  /** 查找条输入框：开栏后由本 hook 负责聚焦并全选旧词。 */
  findInputRef: RefObject<HTMLInputElement | null>;
}

/**
 * ⌕ 浮标那颗按钮的 ref **不在入参里**：它只服务于宿主的 JSX（`FindOpenButton btnRef={…}`），
 * 本 hook 一次都不读它。入参只收「编排确实要用」的引用，多给一个就是让每个宿主都去量一遍它的按钮。
 */

export interface FindLayer {
  findOpen: boolean;
  /** 输入框里的即时值（可能还没提交进命中层）。 */
  findTerm: string;
  /** 改了词：序号同时归零，否则计数会指到一个不存在的位置。 */
  changeTerm: (value: string) => void;
  /** 命中层真正在用的词（开栏 = 提交后的栏内词，关栏 = 外部词）。 */
  effectiveTerm: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  toggleCaseSensitive: () => void;
  toggleWholeWord: () => void;
  result: DiffFindResult;
  /** 步进单位 = 行，所以分母是组数而不是标红单元数。 */
  hitCount: number;
  activeIdx: number;
  currentGroup: DiffHitGroup | null;
  /** 当前那一组里的全部标红编号（等行左右两格同时亮仍是「一处」）。 */
  currentMarkIndexes: Set<number>;
  /** 顶部净空：关栏 0，开栏 = 条子上缘 8 + 实测条高 + 8。 */
  padTop: number;
  openFind: () => void;
  closeFind: () => void;
  navigate: (delta: number) => void;
  onFindKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  /**
   * 换正文时收起查找栏，但**不归还焦点**：换文件是用户在列表里点出来的，焦点该留在他点的位置；
   * `closeFind` 的语义是「我刚结束查找，把焦点还给正文」。两条出口不许混（R62 口径）。
   */
  resetFindForNewContent: () => void;
}

export function useFindLayer({
  rows,
  externalTerm,
  active,
  enableFind,
  rootRef,
  bodyRef,
  findBarRef,
  findInputRef,
}: UseFindLayerInput): FindLayer {
  const [findOpen, setFindOpen] = useState(false);
  const [findTerm, setFindTerm] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  /**
   * 「我又跳了一次」的纯计数器（轮29 F-18）：命中只剩一行时 `(0+1+1)%1 === 0`，
   * activeIdx 值没变、React 连重渲染都省了，用户连按 Enter 屏幕一动不动。
   */
  const [navTick, setNavTick] = useState(0);
  const [findBarHeight, setFindBarHeight] = useState(0);
  /**
   * 上一轮打上 current 类的 <mark>：换当前命中前逐个摘掉，保证 DOM 里恒有一颗「当前」。
   * 必须是每个宿主实例一份 ref——写成模块级单例会让两个并排面板互相摘掉对方的标记，
   * 而且 React 根本不会为重渲染重建它（轮49 起草时踩过，别改回去）。
   */
  const currentHitMarksRef = useRef<HTMLElement[]>([]);
  // 两个匹配开关与其余宿主共用同一对记忆键：切视图不丢口径，且不落 localStorage。
  const [caseSensitive, setCaseSensitive] = useRememberedState<boolean>("codeFind.caseSensitive", false);
  const [wholeWord, setWholeWord] = useRememberedState<boolean>("codeFind.wholeWord", false);

  /**
   * 输入延迟的入参按**可见行数**取——隐藏掉等行之后，这份工作量的确变小了。
   * 延迟口径只有一份（lib/findInput），不许在这里再写 setTimeout。
   */
  const { term: committedTerm, isPending, flush: flushTerm } = useDebouncedFindTerm(findTerm, rows.length);
  const effectiveTerm = findOpen ? committedTerm : externalTerm;
  const matchOptions = useMemo<MatchOptions>(
    () => (findOpen ? { caseSensitive, wholeWord } : NEUTRAL_MATCH_OPTIONS),
    [findOpen, caseSensitive, wholeWord]
  );
  const result = useMemo(() => findDiffHits(rows, effectiveTerm.trim(), matchOptions), [rows, effectiveTerm, matchOptions]);
  const hitCount = result.groups.length;
  const currentGroup = useMemo(() => currentDiffGroup(result, activeIdx), [result, activeIdx]);
  const currentMarkIndexes = useMemo(() => new Set(currentGroup?.markIndexes ?? []), [currentGroup]);
  const padTop = padTopForFindBar(0, findOpen, findBarHeight);

  const changeTerm = useCallback((value: string) => {
    setFindTerm(value);
    setActiveIdx(0);
  }, []);

  const openFind = useCallback(() => {
    // 选区 > 栏内旧词 > 外部搜索词（轮26 F-3）：按 Ctrl+F 前选中一段配置名，要的就是搜它。
    // 必须在这个函数里、setState 之前同步读：查找输入框一拿到焦点，文档级选区就被清掉了。
    const selectionRaw = selectionTextWithin(bodyRef.current);
    setFindOpen(true);
    setFindTerm((prev) => pickFindTermOnOpen({ previous: prev, selectionRaw, external: externalTerm }));
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
  }, [bodyRef, externalTerm, findInputRef]);

  const navigate = useCallback(
    (delta: number) => {
      // 输入框里还有没落进命中层的字符：这次按键只负责提交，新词的命中表到位后由落地效应落第一处。
      // 用它跳等于拿旧词的命中表数格子（轮29 F-16 AC3）。
      if (isPending) {
        flushTerm();
        return;
      }
      const total = result.groups.length;
      if (!total) return;
      // updater 只算序号、不滚动（轮29 F-17）：滚动是副作用，写在 updater 里等于交给 React 决定跑几次
      // ——StrictMode 每次更新把 updater 调两遍，一次 Enter 就给 scrollTop 赋值两次。
      setActiveIdx((prev) => (prev + delta + total) % total);
      setNavTick((tick) => tick + 1);
    },
    [flushTerm, isPending, result]
  );

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindTerm("");
    setActiveIdx(0);
    // 归还焦点给正文这一层（tabIndex=0 + role="region"）：少了这一步，条子随卸载一起消失、
    // activeElement 掉回 body，用户接着按方向键 / PageUp 一动不动，必须先用鼠标点一下正文（R62）。
    // preventScroll：这一层可能只露出半截，聚焦不该顺手把整页滚动条拽过来。
    bodyRef.current?.focus({ preventScroll: true });
  }, [bodyRef]);

  const resetFindForNewContent = useCallback(() => {
    setFindOpen(false);
    setFindTerm("");
    setActiveIdx(0);
  }, []);

  // 查找栏是页面内的瞬时层，必须自己登记 Esc，否则被宿主弹层吃掉（R61）。
  // 两道门：宿主视图被保活隐藏、以及栏没开时都不参与，免得看不见的层抢走按键。
  useEscape(active && findOpen, closeFind, EscapePriority.find);

  // 换词 / 换口径：序号归零。口径必须进依赖——勾上全词后命中会变少，
  // 旧的 activeIdx 可能已经越过新的末尾，计数会显示成一个不存在的位置。
  useEffect(() => {
    setActiveIdx(0);
  }, [effectiveTerm, matchOptions]);

  // Ctrl+F / Cmd+F / F3：所有权判定收在 lib/findKeyOwnership，与浏览态、编辑态共用一份。
  // 根 = 宿主给的 rootRef：⌕ 浮标、查找条、正文选区都在这棵树里；焦点落在输入框时绝不抢走原生查找。
  useEffect(() => {
    if (!enableFind || !active) return;
    const root = rootRef.current;
    // 注册表与监听同生同灭：摘掉属性就等于「这一层不再认领 Ctrl+F」，
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
  }, [active, enableFind, findOpen, navigate, openFind, rootRef]);

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
  }, [findOpen, findBarRef]);

  /**
   * 当前命中行的落地：先摘掉上一轮的 current 类，再给这一行**每一格的每一处**标红打上 current，
   * 最后按量出来的矩形居中。
   *
   * 顺序不能反：标记层重建后 DOM 里的 current 类不会自己挪位置，先量就量到上一处；
   * 而行要先进了视口，它里面 <mark> 的矩形才量得准。
   * 依赖里不许出现滚动位置：用户自己拖走之后，只要当前命中没变就不许再把他拽回来。
   * 「当前是哪一组」只读 currentGroup 这一个出处（含越界夹取，见 lib/diffFind），
   * 这里再夹一次序号就是第二套编号语义——行号变红与 <mark> 打类会各说各话。
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
  }, [bodyRef, currentGroup, findOpen, navTick]);

  /** Enter / Shift+Enter 步进。Esc 不在这里处理：查找栏已登记为 find 优先级的瞬时层（R61），
   *  分派器在捕获阶段就把按键吃掉，这里的裸分支是跑不到的死代码。 */
  const onFindKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (isImeComposing(event)) return;
      if (event.key === "Enter") {
        event.preventDefault();
        navigate(event.shiftKey ? -1 : 1);
      }
    },
    [navigate]
  );

  return {
    findOpen,
    findTerm,
    changeTerm,
    effectiveTerm,
    caseSensitive,
    wholeWord,
    toggleCaseSensitive: () => setCaseSensitive((v) => !v),
    toggleWholeWord: () => setWholeWord((v) => !v),
    result,
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
  };
}

