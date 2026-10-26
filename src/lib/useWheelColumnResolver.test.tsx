/**
 * @vitest-environment jsdom
 */
import { act, render } from "../test/react";
import { useCallback, useRef, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WHEEL_ROW_H,
  consumeWheel,
  hasScrollableAncestor,
  isVerticallyScrollable,
  pickWheelSurface,
  registerWheelSurface,
  wheelPixelDelta,
  wheelSurfacesWithin,
  __clearWheelSurfacesForTest,
  type WheelSurfaceEntry,
} from "./wheelScroll";
import { useWheelColumnResolver, useWheelSurface } from "./useWheelColumnResolver";

/**
 * 轮33 F-34：页面级滚轮兜底（结构死区）+ 滚动面登记表。
 *
 * 取证口径来自 research/p3_batch_match_chrome.txt / p4_browse_chrome.txt / p5_dead_area.txt：
 * chrome 条既不在滚动容器子树里、自己子树也没有滚动容器 ⇒ 浏览器往上找不到可滚祖先，一格都不动
 * （配置浏览 22.2% 视口、差异对比宽栏 28.3%–29.6%）。这里钉的是机制本身：
 * 硬闸门（不抢原生）、按几何选列（不按 class）、禁区子树、页面作用域隔离、换算档位与夹界。
 * 真页面接线由 ConfigBrowser.test.tsx / DiffView.test.tsx 钉，真机复核走 Playwright 探针。
 */
const ROW_H = 20;

function wheelOn(target: EventTarget, init: WheelEventInit): WheelEvent {
  const event = new WheelEvent("wheel", { cancelable: true, bubbles: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

/** jsdom 没布局：可滚判定要的 overflow / 两个高度、选列要的矩形，全靠自己装。 */
function installScrollable(el: HTMLElement, opts: { overflow?: string; scrollHeight?: number; clientHeight?: number }) {
  el.style.overflowY = opts.overflow ?? "auto";
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => opts.scrollHeight ?? 600 });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => opts.clientHeight ?? 100 });
}

function installRect(el: HTMLElement, rect: { left: number; right: number; top?: number; bottom?: number }) {
  el.getBoundingClientRect = () =>
    ({
      left: rect.left,
      right: rect.right,
      top: rect.top ?? 100,
      bottom: rect.bottom ?? 500,
      width: rect.right - rect.left,
      height: (rect.bottom ?? 500) - (rect.top ?? 100),
      x: rect.left,
      y: rect.top ?? 100,
      toJSON: () => ({}),
    }) as DOMRect;
}

function entry(el: HTMLElement, opts: { syncScroll?: () => void; rowHeight?: number } = {}): WheelSurfaceEntry {
  return { el, syncScroll: opts.syncScroll, rowHeight: opts.rowHeight };
}

beforeEach(() => {
  // 登记表是模块级的：纯函数用例手动登记的对象不会随组件卸载消失，必须显式清
  __clearWheelSurfacesForTest();
});

