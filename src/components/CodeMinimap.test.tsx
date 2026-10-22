/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render } from "../test/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { padTopForFindBar } from "../lib/codeScroll";
import CodeMinimap, { MINIMAP_W } from "./CodeMinimap";

/**
 * 缩略图自己的测试（轮31 F-27 起）。
 *
 * 三轮以来**画布那条路径一次都没被执行过**：jsdom 里 `canvas.clientWidth` 恒 0，绘制 effect
 * 第一行就 return，`getContext` 根本没被调。结果是「桶表算对了、位置画错了」这种缺陷
 * 一条测试都拦不住——而画错位置正是缩略图唯一的用途（点了要落到那一行）会坏的方式。
 * 这里把 `getContext` 换成记录 `fillRect` 的假上下文，再量一次尺寸，让「画上去的 y」
 * 第一次变成可断言的输出。
 *
 * 只测 CodeMinimap 本身，不经两个视图：几何全由这里桩出来，两个视图的接线由
 * CodeView.test.tsx / CodeEditor.test.tsx 各自负责。
 */

// ---- 假几何（和正文真实形状同构，不是随手取的整数）----
const LINE_COUNT = 40;
const ROW_H = 20; // 与两个视图的 ROW_H 同值
const PAD_TOP = padTopForFindBar(6, true, 58); // 查找栏开着时的顶部净空，走真公式不抄第二个数
const PAD_BOTTOM = 12; // .code-editor-ta 的下留白
/** 正文滚动内容的总高：第 L 行的 top = PAD_TOP + L*ROW_H，scrollHeight 还要加底部留白。 */
const CONTENT_H = PAD_TOP + LINE_COUNT * ROW_H + PAD_BOTTOM;
const VIEWPORT_H = 300;
const MM_H = 200;

const LINES = Array.from({ length: LINE_COUNT }, (_, i) => `key${i} = value${i}`);

/** 按正文像素算，第 startLine 行在缩略图上该画在哪、画多高（AC1 的那把尺）。 */
function expectedBarY(startLine: number): number {
  return ((PAD_TOP + startLine * ROW_H) / CONTENT_H) * MM_H;
}
/** 同一分母下的条高：一桶覆盖 1 行时就是 rowHeight/contentH*画布高，再减桶间缝。 */
const EXPECTED_BAR_H = (ROW_H / CONTENT_H) * MM_H - 0.5;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  fillStyle: string;
}

