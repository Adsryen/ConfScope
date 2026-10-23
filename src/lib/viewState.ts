import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";

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

/**
 * 恢复位置被布局夹住时逐帧补写的上限（≈0.5s），见 useScrollMemory。
 * 只给「异步内容补完」这点余量，不去追一个永远在变高的内容。
 */
const RESTORE_RETRY_FRAMES = 30;

/**
 * 一次「还没落到位」的恢复计划。放在 ref 里而不是 effect 闭包里，
 * 是因为开发模式 React 18 StrictMode 会把 effect 跑两遍（setup → cleanup → setup）：
 * 第一遍刚被布局夹住、补写循环刚被 cleanup 取消，第二遍必须能把它接上。
 * 真机量过——旧实现用「这个列表版本已应用过」挡住第二遍，设置页 PARK=2000 永久停在 1688。
 */
interface RestorePlan {
  /** 要回到的位置（记账那一刻的真实值，不随补写过程改变）。 */
  target: number;
  /** 上一次我们写进去的值：容器现状等于它，说明没人动过，可以继续补。 */
  lastWritten: number;
  /** 已补写的帧数，跨 effect 重跑累计，上限 RESTORE_RETRY_FRAMES。 */
  frames: number;
}

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
 *
 * `externalRef` 给调用方已经持有的容器（设置页那种整页面板：同一个 ref 还要喂给
 * scroll-spy，两处不能各自攥一份，否则恢复和位置判定各写各的）。传了就用它，
 * 返回值里的 `ref` 是同一个对象，接线的写法在有无 externalRef 两种形态下保持一致。
 *
 * 补写为什么必须跨 effect 重跑活着：见 RestorePlan。开发模式 StrictMode 双跑 effect、
 * 生产模式异步内容在恢复之后才长齐，两种都会出现「写进去被夹住、下一帧才够长」。
 */
export function useScrollMemory(key: string, listVersion: number, externalRef?: MutableRefObject<HTMLDivElement | null>) {
  const ownRef = useRef<HTMLDivElement | null>(null);
  const ref = externalRef ?? ownRef;
  const planRef = useRef<RestorePlan | null>(null);

  useLayoutEffect(() => {
    let cancelled = false;
    let rafId = 0;

    const schedule = (run: () => void) => {
      if (typeof requestAnimationFrame === "function") {
        rafId = requestAnimationFrame(run);
        return;
      }
      rafId = setTimeout(run, 16) as unknown as number;
    };

    const stop = () => {
      cancelled = true;
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafId);
      else clearTimeout(rafId as unknown as ReturnType<typeof setTimeout>);
    };

    /*
     * 一帧补写：到位 / 用户自己动了 / 帧数预算用完，就收手。
     * 每次重新取 ref.current——异步重渲染可能换掉这个 DOM 节点，
     * 闭包攥着旧节点会一直读到一个脱离文档的元素（它的 scrollTop 永远等于我们写进去的夹住值）。
     */
    const step = () => {
      if (cancelled) return;
      const el = ref.current;
      const plan = planRef.current;
      if (!el || !plan) return;
      if (el.scrollTop !== plan.lastWritten) {
        planRef.current = null;
        return;
      }
      el.scrollTop = plan.target;
      if (el.scrollTop >= plan.target) {
        planRef.current = null;
        return;
      }
      plan.lastWritten = el.scrollTop;
      plan.frames += 1;
      if (plan.frames >= RESTORE_RETRY_FRAMES) {
        planRef.current = null;
        return;
      }
      schedule(step);
    };

    const el = ref.current;
    if (!el) return;

    // 上一轮还没落到位、且没人动过容器（现状就是我们写进去的值）→ 接着补，跨 StrictMode 双跑
    const pending = planRef.current;
    if (pending) {
      if (el.scrollTop !== pending.lastWritten || pending.frames >= RESTORE_RETRY_FRAMES) {
        planRef.current = null;
      } else {
        step();
        return stop;
      }
    }

    // 已经在读这一屏（人自己滚的，或上一轮刚放好的位置），不许再把他拽回记住的位置
    if (el.scrollTop > 0) return;

    const remembered = readViewState<number>(key);
    if (typeof remembered !== "number" || remembered <= 0) return;
    el.scrollTop = remembered;
    if (el.scrollTop >= remembered) return;

    /*
     * 没落到位 = 挂载这一帧内容还没长齐，布局把赋值夹住了（轮67 真机量 PARK=2000：
     * 首帧内容 2386px 只能滚到 1688，数据补进来后是 2898，用户被少放 312px 且再也没补上）。
     * 上限 30 帧（≈0.5s）：只给「异步内容补完」这点余量，不去追一个永远在变高的内容
     * ——那样会把用户自己的滚动当成夹住。
     */
    planRef.current = { target: remembered, lastWritten: el.scrollTop, frames: 0 };
    schedule(step);

    return stop;
  }, [key, listVersion, ref]);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (el) writeViewState(key, el.scrollTop);
  }, [key, ref]);

  return { ref, onScroll };
}