describe("wheelPixelDelta / consumeWheel：换算与夹界（全站唯一一份实现）", () => {
  it("deltaMode=0 是像素：一格就是 deltaY，不许乘行高", () => {
    const el = document.createElement("div");
    installScrollable(el, {});
    // 这条钉的是最直觉的档位：把它当行高换算，Windows/WebView2 上每格会滚 20 倍距离
    expect(wheelPixelDelta(new WheelEvent("wheel", { deltaY: 100, deltaMode: 0 }), el, ROW_H)).toBe(100);
    expect(wheelPixelDelta(new WheelEvent("wheel", { deltaY: 3, deltaMode: 1 }), el, ROW_H)).toBe(60);
    expect(wheelPixelDelta(new WheelEvent("wheel", { deltaY: 1, deltaMode: 2 }), el, ROW_H)).toBe(100);
    expect(
      wheelPixelDelta(new WheelEvent("wheel", { deltaY: 1, deltaMode: 2 }), Object.assign(document.createElement("div"), {}), ROW_H)
    ).toBe(ROW_H);
  });

  it("没登记行高时按 DEFAULT_WHEEL_ROW_H 换算，不许退成像素", () => {
    const el = document.createElement("div");
    installScrollable(el, {});
    expect(wheelPixelDelta(new WheelEvent("wheel", { deltaY: 2, deltaMode: 1 }), el)).toBe(2 * DEFAULT_WHEEL_ROW_H);
  });

  it("写偏移 + 当帧同步 + 取消默认动作；上下都夹在可滚区间", () => {
    const offsets = { top: 0 };
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollTop", { configurable: true, get: () => offsets.top, set: (v: number) => (offsets.top = v) });
    installScrollable(el, { scrollHeight: 600, clientHeight: 100 });
    const seenAtSync: number[] = [];
    const syncScroll = vi.fn(() => {
      seenAtSync.push(offsets.top);
    });

    const down = new WheelEvent("wheel", { cancelable: true, deltaY: 40, deltaMode: 0 });
    expect(consumeWheel(down, el, { syncScroll })).toBe(true);
    // 同步被调到的那一刻读到的偏移：等 scroll 事件回来自愈就是慢一帧（轮30 F-20 那条不变式）
    expect(seenAtSync, "写完偏移没当帧同步行号层与命中行层").toEqual([40]);
    expect(down.defaultPrevented, "不取消默认动作：外层面板会跟着一起滚").toBe(true);

    expect(consumeWheel(new WheelEvent("wheel", { cancelable: true, deltaY: 9000 }), el, { syncScroll })).toBe(true);
    expect(offsets.top, "下界要夹在 scrollHeight - clientHeight").toBe(500);
    expect(consumeWheel(new WheelEvent("wheel", { cancelable: true, deltaY: -9000 }), el, { syncScroll })).toBe(true);
    expect(offsets.top, "上界夹在 0：负偏移会让行号层与正文错开").toBe(0);
    expect(seenAtSync, "每一格写完偏移都要当帧补一次同步").toEqual([40, 500, 0]);
  });

  it("纯横向与捏合缩放都放手：不写偏移、不取消默认动作", () => {
    const offsets = { top: 0 };
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollTop", { configurable: true, get: () => offsets.top, set: (v: number) => (offsets.top = v) });
    installScrollable(el, {});
    const horizontal = new WheelEvent("wheel", { cancelable: true, deltaY: 0, deltaX: 120 });
    expect(consumeWheel(horizontal, el)).toBe(false);
    expect(horizontal.defaultPrevented).toBe(false);
    const pinch = new WheelEvent("wheel", { cancelable: true, deltaY: 100, ctrlKey: true });
    expect(consumeWheel(pinch, el)).toBe(false);
    expect(pinch.defaultPrevented).toBe(false);
    expect(offsets.top).toBe(0);
  });

  it("换算基数坏了（NaN / Infinity）就交还原生，不许把偏移写成 NaN", () => {
    const offsets = { top: 0 };
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollTop", { configurable: true, get: () => offsets.top, set: (v: number) => (offsets.top = v) });
    installScrollable(el, {});
    const nan = new WheelEvent("wheel", { cancelable: true, deltaY: 3, deltaMode: 1 });
    expect(consumeWheel(nan, el, { rowHeight: Number.NaN })).toBe(false);
    expect(nan.defaultPrevented).toBe(false);
    const inf = new WheelEvent("wheel", { cancelable: true, deltaY: 3, deltaMode: 1 });
    expect(consumeWheel(inf, el, { rowHeight: Number.POSITIVE_INFINITY })).toBe(false);
    expect(Number.isFinite(offsets.top), "Infinity 偏移被写进去了").toBe(true);
  });
});

