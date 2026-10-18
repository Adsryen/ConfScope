/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "../test/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDevicePixelRatio } from "./useDevicePixelRatio";

/**
 * 全站唯一的 dpr 订阅（轮32 F-32）。
 *
 * 为什么要订阅而不是在绘制时读一次：`devicePixelRatio` 变了（拖到另一台屏、改系统缩放、
 * WebView2 缩放档位）之后，按旧值摆好的画布不会自己重画，用户看到的是整条缩略图发糊，
 * 直到别的原因恰好触发一次重绘才自愈——「过一会儿自己好了」这种缺陷最难复现，也最难修。
 */

interface Stub {
  box: { value: number };
  queries: string[];
  listeners: Array<(this: unknown, ev: unknown) => void>;
  removed: string[];
  fireChange: () => void;
}

function stubMatchMedia(initial: number, opts: { withAddEventListener?: boolean } = {}): Stub {
  const box = { value: initial };
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => box.value });
  const stub: Stub = {
    box,
    queries: [],
    listeners: [],
    removed: [],
    fireChange: () => stub.listeners.forEach((cb) => cb({ type: "change" })),
  };
  const withAddEventListener = opts.withAddEventListener !== false;
  vi.stubGlobal("matchMedia", (query: string) => {
    stub.queries.push(query);
    return {
      media: query,
      matches: false,
      onchange: null,
      addEventListener: withAddEventListener
        ? (_type: string, cb: (this: unknown, ev: unknown) => void) => {
            stub.listeners.push(cb);
          }
        : undefined,
      removeEventListener: withAddEventListener
        ? (_type: string, cb: (this: unknown, ev: unknown) => void) => {
            stub.removed.push(String(cb === stub.listeners[stub.listeners.length - 1] ? "same" : "other"));
            const i = stub.listeners.indexOf(cb);
            if (i >= 0) stub.listeners.splice(i, 1);
          }
        : undefined,
    };
  });
  return stub;
}

describe("useDevicePixelRatio（轮32 F-32）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => 1 });
  });

  it("初始就是当前档位", () => {
    stubMatchMedia(2);
    const { result } = renderHook(() => useDevicePixelRatio());
    expect(result.current).toBe(2);
  });

  it("订阅的 media 里写的是当前 dppx，换档之后重新订阅新的那一条", () => {
    const stub = stubMatchMedia(1);
    const { result } = renderHook(() => useDevicePixelRatio());
    expect(stub.queries).toEqual(["(resolution: 1dppx)"]);

    act(() => {
      stub.box.value = 1.5;
      stub.fireChange();
    });
    expect(result.current, "change 到了却没把新档位读出来").toBe(1.5);
    expect(stub.queries[stub.queries.length - 1], "订阅还挂在旧 dpr 那条 media 上：下一次跨档没人通知").toBe("(resolution: 1.5dppx)");
  });

  it("档位没真的变化就不制造多余的渲染", () => {
    const stub = stubMatchMedia(2);
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useDevicePixelRatio();
    });
    const before = renders;
    act(() => stub.fireChange());
    expect(result.current).toBe(2);
    expect(renders, "同值也要 setState：绘制 effect 会被白拖一遍").toBe(before);
  });

  it("卸载时摘掉监听", () => {
    const stub = stubMatchMedia(1);
    const { unmount } = renderHook(() => useDevicePixelRatio());
    expect(stub.listeners).toHaveLength(1);
    unmount();
    expect(stub.listeners, "卸载后残留监听：换文件时攒出一串回调互相覆盖").toHaveLength(0);
  });

  it("没有 matchMedia 的宿主：退回一次性读取，不抛错", () => {
    const stub = stubMatchMedia(3, { withAddEventListener: false });
    const { result } = renderHook(() => useDevicePixelRatio());
    expect(result.current).toBe(3);
    expect(stub.listeners, "没有 addEventListener 通道时不该假装订阅成功").toHaveLength(0);
  });

  it("window.matchMedia 整个缺失：仍返回兜底档位，不抛错", () => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => 4 });
    vi.stubGlobal("matchMedia", undefined);
    const { result } = renderHook(() => useDevicePixelRatio());
    expect(result.current).toBe(4);
  });

  it("devicePixelRatio 读到脏值（0 / NaN）时兜底为 1，别让画布塌成 0 像素", () => {
    for (const bad of [0, Number.NaN]) {
      stubMatchMedia(bad);
      const { result } = renderHook(() => useDevicePixelRatio());
      expect(result.current, `dpr=${bad} 时不该把画布尺寸乘成 0`).toBe(1);
      vi.unstubAllGlobals();
    }
  });
});
