import { useEffect, type RefObject } from "react";

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

export interface WheelScrollsContainerOptions {
  /** 真正被滚的容器：浏览态 `.code-area` / 编辑态 `textarea`。 */
  containerRef: RefObject<HTMLElement | null>;
  /**
   * 写完偏移之后**当帧**要补的那一次同步（轮30 F-20）。
   *
   * 行号层与命中行底色层在滚动容器之外，靠 `transform: translateY(-scrollTop)` 跟手；
   * scroll 事件是异步派发的，所以每次写偏移都由调用方把它自己的 syncScroll 交出来。
   */
  syncScroll: () => void;
  /** 行网格的行高（px）：`deltaMode === 1`（按行）时的换算基数，由调用方递自己的 ROW_H。 */
  rowHeight: number;
  /**
   * 重挂依据：目标表面会因为外部条件消失又回来（缩略图「不满一屏就整条收起」、
   * 查找条关而又开），回来时是**新节点**，不重挂监听就等于这条出口静默失活。
   * 写影响该节点存在性的量（`canScrollContent` / `findOpen`），别每次渲染都换身份。
   */
  reattachKey?: unknown;
}

/**
 * 滚轮落在某块浮层表面（`.code-minimap` / `.code-find`）上 ⇒ 滚正文（轮31 F-25 / 轮32 F-33）。
 *
 * 缺陷长什么样：这些浮层是滚动容器（浏览态 `.code-area` / 编辑态 `textarea`）的**兄弟节点**，
 * 两者都 `inset:0` 铺在 `overflow:hidden` 的 `.code-body` / `.code-editor` 里。滚轮事件打在浮层上时，
 * 浏览器往上找的「最近可滚祖先」是外层面板而不是正文：指针明明在代码区里，正文一动不动，
 * 用户只会觉得「滚到右边那条就卡住」「滚到上面那条就卡住」（实测取证 research/wheelbar_probe.txt：
 * 条子 532×38，正文起始偏移 120，滚一格在宽栏与窄栏下三个落点全部停在 120，外层也始终 0 —— 纯死区）。
 * VSCode 的 minimap 与 find widget 上滚轮滚的正是正文。
 *
 * 为什么必须是元素上的原生监听，而不是 JSX 里的 `onWheel`：React 18 把 wheel 挂在根容器上且是
 * **passive** 监听，`e.preventDefault()` 直接失效（探针实测：`onWheel` 里调了 preventDefault，
 * 事件到手仍是 `defaultPrevented === false`，证据留在任务目录 research/wheel_probe.txt）。
 * 不取消默认动作又会让外层面板跟着一起滚——双滚比不滚更糟。
 *
 * `deltaMode` 三种档位都要换算：0 像素（Chromium/WebView2）、1 行（Linux 上 WebKitGTK 常见）、
 * 2 页。只认 `deltaY` 当像素，行/页模式在 Linux 上每格就只滚一两个像素量级。
 */
export function useWheelScrollsContainer(
  targetRef: RefObject<HTMLElement | null>,
  { containerRef, syncScroll, rowHeight, reattachKey }: WheelScrollsContainerOptions
): void {
  useEffect(() => {
    const surface = targetRef.current;
    if (!surface) return;
    const onWheel = (event: WheelEvent) => {
      // 滚动容器在 handler 里现取，不在 effect 头cache：换文件时视图可能重建节点，
      // 抓住旧节点就等于对着一份已经不存在的正文算偏移
      const el = containerRef.current;
      if (!el) return;
      // 只接管纵向：横向（shift+滚 / 触控板横划）与捏合缩放（ctrl+wheel）都留给原生
      if (event.deltaY === 0 || event.ctrlKey) return;
      const unit = event.deltaMode === 1 ? rowHeight : event.deltaMode === 2 ? (el.clientHeight > 0 ? el.clientHeight : rowHeight) : 1;
      const delta = event.deltaY * unit;
      if (!Number.isFinite(delta) || delta === 0) return;
      event.preventDefault();
      el.scrollTop = clamp(el.scrollTop + delta, 0, Math.max(0, el.scrollHeight - el.clientHeight));
      syncScroll();
    };
    surface.addEventListener("wheel", onWheel, { passive: false });
    return () => surface.removeEventListener("wheel", onWheel);
    // reattachKey 在依赖里：见上面那条说明——浮层消失又回来时是新节点，必须重挂。
  }, [targetRef, containerRef, syncScroll, rowHeight, reattachKey]);
}
