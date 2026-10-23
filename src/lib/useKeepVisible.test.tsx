/**
 * @vitest-environment jsdom
 */
import { render } from "../test/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeepVisible } from "./useKeepVisible";

/** 挂一个真节点当提示块：hook 只认自己 ref 上那个元素。 */
function Probe({ active, content = "" }: { active: boolean; content?: string }) {
  const ref = useKeepVisible<HTMLDivElement>(active, content);
  return (
    <div ref={ref} data-probe>
      {content}
    </div>
  );
}

function probeOf(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>("[data-probe]");
  if (!el) throw new Error("探针节点没渲染出来");
  return el;
}

/** 记录调用：只在提示真的「出现」时才会被调到。 */
let calls: ScrollIntoViewOptions[] = [];
let spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  calls = [];
  spy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element, options?: ScrollIntoViewOptions | boolean) {
    if (options && typeof options === "object") calls.push(options);
    else calls.push({});
    return undefined;
  });
});

afterEach(() => {
  spy.mockRestore();
});

describe("useKeepVisible", () => {
  it("提示出现时把自己滚进可视区，用 nearest 不抢位置", () => {
    const { container } = render(<Probe active content="上传失败" />);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ block: "nearest" });
    expect(probeOf(container)).toBeInTheDocument();
  });

  it("藏着的时候一动都不动（切页面不该被提示拽走）", () => {
    render(<Probe active={false} content="" />);
    expect(calls).toHaveLength(0);
  });

  it("隐藏 → 出现算一次，出现后重复渲染不再滚第二次", () => {
    const { container, rerender } = render(<Probe active={false} />);
    rerender(<Probe active content="第一份提示" />);
    expect(calls).toHaveLength(1);

    // React 每次渲染都跑一遍组件，若判据写成「渲染就滚」，用户刚把面板拖回去就又被抓回提示处
    rerender(<Probe active content="第一份提示" />);
    rerender(<Probe active content="第一份提示" />);
    expect(calls).toHaveLength(1);
    expect(probeOf(container)).toBeInTheDocument();
  });

  it("提示文本换了要再滚一次（重排后可能又跑到框外）", () => {
    const { rerender } = render(<Probe active content="上传失败" />);
    rerender(<Probe active content="下载失败" />);
    expect(calls).toHaveLength(2);
  });

  it("消失后再出现算新的一次", () => {
    const { rerender } = render(<Probe active content="上传失败" />);
    rerender(<Probe active={false} />);
    rerender(<Probe active content="上传失败" />);
    expect(calls).toHaveLength(2);
  });

  it("宿主环境没有 scrollIntoView 时早退，不许把渲染整棵子树带崩", () => {
    // 必须真的把方法拿掉：mockImplementation(undefined) 之后它仍是个函数，
    // 调用不抛错，判空那条分支就没被走到（变异验证时发现这个假绿）。
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Object.defineProperty(Element.prototype, "scrollIntoView", { value: undefined, configurable: true, writable: true });
    try {
      expect(() => render(<Probe active content="上传失败" />)).not.toThrow();
    } finally {
      if (descriptor) Object.defineProperty(Element.prototype, "scrollIntoView", descriptor);
      else delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView;
    }
  });

  it("动效口径跟着系统偏好：默认 smooth，减少动效时 auto", () => {
    render(<Probe active content="上传失败" />);
    expect(calls[0]?.behavior).toBe("smooth");

    calls = [];
    const matchMedia = vi.fn((query: string) => ({
      matches: query.includes("reduce"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    vi.stubGlobal("matchMedia", matchMedia);
    render(<Probe active content="上传失败" />);
    expect(calls[0]?.behavior).toBe("auto");
    vi.unstubAllGlobals();
  });
});
