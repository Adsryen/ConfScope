/**
 * 「跳到下一处命中」不许重画整篇文档（轮28 F-14 + F-15）。
 *
 * 缺陷长什么样（bench 实测，见任务 PRD）：两个视图的 html memo 把「当前在第几处」圈进了依赖，
 * 于是每按一次 Enter 都要重跑 highlightCode + 重新标记 + 让浏览器重新解析整篇 HTML——
 * 2k 行 25-45ms / 20k 行（约 1MB）235-342ms / 200k 行（约 10MB）1586-3136ms。
 * 用户感受不是"有点卡"，是"按回车翻页等一秒以上白屏"。
 * 另一半：算「可视区内的命中行」是 `for (const hit of hits)` 线性扫全量，挂在 visibleRange 上
 * ⇒ 每滚一格把 5000 处命中从头扫一遍，绝大多数还在窗口外白扫。
 *
 * 修法只有一条路能被钉住，所以钉形状而不是钉性能数字：
 * 1) 高亮层只依赖「正文 + 格式」，命中层只依赖「高亮层 + 命中集合」；
 * 2) 「当前命中」由视图在提交后往 <mark data-hit> 上切类表达，lib 产出的 HTML 里没有这个类；
 * 3) 切类必须排在水平定位之前（否则量的还是上一处的矩形，轮27 的坑换个方向再踩一次）；
 * 4) 命中行窗口走二分（hitLinesInRange），视图里不许再出现线性扫 hits。
 *
 * 末尾三条自检把三种「退回」钉成判红。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource, sourceFiles } from "./scanUtils";

const LIB = "src/lib/codeLines.ts";
const SCROLL_LIB = "src/lib/codeScroll.ts";
const VIEWS = [
  {
    file: "src/components/CodeView.tsx",
    sourceVar: "code",
    // 轮29 F-18：浏览态把跳转计数与滚动都并进这条效果，navTick / scrollLineIntoView 必须在依赖里。
    deps: "html, findOpen, hits, activeIdx, navTick, scrollLineIntoView",
  },
  {
    file: "src/components/CodeEditor.tsx",
    sourceVar: "doc",
    // 编辑态的垂直滚动本来就在 updater 之外（revealHit），没有 F-18 那个症状，口径不动。
    deps: "html, findOpen, hits, activeIdx",
  },
] as const;

const CURRENT_CLASS = "search-hit-current";
/** 当前命中必须"先加类、后定位"：同一个 effect 体内两处的相对顺序。 */
const ADD_CLASS = "classList.add(CURRENT_HIT_CLASS)";
const REMOVE_CLASS = "classList.remove(CURRENT_HIT_CLASS)";

/** 抽出 useLayoutEffect 块（到依赖数组那一行为止），口径与 codeRevealSingleSource 一致。 */
function layoutEffectBlocks(src: string): string[] {
  return [...src.matchAll(/useLayoutEffect\(\(\) => \{[\s\S]*?\n\s*\}, \[/g)].map((m) => m[0]);
}

/** 连依赖数组一起抽出来：只截到 `}, [` 的话，依赖里的东西永远查不到（空转守卫的常见形状）。 */
function layoutEffectsWithDeps(src: string): Array<{ body: string; deps: string }> {
  return [...src.matchAll(/useLayoutEffect\(\(\) => \{[\s\S]*?\n\s*\}, \[([^\]]*)\]\);/g)].map((m) => ({
    body: m[0],
    deps: (m[1] ?? "").replace(/\s+/g, " ").trim(),
  }));
}

/** 取 `decl` 这条 memo 的依赖数组内容（已把空白压成单个空格）；解析不到返回 null。 */
function depsOf(src: string, decl: string): string | null {
  const start = src.indexOf(decl);
  if (start < 0) return null;
  const found = /,\s*\[([^\]]*)\]\s*\);/.exec(src.slice(start, start + 4000));
  return found ? (found[1] ?? "").replace(/\s+/g, " ").trim() : null;
}

/** 「切类在定位之前」这条顺序判据（自检也用同一个函数，不另写一份）。 */
function classIsAppliedBeforeReveal(block: string): boolean {
  const add = block.indexOf(ADD_CLASS);
  const reveal = block.indexOf("revealMarkHorizontally");
  return add >= 0 && reveal >= 0 && add < reveal;
}

