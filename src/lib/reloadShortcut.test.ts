/**
 * @vitest-environment jsdom
 *
 * 刷新快捷键判据与兜底（轮45 R01）。
 * 判据表必须把「裸 r 是打字」这一条钉死：它一旦被写成无条件匹配，
 * 用户在搜索框/编辑器里就打不出 r 了，而这种回归在真机上极难归因。
 */
import { fireEvent, renderHook } from "../test/react";
import { describe, expect, it, vi } from "vitest";
import { isReloadShortcutKey, useBlockNativeReloadShortcut } from "./reloadShortcut";

describe("isReloadShortcutKey（轮45 R01）", () => {
  function signal(patch: Partial<{ key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }>) {
    return { key: "F5", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...patch };
  }

  it("F5 与它的强刷变体都算刷新", () => {
    expect(isReloadShortcutKey(signal({}))).toBe(true);
    expect(isReloadShortcutKey(signal({ ctrlKey: true }))).toBe(true);
    expect(isReloadShortcutKey(signal({ ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it("Ctrl+R（Windows/Linux）与 Cmd+R（macOS）都算刷新，大小写都认", () => {
    expect(isReloadShortcutKey(signal({ key: "r", ctrlKey: true }))).toBe(true);
    expect(isReloadShortcutKey(signal({ key: "R", ctrlKey: true }))).toBe(true);
    expect(isReloadShortcutKey(signal({ key: "r", metaKey: true }))).toBe(true);
  });

  it("裸 r 不算刷新：不能把打字拦成快捷键", () => {
    expect(isReloadShortcutKey(signal({ key: "r" }))).toBe(false);
    expect(isReloadShortcutKey(signal({ key: "r", shiftKey: true }))).toBe(false);
  });

  it("别的字母组合不算刷新", () => {
    expect(isReloadShortcutKey(signal({ key: "f", ctrlKey: true }))).toBe(false);
    expect(isReloadShortcutKey(signal({ key: "F4" }))).toBe(false);
  });

  it("带 alt 的组合一律放行，给开发者留手敲重载的逃生门", () => {
    expect(isReloadShortcutKey(signal({ altKey: true }))).toBe(false);
    expect(isReloadShortcutKey(signal({ key: "r", ctrlKey: true, altKey: true }))).toBe(false);
  });
});

describe("useBlockNativeReloadShortcut（轮45 R01）", () => {
  it("没人接管的 F5 / Ctrl+R 被拦下，原生重载不会发生", () => {
    renderHook(() => useBlockNativeReloadShortcut());

    expect(fireEvent.keyDown(document, { key: "F5" })).toBe(false);
    expect(fireEvent.keyDown(document, { key: "r", ctrlKey: true })).toBe(false);
  });

  it("打字不受影响：裸 r 与 Ctrl+Alt+R 都不许被吞", () => {
    renderHook(() => useBlockNativeReloadShortcut());

    expect(fireEvent.keyDown(document, { key: "r" })).toBe(true);
    expect(fireEvent.keyDown(document, { key: "r", ctrlKey: true, altKey: true })).toBe(true);
  });

  it("别处已接管（defaultPrevented）时绝不重复处理", () => {
    renderHook(() => useBlockNativeReloadShortcut());
    const event = new KeyboardEvent("keydown", { key: "F5", bubbles: true, cancelable: true });
    const spy = vi.spyOn(event, "preventDefault");
    document.addEventListener("keydown", () => event.preventDefault(), { once: true });

    document.dispatchEvent(event);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("组合态的 F5 属于输入法，兜底不拦", () => {
    renderHook(() => useBlockNativeReloadShortcut());

    expect(fireEvent.keyDown(document, { key: "F5", isComposing: true })).toBe(true);
  });

  it("卸载后不再监听", () => {
    const { unmount } = renderHook(() => useBlockNativeReloadShortcut());
    unmount();

    expect(fireEvent.keyDown(document, { key: "F5" })).toBe(true);
  });
});
