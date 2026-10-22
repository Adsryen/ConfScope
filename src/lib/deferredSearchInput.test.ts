/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "../test/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDeferredSearchInput } from "./deferredSearchInput";

// 假时钟：这几条测的全是「什么时候才发请求」，真等 400ms 只会让套件变慢且不稳。
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("输入即搜的输入法闸门（轮66 WP-6）", () => {
  it("组合期间一个字都不许多搜：半截拼音发出去只换来假的「无结果」", () => {
    const onSearch = vi.fn();
    const { result } = renderHook(() => useDeferredSearchInput(onSearch, 400));

    act(() => result.current.schedule("备"));
    act(() => result.current.onCompositionStart());
    // 用户还在打拼音：be / bei / beiw 每一下都会调 schedule
    for (const partial of ["b", "be", "bei", "beiw"]) {
      act(() => result.current.schedule(partial));
      act(() => vi.advanceTimersByTime(1000));
    }
    expect(onSearch).not.toHaveBeenCalled();
  });

  it("上屏后按输入框里的最终值补排一次", () => {
    const onSearch = vi.fn();
    const { result } = renderHook(() => useDeferredSearchInput(onSearch, 400));

    act(() => result.current.onCompositionStart());
    act(() => result.current.schedule("beiw"));
    act(() => result.current.onCompositionEnd("备份"));
    expect(onSearch).not.toHaveBeenCalled(); // 只是排期，不能提前抢跑

    act(() => vi.advanceTimersByTime(400));
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith("备份");
  });

  it("组合期间已经排好的那一次要撤掉，不能让它带着半截拼音落地", () => {
    const onSearch = vi.fn();
    const { result } = renderHook(() => useDeferredSearchInput(onSearch, 400));

    act(() => result.current.schedule("be"));
    act(() => result.current.onCompositionStart()); // 用户这时切到了输入法
    act(() => vi.advanceTimersByTime(1000));
    expect(onSearch).not.toHaveBeenCalled();
  });

  it("Enter 这类明确提交不等防抖，也不被组合态挡住", () => {
    const onSearch = vi.fn();
    const { result } = renderHook(() => useDeferredSearchInput(onSearch, 400));

    act(() => result.current.schedule("x"));
    act(() => result.current.runNow("y"));
    expect(onSearch).toHaveBeenCalledWith("y");
    act(() => vi.advanceTimersByTime(1000));
    expect(onSearch).toHaveBeenCalledTimes(1); // 排期那次已被撤
  });

  it("延迟为 0 时直接透传，小文档不必为定时器排队", () => {
    const onSearch = vi.fn();
    const { result } = renderHook(() => useDeferredSearchInput(onSearch, 0));
    act(() => result.current.schedule("k"));
    expect(onSearch).toHaveBeenCalledWith("k");
  });

  it("卸载收定时器：组件都没了，不该再回调一次搜索", () => {
    const onSearch = vi.fn();
    const { result } = renderHook(() => useDeferredSearchInput(onSearch, 400));
    act(() => result.current.schedule("abc"));
    result.current.cancel();
    act(() => vi.advanceTimersByTime(1000));
    expect(onSearch).not.toHaveBeenCalled();

    const second = renderHook(() => useDeferredSearchInput(onSearch, 400));
    act(() => second.result.current.schedule("abc"));
    second.unmount();
    act(() => vi.advanceTimersByTime(1000));
    expect(onSearch).not.toHaveBeenCalled();
  });

  it("定时器里读到的是最新闭包，不是排期那一帧的陈旧 state", () => {
    // 真实形态：回调要带上「当前搜索模式 / 当前 group」，这些完全可能在排期之后被改掉。
    const seen: string[] = [];
    const { rerender, result } = renderHook(
      ({ mode }: { mode: string }) => useDeferredSearchInput((value) => seen.push(`${mode}:${value}`)),
      { initialProps: { mode: "name" } }
    );

    // 排期发生在 mode=name 那一帧，400ms 还没到，用户切到了内容搜索模式
    act(() => result.current.schedule("abc"));
    act(() => rerender({ mode: "content" }));
    act(() => vi.advanceTimersByTime(400));
    expect(seen).toEqual(["content:abc"]);
  });
});