describe("isVerticallyScrollable / hasScrollableAncestor：兜底的硬闸门", () => {
  it("overflow-y 是 auto/scroll 且真有溢出才算可滚；hidden / visible 都不算", () => {
    const auto = document.createElement("div");
    installScrollable(auto, { overflow: "auto" });
    expect(isVerticallyScrollable(auto)).toBe(true);
    const hidden = document.createElement("div");
    installScrollable(hidden, { overflow: "hidden" });
    expect(isVerticallyScrollable(hidden), "overflow:hidden 原生滚不动，不能拿它当「已经归原生管」的证据").toBe(false);
    const visible = document.createElement("div");
    installScrollable(visible, { overflow: "visible" });
    expect(isVerticallyScrollable(visible)).toBe(false);
    const noRoom = document.createElement("div");
    installScrollable(noRoom, { overflow: "auto", scrollHeight: 101, clientHeight: 100 });
    expect(isVerticallyScrollable(noRoom), "1px 的四舍五入溢出算滚不动").toBe(false);
  });

  it("祖先链上有一个可滚容器 ⇒ 这一格归原生，兜底不许碰", () => {
    const root = document.createElement("div");
    const scroller = document.createElement("div");
    const chrome = document.createElement("span");
    scroller.appendChild(chrome);
    root.appendChild(scroller);
    document.body.appendChild(root);
    installScrollable(scroller, { overflow: "auto" });
    expect(hasScrollableAncestor(chrome)).toBe(true);

    // 换成一路 hidden（.workspace / .code-body / body 的形状）——就是实测里的一动不动
    const dead = document.createElement("div");
    const bar = document.createElement("span");
    dead.appendChild(bar);
    document.body.appendChild(dead);
    installScrollable(dead, { overflow: "hidden" });
    expect(hasScrollableAncestor(bar)).toBe(false);
    root.remove();
    dead.remove();
  });
});

describe("pickWheelSurface：只按几何选列，不按 class", () => {
  const VIEWPORT = { width: 1440, height: 900 };

  function mkColumn(testid: string, left: number, right: number, depth = 0) {
    const host = document.createElement("div");
    let el = host;
    for (let i = 0; i < depth; i += 1) {
      const child = document.createElement("div");
      el.appendChild(child);
      el = child;
    }
    el.setAttribute("data-surface", testid);
    installScrollable(el, {});
    installRect(el, { left, right });
    document.body.appendChild(host);
    return entry(el);
  }

  it("指针 x 落在哪一列就滚那一列的正文（chrome 贴在正文上方、y 不参与判列）", () => {
    const items = mkColumn("items", 0, 360);
    const code = mkColumn("code", 361, 1440);
    expect(pickWheelSurface([items, code], 120, 150, VIEWPORT)?.el.getAttribute("data-surface")).toBe("items");
    expect(pickWheelSurface([items, code], 1052, 159, VIEWPORT)?.el.getAttribute("data-surface")).toBe("code");
    // 批量态横跨两列的 .batch-diff-failures-head / .diff-loadbar 同一条规则：x 在列表列滚列表，x 在主区滚主区（.batch-diff-toolbar 是 fixture 里的名字，真实组件从未渲染，轮89 已删其死样式）
    expect(pickWheelSurface([items, code], 1052, 881, VIEWPORT)?.el.getAttribute("data-surface")).toBe("code");
  });

  it("落两列的 gap：退「可见面积最大者」", () => {
    const narrow = mkColumn("narrow", 0, 360);
    const wide = mkColumn("wide", 400, 1440);
    // x=380 落在两块矩形都不包含的缝里（narrow 右边界 360，wide 左边界 400）
    expect(pickWheelSurface([narrow, wide], 380, 400, VIEWPORT)?.el.getAttribute("data-surface")).toBe("wide");
  });

  it("窄栏堆叠布局：左右两列上下排、x 区间重叠时用指针 y 分开", () => {
    const nav = mkColumn("nav", 0, 1440);
    const main = mkColumn("main", 0, 1440);
    installRect(nav.el, { left: 0, right: 1440, top: 80, bottom: 260 });
    installRect(main.el, { left: 0, right: 1440, top: 270, bottom: 880 });
    expect(pickWheelSurface([nav, main], 700, 700, VIEWPORT)?.el.getAttribute("data-surface")).toBe("main");
    expect(pickWheelSurface([nav, main], 700, 200, VIEWPORT)?.el.getAttribute("data-surface")).toBe("nav");
  });

  it("嵌套滚动容器同列命中时取最内层，不许把滚轮投给外层面板", () => {
    const outer = mkColumn("outer", 0, 1440, 0);
    const inner = mkColumn("inner", 0, 1440, 3);
    expect(pickWheelSurface([outer, inner], 700, 400, VIEWPORT)?.el.getAttribute("data-surface")).toBe("inner");
  });

  it("滚不动的候选一律剔除：全部不可滚返回 null（调用方就不许 preventDefault）", () => {
    const atEdge = mkColumn("edge", 0, 360);
    installScrollable(atEdge.el, { overflow: "auto", scrollHeight: 100, clientHeight: 100 });
    expect(pickWheelSurface([atEdge], 100, 400, VIEWPORT)).toBeNull();

    const clipped = mkColumn("clipped", 400, 1440);
    installScrollable(clipped.el, { overflow: "hidden" });
    expect(pickWheelSurface([atEdge, clipped], 900, 400, VIEWPORT)).toBeNull();
  });

  it("完全在视口外的候选（面积 0）不参与兜底", () => {
    const offscreen = mkColumn("offscreen", 2000, 2400);
    const visible = mkColumn("visible", 0, 360);
    expect(pickWheelSurface([offscreen, visible], 180, 400, VIEWPORT)?.el.getAttribute("data-surface")).toBe("visible");
    expect(pickWheelSurface([offscreen], 2100, 400, VIEWPORT)).toBeNull();
  });
});

