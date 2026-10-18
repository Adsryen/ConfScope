/**
 * 滚轮 → 滚动容器的公共原语（轮33 F-34）。
 *
 * 这里只有**纯函数与一张注册表**，不含 React：
 * - `wheelPixelDelta` / `consumeWheel`：把 `deltaMode` 三档换算成像素并写偏移（全站唯一一份实现）；
 * - `isVerticallyScrollable` / `hasScrollableAncestor`：判定「这块地方到底归不归原生管」；
 * - `pickWheelSurface`：指针落点在**几何**上属于哪一列的正文；
 * - `registerWheelSurface`：跨组件的滚动面登记表（子组件登记自己的容器与它的当帧同步，
 *   页面根节点只登记「我这一页要兜底」，两边不需要 prop 互相穿透，也不需要按 class 猜目标）。
 */

/** `deltaMode === 1`（按行）时没有登记行高的容器用的换算基数：全站代码类行网格 ROW_H 都是 20。 */
export const DEFAULT_WHEEL_ROW_H = 20;

/** 可滚判定的一像素余量：四舍五入造成的 1px 溢出当作「滚不动」，避免兜底去抢一个原生已经能滚的容器。 */
const SCROLL_ROOM_EPS = 1;

export interface WheelSurfaceOptions {
  /**
   * 写完偏移之后**当帧**要补的那一次同步（轮30 F-20）。
   * 行号层/命中行底色层在滚动容器之外，靠 `transform: translateY(-scrollTop)` 跟手，
   * `scroll` 事件是异步派发的，谁写 scrollTop 谁就得把这次同步叫上。容器没有外部同步层就不传。
   */
  syncScroll?: () => void;
  /** 行网格的行高（px）：`deltaMode === 1` 的换算基数。不传按 `DEFAULT_WHEEL_ROW_H`。 */
  rowHeight?: number;
}

export interface WheelSurfaceEntry extends WheelSurfaceOptions {
  el: HTMLElement;
}

/**
 * 可以登记的目标：节点本身，或一个指向节点的引用（React 的 `RefObject`）。
 *
 * 为什么两种都要：批量态的左列、匹配态的左右列表都是**条件渲染**——组件挂载那一次 effect 跑的时候
 * 节点还不存在，把当时的 `ref.current`（null）抄进登记表就等于这条兜底静默失活（轮33 F-34 实测）。
 * 登记引用、事件时现取，节点后来挂出来就自动生效，也不需要任何「重挂依据」。
 */
export type WheelSurfaceTarget = HTMLElement | { current: HTMLElement | null };

/** 登记表里的一条原始登记（可能是还没挂出来的引用）。 */
interface WheelSurfaceRegistration extends WheelSurfaceOptions {
  target: WheelSurfaceTarget;
}

