/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FIND_BAR_FALLBACK_HEIGHT,
  FIND_BAR_GAP,
  FIND_BAR_TOP,
  HIT_REVEAL_MARGIN,
  measureFindBarHeight,
  neededScrollLeftForMark,
  neededScrollTopToCenter,
  padTopForFindBar,
  revealMarkHorizontally,
  revealRowVertically,
} from "./codeScroll";

function rect(left: number, width: number): DOMRect {
  return {
    left,
    right: left + width,
    width,
    top: 0,
    bottom: 20,
    height: 20,
    x: left,
    y: 0,
    toJSON: () => "",
  } as DOMRect;
}

describe("neededScrollLeftForMark：命中该送到哪个横向偏移", () => {
  const base = { markWidth: 80, clientWidth: 800, scrollWidth: 8000, margin: HIT_REVEAL_MARGIN };

  it("命中在视口右侧之外：按「刚好露出 + 边距」位移，不居中", () => {
    const next = neededScrollLeftForMark({ ...base, markLeft: 4000, scrollLeft: 0 });
    expect(next).toBe(4080 - 800 + HIT_REVEAL_MARGIN);
  });

  it("命中在视口左侧之外：露出左缘 + 边距", () => {
    const next = neededScrollLeftForMark({ ...base, markLeft: 100, scrollLeft: 3000 });
    expect(next).toBe(100 - HIT_REVEAL_MARGIN);
  });

  it("命中已完整可见时返回 null：用户自己滚开的位置不许被拽回来", () => {
    expect(neededScrollLeftForMark({ ...base, markLeft: 3400, scrollLeft: 3300 })).toBeNull();
  });

  it("贴着视口边缘的一半可见也算看不见：要动就动到完整露出", () => {
    // markRight = 810 > scrollLeft + clientWidth - margin = 776
    const next = neededScrollLeftForMark({ ...base, markLeft: 730, scrollLeft: 0 });
    expect(next).toBe(810 - 800 + HIT_REVEAL_MARGIN);
  });

  it("没有横向溢出时返回 null：整行本来就全看得见", () => {
    expect(neededScrollLeftForMark({ ...base, scrollWidth: 800, clientWidth: 800, markLeft: 100, scrollLeft: 0 })).toBeNull();
  });

  it("量不到（宽度 0 / 视口 0 / 非有限数）一律返回 null：动就是把用户已有偏移清掉", () => {
    expect(neededScrollLeftForMark({ ...base, markWidth: 0, markLeft: 4000, scrollLeft: 0 })).toBeNull();
    expect(neededScrollLeftForMark({ ...base, clientWidth: 0, markLeft: 4000, scrollLeft: 0 })).toBeNull();
    expect(neededScrollLeftForMark({ ...base, markLeft: Number.NaN, scrollLeft: 0 })).toBeNull();
    expect(neededScrollLeftForMark({ ...base, scrollLeft: Number.NaN, markLeft: 4000 })).toBeNull();
  });

  it("结果夹在 [0, scrollWidth - clientWidth] 内：两端都不许溢出", () => {
    expect(neededScrollLeftForMark({ ...base, markLeft: -40, scrollLeft: 500 })).toBe(0);
    expect(neededScrollLeftForMark({ ...base, markLeft: 7900, scrollLeft: 0 })).toBe(8000 - 800);
  });

  it("超窄容器（边距比半个视口还宽）不来回抖：第二次基于第一次结果就判为已可见", () => {
    const narrow = { markWidth: 80, clientWidth: 30, scrollWidth: 8000, markLeft: 4000, scrollLeft: 0, margin: HIT_REVEAL_MARGIN };
    const first = neededScrollLeftForMark(narrow);
    expect(first).not.toBeNull();
    expect(neededScrollLeftForMark({ ...narrow, scrollLeft: first! })).toBeNull();
  });
});

/**
 * 手写一棵最小 DOM：滚动容器 + 命中标记。
 *
 * marks[].left 用**内容坐标**写（第 4000 列那种），但桩出来的矩形必须是**视口相对**的
 * ——真浏览器里 getBoundingClientRect 的 left 已经减掉了一次 scrollLeft，
 * lib 为了拿内容坐标会再加回来。桩成内容坐标就等于测了个假几何：
 * 凡是 scrollLeft != 0 的用例全歪（本轮踩过，故写在纸上）。
 */
