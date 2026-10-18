/**
 * @vitest-environment jsdom
 *
 * 轮29 F-16：查找词输入的延迟策略。
 * 钉三条口径：小文档逐字实时（不建定时器）、大文档停顿后只提交最后一次、
 * 以及 flush 必须让「刚敲完就按回车」拿到新词的命中表。
 */
import { act, renderHook } from "../test/react";
import { describe, expect, it, vi } from "vitest";
import { FIND_INPUT_DEBOUNCE_MS, FIND_INPUT_DEFER_MIN_LINES, findInputDelayFor, useDebouncedFindTerm } from "./findInput";

const SMALL = FIND_INPUT_DEFER_MIN_LINES - 1;
const BIG = FIND_INPUT_DEFER_MIN_LINES;

describe("findInputDelayFor", () => {
  it("阈值以下不推迟，阈值以上按常量推迟", () => {
    expect(findInputDelayFor(0)).toBe(0);
    expect(findInputDelayFor(1)).toBe(0);
    expect(findInputDelayFor(SMALL)).toBe(0);
    expect(findInputDelayFor(FIND_INPUT_DEFER_MIN_LINES)).toBe(FIND_INPUT_DEBOUNCE_MS);
    expect(findInputDelayFor(200000)).toBe(FIND_INPUT_DEBOUNCE_MS);
  });

  it("阈值与延迟是同一份常量，视图里不许出现第二个字面量", () => {
    expect(FIND_INPUT_DEFER_MIN_LINES).toBe(3000);
    expect(FIND_INPUT_DEBOUNCE_MS).toBe(200);
  });
});

describe("useDebouncedFindTerm", () => {
  it("小文档逐字实时：term 立刻等于输入值，且不建任何定时器", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ term }) => useDebouncedFindTerm(term, SMALL), { initialProps: { term: "" } });
    expect(result.current.term).toBe("");
    expect(result.current.isPending).toBe(false);

    rerender({ term: "spr" });
    expect(result.current.term).toBe("spr");
    expect(result.current.isPending).toBe(false);
    // 这条是关键：延迟为 0 时透传，既不用等也不排定时器（渲染次数与改动前逐字一致）
    expect(vi.getTimerCount()).toBe(0);
  });

  it("大文档敲字期间不动命中层，停顿后才提交；停顿期间继续敲只提交最后一次", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ term }) => useDebouncedFindTerm(term, BIG), { initialProps: { term: "" } });

    rerender({ term: "s" });
    expect(result.current.term, "第一个字母就提交，等于没防抖").toBe("");
    expect(result.current.isPending).toBe(true);

    // 用户没停手：每 100ms 敲一个，定时器被一路重排
    for (const next of ["sp", "spr"]) {
      act(() => vi.advanceTimersByTime(100));
      rerender({ term: next });
      expect(result.current.term, "手没停就该一直等").toBe("");
    }

    act(() => vi.advanceTimersByTime(FIND_INPUT_DEBOUNCE_MS));
    expect(result.current.term).toBe("spr");
    expect(result.current.isPending).toBe(false);
    // 中间态从未被提交过：上面每次断言 term 都还是 ""，说明只付了一次重算的钱
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flush 立刻提交并吃掉待触发的定时器（Enter 不能拿旧词的命中表跳格子）", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ term }) => useDebouncedFindTerm(term, BIG), { initialProps: { term: "ab" } });

    rerender({ term: "abc" });
    expect(result.current.term).toBe("ab");
    expect(vi.getTimerCount()).toBe(1);

    act(() => result.current.flush());
    expect(result.current.term).toBe("abc");
    expect(result.current.isPending).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    // 提交后不再有"到点又写一次"的尾巴
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.term).toBe("abc");
  });

  it("卸载后不留下野定时器，也不在卸载后写状态", () => {
    vi.useFakeTimers();
    const { rerender, unmount } = renderHook(({ term }) => useDebouncedFindTerm(term, BIG), { initialProps: { term: "" } });
    rerender({ term: "xyz" });
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    act(() => vi.advanceTimersByTime(1000));
    expect(spy, "卸载后定时器还回调了一次 setState").not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("从大正文换到小正文：即时透传并且清掉没落地的定时器", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ term, totalLines }) => useDebouncedFindTerm(term, totalLines), {
      initialProps: { term: "old", totalLines: BIG },
    });

    rerender({ term: "new", totalLines: BIG });
    expect(vi.getTimerCount()).toBe(1);

    rerender({ term: "new", totalLines: SMALL });
    expect(result.current.term, "小文档还挂在旧词上：committed 没跟上").toBe("new");
    expect(vi.getTimerCount()).toBe(0);
  });
});
