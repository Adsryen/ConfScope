/** @vitest-environment jsdom */
/**
 * 「我在哪一节」的判定与点击锁定（轮67 R67-WP3a）。
 *
 * 缺陷是真机量出来的：点第 4 项后 scrollTop 0→536，8 项的 aria-current 全 null、
 * className/背景/文字色一字未变；滚到底也一样——左栏根本没在跟随位置。
 */
import { fireEvent, render, screen } from "../test/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef, type ReactNode } from "react";
import { pickActiveSectionId, useSectionSpy, SECTION_SPY_THRESHOLD, isEditableTarget } from "./sectionSpy";

describe("pickActiveSectionId", () => {
  const ids = ["s1", "s2", "s3"];

  it("取最后一个已越过判定线的节", () => {
    expect(pickActiveSectionId(ids, [0, 300, 600])).toBe("s1");
    expect(pickActiveSectionId(ids, [-500, -200, 50])).toBe("s2");
    expect(pickActiveSectionId(ids, [-500, -300, -20])).toBe("s3");
  });

  it("边界：正好压线算当前节，越线一格就不算", () => {
    expect(pickActiveSectionId(ids, [0, SECTION_SPY_THRESHOLD, 999])).toBe("s2");
    expect(pickActiveSectionId(ids, [0, SECTION_SPY_THRESHOLD + 1, 999])).toBe("s1");
  });

  it("一节都判不出来（全在下方）时给 null，调用方保留上一次答案", () => {
    expect(pickActiveSectionId(ids, [100, 300, 600])).toBeNull();
    expect(pickActiveSectionId([], [])).toBeNull();
  });

  it("量不到矩形的那一节被跳过，不把它当成 0 或「早已越过」抢走当前节", () => {
    expect(pickActiveSectionId(ids, [-100, Number.NaN, 400])).toBe("s1");
    expect(pickActiveSectionId(ids, [Number.NaN, 5, 400])).toBe("s2");
    // 判据是「有限且越过线」：NaN 的比较恒为 false，负无穷却是「越过了」，
    // 少了这层判空，一个坏读数就能把当前节判给它（s1 那格在真机上并没有滚出上缘）。
    expect(pickActiveSectionId(ids, [Number.NEGATIVE_INFINITY, 300, 600])).toBeNull();
  });

  it("isEditableTarget 只认正在接收输入的控件", () => {
    document.body.innerHTML = `<input id="i" /><textarea id="t"></textarea><select id="s"><option>a</option></select><div id="d" contenteditable></div><section id="e" tabindex="-1"></section>`;
    const at = (id: string) => isEditableTarget(document.getElementById(id));
    expect([at("i"), at("t"), at("s"), at("d")]).toEqual([true, true, true, true]);
    expect(at("e")).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    document.body.innerHTML = "";
  });
});

const IDS = ["s1", "s2", "s3"];