function buildDoc(marks: Array<{ cls: string; left: number; width: number }>) {
  const scroller = document.createElement("pre");
  const code = document.createElement("code");
  let left = 0;
  marks.forEach((spec, index) => {
    const mark = document.createElement("mark");
    mark.className = spec.cls;
    mark.textContent = `m${index}`;
    vi.spyOn(mark, "getBoundingClientRect").mockImplementation(() => rect(spec.left - left, spec.width));
    code.appendChild(mark);
  });
  scroller.appendChild(code);
  document.body.appendChild(scroller);
  Object.defineProperty(scroller, "clientWidth", { configurable: true, get: () => 800 });
  Object.defineProperty(scroller, "scrollWidth", { configurable: true, get: () => 8000 });
  Object.defineProperty(scroller, "scrollLeft", {
    configurable: true,
    get: () => left,
    set: (value: number) => {
      left = value;
    },
  });
  vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(rect(0, 800));
  return { scroller, getLeft: () => left, setLeft: (value: number) => (left = value) };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("revealMarkHorizontally：从 DOM 量矩形并写回偏移", () => {
  it("当前命中在屏幕外：写 scrollLeft 并报告动过", () => {
    const doc = buildDoc([{ cls: "search-hit search-hit-current", left: 4000, width: 80 }]);
    expect(revealMarkHorizontally(doc.scroller, doc.scroller)).toBe(true);
    expect(doc.getLeft()).toBe(4080 - 800 + HIT_REVEAL_MARGIN);
  });

  it("一个命中跨语法 token 被切成几个 <mark> 时取并集：宽度算少会露出半截", () => {
    const doc = buildDoc([
      { cls: "search-hit search-hit-current", left: 4000, width: 40 },
      { cls: "search-hit search-hit-current", left: 4040, width: 40 },
    ]);
    expect(revealMarkHorizontally(doc.scroller, doc.scroller)).toBe(true);
    // 并集 4000..4080，与单条整段命中的结果一致
    expect(doc.getLeft()).toBe(4080 - 800 + HIT_REVEAL_MARGIN);
  });

  it("栏没开（外部内容搜索词整篇标红，不存在 current）时退到第一处命中", () => {
    const doc = buildDoc([
      { cls: "search-hit", left: 4000, width: 80 },
      { cls: "search-hit", left: 6000, width: 80 },
    ]);
    expect(revealMarkHorizontally(doc.scroller, doc.scroller)).toBe(true);
    // 露的是**第一处**（4000），不是更靠外的第二处：与 locateFirstExternalHit 定位 hits[0] 同一口径
    expect(doc.getLeft()).toBe(4080 - 800 + HIT_REVEAL_MARGIN);
  });

  it("第一处已在视口内就不动：更靠外的第二处命中的存在不该触发位移", () => {
    const doc = buildDoc([
      { cls: "search-hit", left: 100, width: 80 },
      { cls: "search-hit", left: 6000, width: 80 },
    ]);
    expect(revealMarkHorizontally(doc.scroller, doc.scroller)).toBe(false);
    expect(doc.getLeft()).toBe(0);
  });

  it("比视口还宽的命中（整段标红的一长串 / 超窄容器）左对齐一次就到位：不许左右来回跳", () => {
    const doc = buildDoc([{ cls: "search-hit search-hit-current", left: 4000, width: 900 }]);
    expect(revealMarkHorizontally(doc.scroller, doc.scroller)).toBe(true);
    expect(doc.getLeft()).toBe(4000 - HIT_REVEAL_MARGIN);
    // 同一处再导航一次：判为已到位，不再动（旧口径会改成右对齐，来回抖）
    expect(revealMarkHorizontally(doc.scroller, doc.scroller)).toBe(false);
    expect(doc.getLeft()).toBe(4000 - HIT_REVEAL_MARGIN);
  });

  it("正文里没有命中时不动，也不清掉用户已有的横向偏移", () => {
    const doc = buildDoc([{ cls: "hljs-string", left: 4000, width: 80 }]);
    doc.setLeft(500);
    expect(revealMarkHorizontally(doc.scroller, doc.scroller)).toBe(false);
    expect(doc.getLeft()).toBe(500);
  });

  it("容器或参数缺失时直接返回 false（调用方传的可能是 null ref）", () => {
    const doc = buildDoc([{ cls: "search-hit search-hit-current", left: 4000, width: 80 }]);
    expect(revealMarkHorizontally(null, doc.scroller)).toBe(false);
    expect(revealMarkHorizontally(doc.scroller, null)).toBe(false);
    expect(doc.getLeft()).toBe(0);
  });

  it("差不到 1px 当作已到位：省下一次无意义的重排", () => {
    const doc = buildDoc([{ cls: "search-hit search-hit-current", left: 4000, width: 80 }]);
    doc.setLeft(4080 - 800 + HIT_REVEAL_MARGIN - 0.5);
    expect(revealMarkHorizontally(doc.scroller, doc.scroller)).toBe(false);
  });
});

describe("padTopForFindBar：查找栏打开时正文顶部该留多少净空（轮27 F-8）", () => {
  it("关栏原样返回基础值：浏览态 6 / 编辑态 12，不许把正文凭空顶下去", () => {
    expect(padTopForFindBar(6, false, 34)).toBe(6);
    expect(padTopForFindBar(12, false, 34)).toBe(12);
    expect(padTopForFindBar(6, false, 0)).toBe(6);
  });

  it("开栏按「条顶偏移 + 实测条高 + 栏底间隙」给：窄容器 flex-wrap 成两行（60）也跟着长", () => {
    expect(padTopForFindBar(6, true, 34)).toBe(FIND_BAR_TOP + 34 + FIND_BAR_GAP);
    expect(padTopForFindBar(6, true, 60)).toBe(FIND_BAR_TOP + 60 + FIND_BAR_GAP);
    expect(padTopForFindBar(6, true, 34)).toBe(50);
    expect(padTopForFindBar(6, true, 60)).toBe(76);
  });

  it("量不到条高时退到兜底常量：开栏那一帧还没有布局，留少了就等于没修", () => {
    expect(padTopForFindBar(6, true)).toBe(FIND_BAR_TOP + FIND_BAR_FALLBACK_HEIGHT + FIND_BAR_GAP);
    expect(padTopForFindBar(6, true, 0)).toBe(50);
    expect(padTopForFindBar(6, true, Number.NaN)).toBe(50);
    expect(padTopForFindBar(6, true, -12)).toBe(50);
  });

  it("只增不减：基础净空本来就够时按基础值，不许倒过来把第一行抬进条子里", () => {
    expect(padTopForFindBar(120, true, 10)).toBe(120);
  });
});

describe("measureFindBarHeight：查找条高度量不到就交 0 给公式兜底", () => {
  afterEach(() => vi.unstubAllGlobals());

  function elWithHeight(height: number | null) {
    return { offsetHeight: height } as unknown as HTMLElement;
  }

  it("null / 0 / 非有限数一律 0：调用方不必再判一次", () => {
    expect(measureFindBarHeight(null)).toBe(0);
    expect(measureFindBarHeight(elWithHeight(0))).toBe(0);
    expect(measureFindBarHeight(elWithHeight(-4))).toBe(0);
    expect(measureFindBarHeight(elWithHeight(Number.NaN))).toBe(0);
    expect(measureFindBarHeight(elWithHeight(Number.POSITIVE_INFINITY))).toBe(0);
  });

  it("量得到就照实返回", () => {
    expect(measureFindBarHeight(elWithHeight(34))).toBe(34);
    expect(measureFindBarHeight(elWithHeight(60))).toBe(60);
  });
});

/** 视口相对的竖向矩形桩（只需 top/height/bottom 参与计算）。 */
function rectV(top: number, height: number): DOMRect {
  return {
    left: 0,
    right: 100,
    width: 100,
    top,
    bottom: top + height,
    height,
    x: 0,
    y: top,
    toJSON: () => "",
  } as DOMRect;
}

/**
 * 手写一棵变高行的最小 DOM：滚动容器 + 一行 + 行内命中标记。
 *
 * 入参的 top 全部写**内容坐标**（这行在文档里的第几像素），但桩出来的矩形必须是
 * **视口相对**的——真浏览器里 rect.top 已经减掉了一次 scrollTop，lib 为了拿内容坐标
 * 会再加回来。桩成内容坐标就等于测了个假几何（与上面水平那组同一教训）。
 * 桩用 mockImplementation 现算，所以第二次导航读到的是第一次写回之后的几何。
 */
function buildRowDoc(spec: {
  clientHeight: number;
  scrollHeight: number;
  scrollTop?: number;
  scrollerTop?: number;
  row?: { top: number; height: number } | null;
  marks?: Array<{ cls: string; top: number; height: number }>;
}) {
  const scroller = document.createElement("div");
  const row = document.createElement("div");
  row.className = "diff-row";
  row.setAttribute("data-row-index", "7");
  scroller.appendChild(row);
  document.body.appendChild(scroller);

  let scrollTop = spec.scrollTop ?? 0;
  const scrollerTop = spec.scrollerTop ?? 0;
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => spec.clientHeight });
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => spec.scrollHeight });
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  vi.spyOn(scroller, "getBoundingClientRect").mockImplementation(() => rectV(scrollerTop, spec.clientHeight));

  const rowSpec = spec.row ?? null;
  if (rowSpec) {
    vi.spyOn(row, "getBoundingClientRect").mockImplementation(
      () => rectV(scrollerTop + rowSpec.top - scrollTop, rowSpec.height)
    );
  }
  for (const markSpec of spec.marks ?? []) {
    const mark = document.createElement("mark");
    mark.className = markSpec.cls;
    mark.textContent = "x";
    vi.spyOn(mark, "getBoundingClientRect").mockImplementation(
      () => rectV(scrollerTop + markSpec.top - scrollTop, markSpec.height)
    );
    row.appendChild(mark);
  }
  return { scroller, row, getTop: () => scrollTop, setTop: (value: number) => (scrollTop = value) };
}

