// 代码视图的横向假布局（单测专用）。
//
// 为什么需要：jsdom 没有布局引擎，getBoundingClientRect 恒为 0、clientWidth / scrollWidth 恒为 0。
// 于是「按命中 <mark> 的实际矩形做水平定位」（src/lib/codeScroll.ts）这条真实路径在单测里
// 永远只走「量不到就别动」的分支——写多少断言都测不到真行为。
// 这里补一层最小假布局：横向按「每字符 charWidth 像素、整篇文本从 x=0 起排」给 mark 算矩形，
// 再把滚动容器的横向尺寸撑出来。纵向不需要：行网格本来就是组件里的 PAD_TOP + i * ROW_H 常量算的。
//
// 打桩用 vi.spyOn，src/test/react.ts 的 afterEach 里 vi.restoreAllMocks() 会自动收回，
// 用例之间不会互相残留。

import { vi } from "vitest";

export interface FakeLayoutOptions {
  /** 每个字符的假宽度（px）。 */
  charWidth?: number;
  /** 滚动容器可视宽（px）。 */
  viewportWidth?: number;
  /** 滚动内容总宽（px）：必须大于 viewportWidth，否则「没有横向溢出」本来就不该动。 */
  contentWidth?: number;
}

/** 挂在容器上的横向滚动状态：jsdom 里 scrollLeft 是只读常量 0，得自己换成可读写。 */
export interface FakeScroll {
  get(): number;
  set(value: number): void;
}

export function stubScrollLeft(el: HTMLElement): FakeScroll {
  const state = { left: 0 };
  Object.defineProperty(el, "scrollLeft", {
    configurable: true,
    get: () => state.left,
    set: (value: number) => {
      state.left = value;
    },
  });
  return {
    get: () => state.left,
    set: (value: number) => {
      state.left = value;
    },
  };
}

/** 文本节点遍历：某元素在整篇文本里的起始字符数（与命中偏移同一口径）。 */
function textOffsetOf(root: HTMLElement, target: Element): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let count = 0;
  let node: Node | null = walker.nextNode();
  while (node) {
    if (target.contains(node)) return count;
    count += node.nodeValue?.length ?? 0;
    node = walker.nextNode();
  }
  return -1;
}

/**
 * 给一对「滚动容器 + 承载 mark 的元素」挂上假布局。
 *
 * @param scroller 写 scrollLeft 的那一层（浏览态 .code-area / 编辑态 textarea）
 * @param marksRoot 命中 <mark> 所在、且文本与正文逐字相等的那一层（浏览态同上 / 编辑态高亮层 pre）
 */
export function stubCodeHorizontalLayout(scroller: HTMLElement, marksRoot: HTMLElement, options: FakeLayoutOptions = {}): FakeScroll {
  const charWidth = options.charWidth ?? 8;
  const viewportWidth = options.viewportWidth ?? 800;
  const contentWidth = options.contentWidth ?? 8000;
  const scroll = stubScrollLeft(scroller);
  Object.defineProperty(scroller, "clientWidth", { configurable: true, get: () => viewportWidth });
  Object.defineProperty(scroller, "scrollWidth", { configurable: true, get: () => contentWidth });

  const original = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.classList?.contains("search-hit")) {
      const start = textOffsetOf(marksRoot, this);
      if (start >= 0) {
        // 真浏览器的 rect.left 是**视口相对**的，已经减掉过一次横向滚动偏移；
        // lib 拿它加回 scrollLeft 换内容坐标。桩成内容坐标就等于测了个假几何
        // （本轮在 codeScroll.test.ts 里踩过，同一条坑写在这里免得组件级用例再踩）。
        const left = start * charWidth - scroller.scrollLeft;
        const width = (this.textContent?.length ?? 0) * charWidth;
        return { ...original.call(this), left, right: left + width, width, top: 0, bottom: 20, height: 20, x: left, y: 0 };
      }
    }
    return original.call(this);
  });

  return scroll;
}

/**
 * 命中是否完整落在横向视口里（与 lib 的可见性判据同一口径，断言用它而不是抄第二份边距常量）。
 *
 * 全程用视口坐标比较：jsdom 没有布局，容器自己的 rect 恒为 0，
 * 所以「视口相对」与「相对容器」在这里是同一个数，不必再加 scrollLeft（加了反而歪）。
 */
export function isMarkVisible(scroller: HTMLElement, mark: HTMLElement, margin: number): boolean {
  const inset = Math.min(margin, Math.floor(scroller.clientWidth / 2));
  const rect = mark.getBoundingClientRect();
  return rect.left >= inset && rect.right <= scroller.clientWidth - inset;
}
