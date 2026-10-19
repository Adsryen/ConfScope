import { useEffect, useState } from "react";

/**
 * 保活挂载（第 2 档）：一张页第一次被看见时挂载，之后**永不卸载**，切走只是 `hidden`。
 *
 * 为什么全站需要唯一一份实现：
 * - `lib/viewState.ts` 是第 1 档（非保活页切走不丢筛选/滚动），它记的是**字段**；
 *   保活页要留住的是整棵子树（滚动位置、正在编辑的草稿、刚跑完的对比结果）。
 * - 这两件事在 App 里各写一遍 `useState` 的话，抄错一次就是一个静默 bug：
 *   写成「常驻挂载」= 给启动路径白加一轮取数（配置对比页探针实测切回一次要打 8 次请求）；
 *   写成「切走即卸载」= 用户刚看完的结果没了，只能重新跑一遍。
 *   返回值只回答一个问题——「这张页该不该还在 DOM 里」，闸门与语义都收在这一处。
 *
 * 可见性判定仍归调用方（`mode === "browse"` 这类），本 hook 不认路由也不认 mode，
 * 这样隐藏期能不能取数、要不要攒事件，还是由页面自己按语义决定（见 DiffView / ConfigBrowser
 * 的 `active` 闸门与 `pendingStaleRef`）。
 */
export function useMountOnceVisible(visible: boolean): boolean {
  const [everVisible, setEverVisible] = useState(visible);

  useEffect(() => {
    if (visible && !everVisible) setEverVisible(true);
  }, [visible, everVisible]);

  // `visible ||` 不是冗余：首次进入这一页的那一帧里，effect 还没跑、everVisible 还是 false，
  // 只返回 state 就会先渲染一个空壳再补一次渲染——用户看到的一次闪屏，正是这轮要消灭的东西。
  return visible || everVisible;
}
