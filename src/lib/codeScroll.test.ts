/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HIT_REVEAL_MARGIN, neededScrollLeftForMark, revealMarkHorizontally } from "./codeScroll";

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
