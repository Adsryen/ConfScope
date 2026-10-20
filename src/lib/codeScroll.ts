// 浏览态（CodeView）与编辑态（CodeEditor）共用的查找定位几何。
//
// 为什么这份代码必须待在 lib：同一个「把当前命中送到用户眼前」的动作原先有两套口径——
// 编辑态按「列 × 隐形探针量出的字宽」算 scrollLeft，浏览态压根不写 scrollLeft。
// Nacos 里大量配置是单行长 JSON（几 KB 到几十 KB 挤在一行），浏览态搜 serverPort 时
// 查找栏老实显示「第 1/12 处」，红字却在第 4000 列的屏幕外（轮27 F-7）：
// 行是对的（全文就这一行），列是错的。
//
// 列宽算式本身也量不准，两处系统性偏差：
// 1. CSS 写着 tab-size: 2，而 hit.column 按码点算，一个制表符只记 1 列；
// 2. 中日韩字符在等宽字体里占两倍字宽，中文值前面的列全被算少。
// ⇒ 改成量命中 <mark> 自己渲染出来的矩形：浏览器算好的东西不需要第二份近似实现。
//
// 组件侧只许调用本模块，不许再各写一份水平定位（与 tests/ux/detailScrollResetSingleSource
// 对滚动归零的口径同源：几何口径的第二份实现就是下一轮 bug 的出处）。

import { CURRENT_HIT_CLASS } from "./codeLines";

/** 查找条自己的几何：`position:absolute; top:8`（styles.css 的 .code-find）。 */
export const FIND_BAR_TOP = 8;
/** 量不到栏高时的兜底：Playwright 实测单行态高 34（窄容器 flex-wrap 会到 60，轮26 F-4 记过）。 */
export const FIND_BAR_FALLBACK_HEIGHT = 34;
/** 栏底与正文第一行之间留的空隙：贴边看着像被裁，也给滚动条圆角留位。 */
export const FIND_BAR_GAP = 8;

/**
 * 查找栏打开期间，滚动内容顶部该留多少净空。
 *
 * 缺陷长什么样（轮27 F-8）：查找条浮在正文之上，而 `scrollLineIntoView` 是
 * `clamp(y - clientHeight / 2, 0, …)` —— 目标行在文件开头时算出负数被夹到 0，
 * **已经没有任何滚动余量**把行让到条子下面。于是搜 `spring:` / `serverPort:` 这类
 * 就在第 1 行的顶层键，开栏后红字与命中行底色整条被查找条盖住（实测盖住第 1-2 行）。
 *
 * 只能靠留白解决：行 i 的 top = padTop + i * ROW_H 是行号层 / 命中行层 / 缩略图 /
 * 可见区间共用的同一条公式，所以净空必须由这**一个**数导出，三层跟着走。
 * 取 max(基础值, …)：万一某个容器里条子比正文本来留的上边距还矮，退化成原样，不许把正文顶下去。
 *
 * @param basePadTop 组件自己关栏时的上边距（浏览态 6 / 编辑态 12，与 CSS 变量同源）
 * @param measuredBarHeight 实测栏高；量不到（首帧 / 视图被保活隐藏 / jsdom）传 0，走兜底常量
 */
export function padTopForFindBar(basePadTop: number, findOpen: boolean, measuredBarHeight = 0): number {
  if (!findOpen) return basePadTop;
  const barHeight = measuredBarHeight > 0 ? measuredBarHeight : FIND_BAR_FALLBACK_HEIGHT;
  return Math.max(basePadTop, FIND_BAR_TOP + barHeight + FIND_BAR_GAP);
}

/** 实测查找条高度。量不到返回 0，交给 padTopForFindBar 兜底，调用方不必再判一次有限性。 */
export function measureFindBarHeight(el: HTMLElement | null): number {
  const height = el?.offsetHeight ?? 0;
  return Number.isFinite(height) && height > 0 ? height : 0;
}

/** 命中送进视口时左右各留的像素边距：贴着视口边缘会被滚动条与圆角吃掉半个字符。 */
export const HIT_REVEAL_MARGIN = 24;

/**
 * 当前命中的标记类名与 codeLines 同源（轮28 F-14：类改由视图在提交后往 <mark> 上切换，
 * 不再进高亮 HTML）。一个命中跨语法 token 时会被切成相邻的几个 <mark>，它们带同一个 data-hit。
 */
