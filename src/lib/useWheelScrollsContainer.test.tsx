/**
 * @vitest-environment jsdom
 */
import { act, render } from "../test/react";
import { useRef, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { useWheelScrollsContainer } from "./useWheelScrollsContainer";

/**
 * 全站唯一的「滚轮落在这块表面上 ⇒ 滚正文」出口（轮32 F-33）。
 *
 * 为什么要抽出来：同一件事在缩略图上已经做过一轮（轮31 F-25），查找条是这一轮新发现的死区
 * （实测取证 research/wheelbar_probe.txt：条子 532×38，正文起始偏移 120，滚一格三个落点全
 * 部停在 120 不动，外层也始终 0 —— 不是双滚，是纯死区）。再抄一份换算就是下一轮 bug 的出处。
 * 这里钉的是这份实现本身：换算档位、夹界、该放手时放手、当帧同步、原生 non-passive、重挂。
 * 两个视图 + 缩略图各自的接线由 CodeView.test.tsx / CodeEditor.test.tsx / CodeMinimap.test.tsx 钉。
 */
const VIEWPORT_H = 100;
const CONTENT_H = 600;
const ROW_H = 20;

/** 一条 wheel 注册记录（含挂 / 摘、目标节点与第三个参数）。 */
interface WheelReg {
  kind: "add" | "remove";
  target: Element;
  options: AddEventListenerOptions | boolean | undefined;
}

/**
 * 记录探针表面上真实挂出 / 摘掉的 wheel 监听，口径与 CodeMinimap.test.tsx 一致。
 *
 * 必须按 `data-testid` 过滤：React 18 建 root 时会在渲染容器 div 上挂 wheel 的冒泡与捕获监听
 * （passive 那份就是 preventDefault 无效的由来），混进来就是三条白送的噪声。
 */
function spyWheelRegistrations() {
  const all: WheelReg[] = [];
  const original = Element.prototype.addEventListener;
  vi.spyOn(Element.prototype, "addEventListener").mockImplementation(function (
    this: Element,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean
  ) {
    if (type === "wheel") all.push({ kind: "add", target: this, options });
    return original.call(this, type, listener, options);
  });
  const originalRemove = Element.prototype.removeEventListener;
  vi.spyOn(Element.prototype, "removeEventListener").mockImplementation(function (
    this: Element,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean
  ) {
    if (type === "wheel") all.push({ kind: "remove", target: this, options });
    return originalRemove.call(this, type, listener, options);
  });
  const onSurface = (kind: "add" | "remove") => all.filter((r) => r.kind === kind && r.target.getAttribute("data-testid") === "surface");
  return { entries: () => onSurface("add"), removed: () => onSurface("remove") };
}

/**
 * jsdom 的 fireEvent.wheel 造出来的事件读不到 deltaY，所以直接构造 WheelEvent。
 * 返回值留着断言 defaultPrevented —— 不取消默认动作就是双滚（外层面板跟着走）。
 */
function wheelOn(target: EventTarget, init: WheelEventInit): WheelEvent {
  const event = new WheelEvent("wheel", { cancelable: true, bubbles: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

interface Case {
  /** 行高：deltaMode=1 的换算基数。 */
  rowHeight?: number;
  /** 重挂依据，改它 ⇒ 探针重渲染。 */
  stage?: string;
  /** 换 surface 的 key：模拟目标节点被 React 重建（缩略图消失又回来、查找条关而又开）。 */
  nodeKey?: string;
  /** 关掉 ⇒ 正文容器还没挂上（首帧 / 换文件时视图重建节点）。 */
  withContainer?: boolean;
  /** 假几何：jsdom 没布局，clientHeight 恒 0 时页模式要退回行高。 */
  clientHeight?: number;
  scrollHeight?: number;
}

function mountWheelSurface(options: Case = {}) {
  const {
    rowHeight = ROW_H,
    stage = "a",
    nodeKey = "n1",
    withContainer = true,
    clientHeight = VIEWPORT_H,
    scrollHeight = CONTENT_H,
  } = options;
  const syncScroll = vi.fn();
  const offsets = { top: 0 };
  const registrations = spyWheelRegistrations();

  /** 探针：一块挂了滚轮出口的表面 + 一个可以装假几何的正文容器（与两个视图的形状一致）。 */
  function Probe({ stage: current, nodeKey: currentKey }: { stage: string; nodeKey: string }): ReactElement {
    const surfaceRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
    useWheelScrollsContainer(surfaceRef, { containerRef, syncScroll, rowHeight, reattachKey: current });
    return (
      <div>
        <div data-testid="surface" key={currentKey} ref={surfaceRef} />
        {withContainer ? <div data-testid="container" ref={containerRef} /> : null}
      </div>
    );
  }

  const view = render(<Probe stage={stage} nodeKey={nodeKey} />);
  // 探针自己的 DOM 里查，别用 getByTestId：同一用例挂两次时会撞到上一棵子树
  const query = (testid: string) => view.container.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
  const container = query("container");
  // jsdom 没布局：偏移可读写、两个高度自己装，「滚没滚」才分得开
  if (container) installGeometry(container, offsets, clientHeight, scrollHeight);
  const rerender = (next: { stage?: string; nodeKey?: string }) =>
    view.rerender(<Probe stage={next.stage ?? stage} nodeKey={next.nodeKey ?? nodeKey} />);
  return {
    surface: query("surface") as HTMLElement,
    query,
    container,
    offsets,
    syncScroll,
    registrations,
    rerender,
  };
}

function installGeometry(el: HTMLElement, offsets: { top: number }, clientHeight: number, scrollHeight: number) {
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => offsets.top,
    set: (value: number) => {
      offsets.top = value;
    },
  });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
}

describe("useWheelScrollsContainer：滚轮落在这块表面上要滚正文", () => {
  it("像素档位：写新偏移并当帧补一次同步，且取消默认动作", () => {
    const { surface, offsets, syncScroll } = mountWheelSurface();
    // 同步被调到的那一刻读到的偏移：等到 scroll 事件回来自愈就是慢一帧（轮30 F-20 那条不变式）
    let topAtSync = -1;
    syncScroll.mockImplementation(() => {
      topAtSync = offsets.top;
    });

    const event = wheelOn(surface, { deltaY: 40, deltaMode: 0 });
    expect(offsets.top, "滚轮打在表面上，正文一动不动").toBe(40);
    expect(topAtSync, "写完偏移没当帧同步行号层与命中行层").toBe(40);
    expect(syncScroll).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented, "不取消默认动作：外层面板会跟着一起滚").toBe(true);
  });

  it("deltaMode=1 按行换算，不许当像素用", () => {
    const { surface, offsets } = mountWheelSurface();
    wheelOn(surface, { deltaY: 3, deltaMode: 1 });
    // Linux 上 WebKitGTK 常见这一档：当像素就只滚 3px，一格等于没滚
    expect(offsets.top).toBe(60);
  });

  it("deltaMode=2 按视口高；量不到视口时退回行高，不许滚 0", () => {
    const { surface, offsets } = mountWheelSurface();
    wheelOn(surface, { deltaY: 1, deltaMode: 2 });
    expect(offsets.top, "页模式该滚整整一屏").toBe(VIEWPORT_H);

    const zero = mountWheelSurface({ clientHeight: 0 });
    wheelOn(zero.surface, { deltaY: 1, deltaMode: 2 });
    expect(zero.offsets.top, "clientHeight 还是 0 时页模式退回行高").toBe(ROW_H);
  });

  it("上下都夹在可滚区间里，越界不许变成负偏移", () => {
    const { surface, offsets } = mountWheelSurface();
    wheelOn(surface, { deltaY: 5000 });
    expect(offsets.top, "上界要夹在 scrollHeight - clientHeight").toBe(CONTENT_H - VIEWPORT_H);
    wheelOn(surface, { deltaY: -5000 });
    expect(offsets.top, "下界夹在 0：负偏移会让行号层与正文错开").toBe(0);
  });

  it("纯横向与捏合缩放都放手：不写偏移、不取消默认动作", () => {
    const { surface, offsets, syncScroll } = mountWheelSurface();
    const horizontal = wheelOn(surface, { deltaY: 0, deltaX: 120 });
    expect(horizontal.defaultPrevented, "shift+滚 / 触控板横划要留给原生").toBe(false);
    expect(offsets.top).toBe(0);
    const pinch = wheelOn(surface, { deltaY: 100, ctrlKey: true });
    expect(pinch.defaultPrevented, "ctrl+wheel 是浏览器缩放").toBe(false);
    expect(offsets.top, "捏合缩放不该把正文滚走").toBe(0);
    expect(syncScroll, "没滚就不许补同步").not.toHaveBeenCalled();
  });

  it("换算不出有限值就放手（NaN 传进 clamp 会把整条正文弄没）", () => {
    // jsdom 的 WheelEvent 构造函数直接拒绝非有限的 deltaY，所以从换算基数这一头进：
    // 调用方递错行高（NaN / Infinity）时这一格该原样交还原生，而不是把偏移写成 NaN
    const nanCase = mountWheelSurface({ rowHeight: Number.NaN });
    const nan = wheelOn(nanCase.surface, { deltaY: 3, deltaMode: 1 });
    expect(nan.defaultPrevented, "没处理成功就不许取消默认动作").toBe(false);
    expect(nanCase.offsets.top, "NaN 偏移被写进去了").toBe(0);

    const infCase = mountWheelSurface({ rowHeight: Number.POSITIVE_INFINITY });
    const inf = wheelOn(infCase.surface, { deltaY: 3, deltaMode: 1 });
    expect(inf.defaultPrevented).toBe(false);
    expect(Number.isFinite(infCase.offsets.top), "Infinity 偏移被写进去了").toBe(true);
  });

  it("正文容器还没挂上：什么都别做，也别抛", () => {
    const { surface, syncScroll, container } = mountWheelSurface({ withContainer: false });
    expect(container, "容器不该存在").toBeNull();
    expect(() => wheelOn(surface, { deltaY: 40 })).not.toThrow();
    const event = wheelOn(surface, { deltaY: 40 });
    expect(event.defaultPrevented, "找不到正文就不算接管，取消默认动作等于吃掉用户的滚轮").toBe(false);
    expect(syncScroll).not.toHaveBeenCalled();
  });

  it("必须是原生 non-passive 监听，卸载时摘掉", () => {
    const { registrations, surface } = mountWheelSurface();
    const mine = registrations.entries();
    expect(mine, "没挂出 wheel 监听：React 的 onWheel 是 passive 的，preventDefault 实测无效").toHaveLength(1);
    expect(mine[0].target, "监听没挂在表面上").toBe(surface);
    expect(mine[0].options, "passive 必须是 false，否则浏览器直接忽略 preventDefault").toMatchObject({ passive: false });
  });

  it("目标节点被重建时重挂到新节点，旧节点上的监听同时摘干净", () => {
    const { surface: first, registrations, offsets, rerender } = mountWheelSurface();
    rerender({ stage: "b", nodeKey: "n2" });
    const second = document.querySelector('[data-testid="surface"]') as HTMLElement;
    expect(second, "换 key 没换出新的表面节点").not.toBe(first);
    expect(registrations.entries(), "重挂依据变了却没重新订阅：新节点上的滚轮永远滚不动正文").toHaveLength(2);
    expect(registrations.entries()[1].target).toBe(second);
    expect(registrations.removed(), "旧节点的监听没摘：攒出一串 handler，同一格滚轮滚好几遍").toHaveLength(1);
    expect(registrations.removed()[0].target).toBe(first);

    offsets.top = 0;
    const stale = wheelOn(first, { deltaY: 40 });
    expect(stale.defaultPrevented, "旧节点上的残留监听必须已经失效").toBe(false);
    expect(offsets.top).toBe(0);
    wheelOn(second, { deltaY: 40 });
    expect(offsets.top, "新节点要接得住").toBe(40);
  });

  it("重挂依据没变时不许反复摘挂（同一档滚轮被处理两遍）", () => {
    const { registrations, rerender } = mountWheelSurface();
    rerender({ stage: "a" });
    rerender({ stage: "a" });
    expect(registrations.entries(), "重挂依据没变就重订阅：依赖表里塞进了每次渲染都换身份的东西").toHaveLength(1);
  });
});