function Probe({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { activeId, jumpToSection } = useSectionSpy(ref, IDS);
  return (
    <div>
      <div>
        {IDS.map((id) => (
          <button key={id} type="button" aria-current={activeId === id ? "true" : undefined} onClick={() => jumpToSection(id)}>
            {id}
          </button>
        ))}
      </div>
      <div ref={ref} data-top={0} tabIndex={-1}>
        {IDS.map((id) => (
          <section key={id} id={id} tabIndex={-1} data-top={id === "s1" ? 0 : id === "s2" ? 300 : 600}>
            {id === "s2" ? <input aria-label="proxy" /> : null}
          </section>
        ))}
        {children}
      </div>
    </div>
  );
}

function rectFor(el: Element): DOMRect {
  const top = Number(el.getAttribute("data-top") ?? 0);
  const original = new DOMRect(0, top, 200, 100);
  return original;
}

/** 把章节挪到新位置（等价于容器滚了一段：视口相对坐标全体下移）。 */
function moveTo(container: HTMLElement, tops: Record<string, number>) {
  IDS.forEach((id) => {
    const el = document.getElementById(id) as HTMLElement;
    el.setAttribute("data-top", String(tops[id]));
  });
  container.setAttribute("data-top", String(tops.__container ?? 0));
}

describe("useSectionSpy", () => {
  beforeEach(() => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return rectFor(this);
    });
  });

  // matchMedia 是给「减少动效」那两条用例临时 stub 的，不收回来会把后面的
  // behavior: "smooth" 断言全带偏（stubGlobal 不受 restoreAllMocks 管）。
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("挂载即按位置给出当前节，左栏带 aria-current", () => {
    render(<Probe />);
    expect(screen.getByRole("button", { name: "s1" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "s2" })).not.toHaveAttribute("aria-current");
  });

  it("用户滚动后高亮跟着位置走", () => {
    render(<Probe />);
    const container = document.querySelector("div[tabindex='-1']") as HTMLElement;
    moveTo(container, { s1: -500, s2: -200, s3: 50 });
    fireEvent.scroll(container);
    expect(screen.getByRole("button", { name: "s2" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "s1" })).not.toHaveAttribute("aria-current");
  });

  it("点索引立刻钉在点的那一节，位置还没跟上也不许扫过中间章节", () => {
    render(<Probe />);
    const container = document.querySelector("div[tabindex='-1']") as HTMLElement;
    // 钉住期间真实位置仍停在 s1（平滑滚动动画中，或滚到底时最后一节够不到判定线）
    fireEvent.click(screen.getByRole("button", { name: "s3" }));
    fireEvent.scroll(container);
    fireEvent.scroll(container);
    expect(screen.getByRole("button", { name: "s3" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "s1" })).not.toHaveAttribute("aria-current");
  });

  it("滚轮/触摸是「我自己动了」的信号，高亮交还位置判定", () => {
    render(<Probe />);
    const container = document.querySelector("div[tabindex='-1']") as HTMLElement;
    fireEvent.click(screen.getByRole("button", { name: "s3" }));
    moveTo(container, { s1: 0, s2: -10, s3: 300 });
    fireEvent.wheel(container);
    expect(screen.getByRole("button", { name: "s2" })).toHaveAttribute("aria-current", "true");
  });

  it("触摸滚动同样交还", () => {
    render(<Probe />);
    const container = document.querySelector("div[tabindex='-1']") as HTMLElement;
    fireEvent.click(screen.getByRole("button", { name: "s3" }));
    moveTo(container, { s1: -600, s2: -300, s3: -20 });
    fireEvent.touchStart(container);
    expect(screen.getByRole("button", { name: "s3" })).toHaveAttribute("aria-current", "true");
  });

  it("输入框里的方向键不算用户滚动，交还只认真正在滚的键", () => {
    render(<Probe />);
    const container = document.querySelector("div[tabindex='-1']") as HTMLElement;
    fireEvent.click(screen.getByRole("button", { name: "s2" }));
    fireEvent.keyDown(screen.getByLabelText("proxy"), { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: "s2" })).toHaveAttribute("aria-current", "true");

    moveTo(container, { s1: 0, s2: 300, s3: 600 });
    fireEvent.keyDown(container, { key: "PageDown" });
    expect(screen.getByRole("button", { name: "s1" })).toHaveAttribute("aria-current", "true");
  });

  it("窗口尺寸变了要重新判定，但钉住期间不动", () => {
    render(<Probe />);
    moveTo(document.querySelector("div[tabindex='-1']") as HTMLElement, { s1: -900, s2: -600, s3: 10 });
    fireEvent.click(screen.getByRole("button", { name: "s1" }));
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    fireEvent(window, new Event("resize"));
    expect(screen.getByRole("button", { name: "s1" })).toHaveAttribute("aria-current", "true");
    fireEvent.keyDown(document.querySelector("div[tabindex='-1']") as HTMLElement, { key: "End" });
    expect(screen.getByRole("button", { name: "s3" })).toHaveAttribute("aria-current", "true");
  });

  it("跳转按容器内偏移滚动，并把焦点交给目标章节", () => {
    render(<Probe />);
    const container = document.querySelector("div[tabindex='-1']") as HTMLElement;
    const scrollTo = vi.fn();
    container.scrollTo = scrollTo;
    Object.defineProperty(container, "scrollTop", { value: 120, configurable: true, writable: true });
    moveTo(container, { s1: 0, s2: 420, s3: 600 });
    (container as HTMLElement).setAttribute("data-top", "20");

    fireEvent.click(screen.getByRole("button", { name: "s2" }));

    expect(scrollTo).toHaveBeenCalledWith({ top: 120 + 420 - 20, behavior: "smooth" });
    expect(document.activeElement).toBe(document.getElementById("s2"));
  });

  it("减少动效偏好下跳转不动画，但位置与焦点不变", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    render(<Probe />);
    const container = document.querySelector("div[tabindex='-1']") as HTMLElement;
    const scrollTo = vi.fn();
    container.scrollTo = scrollTo;
    fireEvent.click(screen.getByRole("button", { name: "s3" }));
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "auto" }));
    expect(document.activeElement).toBe(document.getElementById("s3"));
  });

  it("没有 scrollTo 实现时只放弃滚动，焦点与高亮照给", () => {
    render(<Probe />);
    fireEvent.click(screen.getByRole("button", { name: "s1" }));
    expect(document.activeElement).toBe(document.getElementById("s1"));
    expect(screen.getByRole("button", { name: "s1" })).toHaveAttribute("aria-current", "true");
  });

  it("目标章节不在 DOM 里时不抛错也不改高亮", () => {
    render(<Probe />);
    const before = screen.getByRole("button", { name: "s1" }).getAttribute("aria-current");
    expect(() => {
      fireEvent.click(screen.getByRole("button", { name: "s1" }));
    }).not.toThrow();
    expect(screen.getByRole("button", { name: "s1" }).getAttribute("aria-current")).toBe(before);
  });
});