describe("registerWheelSurface / wheelSurfacesWithin：登记表按子树隔离", () => {
  it("只把本页面子树内的滚动面给这一页的兜底", () => {
    const pageA = document.createElement("div");
    const pageB = document.createElement("div");
    const elA = document.createElement("div");
    const elB = document.createElement("div");
    elA.setAttribute("data-surface", "a");
    elB.setAttribute("data-surface", "b");
    pageA.appendChild(elA);
    pageB.appendChild(elB);
    document.body.append(pageA, pageB);
    const offA = registerWheelSurface(elA, { rowHeight: ROW_H });
    registerWheelSurface(elB);

    expect(wheelSurfacesWithin(pageA).map((e) => e.el.getAttribute("data-surface"))).toEqual(["a"]);
    expect(wheelSurfacesWithin(pageB).map((e) => e.el.getAttribute("data-surface"))).toEqual(["b"]);

    offA();
    expect(wheelSurfacesWithin(pageA)).toHaveLength(0);
    pageA.remove();
    pageB.remove();
  });

  it("同一节点重复登记以最后一次为准（不攒出多份同步回调）", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const first = vi.fn();
    const second = vi.fn();
    registerWheelSurface(el, { syncScroll: first });
    registerWheelSurface(el, { syncScroll: second });
    const listed = wheelSurfacesWithin(document.body).filter((e) => e.el === el);
    expect(listed).toHaveLength(1);
    expect(listed[0].syncScroll).toBe(second);
    el.remove();
  });
});

