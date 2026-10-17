/**
 * @vitest-environment jsdom
 */
import { useRef } from "react";
import { act, render, renderHook } from "../test/react";
import { describe, expect, it, vi } from "vitest";
import { useScrollResetOnContentChange, useScrollResetRef } from "./useScrollResetOnContentChange";

const noop = () => {};

/** 造一个能写回 scrollTop 的元素：jsdom 没有布局引擎，滚动位置直接赋值读回，用例不假装有滚动。 */
function makeBox(): HTMLElement {
  const el = document.createElement("pre");
  seed(el, 0, 0);
  document.body.append(el);
  return el;
}

function seed(el: HTMLElement, top: number, left = 0) {
  Object.defineProperty(el, "scrollTop", { value: top, writable: true });
  Object.defineProperty(el, "scrollLeft", { value: left, writable: true });
}

describe("useScrollResetOnContentChange", () => {
  it("挂载就归零一次，并回调 onReset（CodeView 的侧栏要跟手）", () => {
    const box = makeBox();
    const onReset = vi.fn();
    renderHook(() => {
      const ref = useRef<HTMLElement | null>(box);
      useScrollResetOnContentChange(ref, ["a"], onReset);
    });

    expect(box.scrollTop).toBe(0);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("换内容把滚动拉回起点", () => {
    const box = makeBox();
    const onReset = vi.fn();
    const { rerender } = renderHook(
      ({ key }: { key: string }) => {
        const ref = useRef<HTMLElement | null>(box);
        useScrollResetOnContentChange(ref, [key], onReset);
      },
      { initialProps: { key: "v1" } }
    );

    act(() => {
      seed(box, 320, 40);
    });
    rerender({ key: "v2" });

    expect(box.scrollTop).toBe(0);
    expect(box.scrollLeft).toBe(0);
    expect(onReset).toHaveBeenCalledTimes(2);
  });

  it("同一份内容重复渲染，不许清掉用户手动滚的位置", () => {
    const box = makeBox();
    const onReset = vi.fn();
    const { rerender } = renderHook(
      ({ tick }: { tick: number }) => {
        const ref = useRef<HTMLElement | null>(box);
        // 数组每次渲染都是新对象：比较必须看内容，不能看引用
        useScrollResetOnContentChange(ref, ["same", "same"], onReset);
        return tick;
      },
      { initialProps: { tick: 0 } }
    );

    act(() => {
      seed(box, 500);
    });
    rerender({ tick: 1 });
    rerender({ tick: 2 });

    expect(box.scrollTop).toBe(500);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("正文逐字相同但选中项变了也要归零（R9 口径）", () => {
    const box = makeBox();
    const { rerender } = renderHook(
      ({ id }: { id: string }) => {
        const ref = useRef<HTMLElement | null>(box);
        useScrollResetOnContentChange(ref, [id, "同样的正文"], noop);
      },
      { initialProps: { id: "row-1" } }
    );

    act(() => {
      seed(box, 210);
    });
    rerender({ id: "row-2" });

    expect(box.scrollTop).toBe(0);
  });

  it("元素还没挂上时不炸", () => {
    const onReset = vi.fn();
    expect(() => {
      renderHook(() => {
        const ref = useRef<HTMLElement | null>(null);
        useScrollResetOnContentChange(ref, ["a"], onReset);
      });
    }).not.toThrow();
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("keys 数量变化算换内容", () => {
    const box = makeBox();
    const { rerender } = renderHook(
      ({ extra }: { extra?: string }) => {
        const ref = useRef<HTMLElement | null>(box);
        useScrollResetOnContentChange(ref, extra ? ["a", extra] : ["a"], noop);
      },
      { initialProps: {} }
    );

    act(() => {
      seed(box, 90);
    });
    rerender({ extra: "b" });

    expect(box.scrollTop).toBe(0);
  });
});

describe("useScrollResetRef（一屏多个只读块）", () => {
  /** 列表版必须在真实组件树里跑：`map` 里不能逐个挂 hook，只能把节点登记起来。 */
  function List({ id, count }: { id: string; count: number }) {
    const attach = useScrollResetRef([id]);
    return (
      <div>
        {Array.from({ length: count }, (_, index) => (
          <pre key={index} ref={attach} />
        ))}
      </div>
    );
  }

  const presOf = (container: HTMLElement) => Array.from(container.querySelectorAll("pre")) as HTMLElement[];

  it("换选中时整屏的块一起回到起点", () => {
    const { container, rerender } = render(<List id="v1" count={3} />);
    const pres = presOf(container);
    pres.forEach((el, index) => seed(el, 100 + index, 7));

    rerender(<List id="v2" count={3} />);

    expect(pres.map((el) => el.scrollTop)).toEqual([0, 0, 0]);
    expect(pres.map((el) => el.scrollLeft)).toEqual([0, 0, 0]);
  });

  it("同一份内容重复渲染不许动用户滚的位置", () => {
    const { container, rerender } = render(<List id="same" count={2} />);
    const pres = presOf(container);
    pres.forEach((el, index) => seed(el, 60 + index));

    rerender(<List id="same" count={2} />);
    rerender(<List id="same" count={2} />);

    expect(pres.map((el) => el.scrollTop)).toEqual([60, 61]);
  });

  it("被 React 卸载的那一格不再参与归零，活着的一格照常归零", () => {
    const { container, rerender } = render(<List id="v1" count={3} />);
    const [kept, dropped] = presOf(container);
    seed(kept, 100);
    seed(dropped, 55);

    // 少一格：id 没变，谁都不许被清
    rerender(<List id="v1" count={1} />);
    expect(kept.scrollTop).toBe(100);
    expect(dropped.isConnected).toBe(false);

    // 换内容：活着的归零，已离开文档的那格保持原值（说明它已被摘出登记表）
    rerender(<List id="v2" count={1} />);
    expect(kept.scrollTop).toBe(0);
    expect(dropped.scrollTop).toBe(55);
  });
});
