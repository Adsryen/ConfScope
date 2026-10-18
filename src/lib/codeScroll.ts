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

/** 命中送进视口时左右各留的像素边距：贴着视口边缘会被滚动条与圆角吃掉半个字符。 */
export const HIT_REVEAL_MARGIN = 24;

/** 当前命中的标记类名（markHighlightedHtml 产出）。一个命中跨语法 token 时会被切成相邻的几个 <mark>。 */
const CURRENT_MARK_SELECTOR = ".search-hit-current";
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

function clampScrollLeft(value: number, maxScrollLeft: number): number {
  const upper = Math.max(0, maxScrollLeft);
  if (value < 0) return 0;
  return value > upper ? upper : value;
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