describe("useWheelColumnResolver：页面级兜底的行为边界", () => {
  /** 一棵和真页面同形的假树：根是 overflow:hidden 的 .workspace 味道，chrome 条是滚动容器的兄弟。 */
  function Probe({
    leftChromeLabel = "计数条",
    denyNode = false,
    ancestorScrollable = false,
    reattachKey = "a",
    nodeKey = "n1",
  }: {
    leftChromeLabel?: string;
    denyNode?: boolean;
    ancestorScrollable?: boolean;
    reattachKey?: unknown;
    nodeKey?: string;
  }): ReactElement {
    const rootRef = useRef<HTMLDivElement>(null);
    const itemsRef = useRef<HTMLDivElement>(null);
    const codeRef = useRef<HTMLDivElement>(null);
    const syncItems = useCallback(() => {
      itemsSync(itemsRef.current);
    }, []);
    useWheelColumnResolver(rootRef, { reattachKey });
    useWheelSurface(itemsRef, { syncScroll: syncItems, rowHeight: ROW_H });
    useWheelSurface(codeRef, { rowHeight: ROW_H });
    return (
      <div key={nodeKey} ref={rootRef} data-testid="root" style={{ overflow: "hidden" }}>
        {ancestorScrollable ? (
          <div data-testid="scrollable-ancestor" style={{ overflowY: "auto" }}>
            <div data-testid="chrome-left">{leftChromeLabel}</div>
          </div>
        ) : (
          <>
            <div data-testid="chrome-left">{leftChromeLabel}</div>
            <div data-testid="chrome-right">格式化条</div>
          </>
        )}
        {denyNode ? (
          <div className="modal-overlay" data-testid="modal">
            <div data-testid="modal-header">标题</div>
          </div>
        ) : null}
        <div data-testid="items" ref={itemsRef} data-surface="items" />
        <div data-testid="code" ref={codeRef} data-surface="code" />
      </div>
    );
  }

  let itemsSynced = 0;
  function itemsSync(el: HTMLElement | null) {
    if (el) itemsSynced += 1;
  }

  function mount(options: Parameters<typeof Probe>[0] = {}) {
    itemsSynced = 0;
    const view = render(<Probe {...options} />);
    const q = (testid: string) => view.container.querySelector(`[data-testid="${testid}"]`) as HTMLElement;
    const root = q("root");
    const items = q("items");
    const code = q("code");
    const offsets = { items: 0, code: 0 };
    Object.defineProperty(items, "scrollTop", { configurable: true, get: () => offsets.items, set: (v: number) => (offsets.items = v) });
    Object.defineProperty(code, "scrollTop", { configurable: true, get: () => offsets.code, set: (v: number) => (offsets.code = v) });
    installScrollable(items, { scrollHeight: 600, clientHeight: 100 });
    installScrollable(code, { scrollHeight: 600, clientHeight: 100 });
    // 两列 + 两块 chrome 的真实几何：左列 0..360，右列 361..1440；chrome 贴在各自正文上方（y 不同）
    installRect(items, { left: 0, right: 360, top: 250, bottom: 880 });
    installRect(code, { left: 361, right: 1440, top: 170, bottom: 860 });
    const chromeLeft = q("chrome-left");
    const chromeRight = view.container.querySelector('[data-testid="chrome-right"]') as HTMLElement | null;
    installRect(chromeLeft, { left: 0, right: 360, top: 100, bottom: 250 });
    if (chromeRight) installRect(chromeRight, { left: 361, right: 1440, top: 120, bottom: 170 });
    if (ancestor(options)) installScrollable(q("scrollable-ancestor"), { scrollHeight: 600, clientHeight: 100 });
    return { view, root, items, code, chromeLeft, chromeRight: chromeRight as HTMLElement, offsets, q };
  }

  function ancestor(options: { ancestorScrollable?: boolean }) {
    return options.ancestorScrollable === true;
  }

  it("chrome 条落点没有可滚祖先 ⇒ 滚同一列的正文，并当帧补同步", () => {
    const { chromeLeft, chromeRight, offsets } = mount();
    const left = wheelOn(chromeLeft, { deltaY: 120, clientX: 120, clientY: 150 });
    expect(offsets.items, "滚轮打在配置浏览的计数条上，左列列表一动不动").toBe(120);
    expect(left.defaultPrevented).toBe(true);
    expect(itemsSynced, "写完偏移没当帧同步左列").toBe(1);

    const right = wheelOn(chromeRight, { deltaY: 120, clientX: 1052, clientY: 159 });
    expect(offsets.code, "格式化条上滚轮该滚正文").toBe(120);
    expect(right.defaultPrevented).toBe(true);
  });

  it("落两列之间的缝里：退可见面积最大者（正文列），不是一动不动", () => {
    const { chromeRight, offsets } = mount();
    wheelOn(chromeRight, { deltaY: 120, clientX: 380, clientY: 140 });
    expect(offsets.code, "gap 上要按面积兜到正文，否则用户还是觉得卡住").toBe(120);
  });

  it("硬闸门：祖先链里已经有一个可滚容器 ⇒ 整格交还原生，不接管也不取消默认动作", () => {
    const { chromeLeft, offsets } = mount({ ancestorScrollable: true });
    const event = wheelOn(chromeLeft, { deltaY: 120, clientX: 120, clientY: 150 });
    expect(event.defaultPrevented, "抢了原生滚动，.modal-body/.sel-menu/.message-list 的语义就会被动过").toBe(false);
    expect(offsets.items).toBe(0);
    expect(itemsSynced).toBe(0);
  });

  it("弹框子树是禁区：即使闸门判定它是死区也不转发", () => {
    const { offsets, q } = mount({ denyNode: true });
    const header = q("modal-header");
    const event = wheelOn(header, { deltaY: 120, clientX: 120, clientY: 150 });
    expect(event.defaultPrevented, "弹框后面那块 chrome 被滚走 = 关掉弹框后位置错乱").toBe(false);
    expect(offsets.items).toBe(0);
  });

  it("事件已被别人消费（轮31/32 的 per-surface 接线）⇒ 让路，不许双滚", () => {
    const { chromeLeft, offsets } = mount();
    const event = new WheelEvent("wheel", { cancelable: true, bubbles: true, deltaY: 120, clientX: 120, clientY: 150 });
    event.preventDefault();
    act(() => {
      chromeLeft.dispatchEvent(event);
    });
    expect(offsets.items, "已经 defaultPrevented 还要再滚一次，一格变两格").toBe(0);
  });

  it("纯横向与捏合缩放在 chrome 上也照样放手", () => {
    const { chromeLeft, offsets } = mount();
    const horizontal = wheelOn(chromeLeft, { deltaY: 0, deltaX: 120, clientX: 120, clientY: 150 });
    expect(horizontal.defaultPrevented).toBe(false);
    const pinch = wheelOn(chromeLeft, { deltaY: 100, ctrlKey: true, clientX: 120, clientY: 150 });
    expect(pinch.defaultPrevented, "ctrl+wheel 是浏览器缩放").toBe(false);
    expect(offsets.items).toBe(0);
  });

  it("夹界：滚到底停住，不外溢到页面其它地方", () => {
    const { chromeLeft, offsets } = mount();
    wheelOn(chromeLeft, { deltaY: 9000, clientX: 120, clientY: 150 });
    expect(offsets.items).toBe(500);
    wheelOn(chromeLeft, { deltaY: 120, clientX: 120, clientY: 150 });
    expect(offsets.items, "已经到底还继续加，偏移会越界").toBe(500);
  });

  it("必须是原生 non-passive 监听，卸载时摘掉；重挂依据没变不许反复摘挂", () => {
    const regs: { kind: "add" | "remove"; target: Element; options: AddEventListenerOptions | boolean | undefined }[] = [];
    const originalAdd = Element.prototype.addEventListener;
    vi.spyOn(Element.prototype, "addEventListener").mockImplementation(function (
      this: Element,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: AddEventListenerOptions | boolean
    ) {
      if (type === "wheel" && this.getAttribute?.("data-testid") === "root") regs.push({ kind: "add", target: this, options });
      return originalAdd.call(this, type, listener, options);
    });
    const originalRemove = Element.prototype.removeEventListener;
    vi.spyOn(Element.prototype, "removeEventListener").mockImplementation(function (
      this: Element,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: AddEventListenerOptions | boolean
    ) {
      if (type === "wheel" && this.getAttribute?.("data-testid") === "root") regs.push({ kind: "remove", target: this, options });
      return originalRemove.call(this, type, listener, options);
    });

    const view = render(<Probe reattachKey="a" />);
    expect(regs.filter((r) => r.kind === "add")).toHaveLength(1);
    expect(regs.filter((r) => r.kind === "add")[0].options).toMatchObject({ passive: false });
    act(() => view.rerender(<Probe reattachKey="a" />));
    expect(
      regs.filter((r) => r.kind === "add"),
      "重挂依据没变就重订阅：同一格滚轮被处理两遍"
    ).toHaveLength(1);
    view.unmount();
    expect(
      regs.filter((r) => r.kind === "remove"),
      "页面根上的监听没摘"
    ).toHaveLength(1);
    vi.restoreAllMocks();
  });
});