describe("当前命中不许重画整篇文档（轮28 F-14）", () => {
  it("lib 产出的 HTML 里没有「当前命中」的类，只有 data-hit 编号", () => {
    const lib = readScannedSource(LIB);
    expect(lib).toContain(`export const CURRENT_HIT_CLASS = "${CURRENT_CLASS}"`);
    // 第三参 hitIndexBase（轮48）：逐段标记（diff 的一行两格）需要全篇编号，默认 0 = 旧行为。
    // 「当前命中」仍然不进这一层——所以它只能多一个编号基址，不许长出 active 之类的第二形态。
    expect(lib).toMatch(/export function markHighlightedHtml\(html: string, hits: CodeHit\[\], hitIndexBase = 0\): string/);
    expect(lib, "markHighlightedHtml 又带回 activeOffset 参数了").not.toMatch(/markHighlightedHtml\([^)]*activeOffset/);
    expect(lib, "产出 HTML 里还有 active 分支＝每换一处都要重画整篇").not.toMatch(/range\.active/);
    expect(lib).toContain('<mark class="search-hit" data-hit="${range.hitIndex}"');
    // activeOffsetOf 是这条依赖的入口，留着就有人会再把它圈进 memo
    expect(lib, "activeOffsetOf 已无用途，留着就是下一次回退的接口").not.toContain("activeOffsetOf");
  });

  it("data-hit 与 current 类名各只有一份定义，视图不许自己拼选择器", () => {
    const dataHitSites = sourceFiles().filter((file) => readScannedSource(file).includes("data-hit="));
    expect(dataHitSites, "命中编号的产出口径出现了第二份").toEqual([LIB]);
    const classSites = sourceFiles().filter((file) => readScannedSource(file).includes(`"${CURRENT_CLASS}"`));
    expect(classSites, "current 类名被写成了第二份字面量").toEqual([LIB]);
    const scroll = readScannedSource(SCROLL_LIB);
    expect(scroll, "codeScroll 没跟 lib 同源取 current 类名").toContain("const CURRENT_MARK_SELECTOR = `.${" + "CURRENT_HIT_CLASS}`;");
  });

  it("两个视图的高亮层只依赖正文与格式，命中层只依赖高亮层与命中", () => {
    for (const { file, sourceVar } of VIEWS) {
      const view = readScannedSource(file);
      expect(view, `${file} 的 baseHtml 写法变了，守卫要一起看`).toContain("const baseHtml = useMemo(");
      expect(depsOf(view, "const baseHtml = useMemo("), `${file} 的高亮层依赖不再只是正文与格式`).toBe(`${sourceVar}, format`);
      expect(view, `${file} 的命中层写法变了`).toContain("const html = useMemo(() => markHighlightedHtml(baseHtml, hits)");
      expect(depsOf(view, "const html = useMemo("), `${file} 的命中层依赖不该只有高亮层与命中`).toBe("baseHtml, hits");
      expect(view.match(/highlightCode\(/g) || [], `${file} 里 highlightCode 的调用点应当只有一处`).toHaveLength(1);
      // 最硬的一条：这两个文件里连"当前命中的偏移"这个变量都不该再存在
      expect(view, `${file} 又出现了 activeOffset（它一旦被圈进 memo 就是重画整篇）`).not.toMatch(/activeOffset/);
    }
  });

  it("先切类再定位，且收在同一个 useLayoutEffect 里", () => {
    for (const { file, deps: expectedDeps } of VIEWS) {
      const effects = layoutEffectsWithDeps(readScannedSource(file));
      expect(effects.length, `${file} 一条 useLayoutEffect 都没解析到（形状变了，守卫在空转）`).toBeGreaterThan(0);
      const found = effects.filter((effect) => effect.body.includes("revealMarkHorizontally"));
      expect(found, `${file} 的水平定位不在 useLayoutEffect 里`).toHaveLength(1);
      const { body, deps } = found[0];
      expect(body, `${file} 没在同一个块里收回上一处的 current 类`).toContain(REMOVE_CLASS);
      expect(body, `${file} 没按命中编号取节点`).toContain("currentHitSelector(");
      expect(classIsAppliedBeforeReveal(body), `${file} 又先量矩形后切类：量到的是上一处的位置`).toBe(true);
      expect(deps, `${file} 的定位效果依赖数组变了`).toBe(expectedDeps);
      // 轮27 钉过的口径：横向偏移被用户自己拖走之后，当前命中没变就不许再把他拽回来
      expect(deps, `${file} 把 metrics 圈进了定位依赖（每滚一格都把他拽回上一处）`).not.toMatch(/metrics/);
      // 旧的「按 activeOffset 定位」那条效果不许和这条并存：两条会各写一次 scrollLeft
      expect(
        layoutEffectBlocks(readScannedSource(file)).filter((b) => b.includes("revealMarkHorizontally")).length,
        `${file} 出现第二条水平定位效果`
      ).toBe(1);
    }
  });
});

describe("可视区命中行走二分窗口（轮28 F-15）", () => {
  it("lib 里 hitLinesInRange 是二分起点，且要求入参升序", () => {
    const lib = readScannedSource(LIB);
    expect(lib).toMatch(/export function hitLinesInRange\(sortedHitLines: number\[\], start: number, end: number\): number\[\]/);
    const start = lib.indexOf("export function hitLinesInRange(");
    const body = lib.slice(start, start + 1200);
    expect(body, "窗口起点不是二分定位").toMatch(/while\s*\(lo < hi\)/);
    expect(body, "窗口起点还是线性定位").toMatch(/sortedHitLines\[mid\] < start/);
  });

  it("两个视图都不再线性扫全量命中", () => {
    for (const { file } of VIEWS) {
      const view = readScannedSource(file);
      expect(view, `${file} 又用 for (const hit of hits) 扫全量命中算窗口`).not.toMatch(/for \(const hit of hits\)/);
      expect(view, `${file} 的命中行窗口没走 hitLinesInRange`).toMatch(
        /hitLinesInRange\(hitLineArray, (?:visibleRange\.start|start), (?:visibleRange\.end|end)\)/
      );
      const deps = depsOf(view, "const hitRows = useMemo(");
      expect(deps, `${file} 的 hitRows 依赖里没换掉全量 hits`).toBeTruthy();
      expect(deps!, `${file} 的 hitRows 又依赖全量 hits`).not.toMatch(/(^|, )hits(,|$)/);
      expect(deps!, `${file} 的 hitRows 没依赖升序命中行表`).toContain("hitLineArray");
    }
  });
});

describe("守卫自身不空转：三种退回必须判红", () => {
  it("自检一：把 activeOffset 圈回高亮层依赖必须判红", () => {
    const view = readScannedSource(VIEWS[0].file);
    const honest = depsOf(view, "const baseHtml = useMemo(");
    expect(honest).toBe("code, format");
    const mutant = view.replace(`}, [${honest}]);`, "}, [code, format, activeOffset]);");
    expect(depsOf(mutant, "const baseHtml = useMemo("), "变异没落到依赖数组里，这条自检是空转").toBe("code, format, activeOffset");
    expect(depsOf(mutant, "const baseHtml = useMemo(")).not.toBe("code, format");
  });

  it("自检二：退回「先量矩形再切类」必须判红", () => {
    const view = readScannedSource(VIEWS[0].file);
    const block = layoutEffectBlocks(view).find((b) => b.includes("revealMarkHorizontally")) ?? "";
    expect(classIsAppliedBeforeReveal(block)).toBe(true);
    const regressed = block
      .replace(ADD_CLASS + ";", "")
      .replace("revealMarkHorizontally(root, root);", `revealMarkHorizontally(root, root);\n    ${ADD_CLASS};`);
    expect(regressed.includes(ADD_CLASS), "变异没把切类挪到定位之后，这条自检是空转").toBe(true);
    expect(classIsAppliedBeforeReveal(regressed)).toBe(false);
  });

  it("自检三：命中行窗口退回线性扫全量必须判红", () => {
    const view = readScannedSource(VIEWS[0].file);
    expect(view).not.toMatch(/for \(const hit of hits\)/);
    const regressed = view.replace(
      /const hitRows = useMemo\(\s*\(\) => hitLinesInRange\(hitLineArray, visibleRange\.start, visibleRange\.end\),\s*\[hitLineArray, visibleRange\]\s*\);/,
      `const hitRows = useMemo(() => {
    const out: number[] = [];
    for (const hit of hits) {
      if (hit.line >= visibleRange.start && hit.line < visibleRange.end) out.push(hit.line);
    }
    return out;
  }, [hits, visibleRange]);`
    );
    expect(regressed.includes("for (const hit of hits)"), "变异没落到 hitRows 里，这条自检是空转").toBe(true);
    expect(regressed).toMatch(/for \(const hit of hits\)/);
    expect(depsOf(regressed, "const hitRows = useMemo(")).toMatch(/(^|, )hits(,|$)/);
  });
});