const CURRENT_MARK_SELECTOR = `.${CURRENT_HIT_CLASS}`;
/** 没有「当前命中」语义时退到整篇标红的第一处（外部内容搜索词路径：栏没开，不存在 current）。 */
const ANY_MARK_SELECTOR = ".search-hit";

/** 一次水平可见性计算所需的全部几何量（都由 DOM 量出，不由调用方换算）。 */
export interface MarkRevealGeometry {
  /** 命中左缘在滚动内容坐标系里的 x（px）：rect.left - 滚动容器 rect.left + scrollLeft。 */
  markLeft: number;
  /** 命中渲染宽度（px）。 */
  markWidth: number;
  /** 滚动容器可视宽（px）。 */
  clientWidth: number;
  /** 当前横向偏移（px）。 */
  scrollLeft: number;
  /** 滚动内容总宽（px）。 */
  scrollWidth: number;
  /** 左右各留的边距（px）。 */
  margin: number;
}

/** 夹在 [0, max] 内：max 为负（没有溢出）时就只剩 0 这一个合法值。 */
function clampOffset(value: number, max: number): number {
  const upper = Math.max(0, max);
  if (value < 0) return 0;
  return value > upper ? upper : value;
}

function clampScrollLeft(value: number, maxScrollLeft: number): number {
  return clampOffset(value, maxScrollLeft);
}

/**
 * 要让命中可见，scrollLeft 该设成多少；返回 null 表示「别动」。
 *
 * null 的三种情形各有代价要躲：
 * - 量不到（jsdom 无布局 / 首帧 / 祖先隐藏）：此时动水平偏移等于把用户已有的偏移清掉；
 * - 没有横向溢出（scrollWidth <= clientWidth）：整行本来就全看得见，动它是无意义抖动；
 * - 命中已完整落在视口内：用户正在看这一片，不该被重新拉走。
 *
 * 位移按「刚好露出 + 边距」算，不按居中：沿一条长行用 Enter/F3 逐个命中导航时，
 * 居中会让每次按键横向跳半屏，丢掉刚看过的上下文；最小位移保住上下文，且一定露出命中。
 */
export function neededScrollLeftForMark(geom: MarkRevealGeometry): number | null {
  const { markLeft, markWidth, clientWidth, scrollLeft, scrollWidth, margin } = geom;
  if (!Number.isFinite(markLeft) || !Number.isFinite(markWidth) || markWidth <= 0) return null;
  if (!Number.isFinite(clientWidth) || !Number.isFinite(scrollWidth) || clientWidth <= 0) return null;
  if (scrollWidth <= clientWidth) return null;
  if (!Number.isFinite(scrollLeft)) return null;
  const maxScrollLeft = scrollWidth - clientWidth;
  // 边距比视口还宽（超窄容器）时退化成「左缘贴边」，否则 viewLeft > viewRight 会判成永远不可见并来回抖。
  const inset = Math.min(margin, Math.floor(clientWidth / 2));
  const viewLeft = scrollLeft + inset;
  const viewRight = scrollLeft + clientWidth - inset;
  const markRight = markLeft + markWidth;

  // 命中本身就比「视口扣掉两边边距」还宽（超窄容器 / 整段标红的一长串）时，
  // 「完整露出」这个判据永远满足不了：下一次导航又会从右对齐跳回左对齐，来回抖。
  // ⇒ 退化成只要求左缘落在窗口里，位移口径固定为左对齐，第二次一定判为已到位。
  if (markWidth > clientWidth - 2 * inset) {
    if (markLeft >= viewLeft && markLeft <= viewRight) return null;
    return clampScrollLeft(markLeft - inset, maxScrollLeft);
  }

  if (markLeft >= viewLeft && markRight <= viewRight) return null;
  if (markLeft < viewLeft) return clampScrollLeft(markLeft - inset, maxScrollLeft);
  return clampScrollLeft(markRight - clientWidth + inset, maxScrollLeft);
}

/**
 * 命中在 DOM 里的矩形：优先当前命中（跨 token 时取几个 <mark> 的并集，宽度才是完整命中），
 * 没有当前命中就退到整篇标红的第一处。返回 null 表示这一屏没有可测的命中。
 */
