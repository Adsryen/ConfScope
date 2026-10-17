/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, renderHook } from "../test/react";
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
