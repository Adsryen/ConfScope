/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, renderHook } from "../test/react";
import { StrictMode } from "react";
import type { MutableRefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearViewState, readViewState, useRememberedState, useScrollMemory, viewStateKeys, writeViewState } from "./viewState";

/**
 * jsdom 没有布局引擎，原生的 scrollTop 赋值不会夹到真实可滚动范围。
 * 这里换成探针：记账写入值 + 按 max 夹回，才能同时验「写回」「恢复」「夹回后下次再试」。
 */
let restoreScrollTop: (() => void) | null = null;
let writes: number[] = [];
const maxStore = new WeakMap<Element, number>();

function installScrollSpy(): void {
  const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  expect(original, "jsdom 应在 Element.prototype 上定义 scrollTop").toBeTruthy();
  restoreScrollTop = () => Object.defineProperty(Element.prototype, "scrollTop", original!);
  writes = [];
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get(this: Element) {
      return store.get(this) ?? 0;
    },
    set(this: Element, value: number) {
      writes.push(value);
      // 没显式设定可滚动范围时不夹，模拟「列表已经够长」；用例可自己设 0 来模拟空列表
      const max = maxStore.has(this) ? (maxStore.get(this) ?? 0) : Number.POSITIVE_INFINITY;
      store.set(this, Math.max(0, Math.min(value, max)));
    },
  });
}

const store = new WeakMap<Element, number>();

function setScrollMax(el: Element, max: number): void {
  maxStore.set(el, max);
}

function scrollTo(el: Element, value: number): void {
  store.set(el, value);
  fireEvent.scroll(el);
}

beforeEach(() => {
  installScrollSpy();
  clearViewState();
});

afterEach(() => {
  restoreScrollTop?.();
  restoreScrollTop = null;
  clearViewState();
});

/**
 * 容器由调用方持有的形态（轮67 R67-WP3c 的设置页整页面板）：
 * 同一根 ref 还要喂给 scroll-spy，hook 不许再发一根新的。
 */
function ExternalScrollProbe({ name, hostRef, max }: { name: string; hostRef: MutableRefObject<HTMLDivElement | null>; max: number }) {
  const { ref, onScroll } = useScrollMemory(name, 0, hostRef);
  return (
    <div
      data-testid="scroller"
      ref={(node) => {
        // 返回值必须是调用方那一份，否则恢复写在 hook 私有 ref 上，调用方永远看不到
        expect(ref).toBe(hostRef);
        if (node) {
          setScrollMax(node, max);
          hostRef.current = node;
        }
      }}
      onScroll={onScroll}
    />
  );
}

function ScrollProbe({ name, version, max }: { name: string; version: number; max: number }) {
  const { ref, onScroll } = useScrollMemory(name, version);
  return (
    <div
      data-testid="scroller"
      ref={(node) => {
        // 先给容器定可滚动范围，再交给 hook：React 先挂子节点的 ref，才跑本组件的 useLayoutEffect，
        // 这样挂载时的恢复才会像真实浏览器一样被夹在可滚动范围内。
        if (node) setScrollMax(node, max);
        ref.current = node;
      }}
      onScroll={onScroll}
    />
  );
}