function measureHitMark(measureRoot: HTMLElement): { left: number; right: number } | null {
  const current = measureRoot.querySelectorAll<HTMLElement>(CURRENT_MARK_SELECTOR);
  if (current.length) {
    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let measured = 0;
    for (const mark of current) {
      const rect = mark.getBoundingClientRect();
      if (!(rect.width > 0)) continue;
      measured += 1;
      left = Math.min(left, rect.left);
      right = Math.max(right, rect.right);
    }
    // 一条都没量到宽（jsdom / 隐藏）⇒ 交给调用方决定「别动」。
    return measured > 0 ? { left, right } : null;
  }
  // 这里用 querySelector 而不是 queryAll：外部搜索词路径只需要第一处，
  // 而单行长 JSON 的 1.14MB 正文里可能有上千个 mark，全量收集纯属浪费。
  const first = measureRoot.querySelector<HTMLElement>(ANY_MARK_SELECTOR);
  if (!first) return null;
  const rect = first.getBoundingClientRect();
  return rect.width > 0 ? { left: rect.left, right: rect.right } : null;
}

/**
 * 把当前命中送进横向视口。返回 true 表示真的动过 scrollLeft（调用方据此决定要不要补一次同步）。
 *
 * 为什么用 <mark> 的实际矩形而不是列号：浏览态的正文 blob 是整体渲染的
 * （虚拟化只作用于行号层 / 命中行层 / 缩略图），命中矩形量得到；编辑态的高亮层
 * 与 textarea 逐字同格（透明 textarea 叠在 pre 上），在 pre 里量的就是 textarea 那一列的位置。
 *
 * @param scroller 真正要写 scrollLeft 的滚动容器（浏览态 .code-area，编辑态 textarea）
 * @param measureRoot 命中 <mark> 所在的可测量元素（浏览态同上，编辑态是高亮层 pre）
 */
export function revealMarkHorizontally(
  scroller: HTMLElement | null,
  measureRoot: HTMLElement | null,
  margin: number = HIT_REVEAL_MARGIN
): boolean {
  if (!scroller || !measureRoot) return false;
  const hit = measureHitMark(measureRoot);
  if (!hit) return false;
  const { clientWidth, scrollWidth, scrollLeft, clientLeft } = scroller;
  if (scrollWidth <= clientWidth || clientWidth <= 0) return false;
  const scrollerRect = scroller.getBoundingClientRect();
  if (!Number.isFinite(scrollerRect.left)) return false;
  // clientLeft = 滚动容器左边框宽：内容坐标从 padding box 起算，不扣掉边框会整体偏一个边框宽。
  const markLeft = hit.left - scrollerRect.left + scrollLeft - clientLeft;
  const next = neededScrollLeftForMark({
    markLeft,
    markWidth: hit.right - hit.left,
    clientWidth,
    scrollLeft,
    scrollWidth,
    margin,
  });
  if (next === null) return false;
  // 差不到 1px 就当已经到位：写 scrollLeft 会触发 scroll 事件与一轮重排，白跳一次不如不动。
  if (Math.abs(next - scrollLeft) < 1) return false;
  scroller.scrollLeft = next;
  return true;
}

/* ── 纵向定位：变高行的那一种（并排差异视图） ───────────────────────── */

/**
 * 纵向可见性计算所需的全部几何量（都由 DOM 量出，不由调用方换算）。
 *
 * 与水平那一份的差别只在"目标块可能比视口还高"：`.diff-row` 的单元格是
 * `white-space: pre-wrap` + `word-break: break-all`，一行长 JSON 能在视口里占十几行，
 * 所以居中时必须连目标自身的高度一起算，否则"把顶边送到视口中线"= 内容还是看不见。
 */
export interface RowRevealGeometry {
  /** 目标块顶边在滚动内容坐标系里的 y（px）：rect.top - 容器 rect.top + scrollTop。 */
  targetTop: number;
  /** 目标块渲染高度（px）。 */
  targetHeight: number;
  /** 滚动容器可视高（px）。 */
  clientHeight: number;
  /** 当前垂直偏移（px）。 */
  scrollTop: number;
  /** 滚动内容总高（px）。 */
  scrollHeight: number;
}

/**
 * 要让这一块可见，scrollTop 该设成多少；返回 null 表示「别动」。
 *
 * 口径与浏览态 `scrollLineIntoView` 一致：**居中**而不是「刚好露出」。理由是跨视图一致性——
 * 用户在代码视图里 Enter 是居中，切到对比视图 Enter 变成"贴边抖一下"，同一个动作两种手感，
 * 会被当成其中一个坏了。行比视口高时 `targetTop - (clientHeight - height)/2` 自动变成
 * `targetTop + (height - clientHeight)/2`，即「让行的中段落在中线」，仍然看得进命中。
 *
 * null 的情形：没有纵向溢出（本来就全看得见，动它是无意义抖动）；量不到（非有限数）；
 * 以及已经在目标位置（差不到 1px，写一次就是一轮重排与一次 scroll 事件）。
 */