function installFakeCanvas(rects: Rect[]) {
  const ctx = {
    fillStyle: "",
    setTransform: () => {},
    clearRect: () => {},
    fillRect: (x: number, y: number, w: number, h: number) => {
      rects.push({ x, y, w, h, fillStyle: ctx.fillStyle });
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
}

/** jsdom 的 getBoundingClientRect 恒给全 0，点击映射得自己有高度（CodeView.test.tsx 同款桩）。 */
function stubMinimapRect(mm: HTMLElement, top: number, height: number) {
  mm.getBoundingClientRect = () =>
    ({ top, height, bottom: top + height, left: 0, right: MINIMAP_W, width: MINIMAP_W, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
}

/** 全局 ResizeObserver 替身：返回「触发所有已登记的回调」，让我们能手动量一次尺寸。 */
function stubResizeObserver() {
  const registered: Array<() => void> = [];
  class FakeRO {
    constructor(cb: () => void) {
      registered.push(cb);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", FakeRO);
  return () => registered.forEach((cb) => cb());
}

/**
 * 一个可当滚动容器用的假元素 + 可读写 scrollTop。
 *
 * `jumpFromPointer` 读写的都是 containerRef 上的真几何（scrollHeight / clientHeight / scrollTop），
 * 而 metrics 是视图 measured 后递下来的同一份——这里刻意让两边取同一个 state，
 * 免得起「测试自己造出两套事实」那种假通过。
 */
function fakeScrollContainer(scrollTop: number) {
  const state = { top: scrollTop, scrollHeight: CONTENT_H, clientHeight: VIEWPORT_H };
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => state.top,
    set: (value: number) => {
      state.top = value;
    },
  });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => state.scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => state.clientHeight });
  return { el, state };
}

function mountMinimap(opts: {
  hits?: number[];
  currentLine?: number | null;
  scrollTop?: number;
  /** 传给组件的 measured 几何；不给就跟着容器走（首帧「量不到」的用例要显式给 0）。 */
  metrics?: { scrollTop: number; scrollHeight: number; clientHeight: number };
  lines?: string[];
}) {
  const rects: Rect[] = [];
  installFakeCanvas(rects);
  const fire = stubResizeObserver();

  const lines = opts.lines ?? LINES;
  const scroll = fakeScrollContainer(opts.scrollTop ?? 0);
  const metrics = opts.metrics ?? {
    scrollTop: scroll.state.top,
    scrollHeight: scroll.state.scrollHeight,
    clientHeight: scroll.state.clientHeight,
  };
  const syncScroll = vi.fn();

  const { container } = render(
    <I18nProvider>
      <CodeMinimap
        containerRef={{ current: scroll.el }}
        syncScroll={syncScroll}
        lines={lines}
        hitLineArray={opts.hits ?? []}
        currentLine={opts.currentLine ?? null}
        metrics={metrics}
        rowHeight={ROW_H}
        padTop={PAD_TOP}
      />
    </I18nProvider>
  );

  const mm = container.querySelector(".code-minimap") as HTMLElement;
  expect(mm, "内容能滚时缩略图必须渲染出来").toBeTruthy();
  Object.defineProperty(mm, "clientWidth", { configurable: true, get: () => MINIMAP_W });
  Object.defineProperty(mm, "clientHeight", { configurable: true, get: () => MM_H });
  stubMinimapRect(mm, 0, MM_H);

  // 挂载那一次量到的是 jsdom 的 0×0，绘制被跳过；补好尺寸后手动触发一次 measure
  expect(rects, "没量到尺寸时不该画（这条前置如果变了，下面的用例全在空转）").toHaveLength(0);
  act(() => {
    fire();
  });
  return { mm, rects, container, scroll, syncScroll, metrics };
}

/** 一个桶可能被画两次（代码色 + 命中红），按 y 归并成「一条桶」再按位置排序。 */
function drawnBars(rects: Rect[]): Rect[] {
  const byY = new Map<number, Rect>();
  for (const r of rects) byY.set(Number(r.y.toFixed(6)), r);
  return [...byY.values()].sort((a, b) => a.y - b.y);
}

/** 记录元素上真实挂出的 wheel 监听（含第三个参数），用来钉 passive:false。 */
function spyWheelRegistrations() {
  const entries: Array<{ target: EventTarget; options: AddEventListenerOptions | boolean | undefined }> = [];
  const original = Element.prototype.addEventListener;
  vi.spyOn(Element.prototype, "addEventListener").mockImplementation(function (
    this: Element,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean
  ) {
    if (type === "wheel") entries.push({ target: this, options });
    return original.call(this, type, listener, options);
  });
  return entries;
}

/**
 * jsdom 的 fireEvent.wheel 造出来的事件读不到 deltaY（testing-library 的初始化不带这几个字段），
 * 所以这里直接构造 WheelEvent——deltaMode 也要能带进去（行 / 页模式是这轮要断言的东西）。
 */
function wheelOn(target: EventTarget, init: WheelEventInit): WheelEvent {
  const event = new WheelEvent("wheel", { cancelable: true, bubbles: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe("CodeMinimap 画条的尺子（轮31 F-27）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("每一个桶都按正文像素画，不再按行序号比例", () => {
    const { rects } = mountMinimap({ hits: [20], currentLine: 20 });
    const bars = drawnBars(rects);
    expect(bars, "40 行 / 每行一桶，画布上就该有 40 条").toHaveLength(LINE_COUNT);
    for (let r = 0; r < LINE_COUNT; r += 1) {
      // 旧实现：y = (startLine / lines.length) * height —— 差一个 PAD_TOP，越短的文件偏得越多
      expect(bars[r].y, `第 ${r} 行的条画歪了（行序号尺 vs 正文像素尺）`).toBeCloseTo(expectedBarY(r), 4);
      expect(bars[r].h, `第 ${r} 行的条高没用同一个分母`).toBeCloseTo(EXPECTED_BAR_H, 4);
    }
    // 第 0 行的条必须留出顶部净空：贴着画布顶端 = 还在用行序号尺
    expect(bars[0].y, "顶部净空没体现在画上：查找栏一开，图和正文就错开一整段").toBeGreaterThan(0);
  });

  it("命中行画两条（代码色 + 红），红条和代码条同一个位置", () => {
    const { rects } = mountMinimap({ hits: [20], currentLine: 20 });
    const hitBar = drawnBars(rects)[20];
    const doubled = rects.filter((r) => Math.abs(r.y - hitBar.y) < 1e-6);
    expect(doubled, "命中桶没被画第二遍，红条根本不存在").toHaveLength(2);
    expect(new Set(doubled.map((r) => r.fillStyle)).size, "两遍用了同一个颜色，红色没落地").toBe(2);
  });

  it("完全在视口里的一行，它的条必须落在视口框内", () => {
    // scrollTop=400：视口盖住内容 400~700px，第 17 行（412~432）整条可见
    const scrollTop = 400;
    const { rects, mm } = mountMinimap({ hits: [17], currentLine: 17, scrollTop });
    const frame = mm.querySelector(".code-minimap-viewport") as HTMLElement;
    expect(frame, "视口框没渲染").toBeTruthy();
    // 框按像素算（top = scrollTop/contentH），旧实现第 17 行的条画在 85px，而框从 90.5px 才开始
    const frameTopPx = (scrollTop / CONTENT_H) * MM_H;
    const frameBottomPx = ((scrollTop + VIEWPORT_H) / CONTENT_H) * MM_H;
    const bar = drawnBars(rects)[17];
    expect(frameTopPx, "这一例要的就是「可见行」，行落在框外的几何就没意义了").toBeLessThan(frameBottomPx);
    expect(bar.y + bar.h, "整条都在视口里的行，红条画在框外：框按像素、条按行号，两把尺").toBeCloseTo(expectedBarY(17) + EXPECTED_BAR_H, 4);
    expect(bar.y, "可见行的红条必须落在视口框内").toBeGreaterThanOrEqual(frameTopPx);
    expect(bar.y + bar.h, "可见行的红条不许越过视口框下沿").toBeLessThanOrEqual(frameBottomPx);
  });

  it("点画出来的那条红条的中心，必须把那一行送到视口中线（±0.5 行）", () => {
    const { rects, mm, scroll, syncScroll } = mountMinimap({ hits: [20], currentLine: 20 });
    const bar = drawnBars(rects)[20];
    // 点的是**实际画出来的**中心：画和跳只要不是同一把尺，这一步就落偏
    fireEvent.pointerDown(mm, { clientY: bar.y + bar.h / 2, pointerId: 1 });
    const lineCenterInContent = PAD_TOP + 20 * ROW_H + ROW_H / 2;
    const landedCenter = scroll.state.top + VIEWPORT_H / 2;
    expect(scroll.state.top, "点了缩略图没滚正文").toBeGreaterThan(0);
    expect(Math.abs(landedCenter - lineCenterInContent), "点第 20 行的条，第 20 行没落在视口中线附近").toBeLessThanOrEqual(ROW_H / 2);
    expect(syncScroll, "写完 scrollTop 必须当帧补同步（轮30 F-20 不变式）").toHaveBeenCalled();
  });

  it("量不到几何的首帧：用兜底分母画，不许出现 NaN", () => {
    const unmeasured = { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
    const { rects } = mountMinimap({ hits: [20], currentLine: 20, metrics: unmeasured });
    const bars = drawnBars(rects);
    expect(bars, "量不到 scrollHeight 时桶表照旧，画布也得照旧有东西").toHaveLength(LINE_COUNT);
    for (const bar of bars) {
      expect(Number.isFinite(bar.y), "除以没量到的 scrollHeight：画上去的是 NaN").toBe(true);
      expect(Number.isFinite(bar.h) && bar.h >= 1, "条高兜底丢了（<1px 的条子读不出来）").toBe(true);
    }
    for (let r = 1; r < bars.length; r += 1) {
      expect(bars[r].y, "桶序不能倒着画").toBeGreaterThan(bars[r - 1].y);
    }
  });
});

describe("CodeMinimap 不挂自己的滚轮监听（轮33 F-34：出口收进宿主的兜底根）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * 轮31 F-25 那条结论没丢——「滚轮落在缩略图那 66px 上 ⇒ 滚正文」现在由宿主兜底负责，
   * 逐点复跑在 src/components/CodeView.test.tsx「拖缩略图的当帧同步」与
   * src/components/CodeEditor.test.tsx「右侧缩略图」两组里（含 deltaMode=1 那一格）；
   * 换算/夹界/放手在 src/lib/useWheelColumnResolver.test.tsx。
   *
   * 这里改钉的是所有权边界：缩略图自己一份监听都不许挂。页面级兜底已经会处理这块落点，
   * 组件再挂一份就是同一格滚两遍（双滚），而且那份监听挂在会随「不满一屏」消失又重建的节点上，
   * 正是轮33 抓出来的静默失活形状。
   */
  it("孤立渲染（没有宿主兜底根）时，缩略图上的滚轮一格都不该动正文", () => {
    const { mm, scroll, syncScroll } = mountMinimap({ scrollTop: 200 });
    const event = wheelOn(mm, { deltaY: 100, deltaMode: 0 });

    expect(scroll.state.top, "缩略图自己还在处理滚轮：出口没收干净").toBe(200);
    expect(event.defaultPrevented, "没人接管就不许取消默认动作，取消了外层面板就滚不动了").toBe(false);
    expect(syncScroll, "没写偏移就不该当帧补同步").not.toHaveBeenCalled();
  });

  it("一份 wheel 监听都不挂（React 的 onWheel 也不算：它是 passive 的，preventDefault 无效）", () => {
    const registrations = spyWheelRegistrations();
    const { mm } = mountMinimap({ scrollTop: 200 });

    expect(
      registrations.filter((entry) => entry.target === mm),
      "缩略图挂出了自己的滚轮监听，兜底根那份和它必然打架"
    ).toHaveLength(0);
    // JSX 里有没有写 onWheel 由 tests/ux/wheelFallbackWiring.test.ts 静态钉（React 的 onWheel 不落到属性上，这里查不出来）
  });

  it("重挂新节点也带不出监听：内容不满一屏收起再回来，出口不靠节点身份", () => {
    const registrations = spyWheelRegistrations();
    const { mm } = mountMinimap({ scrollTop: 200 });
    const { mm: second } = mountMinimap({ scrollTop: 0 });

    expect(second, "换了节点才看得出「监听是抄在旧节点上」").not.toBe(mm);
    expect(
      registrations.filter((entry) => entry.target === mm || entry.target === second),
      "新旧节点上都不许有滚轮监听"
    ).toHaveLength(0);
  });
});

describe("CodeMinimap 点完之后的焦点（轮31 F-26）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * 证据边界（PRD 里写明的口径）：jsdom 不实现「点击改焦点」，所以焦点丢失这一步在单测里测不出来。
   * 能测、也正是我们要钉的那一步是**有没有取消引发它的那个默认动作**：按 Pointer Events 规范，
   * `pointerdown` 被取消后兼容的 `mousedown` 不再派发，而 `mousedown` 正是浏览器改焦点的那一步。
   * fireEvent 返回的是 dispatchEvent 的结果——调过 preventDefault 就是 false。
   */
  it("点缩略图取消 pointerdown 的默认动作，跳行照旧", () => {
    const { mm, scroll, syncScroll } = mountMinimap({ scrollTop: 200 });
    const notCancelled = fireEvent.pointerDown(mm, { clientY: 100, pointerId: 1 });
    expect(notCancelled, "pointerdown 没取消：mousedown 照发，textarea 失焦（打字无效、Ctrl+S 不再被接管）").toBe(false);
    expect(scroll.state.top, "取消默认动作不能把跳行一起取消掉").toBeGreaterThan(200);
    expect(syncScroll, "写完 scrollTop 必须当帧补同步").toHaveBeenCalled();
  });

  it("拖动过程中每一下都不留焦点尾巴：pointermove / pointerup 不许把默认动作吃掉", () => {
    const { mm, scroll } = mountMinimap({ scrollTop: 200 });
    expect(fireEvent.pointerDown(mm, { clientY: 60, pointerId: 1, buttons: 1 }), "按下必须取消").toBe(false);
    const before = scroll.state.top;
    expect(fireEvent.pointerMove(mm, { clientY: 140, pointerId: 1, buttons: 1 }), "拖动不该取消默认动作（它本来没有默认动作）").toBe(true);
    expect(scroll.state.top, "拖动没跟着走").not.toBe(before);
    expect(fireEvent.pointerUp(mm, { clientY: 140, pointerId: 1 }), "抬起不该取消默认动作").toBe(true);
  });

  it("缩略图自己不许做成可聚焦元素（焦点只能留在正文/编辑区）", () => {
    const { mm } = mountMinimap({ scrollTop: 200 });
    expect(mm.hasAttribute("tabindex"), "给缩略图加 tabIndex 等于把焦点从键盘层手里抢走").toBe(false);
    expect(mm.tabIndex, "div 默认 tabIndex 是 -1，任何 >=0 都意味着它能进 Tab 序列").toBeLessThan(0);
    expect(mm.getAttribute("contenteditable"), "缩略图不是编辑面").toBeNull();
  });
});

describe("CodeMinimap 只认主按钮（轮32 F-31）", () => {
  /**
   * 缺陷长什么样：`onPointerDown` 无条件 `preventDefault()` + 跳行，没看 `e.button`。
   * 于是右键落在缩略图上先跳一次行，再因为 pointerdown 被取消而不弹上下文菜单（在正文别处右键是有的）；
   * 中键「按下即粘贴（X11 primary）/ Windows 自动滚动」同样被吞掉并误跳行。
   * 触屏与触控笔的 `button` 也是 0，所以修法只认主按钮，不误伤指针输入。
   */
  it("右键既不跳行，也不取消 pointerdown（菜单还要靠它前面的那一步）", () => {
    const { mm, scroll, syncScroll } = mountMinimap({ scrollTop: 200 });
    const before = scroll.state.top;
    expect(
      fireEvent.pointerDown(mm, { clientY: 100, pointerId: 1, button: 2, buttons: 2 }),
      "右键的 pointerdown 被取消：兼容的 mousedown 不再派发，上下文菜单弹不出来"
    ).toBe(true);
    expect(scroll.state.top, "右键也跳了行：只是想弹个菜单，正文先跳走了").toBe(before);
    expect(syncScroll, "右键这一路不该写偏移").not.toHaveBeenCalled();
  });

  it("中键同样既不跳行也不取消", () => {
    const { mm, scroll, syncScroll } = mountMinimap({ scrollTop: 200 });
    const before = scroll.state.top;
    expect(fireEvent.pointerDown(mm, { clientY: 100, pointerId: 1, button: 1, buttons: 4 }), "中键被吞掉了").toBe(true);
    expect(scroll.state.top, "中键也跳了行").toBe(before);
    expect(syncScroll).not.toHaveBeenCalled();
  });

  it("右键按下之后的 pointermove 不许变成拖动", () => {
    const { mm, scroll } = mountMinimap({ scrollTop: 200 });
    fireEvent.pointerDown(mm, { clientY: 60, pointerId: 1, button: 2, buttons: 2 });
    const before = scroll.state.top;
    fireEvent.pointerMove(mm, { clientY: 140, pointerId: 1, buttons: 2 });
    expect(scroll.state.top, "右键按着不动也算拖动：draggingRef 只许主按钮置位").toBe(before);
  });

  it("主按钮、触屏、触控笔都照旧跳行（button 都是 0，修法不误伤指针输入）", () => {
    for (const [label, init] of [
      ["鼠标左键", { pointerType: "mouse", button: 0, buttons: 1 }],
      ["单指", { pointerType: "touch", button: 0, buttons: 1 }],
      ["触控笔", { pointerType: "pen", button: 0, buttons: 1 }],
    ] as Array<[string, PointerEventInit]>) {
      const { mm, scroll, syncScroll } = mountMinimap({ scrollTop: 200 });
      expect(fireEvent.pointerDown(mm, { clientY: 100, pointerId: 1, ...init }), `${label}：默认动作该被取消`).toBe(false);
      expect(scroll.state.top, `${label}：跳行被一起挡掉了`).toBeGreaterThan(200);
      expect(syncScroll, `${label}：写完 scrollTop 必须当帧补同步`).toHaveBeenCalled();
    }
  });
});

describe("CodeMinimap 换屏 / 改缩放之后必须重画（轮32 F-32）", () => {
  /**
   * 缺陷长什么样：`devicePixelRatio` 在绘制 effect 内部读，依赖表里没有它，全库也没有任何 dpr 订阅。
   * 于是拖到另一台屏、改系统缩放之后，画布的物理像素还是按旧 dpr 摆的，与 CSS 尺寸失配 ⇒
   * 整条缩略图发糊/拉伸，直到别的原因（正文变长、查找栏开合）恰好触发重画才自愈。
   */
  function stubDpr(initial: number) {
    const box = { value: initial };
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => box.value });
    const queries: string[] = [];
    const listeners: Array<() => void> = [];
    vi.stubGlobal("matchMedia", (query: string) => {
      queries.push(query);
      return {
        media: query,
        matches: false,
        addEventListener: (_type: string, cb: () => void) => listeners.push(cb),
        removeEventListener: () => {},
      };
    });
    return {
      box,
      queries,
      fireChange: () => [...listeners].forEach((cb) => cb()),
      listenerCount: () => listeners.length,
    };
  }

  it("dpr 变了当帧按新 dpr 重画，不用等别的原因触发", () => {
    const dpr = stubDpr(1);
    const { mm, rects } = mountMinimap({ hits: [20], currentLine: 20 });
    const canvas = mm.querySelector("canvas") as HTMLCanvasElement;
    expect(dpr.listenerCount(), "没有捕获到 dpr 的 change 监听：这条守卫在空转").toBeGreaterThan(0);
    expect(canvas.width, "dpr=1 时画布宽应等于 CSS 宽").toBe(MINIMAP_W);
    const painted = rects.length;
    expect(painted, "没画东西，下面的重画断言是空转").toBeGreaterThan(0);

    rects.length = 0;
    act(() => {
      dpr.box.value = 2;
      dpr.fireChange();
    });
    expect(canvas.width, "换屏后画布还按旧 dpr 摆物理像素：整条图发糊").toBe(MINIMAP_W * 2);
    expect(rects.length, "dpr 变化没触发重画（依赖表里根本没有 dpr）").toBe(painted);
    // 订阅的 query 里写的是当前 dpr：不跟着换，下一次跨档就没人通知了
    expect(dpr.queries[dpr.queries.length - 1], "换档之后订阅还挂在旧 dpr 那条 media 上").toContain("2");
  });

  it("没有 matchMedia 的老 WebView：一次性读取，不抛错也不阻塞绘制", () => {
    vi.stubGlobal("matchMedia", undefined);
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => 3 });
    const { mm, rects } = mountMinimap({ hits: [20], currentLine: 20 });
    const canvas = mm.querySelector("canvas") as HTMLCanvasElement;
    expect(rects.length, "读不到 matchMedia 就把绘制整条废掉是回归").toBeGreaterThan(0);
    expect(canvas.width, "兜底路径也要按 dpr=3 摆画布").toBe(MINIMAP_W * 3);
  });
});

