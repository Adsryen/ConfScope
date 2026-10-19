/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "../test/react";
import { describe, expect, it } from "vitest";
import { useMountOnceVisible } from "./keepAlive";

describe("useMountOnceVisible", () => {
  it("一开始就可见 ⇒ 首帧即挂载，不给用户留一个空壳帧", () => {
    const { result } = renderHook(() => useMountOnceVisible(true));
    expect(result.current).toBe(true);
  });

  it("一开始不可见 ⇒ 不挂载，一个节点都不进 DOM", () => {
    const { result } = renderHook(() => useMountOnceVisible(false));
    expect(result.current).toBe(false);
  });

  it("第一次可见后翻回不可见 ⇒ 仍然挂载（切走只是 hidden）", () => {
    const { result, rerender } = renderHook(({ visible }) => useMountOnceVisible(visible), {
      initialProps: { visible: false },
    });
    expect(result.current).toBe(false);

    rerender({ visible: true });
    expect(result.current).toBe(true);

    rerender({ visible: false });
    expect(result.current).toBe(true);
  });

  it("反复来回不重复挂载，也不因隐藏而退挂载", () => {
    const { result, rerender } = renderHook(({ visible }) => useMountOnceVisible(visible), {
      initialProps: { visible: true },
    });
    for (const visible of [false, true, false, false, true]) {
      act(() => rerender({ visible }));
      expect(result.current).toBe(true);
    }
  });
});