describe("useWheelColumnResolver 的 localPriority：组件级根拥有自己的浮层", () => {
  /**
   * 轮33 F-34 真机复核挖出的两处静默回归，这里钉的就是修法本身（取证见 PRD 的 G1/G2）：
   * 旧的 per-surface 监听直接挂在浮层元素上，浮层**永远滚自己组件的正文**，既不看外层有没有可滚容器，
   * 也不看自己在不在弹框里。要能等价地删掉那些接线，这两条就得由 localPriority 补回来——
   * 而且只许组件级根（CodeView / CodeEditor）开，页面根开了就变成抢外层面板的原生滚动。
   */
  function LocalProbe({
    localPriority = false,
    ancestorScrollable = false,
    hostWrapper = "none",
    denyInside = false,
    nodeKey = "n1",
  }: {
    localPriority?: boolean;
    ancestorScrollable?: boolean;
    hostWrapper?: "none" | "modal" | "selmenu";
    denyInside?: boolean;
    nodeKey?: string;
  }): ReactElement {
    const rootRef = useRef<HTMLDivElement>(null);
    const taRef = useRef<HTMLDivElement>(null);
    const sync = useCallback(() => {
      synced += 1;
    }, []);
    useWheelColumnResolver(rootRef, { localPriority });
    useWheelSurface(taRef, { syncScroll: sync, rowHeight: ROW_H });
    const tree = (
      <div key={nodeKey} ref={rootRef} data-testid="root" style={{ overflow: "hidden" }}>
        {ancestorScrollable ? (
          <div data-testid="host-panel" style={{ overflowY: "auto" }}>
            <div data-testid="fmt-bar">格式化条</div>
          </div>
        ) : (
          <div data-testid="fmt-bar">格式化条</div>
        )}
        <div data-testid="ta" ref={taRef}>
          <div data-testid="caret-line">正文里的一行</div>
        </div>
        {denyInside ? (
          <div className="modal-overlay" data-testid="inline-deny">
            <div data-testid="inline-deny-header">标题</div>
          </div>
        ) : null}
      </div>
    );
    // 宿主容器写在 JSX 里而不是事后搬 DOM 节点：React 卸载时按父子关系摘节点，搬过就不认识了
    if (hostWrapper === "none") return tree;
    // 类名必须是黑名单里的真名字：.modal-overlay 是 fixed 定位层，.sel-menu 自己是滚动区
    const hostClass = hostWrapper === "modal" ? "modal-overlay" : "sel-menu";
    return (
      <div className={hostClass} data-testid="host-wrapper">
        {tree}
      </div>
    );
  }

  let synced = 0;

  function mountLocal(options: Parameters<typeof LocalProbe>[0] = {}) {
    synced = 0;
    const view = render(<LocalProbe {...options} />);
    const q = (testid: string) => view.container.querySelector(`[data-testid="${testid}"]`) as HTMLElement;
    const ta = q("ta");
    const offsets = { ta: 0 };
    Object.defineProperty(ta, "scrollTop", { configurable: true, get: () => offsets.ta, set: (v: number) => (offsets.ta = v) });
    installScrollable(ta, { scrollHeight: 600, clientHeight: 100 });
    // CodeEditor 的真实形状：正文占满这一列，chrome 条压在正文上方（y 落在正文矩形之外）
    installRect(ta, { left: 0, right: 1200, top: 200, bottom: 800 });
    installRect(q("fmt-bar"), { left: 0, right: 1200, top: 150, bottom: 200 });
    installRect(q("caret-line"), { left: 0, right: 1200, top: 300, bottom: 340 });
    if (options.ancestorScrollable) installScrollable(q("host-panel"), { scrollHeight: 600, clientHeight: 100 });
    if (options.hostWrapper === "selmenu") installScrollable(q("host-wrapper"), { scrollHeight: 600, clientHeight: 100 });
    if (options.denyInside) installRect(q("inline-deny-header"), { left: 0, right: 1200, top: 900, bottom: 950 });
    return { view, q, ta, offsets };
  }

  it("G1 宿主面板自己可滚：组件级根开了 localPriority 仍旧接管正文，页面根绝不接管", () => {
    const { q, offsets } = mountLocal({ ancestorScrollable: true, localPriority: true });
    const event = wheelOn(q("fmt-bar"), { deltaY: 120, clientX: 600, clientY: 175 });
    expect(offsets.ta, "计划页 .apply-detail 包住编辑器 ⇒ 代码浮层滚的是外层面板而不是 textarea").toBe(120);
    expect(event.defaultPrevented).toBe(true);
    expect(synced, "写完偏移要当帧同步行号层与高亮层").toBe(1);

    const closed = mountLocal({ ancestorScrollable: true });
    const pageRootEvent = wheelOn(closed.q("fmt-bar"), { deltaY: 120, clientX: 600, clientY: 175 });
    expect(closed.offsets.ta, "页面根不许开 localPriority：硬闸门照旧，外层面板的原生滚动不能抢").toBe(0);
    expect(pageRootEvent.defaultPrevented).toBe(false);
  });

  it("G2 只是包裹本组件的弹框让位；真滚动区（下拉/消息流）与弹框内部子树都不让", () => {
    const inModal = mountLocal({ hostWrapper: "modal", localPriority: true });
    const modalEvent = wheelOn(inModal.q("fmt-bar"), { deltaY: 120, clientX: 600, clientY: 175 });
    expect(inModal.offsets.ta, "「新建配置」弹框里的查找条又退回纯死区").toBe(120);
    expect(modalEvent.defaultPrevented).toBe(true);

    const inMenu = mountLocal({ hostWrapper: "selmenu", localPriority: true });
    const menuEvent = wheelOn(inMenu.q("fmt-bar"), { deltaY: 120, clientX: 600, clientY: 175 });
    expect(inMenu.offsets.ta, "本组件被塞进下拉这种真滚动区：落点压在谁身上归谁滚，正文不许抢").toBe(0);
    expect(menuEvent.defaultPrevented).toBe(false);

    const denyInside = mountLocal({ localPriority: true, denyInside: true });
    const insideEvent = wheelOn(denyInside.q("inline-deny-header"), { deltaY: 120, clientX: 600, clientY: 925 });
    expect(denyInside.offsets.ta, "黑名单子树在自己内部（不是包裹本组件）时永远不接管：弹框里别的区域被顺带滚一下更糟").toBe(0);
    expect(insideEvent.defaultPrevented).toBe(false);
  });

  it("落点在正文自身里面永远放手：caret、选区、惯性都靠原生滚动", () => {
    const { q, ta, offsets } = mountLocal({ ancestorScrollable: true, localPriority: true });
    const event = wheelOn(q("caret-line"), { deltaY: 120, clientX: 600, clientY: 320 });
    expect(offsets.ta, "兜底改写正文自己的偏移：原生惯性与选区跟随全废").toBe(0);
    expect(event.defaultPrevented, "正文上的滚轮必须留给原生").toBe(false);
    expect(synced).toBe(0);
    expect(ta.contains(q("caret-line"))).toBe(true);
  });
});

