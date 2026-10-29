import { useCallback, useLayoutEffect, useRef } from "react";

/** 只关心「这一屏换没换」的引用框：`{ current: HTMLElement | null }` 避开各版本 React 的类型差异。 */
type RefBox = { current: HTMLElement | null };

/** 逐元素 `===` 比较：站点每次渲染都传新数组，只有真的换了内容才算换。 */
function sameKeys(prev: readonly unknown[], next: readonly unknown[]): boolean {
  if (prev.length !== next.length) return false;
  return prev.every((value, index) => value === next[index]);
}

/**
 * 换内容就把滚动拉回起点（轮13 波29 / R49）。
 *
 * 缺陷长什么样：详情面板、日志原文、错误详情这类 `overflow: auto` 的只读块复用同一个 DOM 节点，
 * 切换选中项时 React 只换文本、不重建元素，`scrollTop` 于是留着上一份内容的偏移——
 * 用户看到「新详情莫名停在中间」，还会以为新内容就只有这几行。
 *
 * 口径来自 CodeView 的 R9：用 `useLayoutEffect` 在**绘制前**归零（否则会闪一帧跳变），
 * 且「正文逐字相同但选中项变了」也要归零。这里把实现收成一份，站点只传 key。
 *
 * key 传什么由站点决定，判定标准只有一条：**这一屏换成了别的对象吗**。
 * 详情面板、日志原文是「选中项 + 正文」；diff 面板这类可以就地改正文的视图（合并箭头、
 * 手写微调）只传文件身份（两侧标签），传正文就等于「用户每改一次，滚动位置就丢一次」
 * ——轮134 在 DiffPanel 上拍到的正是这个。
 *
 * 为什么用「无依赖数组 + 渲染期 key 比较」而不是 `useLayoutEffect(…, keys)`：
 * 站点传的是字面量数组（每次渲染都是新对象），直接当依赖会每帧归零，把用户手动滚的位置清掉；
 * React 也不允许动态依赖数组。所以每次渲染都跑一次，只在 key 真的变了才动手——
 * 比较是 O(几个元素) 的 `===`，比多渲染一次便宜。
 */
export function useScrollResetOnContentChange(ref: RefBox, keys: readonly unknown[], onReset?: () => void): void {
  const seen = useRef<readonly unknown[]>(keys);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    const changed = !mounted.current || !sameKeys(seen.current, keys);
    seen.current = keys;
    mounted.current = true;
    if (!changed) return;
    const el = ref.current;
    if (el) {
      el.scrollTop = 0;
      el.scrollLeft = 0;
    }
    // CodeView 的行号/缩略图靠 transform 跟手，归零后必须再同步一次，否则侧栏停在旧偏移。
    onReset?.();
  });
}

/**
 * 列表版：同一屏里有 N 个只读块（审计矩阵每环境一格、日志每条事件一段）时用它。
 * 这类节点在 `map` 里，逐个挂 `useLayoutEffect` 违反 hook 规则，所以改成登记节点、换内容时一起归零。
 * 返回的 ref 回调保持稳定（`useCallback([])`），React 不会每次渲染都摘挂。
 */
export function useScrollResetRef(keys: readonly unknown[]): (el: HTMLElement | null) => void {
  const nodes = useRef<Set<HTMLElement>>(new Set());
  const seen = useRef<readonly unknown[]>(keys);
  const mounted = useRef(false);
  const attach = useCallback((el: HTMLElement | null) => {
    if (el) nodes.current.add(el);
  }, []);
  useLayoutEffect(() => {
    // 先摘掉已离开文档的节点：React 18 的 ref 回调卸载时只给 null、不给节点，
    // 只能靠 isConnected 收尾，否则这个 Set 只增不减。
    nodes.current.forEach((el) => {
      if (!el.isConnected) nodes.current.delete(el);
    });
    const changed = !mounted.current || !sameKeys(seen.current, keys);
    seen.current = keys;
    mounted.current = true;
    if (!changed) return;
    nodes.current.forEach((el) => {
      el.scrollTop = 0;
      el.scrollLeft = 0;
    });
  });
  return attach;
}
