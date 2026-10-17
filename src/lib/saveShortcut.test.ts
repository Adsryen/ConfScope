/**
 * @vitest-environment jsdom
 */
import { fireEvent, renderHook } from "../test/react";
import { describe, expect, it, vi } from "vitest";
import { isSaveShortcutKey, useBlockNativeSaveShortcut } from "./saveShortcut";

describe("isSaveShortcutKey（R47）", () => {
  function signal(patch: Partial<{ key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }>) {
    return { key: "s", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...patch };
  }

  it("Ctrl+S（Windows/Linux）与 Cmd+S（macOS）都算保存", () => {
    expect(isSaveShortcutKey(signal({ ctrlKey: true }))).toBe(true);
    expect(isSaveShortcutKey(signal({ metaKey: true }))).toBe(true);
    expect(isSaveShortcutKey(signal({ ctrlKey: true, key: "S" }))).toBe(true);
  });

  it("裸 s / 别的字母不算保存：不能把打字拦成快捷键", () => {
    expect(isSaveShortcutKey(signal({}))).toBe(false);
    expect(isSaveShortcutKey(signal({ ctrlKey: true, key: "f" }))).toBe(false);
  });

  it("带 alt 的组合留给宿主扩展，不算保存", () => {
    expect(isSaveShortcutKey(signal({ ctrlKey: true, altKey: true }))).toBe(false);
  });

  it("Ctrl+Shift+S（原生另存为）也进判据，好让兜底把它一起吞掉", () => {
    expect(isSaveShortcutKey(signal({ ctrlKey: true, shiftKey: true }))).toBe(true);
  });
});

describe("useBlockNativeSaveShortcut（R47）", () => {
  it("没人接管的 Ctrl+S 被拦下，原生「保存网页」不会冒出来", () => {
    renderHook(() => useBlockNativeSaveShortcut());

    const notPrevented = fireEvent.keyDown(document, { key: "s", ctrlKey: true });

    expect(notPrevented).toBe(false);
  });

  it("编辑区已接管（defaultPrevented）时绝不重复处理，否则一次按键存两遍", () => {
    renderHook(() => useBlockNativeSaveShortcut());
    const event = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
    const spy = vi.spyOn(event, "preventDefault");
    // 模拟 CodeEditor 的 onSave：它在冒泡到 window 之前就已经拦下这次按键
    document.addEventListener("keydown", () => event.preventDefault(), { once: true });

    document.dispatchEvent(event);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("组合态的 Ctrl+S 属于输入法，兜底不拦", () => {
    renderHook(() => useBlockNativeSaveShortcut());

    const notPrevented = fireEvent.keyDown(document, { key: "s", ctrlKey: true, isComposing: true });

    expect(notPrevented).toBe(true);
  });

  it("卸载后不再监听，别的键也不受影响", () => {
    const { unmount } = renderHook(() => useBlockNativeSaveShortcut());
    unmount();

    expect(fireEvent.keyDown(document, { key: "s", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(document, { key: "f", ctrlKey: true })).toBe(true);
  });
});