describe("useWheelSurface：登记的是引用，不是登记那一刻的节点", () => {
  function Probe({ shown, nodeKey }: { shown: boolean; nodeKey?: string }): ReactElement {
    const ref = useRef<HTMLDivElement>(null);
    const sync = useCallback(() => undefined, []);
    useWheelSurface(ref, { syncScroll: sync, rowHeight: ROW_H });
    return (
      <div>
        {shown ? <div ref={ref} data-testid="surface-node" key={nodeKey} /> : null}
        <button data-testid="toggle" type="button" />
      </div>
    );
  }

  it("节点在登记之后才挂出来（条件渲染）也必须生效", () => {
    // 轮33 F-34 差点踩的就是这个：批量态左列、匹配态两列表、切文件后的正文，
    // 都是「组件挂载 → effect 登记 → 之后才渲染出节点」的形状，
    // 登记表若抄下当时的 null，这些页面整片还是死区，而且一声不响。
    const view = render(<Probe shown={false} />);
    expect(wheelSurfacesWithin(document.body), "节点还没挂出来，表里不该有能投的靶子").toHaveLength(0);

    act(() => view.rerender(<Probe shown nodeKey="n1" />));
    const node = view.container.querySelector('[data-testid="surface-node"]') as HTMLElement;
    const listed = wheelSurfacesWithin(document.body);
    expect(
      listed.some((e) => e.el === node),
      "登记时抄的是当时的 ref.current（null）：节点后来挂出来也永远收不到滚轮"
    ).toBe(true);
    expect(listed[0].rowHeight, "换算基数要跟着登记走").toBe(ROW_H);
    expect(listed[0].syncScroll, "当帧同步要跟着登记走").toBeTypeOf("function");

    act(() => view.rerender(<Probe shown nodeKey="n2" />));
    const second = view.container.querySelector('[data-testid="surface-node"]') as HTMLElement;
    expect(second).not.toBe(node);
    const afterSwap = wheelSurfacesWithin(document.body);
    expect(
      afterSwap.some((e) => e.el === node),
      "旧节点还能被投：兜底会把滚轮交给一块已经不存在的容器"
    ).toBe(false);
    expect(afterSwap).toHaveLength(1);

    view.unmount();
    expect(wheelSurfacesWithin(document.body), "卸载没注销：登记表攒出一串死引用").toHaveLength(0);
  });
});