export function neededScrollTopToCenter(geom: RowRevealGeometry): number | null {
  const { targetTop, targetHeight, clientHeight, scrollTop, scrollHeight } = geom;
  if (!Number.isFinite(targetTop) || !Number.isFinite(targetHeight) || targetHeight <= 0) return null;
  if (!Number.isFinite(clientHeight) || clientHeight <= 0) return null;
  if (!Number.isFinite(scrollHeight) || !Number.isFinite(scrollTop)) return null;
  const maxScrollTop = scrollHeight - clientHeight;
  // 没有纵向溢出：唯一合法值是 0。已经在 0 就别动（返回 null），停在别处（尺寸刚变过）才归位。
  if (maxScrollTop <= 0) return scrollTop === 0 ? null : 0;
  const centered = targetTop - (clientHeight - targetHeight) / 2;
  const next = clampOffset(centered, maxScrollTop);
  if (Math.abs(next - scrollTop) < 1) return null;
  return next;
}

/** 纵向 span 并集：只统计真有高度的元素（jsdom / 隐藏祖先一律量不到）。 */
function measureVerticalSpan(el: Element): { top: number; bottom: number } | null {
  const rect = el.getBoundingClientRect();
  if (!(rect.height > 0) || !Number.isFinite(rect.top)) return null;
  return { top: rect.top, bottom: rect.bottom };
}

/** 一组 <mark> 的纵向并集（一个命中跨语法 token 时会被切成相邻几个，同带 data-hit）。 */
function measureVerticalSpanUnion(list: ArrayLike<Element>): { top: number; bottom: number } | null {
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  let measured = 0;
  for (const el of Array.from(list)) {
    const span = measureVerticalSpan(el);
    if (!span) continue;
    measured += 1;
    top = Math.min(top, span.top);
    bottom = Math.max(bottom, span.bottom);
  }
  return measured > 0 ? { top, bottom } : null;
}

/**
 * 纵向把「命中所在的那一行」送进视口中线。返回 true 表示真的动过 scrollTop。
 *
 * 量的优先级（与水平定位同一口径，浏览器算好的东西不再用公式近似）：
 * 1. 当前命中的 <mark> 并集 —— 行比视口高时只有命中自己的位置是用户真正要看的；
 * 2. 整行里有命中的第一处 <mark>（外部搜索词路径：栏没开，不存在 current）；
 * 3. 都没有就量行本身。
 *
 * 只用于**行高不固定**的视图（并排差异）。固定行高的代码视图继续走
 * `padTop + line * ROW_H` 那条公式：那里行号层 / 命中行层 / 缩略图共用同一个网格，
 * 改成量 DOM 反而把四条出口拆成两套真相。
 *
 * @param scroller 要写 scrollTop 的滚动容器（`.diff-body`）
 * @param row 命中所在的那一行元素（用 `data-row-index` 找）
 */
export function revealRowVertically(scroller: HTMLElement | null, row: Element | null): boolean {
  if (!scroller || !row) return false;
  const current = row.querySelectorAll(CURRENT_MARK_SELECTOR);
  const mark = row.querySelector(ANY_MARK_SELECTOR);
  const span = (current.length ? measureVerticalSpanUnion(current) : null) ?? (mark ? measureVerticalSpan(mark) : null) ?? measureVerticalSpan(row);
  if (!span) return false;
  const scrollerRect = scroller.getBoundingClientRect();
  if (!Number.isFinite(scrollerRect.top) || scroller.clientHeight <= 0) return false;
  // clientTop = 容器上边框宽：内容坐标从 padding box 起算，与水平那一份的 clientLeft 同理。
  const targetTop = span.top - scrollerRect.top + scroller.scrollTop - scroller.clientTop;
  const next = neededScrollTopToCenter({
    targetTop,
    targetHeight: span.bottom - span.top,
    clientHeight: scroller.clientHeight,
    scrollTop: scroller.scrollTop,
    scrollHeight: scroller.scrollHeight,
  });
  if (next === null) return false;
  scroller.scrollTop = next;
  return true;
}