describe("neededScrollTopToCenter：变高行该送到哪个垂直偏移", () => {
  const base = { targetTop: 1000, targetHeight: 20, clientHeight: 400, scrollTop: 0, scrollHeight: 4000 };

  it("居中的是目标块的中线：算式含目标自身高度，行比视口高时不会只把顶边推进来", () => {
    expect(neededScrollTopToCenter({ ...base, targetTop: 1000 })).toBe(1000 - (400 - 20) / 2);
    expect(neededScrollTopToCenter({ ...base, targetTop: 1000, targetHeight: 800 })).toBe(1000 - (400 - 800) / 2);
  });

  it("两端都夹在 [0, scrollHeight - clientHeight] 内", () => {
    // 第一行：居中算式给出负数，夹到 0（scrollTop 本来就是 0 时返回 null，见下一条）
    expect(neededScrollTopToCenter({ ...base, targetTop: 10, scrollTop: 500 })).toBe(0);
    expect(neededScrollTopToCenter({ ...base, targetTop: 3950 })).toBe(4000 - 400);
    expect(neededScrollTopToCenter({ ...base, targetTop: 99999, scrollTop: 100 })).toBe(4000 - 400);
  });

  it("目标已经在顶上：算出来还是 0，不动（别把第一次开栏写成一次无意义滚动）", () => {
    expect(neededScrollTopToCenter({ ...base, targetTop: 10, scrollTop: 0 })).toBeNull();
  });

  it("没有纵向溢出时：已在 0 就不动，停在别处才归位（容器刚被放大过）", () => {
    const flat = { ...base, clientHeight: 400, scrollHeight: 400 };
    expect(neededScrollTopToCenter({ ...flat, targetTop: 100, scrollTop: 0 })).toBeNull();
    expect(neededScrollTopToCenter({ ...flat, targetTop: 100, scrollTop: 50 })).toBe(0);
  });

  it("量不到（高度 0 / 视口 0 / 非有限数）一律 null：动就是把用户已有的偏移清掉", () => {
    expect(neededScrollTopToCenter({ ...base, targetTop: 1000, targetHeight: 0 })).toBeNull();
    expect(neededScrollTopToCenter({ ...base, targetTop: 1000, targetHeight: Number.NaN })).toBeNull();
    expect(neededScrollTopToCenter({ ...base, targetTop: Number.NaN })).toBeNull();
    expect(neededScrollTopToCenter({ ...base, clientHeight: 0 })).toBeNull();
    expect(neededScrollTopToCenter({ ...base, scrollTop: Number.NaN })).toBeNull();
    expect(neededScrollTopToCenter({ ...base, scrollHeight: Number.NaN })).toBeNull();
  });

  it("差不到 1px 当作已到位：写一次 scrollTop 就是一轮重排加一次 scroll 事件", () => {
    const centered = neededScrollTopToCenter({ ...base, targetTop: 1000 })!;
    expect(neededScrollTopToCenter({ ...base, targetTop: 1000, scrollTop: centered - 0.5 })).toBeNull();
  });
});