function resolveWheelSurfaceTarget(target: WheelSurfaceTarget): HTMLElement | null {
  if (target instanceof HTMLElement) return target;
  return target?.current ?? null;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * `deltaMode` 三种档位都要换算：0 像素（Chromium/WebView2）、1 行（Linux 上 WebKitGTK 常见）、2 页。
 * 只认 `deltaY` 当像素，行/页模式在 Linux 上每格就只滚一两个像素量级。
 */
export function wheelPixelDelta(event: WheelEvent, el: HTMLElement, rowHeight: number = DEFAULT_WHEEL_ROW_H): number {
  const unit = event.deltaMode === 1 ? rowHeight : event.deltaMode === 2 ? (el.clientHeight > 0 ? el.clientHeight : rowHeight) : 1;
  return event.deltaY * unit;
}

/**
 * 消费一格滚轮：换算 → 取消默认动作 → 写 scrollTop（夹界）→ 当帧补同步。
 *
 * 返回 `false` 表示「这格不该我们管」（捏合缩放、纯横向、非法 delta），调用方必须原样放手给原生。
 * 之所以必须 `preventDefault`：不取消的话外层面板会跟着一起滚，双滚比不滚更糟（轮31 F-25 实测）。
 */
export function consumeWheel(event: WheelEvent, el: HTMLElement, opts: WheelSurfaceOptions = {}): boolean {
  if (event.ctrlKey || event.deltaY === 0) return false;
  const delta = wheelPixelDelta(event, el, opts.rowHeight);
  if (!Number.isFinite(delta) || delta === 0) return false;
  event.preventDefault();
  el.scrollTop = clamp(el.scrollTop + delta, 0, Math.max(0, el.scrollHeight - el.clientHeight));
  opts.syncScroll?.();
  return true;
}

/** 自身纵向可滚：溢出有得滚，且 `overflow-y` 是 auto/scroll（hidden/visible/clip 都不算，原生不会滚它）。 */
export function isVerticallyScrollable(node: Node | null | undefined): node is HTMLElement {
  if (!(node instanceof HTMLElement)) return false;
  if (node.scrollHeight - node.clientHeight <= SCROLL_ROOM_EPS) return false;
  const overflowY = window.getComputedStyle(node).overflowY;
  return overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
}

/**
 * 落点的祖先链（含自身，一路到 `<body>`）里有没有可滚容器 —— 兜底机制的**硬闸门**。
 *
 * 有 → 原生自己会滚，我们一律不接管（`.modal-body` / `.sel-menu` / `.message-list` / 正文本体
 * 这些现有滚动语义因此**可证明地**不受影响）；没有 → 浏览器往上找不到可滚祖先，这一格落在谁身上
 * 都是「一动不动」，正是轮33 实测出来的结构性死区（配置浏览 22.2%、差异对比宽栏 28.3%–29.6% 视口）。
 */
export function hasScrollableAncestor(node: Node | null): boolean {
  let cur: Node | null = node;
  while (cur) {
    if (isVerticallyScrollable(cur)) return true;
    cur = cur.parentNode;
  }
  return false;
}

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function visibleArea(rect: Rect, vw: number, vh: number): number {
  const w = Math.min(rect.right, vw) - Math.max(rect.left, 0);
  const h = Math.min(rect.bottom, vh) - Math.max(rect.top, 0);
  return w > 0 && h > 0 ? w * h : 0;
}

function domDepth(node: HTMLElement): number {
  let d = 0;
  let cur: HTMLElement | null = node.parentElement;
  while (cur) {
    d += 1;
    cur = cur.parentElement;
  }
  return d;
}

/**
 * 从候选滚动面里挑一块（只看几何，不看 class —— `.diff-stats` 这个类在批量态被复用进左列列表项，
 * 按类名选目标必错，见 research/p3_batch_match_chrome.txt）。
 *
 * 1. 只在「真的有得滚」且**可见面积不为 0** 的候选里选（整块在视口外的正文滚了也看不见，
 *    窄栏 + 视口高 ≤420 时 `.diff-main-column{min-height:640px}` 就是这种形状，见 PRD 观察项 1）；
 * 2. 优先**指针 x 落在其矩形区间内**的那一列；一块都不命中（落在两列的 gap、或 chrome 压住的列本身不滚）
 *    退「可见面积最大者」；
 * 3. 候选多块时先用指针 y 收窄（窄栏堆叠布局里左右两列上下排、x 区间重叠，只有 y 能分开），
 *    **y 一个都不命中不能拿来淘汰候选**——chrome 条本来就贴在正文上方、y 不在正文矩形里，
 *    这正是本轮要修的死区形状；
 * 4. 同列命中取最深（嵌套滚动不许把滚轮投给外层面板），再取可见面积最小者（更贴合这一块列）；
 *    兜底分支反过来取面积最大者，两支排序方向相反，各自的用例都钉着；
 * 5. 都没有 → `null`，调用方不许 preventDefault，保持原生。
 */
export function pickWheelSurface<T extends WheelSurfaceEntry>(
  entries: T[],
  x: number,
  y: number,
  viewport?: { width: number; height: number }
): T | null {
  const pool = entries.filter((entry) => isVerticallyScrollable(entry.el));
  if (pool.length === 0) return null;
  const vw = viewport?.width ?? window.innerWidth;
  const vh = viewport?.height ?? window.innerHeight;
  const measured = pool.map((entry, index) => {
    const rect = entry.el.getBoundingClientRect();
    return {
      entry,
      index,
      rect,
      depth: domDepth(entry.el),
      area: visibleArea({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, vw, vh),
    };
  });
  const onScreen = measured.filter((m) => m.area > 0);
  if (onScreen.length === 0) return null;
  const inColumn = onScreen.filter((m) => m.rect.left <= x && x <= m.rect.right);
  const byColumn = inColumn.length > 0;
  const columnPool = byColumn ? inColumn : onScreen;
  const onRow = columnPool.filter((m) => m.rect.top <= y && y <= m.rect.bottom);
  const picked = onRow.length > 0 ? onRow : columnPool;
  picked.sort((a, b) => {
    if (byColumn) {
      if (b.depth !== a.depth) return b.depth - a.depth;
      if (a.area !== b.area) return a.area - b.area;
    } else {
      if (b.area !== a.area) return b.area - a.area;
      if (b.depth !== a.depth) return b.depth - a.depth;
    }
    return a.index - b.index;
  });
  return picked[0].entry;
}

// —— 滚动面登记表 ——————————————————————————————————————————————

const surfaces = new Set<WheelSurfaceRegistration>();

/**
 * 登记一块「滚轮兜底可以投给它」的滚动面。返回注销函数。
 *
 * 由拥有该容器与它那份当帧同步的组件自己登记（CodeView / CodeEditor / DiffPanel / 列表列…），
 * 页面根只需要登记「这一页要兜底」，两边不必互相拿 ref。同一节点重复登记按最后一次生效。
 */
export function registerWheelSurface(target: WheelSurfaceTarget, opts: WheelSurfaceOptions = {}): () => void {
  const el = resolveWheelSurfaceTarget(target);
  if (el) {
    for (const existing of surfaces) {
      if (resolveWheelSurfaceTarget(existing.target) === el) surfaces.delete(existing);
    }
  }
  const entry: WheelSurfaceRegistration = { target, syncScroll: opts.syncScroll, rowHeight: opts.rowHeight };
  surfaces.add(entry);
  return () => {
    surfaces.delete(entry);
  };
}

/**
 * 某个根节点子树内的在册滚动面（**事件时现取**：条件渲染的容器在登记那一刻还可能没挂出来，
 * 挂出来之后也不必有人再登记一次）。同一节点被登记多次时以最后一次为准（Set 的插入顺序 = 登记顺序）。
 */
export function wheelSurfacesWithin(root: Element): WheelSurfaceEntry[] {
  const byNode = new Map<HTMLElement, WheelSurfaceEntry>();
  for (const reg of surfaces) {
    const el = resolveWheelSurfaceTarget(reg.target);
    if (!el || !root.contains(el)) continue;
    byNode.set(el, { el, syncScroll: reg.syncScroll, rowHeight: reg.rowHeight });
  }
  return [...byNode.values()];
}

/** 测试用：清空登记表（组件卸载本该清干净，这里兜住用例之间的残留）。 */
export function __clearWheelSurfacesForTest(): void {
  surfaces.clear();
}
