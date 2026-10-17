import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * 视图状态保活（R27 第 1 档）：非浏览页切走即卸载，筛选 / 排序 / 选中 / 列表滚动全丢，
 * 回来「白屏一下回到顶部」。这里提供全站唯一一份状态存取实现，
 * 值存在模块内存里（卸载组件不清空），由各页在初始化时读回。
 *
 * 为什么不放到 App 的 props 上：App 每次筛选改动都要重渲染，
 * 而被保活的配置浏览页（`App.tsx` 的 `.browse-cache`）没有被 memo，
 * 在审计页敲一个字符会把整棵隐藏的浏览树重渲染一遍。
 * 也不写 localStorage：审计的环境筛选跨启动往往是脏的（连接已改/已删），
 * 用户要的是「切 Tab 不丢」，不是「重启还记得」。
 *
 * 纪律：任何页面都不许再各写一套 sessionStorage / localStorage 来记状态
 * （tests/ux/viewStateSingleStore.test.ts 守这条）。
 */
const values = new Map<string, unknown>();

/** 读回记住的值；没记过返回 undefined。 */
export function readViewState<T>(key: string): T | undefined {
  return values.get(key) as T | undefined;
}

/** 写入要记住的值（同 key 覆盖）。 */
export function writeViewState(key: string, value: unknown): void {
  values.set(key, value);
}

/** 清空全部或某个前缀（测试隔离用；页面无需主动清）。 */
export function clearViewState(prefix?: string): void {
  if (!prefix) {
    values.clear();
    return;
  }
  for (const key of Array.from(values.keys())) {
    if (key.startsWith(prefix)) values.delete(key);
  }
}

/** 当前记住了哪些 key（守卫用例断言「只有一份实现」时用）。 */
export function viewStateKeys(): string[] {
  return Array.from(values.keys());
}

/**
 * 与 useState 同签名，但初始值优先来自记忆层。
 * key 必须在组件生命周期内保持稳定（各页按「页面名.参数名」写死）。
 */
export function useRememberedState<T>(key: string, initial: T | (() => T)) {
  const [value, setValue] = useState<T>(() => {
    const remembered = values.get(key);
    if (remembered !== undefined) return remembered as T;
    return typeof initial === "function" ? (initial as () => T)() : initial;
  });

  useEffect(() => {
    writeViewState(key, value);
  }, [key, value]);

  return [value, setValue] as const;
}

/**
 * 列表滚动位置记忆：滚动时写回，重新挂载（或列表内容变多）后恢复。
 *
 * `listVersion` 传列表条数：挂载时容器往往还是空的，此时赋值会被真实布局夹回 0，
 * 所以每条新的列表版本都允许再恢复一次；已经在原位（scrollTop > 0）则不动用户。
 * jsdom 没有布局引擎，scrollTop 可直接赋值读回，用例据此断言，不假装有滚动。
 */
export function useScrollMemory(key: string, listVersion: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const appliedVersion = useRef<number>(Number.NaN);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (appliedVersion.current === listVersion) return;
    appliedVersion.current = listVersion;
    if (el.scrollTop > 0) return;
    const remembered = readViewState<number>(key);
    if (typeof remembered === "number" && remembered > 0) el.scrollTop = remembered;
  }, [key, listVersion]);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (el) writeViewState(key, el.scrollTop);
  }, [key]);

  return { ref, onScroll };
}
