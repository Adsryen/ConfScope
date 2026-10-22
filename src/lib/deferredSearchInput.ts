import { useCallback, useEffect, useRef } from "react";

/**
 * 「输入即搜」输入框的时间编排：防抖 + 输入法组合态闸门（轮66 WP-6）。
 *
 * 为什么要有这个文件：浏览页的配置搜索与对比页的跨项内容搜索各自写了一份
 * `clearTimeout + setTimeout`，两处都在**候选词还没上屏**时就发请求。
 * Chromium 在组合期间每敲一个拼音字母都会派发 input，于是搜「备份」会先拿
 * `b`、`be`、`bei`、`beiw` 去查一遍：必然 0 命中，列表闪一下「没有结果」，
 * 内容搜索还要把每份正文都重扫一遍。用户看到的是「我还没打完它就报错说搜不到」。
 *
 * 口径：**回显永远即时，搜索永远等上屏**。
 * - `schedule()` 只安排定时器，组合态直接不回话（等 compositionend 再补一次）；
 * - `runNow()` 给 Enter / 搜索按钮 / 切模式这些明确的提交动作，不等；
 * - `cancel()` 收定时器——清空条件、换 group、卸载都走它。
 *
 * 判定组合态用 start/end 事件记状态，不读 keydown 的 isComposing：
 * 那套只适合按键分派（方向键/回车归输入法），input 事件里它可能已经翻回 false，
 * 而 compositionend 与最后一个 input 的先后顺序各引擎不一致，
 * 所以 `onCompositionEnd` 由调用方把**当前输入框的真实值**传进来，不依赖顺序。
 */

/** 浏览页列表/内容搜索的既有节奏，保持与轮66 之前一致。 */
export const SEARCH_INPUT_DEBOUNCE_MS = 400;

export interface DeferredSearchInput {
  /** 输入框每次变化都调：先让调用方自己 setState 回显，这里只负责要不要安排搜索。 */
  schedule: (value: string) => void;
  /** 明确的提交动作（Enter、搜索按钮、切换搜索模式）：立即执行，不等防抖也不看组合态。 */
  runNow: (value: string) => void;
  /** 收掉尚未触发的搜索。 */
  cancel: () => void;
  onCompositionStart: () => void;
  /** 上屏（或候选窗关闭）后补排一次；value 传输入框当前值。 */
  onCompositionEnd: (value: string) => void;
  /** 组合中：调用方据此决定别把半截拼音当已生效的条件（例如空态文案）。 */
  isComposing: () => boolean;
}

export function useDeferredSearchInput(
  onSearch: (value: string) => void,
  delayMs: number = SEARCH_INPUT_DEBOUNCE_MS
): DeferredSearchInput {
  // 每帧刷新：定时器里读到的永远是最新闭包，不会把排期时的陈旧 state 带进请求。
  const onSearchRef = useRef(onSearch);
  onSearchRef.current = onSearch;
  const timerRef = useRef<number | undefined>(undefined);
  const composingRef = useRef(false);

  const cancel = useCallback(() => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  }, []);

  const fire = useCallback(
    (value: string) => {
      cancel();
      onSearchRef.current(value);
    },
    [cancel]
  );

  const schedule = useCallback(
    (value: string) => {
      cancel();
      if (composingRef.current) return;
      if (delayMs <= 0) {
        fire(value);
        return;
      }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = undefined;
        fire(value);
      }, delayMs);
    },
    [cancel, delayMs, fire]
  );

  const onCompositionStart = useCallback(() => {
    composingRef.current = true;
    // 已经排好的那一次也要撤：此刻框里的串还是半截拼音，发出去只会得到假的「无结果」。
    cancel();
  }, [cancel]);

  const onCompositionEnd = useCallback(
    (value: string) => {
      composingRef.current = false;
      schedule(value);
    },
    [schedule]
  );

  const isComposing = useCallback(() => composingRef.current, []);

  useEffect(() => cancel, [cancel]);

  return { schedule, runNow: fire, cancel, onCompositionStart, onCompositionEnd, isComposing };
}
