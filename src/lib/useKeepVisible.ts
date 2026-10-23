import { useLayoutEffect, useRef, type RefObject } from "react";
import { scrollBehavior } from "./motion";

/**
 * 提示出现时把它自己滚进可视区（轮67 / R67-WP1）。
 *
 * 缺陷长什么样：设置页的面板是「左索引 + 右侧一个 698px 高的滚动容器（内容 2762px）」，
 * 状态/错误块固定挂在面板最顶部。用户在底部点「上传当前数据」，请求失败，
 * 提示确实出现了——但落在容器上方 221px 处（实测 `top=-221`），
 * 那一屏什么都不动，用户只能认为「按钮没反应」，于是再点一次。
 * 同一条提示在面板顶部那一档看得见，纯靠运气。
 *
 * 为什么修「落点」而不是给每个动作各摆一份提示位：那 8 个动作各自的状态会变成 8 份
 * 需要同步的显示通道，`test-msg` 家族也要分裂；一处接线让所有动作同时受益，
 * 也保证「一次只有一条提示被看见」这个既有口径不变。
 *
 * 口径：
 * - `block: "nearest"` —— 已经可见时不产生任何位移，所以重复调用是安全的，
 *   不需要额外判「用户是不是刚自己滚过去」。
 * - 动效走 `scrollBehavior()`，与项目里其它 JS 发起的滚动同一把尺（减少动效偏好下为 auto）。
 * - jsdom 没有 `scrollIntoView`：先判可用性再调用（与 OperationHistoryView 定位命中行同一口径），
 *   否则测试里直接抛错，把「滚进可视区」这件事从断言里挤掉。
 * - 用 `useLayoutEffect` 在绘制前滚，避免先看见一帧空白再跳。
 *
 * @param active  提示当前是否展示。
 * @param content 提示文本。文本变化也算一次「出现」：失败提示被新的失败提示替换时，
 *                位置可能已经随重排跑到框外。
 */
export function useKeepVisible<T extends HTMLElement>(active: boolean, content = ""): RefObject<T> {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el || typeof el.scrollIntoView !== "function") return;
    el.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
  }, [active, content]);
  return ref;
}
