/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render } from "../test/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
