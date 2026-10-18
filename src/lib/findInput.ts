import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 查找词输入的延迟策略（轮29 F-16）。
 *
 * 缺陷长什么样：查找输入框里每敲一个字母都要重算命中、重标记整篇正文，再把整段 HTML 交回浏览器解析。
 * `baseHtml` 已被 memo 挡住（轮28 F-14），剩下的这两层仍然按字数付钱。Playwright chromium 实测
 * （输入 `spring` 逐字敲 6 个键，日志 `research/bench_f16_keystroke_cost.log`）：
 *
 * | 正文 | 每键合计 | 输入这个词合计 |
 * |---|---|---|
 * | 2 000 行 / 98KB | 26ms | 155ms |
 * | 5 000 行 / 247KB | 67ms | 402ms |
 * | 20 000 行 / 1MB | 177ms | 1 065ms |
 * | 200 000 行 / 10MB | ≈1 800ms | **10 798ms** |
 *
 * 每键 50ms 是一条输入帧预算线，落在约 3 000 行：之下逐字实时，之上把一串按键并成「停顿一次」。
 *
 * 为什么不用 `useDeferredValue`：它只把优先级让给输入，**总工作量一点没少**（7 个字符仍排 7 次
 * 1.8 秒的渲染），而 `dangerouslySetInnerHTML` 是一整个不可切分的工作单元，渲染中途让不出主线程。
 * trailing 防抖才是真的把「每键一次」变成「停顿一次」。
 */

/** 阈值以下一律逐字实时：小文件里「输入即所见」是查找的基本体感，不能为大文件整体牺牲。 */
export const FIND_INPUT_DEFER_MIN_LINES = 3000;
/** 停顿 200ms 后提交最后一次输入：短于正常打字停顿，又足够把一串按键并成一次重算。 */
export const FIND_INPUT_DEBOUNCE_MS = 200;

/** 这份正文里「敲一个字」值不值得推迟。两个视图只许经这里拿延迟，不许各写一份阈值。 */
export function findInputDelayFor(totalLines: number): number {
  return totalLines >= FIND_INPUT_DEFER_MIN_LINES ? FIND_INPUT_DEBOUNCE_MS : 0;
}

export interface DebouncedFindTerm {
  /** 命中层该用的词：小文档 = 输入框的即时值；大文档 = 停顿后提交的那一次。 */
  term: string;
  /** 输入框里还有没落进命中层的字符。只给「先提交再导航」用，不参与命中计算。 */
  isPending: boolean;
  /** 立刻提交未落地的字符（Enter / F3 / 上下处按钮调用），身份稳定，可进依赖数组。 */
  flush: () => void;
}

/**
 * 查找词输入去抖。
 *
 * 三条口径写在这里，是因为它们都会被「顺手改一下」破坏：
 * 1. `delay <= 0` 时**不建定时器、直接透传**，React 对同值 `setState` 会 bail out ⇒
 *    小文档的渲染次数与今天逐字一致（既有同步断言的测试一条都不必改成异步）。
 * 2. 只推迟「查找栏自己输入的词」。外部内容搜索词（`searchTerm`）不许进来：它是左侧列表跨文件
 *    搜索的结果，命中数必须与列表在同一帧一致（`configContentSearch.test.ts` 钉的跨模块不变式），
 *    而且 `locateFirstExternalHit` 依赖 `[searchTerm]` 时要立刻拿到新词的 hits。
 * 3. 返回值必须由视图喂给同一个 `effectiveTerm`：hits / 命中行底色 / 计数 / 缩略图红条同源，
 *    否则标红与行号会分叉。
 */
export function useDebouncedFindTerm(requested: string, totalLines: number): DebouncedFindTerm {
  const delay = findInputDelayFor(totalLines);
  const [committed, setCommitted] = useState(requested);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 最新一次输入：flush 是事件回调，读它才能拿到没落定的字符。 */
  const latestRef = useRef(requested);

  useEffect(() => {
    latestRef.current = requested;
    // 每次输入都重新计时（trailing）；换正文/换阈值也走这里，不留旧定时器。
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (delay <= 0) {
      // 逐字实时：把 committed 跟上，免得大→小切换后 term 还挂在旧词上。
      setCommitted(requested);
      return;
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setCommitted(requested);
    }, delay);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [requested, delay]);

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setCommitted(latestRef.current);
  }, []);

  return {
    term: delay > 0 ? committed : requested,
    isPending: delay > 0 && committed !== requested,
    flush,
  };
}