describe("CodeMinimap 的辅助技术语义（轮66 WP-7）", () => {
  beforeEach(() => {
    // 本文件其余用例不断文案，这一组要念出名字与位置，显式钉住中文，免得跟着 jsdom 的 navigator.language 漂
    localStorage.setItem("locale", "zh-CN");
  });

  /**
   * 缺陷长什么样：这条控件只有 pointer 事件，在辅助技术里是「一个 66×N 的无名方块」——
   * 读屏既念不出它是什么，也念不出它此刻指向哪一行，而这恰好是它的唯一信息量。
   * 口径：按它实际是什么声明（抽象滚动条），值给视口百分比，valuetext 直接念行号。
   */
  it("念得出「这是什么」和「此刻在第几行」", () => {
    // 正文第 20 行（0 起）的顶边对齐视口上缘 ⇒ 行号层念 21
    const { mm } = mountMinimap({ scrollTop: PAD_TOP + 20 * ROW_H });
    expect(mm).toHaveAttribute("role", "scrollbar");
    expect(mm).toHaveAttribute("aria-orientation", "vertical");
    expect(mm).toHaveAccessibleName("缩略图");
    expect(mm.getAttribute("aria-valuetext")).toContain("第 21 行");
    expect(mm.getAttribute("aria-valuetext")).toContain(`共 ${LINE_COUNT} 行`);
    expect(mm).toHaveAttribute("aria-valuemin", "0");
    expect(mm).toHaveAttribute("aria-valuemax", "100");
    expect(Number(mm.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
    // 画布与视口框是纯视觉的，不再重复播报一遍
    expect(mm.querySelector("canvas")).toHaveAttribute("aria-hidden", "true");
    expect(mm.querySelector(".code-minimap-viewport")).toHaveAttribute("aria-hidden", "true");
  });

  it("键盘滚动仍归正文那层：缩略图不是第二个 Tab 停靠点", () => {
    const { mm } = mountMinimap({ scrollTop: PAD_TOP + 20 * ROW_H });
    // 挂 tabIndex 会把焦点从 .code-area / textarea 抢走，方向键与 PageUp/PageDown 当场失效
    // （pointerdown 里那句 preventDefault 就是为同一件事，见本文件顶部与 CodeView.tsx）
    expect(mm).not.toHaveAttribute("tabindex");
  });

  it("量不到几何的首帧不念假行号，也不谎报位置", () => {
    const { mm } = mountMinimap({ metrics: { scrollTop: 0, scrollHeight: 0, clientHeight: 0 } });
    expect(mm.getAttribute("aria-valuetext")).toBeNull();
    expect(mm).toHaveAttribute("aria-valuenow", "0");
  });
});