describe("revealRowVertically：从 DOM 量行矩形并写回 scrollTop", () => {
  it("行在视口外：写 scrollTop 并报告动过", () => {
    const doc = buildRowDoc({ clientHeight: 400, scrollHeight: 4000, row: { top: 1000, height: 20 } });
    expect(revealRowVertically(doc.scroller, doc.row)).toBe(true);
    expect(doc.getTop()).toBe(1000 - (400 - 20) / 2);
  });

  it("优先量当前命中：行比视口高时，居中整行只把行的中段推进来，命中仍在屏幕外", () => {
    const doc = buildRowDoc({
      clientHeight: 400,
      scrollHeight: 4000,
      row: { top: 1000, height: 800 },
      marks: [{ cls: "search-hit search-hit-current", top: 1600, height: 20 }],
    });
    expect(revealRowVertically(doc.scroller, doc.row)).toBe(true);
    expect(doc.getTop()).toBe(1600 - (400 - 20) / 2);
  });

  it("一个命中被切成几个 <mark> 时取并集：只量第一格会少算高度", () => {
    const doc = buildRowDoc({
      clientHeight: 400,
      scrollHeight: 4000,
      row: { top: 0, height: 4000 },
      marks: [
        { cls: "search-hit search-hit-current", top: 1600, height: 20 },
        { cls: "search-hit search-hit-current", top: 1700, height: 20 },
      ],
    });
    expect(revealRowVertically(doc.scroller, doc.row)).toBe(true);
    // 并集 1600..1720 ⇒ 居中 (1600 + 1720) / 2 - 200 = 1460
    expect(doc.getTop()).toBe(1460);
  });

  it("栏没开（外部搜索词整篇标红，不存在 current）时退到这一行里的第一处命中", () => {
    const doc = buildRowDoc({
      clientHeight: 400,
      scrollHeight: 4000,
      row: { top: 1000, height: 800 },
      marks: [
        { cls: "search-hit", top: 2000, height: 20 },
        { cls: "search-hit", top: 2500, height: 20 },
      ],
    });
    expect(revealRowVertically(doc.scroller, doc.row)).toBe(true);
    expect(doc.getTop()).toBe(2000 - (400 - 20) / 2);
  });

  it("这一行没有命中标记时量行本身：调用方给的可能是整行的几何", () => {
    const doc = buildRowDoc({
      clientHeight: 400,
      scrollHeight: 4000,
      row: { top: 1000, height: 20 },
      marks: [{ cls: "hljs-string", top: 1000, height: 20 }],
    });
    expect(revealRowVertically(doc.scroller, doc.row)).toBe(true);
    expect(doc.getTop()).toBe(1000 - (400 - 20) / 2);
  });

  it("第二次导航到同一行不再移动：居中判据自洽，不会来回抖", () => {
    const doc = buildRowDoc({ clientHeight: 400, scrollHeight: 4000, row: { top: 1000, height: 20 } });
    expect(revealRowVertically(doc.scroller, doc.row)).toBe(true);
    expect(revealRowVertically(doc.scroller, doc.row)).toBe(false);
  });

  it("量不到任何矩形（jsdom 无布局 / 祖先隐藏）时不动，也不清掉用户已有的偏移", () => {
    const doc = buildRowDoc({ clientHeight: 400, scrollHeight: 4000, row: null });
    doc.setTop(300);
    expect(revealRowVertically(doc.scroller, doc.row)).toBe(false);
    expect(doc.getTop()).toBe(300);
  });

  it("容器或行为 null 时直接返回 false（调用方传的可能是 null ref / DOM 里没这一行）", () => {
    const doc = buildRowDoc({ clientHeight: 400, scrollHeight: 4000, row: { top: 1000, height: 20 } });
    expect(revealRowVertically(null, doc.row)).toBe(false);
    expect(revealRowVertically(doc.scroller, null)).toBe(false);
    expect(doc.getTop()).toBe(0);
  });

  it("容器还没布局（clientHeight 0）时不动：此时 clamp 的结果恒等于 0，跳一次等于没跳", () => {
    const doc = buildRowDoc({ clientHeight: 0, scrollHeight: 4000, row: { top: 1000, height: 20 } });
    doc.setTop(300);
    expect(revealRowVertically(doc.scroller, doc.row)).toBe(false);
    expect(doc.getTop()).toBe(300);
  });
});
