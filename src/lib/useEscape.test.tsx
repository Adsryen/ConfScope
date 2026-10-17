/**
 * @vitest-environment jsdom
 */
import { fireEvent, renderHook } from "../test/react";
import { describe, expect, it, vi } from "vitest";
import { EscapePriority, useEscape } from "./useEscape";

describe("useEscape", () => {
  it("只让最内层（优先级最高）的注册者响应", () => {
    const page = vi.fn();
    const overlay = vi.fn();
    renderHook(() => useEscape(true, page, EscapePriority.page));
    renderHook(() => useEscape(true, overlay, EscapePriority.overlay));

    fireEvent.keyDown(window, { key: "Escape" });

    expect(overlay).toHaveBeenCalledTimes(1);
    expect(page).not.toHaveBeenCalled();
  });

  it("同优先级时后注册者胜（下拉盖在弹层之上）", () => {
    const first = vi.fn();
    const second = vi.fn();
    renderHook(() => useEscape(true, first, EscapePriority.overlay));
    renderHook(() => useEscape(true, second, EscapePriority.overlay));

    fireEvent.keyDown(window, { key: "Escape" });

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("active 为 false 时不参与分派", () => {
    const inactive = vi.fn();
    const active = vi.fn();
    renderHook(() => useEscape(false, inactive, EscapePriority.confirm));
    renderHook(() => useEscape(true, active, EscapePriority.page));

    fireEvent.keyDown(window, { key: "Escape" });

    expect(active).toHaveBeenCalledTimes(1);
    expect(inactive).not.toHaveBeenCalled();
  });

  it("捕获阶段拦截，冒泡阶段的旧式监听不再收到 Esc", () => {
    const legacy = vi.fn();
    const close = vi.fn();
    window.addEventListener("keydown", legacy);
    const { unmount } = renderHook(() => useEscape(true, close, EscapePriority.overlay));

    fireEvent.keyDown(window, { key: "Escape" });
    window.removeEventListener("keydown", legacy);

    expect(close).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
    unmount();
  });

  it("全部卸载后 Esc 不再被拦截，也不误触回调", () => {
    const close = vi.fn();
    const legacy = vi.fn();
    const { unmount } = renderHook(() => useEscape(true, close, EscapePriority.overlay));
    unmount();
    window.addEventListener("keydown", legacy);

    fireEvent.keyDown(window, { key: "Escape" });
    window.removeEventListener("keydown", legacy);

    expect(close).not.toHaveBeenCalled();
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("非 Esc 按键不触发任何回调", () => {
    const close = vi.fn();
    renderHook(() => useEscape(true, close, EscapePriority.overlay));

    fireEvent.keyDown(window, { key: "Enter" });

    expect(close).not.toHaveBeenCalled();
  });

  it("回调更新后按最新闭包执行", () => {
    const { rerender } = renderHook(({ fn }: { fn: () => void }) => useEscape(true, fn), {
      initialProps: { fn: vi.fn() },
    });
    const next = vi.fn();
    rerender({ fn: next });

    fireEvent.keyDown(window, { key: "Escape" });

    expect(next).toHaveBeenCalledTimes(1);
  });
});