describe("视图状态存取", () => {
  it("组件卸载再挂载后仍读回上次记住的值，不再走初始值", () => {
    const first = renderHook(() => useRememberedState("history.filterDataId", ""));
    act(() => first.result.current[1]("pay"));
    expect(readViewState<string>("history.filterDataId")).toBe("pay");

    first.unmount();
    const initial = vi.fn(() => "初始值");
    const again = renderHook(() => useRememberedState("history.filterDataId", initial));

    expect(again.result.current[0]).toBe("pay");
    expect(initial).not.toHaveBeenCalled();
  });

  it("没记过时用初始值；不同 key 互不串页", () => {
    writeViewState("audit.project", "Order");
    const { result } = renderHook(() => useRememberedState("history.project", "默认页"));
    expect(result.current[0]).toBe("默认页");
    expect(readViewState("audit.project")).toBe("Order");
  });

  it("clearViewState 按前缀清理，只动这一页的", () => {
    writeViewState("audit.sortKey", "key");
    writeViewState("audit.scroll.matrix", 320);
    writeViewState("backup.selectedSnapshot", { id: "snap-1" });

    clearViewState("audit.");

    expect(viewStateKeys()).toEqual(["backup.selectedSnapshot"]);
  });

  it("滚动写回：用户滚动即记录，重新挂载把位置写回容器", () => {
    const first = render(<ScrollProbe name="backup.scroll.list" version={3} max={4000} />);
    act(() => scrollTo(first.getByTestId("scroller"), 240));
    expect(readViewState<number>("backup.scroll.list")).toBe(240);

    first.unmount();
    const second = render(<ScrollProbe name="backup.scroll.list" version={3} max={4000} />);
    const secondEl = second.getByTestId("scroller");

    expect(writes).toContain(240);
    expect(secondEl.scrollTop).toBe(240);
  });

  it("挂载时列表还是空的会被夹回 0，数据到达后按新的列表版本再恢复一次", () => {
    writeViewState("history.scroll.list", 480);
    const { rerender, getByTestId } = render(<ScrollProbe name="history.scroll.list" version={0} max={0} />);
    const el = getByTestId("scroller");
    expect(el.scrollTop).toBe(0);

    act(() => rerender(<ScrollProbe name="history.scroll.list" version={12} max={6000} />));

    expect(el.scrollTop).toBe(480);
  });

  // ── 轮67 R67-WP3c：首帧被布局夹住后逐帧补写 ──

  function stubFrames() {
    const queue: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    return {
      pump: async (times = 1) => {
        for (let i = 0; i < times; i += 1) {
          const batch = queue.splice(0);
          await act(async () => batch.forEach((cb) => cb(0)));
        }
      },
      pending: () => queue.length,
    };
  }

  it("首帧内容没长齐被夹回 0 时，不用等新的列表版本也补写到原位", async () => {
    writeViewState("audit.scroll.matrix", 480);
    const frames = stubFrames();
    const { getByTestId } = render(<ScrollProbe name="audit.scroll.matrix" version={3} max={0} />);
    const el = getByTestId("scroller");
    expect(el.scrollTop, "空列表就该被夹在 0，否则这条用例是空的").toBe(0);

    // 数据到了、容器长高了，但没有新的列表版本（设置页那种「同屏在、内容后补」）
    setScrollMax(el, 6000);
    await frames.pump(1);

    expect(el.scrollTop).toBe(480);
    expect(frames.pending(), "落到位就该停手，不许一直追").toBe(0);
  });

  it("补写期间用户自己滚了，立刻收手不把他拽回记住的位置", async () => {
    writeViewState("history.scroll.list", 480);
    const frames = stubFrames();
    const { getByTestId } = render(<ScrollProbe name="history.scroll.list" version={3} max={0} />);
    const el = getByTestId("scroller");

    act(() => scrollTo(el, 120));
    setScrollMax(el, 6000);
    await frames.pump(3);

    expect(el.scrollTop, "用户已经在读了，补写循环不许再动他").toBe(120);
    expect(frames.pending()).toBe(0);
  });

  /**
   * 真机轮67 R67-WP3c 的复现：开发模式 React 18 StrictMode 会把 effect 跑两遍
   * （setup → cleanup → setup）。上一版实现用「这个列表版本已经应用过」挡住第二遍，
   * 于是第一遍被布局夹住的深位置，补写循环刚被 cleanup 取消就再也没人接上——
   * 真机量 PARK=2000 永久停在 1688（首帧只能滚到 1688），用户被少放 312px。
   */
  it("StrictMode 把 effect 跑两遍后，被夹住的深位置照样补写到原位", async () => {
    writeViewState("settings.scroll.panels", 2000);
    const frames = stubFrames();
    const { getByTestId } = render(
      <StrictMode>
        <ScrollProbe name="settings.scroll.panels" version={0} max={1688} />
      </StrictMode>
    );
    const el = getByTestId("scroller");
    expect(el.scrollTop, "首帧内容没长齐，深位置应被夹在 1688").toBe(1688);

    // 异步内容补完：可滚动范围变大，但列表版本没变（设置页那种同屏 8 节）
    setScrollMax(el, 2200);
    await frames.pump(2);

    expect(el.scrollTop, "StrictMode 第二遍 setup 不许把补写弄丢").toBe(2000);
    expect(frames.pending()).toBe(0);
  });

  it("调用方自己持有容器 ref 时，恢复写进的就是它那一份", () => {
    writeViewState("settings.scroll.panels", 800);
    const hostRef: MutableRefObject<HTMLDivElement | null> = { current: null };
    const { getByTestId } = render(<ExternalScrollProbe name="settings.scroll.panels" hostRef={hostRef} max={2000} />);

    expect(hostRef.current).toBe(getByTestId("scroller"));
    expect(hostRef.current!.scrollTop).toBe(800);

    // 用户自己滚动同样记在调用方那根 ref 上（切走时账本里得是最新位置，不是挂载时那份）
    act(() => scrollTo(hostRef.current!, 1500));
    expect(readViewState<number>("settings.scroll.panels")).toBe(1500);
  });

  it("用户已经在读当前这一屏时，列表变化不再把他拽回记住的位置", () => {
    const { rerender, getByTestId } = render(<ScrollProbe name="audit.scroll.matrix" version={5} max={6000} />);
    const el = getByTestId("scroller");
    act(() => scrollTo(el, 900));

    writes = [];
    act(() => rerender(<ScrollProbe name="audit.scroll.matrix" version={9} max={6000} />));

    expect(el.scrollTop).toBe(900);
    expect(writes).toEqual([]);
    expect(readViewState<number>("audit.scroll.matrix")).toBe(900);
  });
});
