import { useEffect, type RefObject } from "react";
import {
  consumeWheel,
  hasScrollableAncestor,
  isVerticallyScrollable,
  pickWheelSurface,
  registerWheelSurface,
  wheelSurfacesWithin,
} from "./wheelScroll";

/**
 * 登记「这一页的滚轮兜底归我」：在页面根节点上挂一份原生 non-passive `wheel` 监听。
 *
 * 要解决的缺陷（轮33 实测，research/p3/p4/p5）：页面自己的 chrome 条——工具条、计数条、列头、
 * 格式化条、分页条、查找区周围的空隙——既不在任何滚动容器的子树里，自己子树里也没有滚动容器，
 * 浏览器往上找不到可滚祖先 ⇒ 滚轮落下去一格都不动。量级：配置浏览页 22.2% 视口、差异对比宽栏
 * 单文件态 28.3% / 批量态 29.6% / 匹配态 25.0%。
 *
 * 为什么是「兜底」而不是「改写」：只有当落点的祖先链里**一个可滚容器都没有**时才接管
 * （`hasScrollableAncestor` 硬闸门）。已经归原生管的（`.modal-body` / `.sel-menu` / `.message-list` /
 * 正文自身）一律不动，连「滚到底 + `overscroll-behavior: contain` 不外溢」的既有语义也原样保留。
 *
 * 为什么监听必须挂在元素上而不是 JSX 的 `onWheel`：React 18 把 wheel 挂在根容器且是 passive，
 * `preventDefault()` 直接失效（轮31/32 实测）。
 *
 * 让路规则：事件已被 `defaultPrevented` 时我们彻底不处理，保证既有 per-surface 接线优先
 * （本方案收口后那些接线会被删掉，删除前它们一直赢）。
 */

/** 黑名单按 DOM 子树判定，不靠闸门推导：实测同一 `.modal-overlay` 换几何就有转发/不转发两种结果，
 *  机理未收敛（research/p2d_point_grid.txt），所以弹框一律不接。 */
export const WHEEL_DENY_SELECTOR = ".modal-overlay, .sel-menu, .message-list";

export interface UseWheelColumnResolverOptions {
  /** 命中这些子树的滚轮一律不接（默认弹框 / 下拉 / 消息流）。 */
  denySelector?: string;
  /** 重挂依据：根节点会因为切态换成新节点时传一个影响其存在性的量，别每次渲染都换身份。 */
  reattachKey?: unknown;
  /**
   * 「本组件的浮层归本组件的正文」：只允许**组件级根**开启（CodeView / CodeEditor），页面根绝不传。
   *
   * 为什么需要它（轮33 F-34 真机复核挖出的两处静默回归）：旧的 per-surface 监听是**直接挂在浮层元素上**的，
   * 所以浮层永远滚自己组件的正文，既无视外层可滚容器，也无视「我在弹框里」。新的两条闸门把这份等价丢了：
   * - G1 宿主面板自己可滚：变更计划页 `.apply-detail{overflow-y:auto}` 包住 `.code-editor`，
   *   `hasScrollableAncestor` 放手 ⇒ 代码浮层滚的是外层面板而不是 textarea；
   * - G2 浮层在弹框里：「新建配置」弹框的 `.modal-overlay` 包住 `CodeEditor`，黑名单先 `return`
   *   ⇒ 浮层退回纯死区。
   *
   * 开启后语义变成：**为这块正文而存在的覆盖层，优先级高于外层任何可滚容器与单纯包裹本组件的弹框**。
   * 因此必须同时守住两条边界，否则就从「修死区」变成「抢滚动」：
   * 1. 落点在选中的滚动面**内部**时永远放手，正文本体交给原生（caret / 选区 / 惯性）；
   * 2. 黑名单只对「只是把本组件整个包起来的定位层」让位：既要 `denyHit.contains(root)`，
   *    还要求它自己**不可滚**。`.modal-overlay` 是 fixed 定位层（overflow 为 visible），包裹弹框里的
   *    编辑器时放行；`.sel-menu` / `.message-list` 本身就是滚动区，落点压在它身上就归它滚，正文不许抢。
   */
  localPriority?: boolean;
}

export function useWheelColumnResolver(
  rootRef: RefObject<HTMLElement | null>,
  { denySelector = WHEEL_DENY_SELECTOR, reattachKey, localPriority = false }: UseWheelColumnResolverOptions = {}
): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (event: WheelEvent) => {
      if (event.defaultPrevented) return;
      const landing = event.target;
      if (!(landing instanceof Element)) return;
      const denyHit = landing.closest(denySelector);
      // 命中黑名单：默认不接。开了 localPriority 的组件级根只有一个例外——那棵子树纯粹是把本组件包在外面
      // （宿主弹框），且它自己不是滚动区；真被塞进下拉/消息流里时照旧不接管。
      const denyIsHostWrapper = !!denyHit && localPriority && denyHit.contains(root) && !isVerticallyScrollable(denyHit);
      if (denyHit && !denyIsHostWrapper) return;
      const surface = pickWheelSurface(wheelSurfacesWithin(root), event.clientX, event.clientY);
      if (!surface) return;
      // 正文本体：永远留给原生（caret / 选区 / 惯性都依赖原生滚动语义）。
      if (surface.el.contains(landing)) return;
      // 硬闸门只对页面根生效：组件级根 owns 自己的浮层（见选项注释 G1）。
      if (hasScrollableAncestor(landing) && !localPriority) return;
      consumeWheel(event, surface.el, surface);
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [rootRef, denySelector, reattachKey, localPriority]);
}

export interface UseWheelSurfaceOptions {
  /** 见 `wheelScroll.ts` 的 `WheelSurfaceOptions.syncScroll`：容器外部有跟手层就必须交出来。 */
  syncScroll?: () => void;
  rowHeight?: number;
}

/**
 * 子组件登记自己的滚动容器给页面级兜底当靶子。
 *
 * 登记发生在**拥有这份同步逻辑的组件**里，而不是页面里：页面因此既不用把 ref 一层层往下穿，
 * 也不用按 class 猜哪块是正文（`.diff-stats` 在批量态被复用进左列列表项，按类名选必错）。
 */
export function useWheelSurface(containerRef: RefObject<HTMLElement | null>, { syncScroll, rowHeight }: UseWheelSurfaceOptions = {}): void {
  // 登记的是 ref 本身：节点多半是条件渲染的（批量态左列、匹配态两列表、切文件换正文），
  // 登记那一刻它可能还不存在 ⇒ 事件时才现取，不必任何「重挂依据」，也不存在静默失活。
  useEffect(() => registerWheelSurface(containerRef, { syncScroll, rowHeight }), [containerRef, syncScroll, rowHeight]);
}
