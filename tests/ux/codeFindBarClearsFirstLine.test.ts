/**
 * 查找栏打开时的顶部净空只认一个出口（轮27 波58 / F-8，轮49 起分两派）。
 *
 * 缺陷长什么样：`.code-find` 是浮在正文上的绝对定位层，而 `scrollLineIntoView` 是
 * `clamp(y - clientHeight / 2, 0, …)` —— 命中在文件开头时算出负数被夹到 0，**没有任何滚动余量**
 * 把行让到条子下面。于是搜 `spring:` / `serverPort:` 这类就在第 1 行的顶层键，
 * 开栏后红字与命中行底色整条被查找条盖住（实测盖住第 1-2 行）。
 *
 * 只能靠留白解决，而「行 i 的 top = 净空 + i * ROW_H」这条公式同时被行号层、命中行底色层、
 * 可见区间计算、缩略图四处使用 ⇒ 净空必须是**一个**数导出的，改一处四层跟着走。
 *
 * 口径：
 * 1. 净空公式住在 src/lib/codeScroll.ts（padTopForFindBar / measureFindBarHeight），谁量谁调用；
 * 2. 「条高在绘制前量 + 关栏清零」这套编排只有一个出处：套行号公式的两个代码视图各自还有一份
 *    （它们与 minimap 的隐式契约本轮不动），量 DOM 的两个宿主统一经 src/lib/useFindLayer.ts；
 *    再冒第三份就是第五处要各自漏改的地方。
 * 3. 条高必须**绘制前**在 useLayoutEffect 里量（窄容器 flex-wrap 成两行是真会发生的事），
 *    且关栏时把量到的值清零，否则下一份文件带着旧条高开栏；
 * 4. 净空那个数必须真的下发到正文：代码视图走 `--code-pad-top`，量 DOM 那一派走锚点高度
 *    ——锚点是滚动容器的在流子元素，撑净空而不动 padding / overflow；
 * 5. styles.css 的 `--code-pad-top` 基础值仍等于各组件的 PAD_TOP 常量：净空只由内联覆盖下发，
 *    CSS 里写死大值会让关栏后正文凭空矮一截。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource } from "./scanUtils";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "./scanUtils";

const LIB = "src/lib/codeScroll.ts";
const CODE_VIEW = "src/components/CodeView.tsx";
const CODE_EDITOR = "src/components/CodeEditor.tsx";
const DIFF_PANEL = "src/components/DiffPanel.tsx";
const UNIFIED_DIFF = "src/components/UnifiedDiff.tsx";
const LAYER = "src/lib/useFindLayer.ts";
const BAR = "src/components/FindBar.tsx";
const CSS_FILE = "src/styles.css";

const CSS = readFileSync(join(PROJECT_ROOT, CSS_FILE), "utf8");

/**
 * 两个派别（轮49 按**几何口径**切，不按宿主数量切）：
 * - FORMULA_HOSTS 套行号公式：定行高 + 还要 syncScroll() 把 transform 推给行号层与缩略图，
 *   本轮仍各自握着条高测量；
 * - DOM_HOSTS 量 DOM：`.diff-cell` / `.udiff-text` 是 pre-wrap + break-all，一行长 JSON 能在
 *   视口里占十几屏，行号公式在那儿不成立 ⇒ 测量与落地都交给共享层，宿主只把净空接到锚点上。
 */
const FORMULA_HOSTS = [CODE_VIEW, CODE_EDITOR];
const DOM_HOSTS = [DIFF_PANEL, UNIFIED_DIFF];
/** 握有条高测量编排的地方：两个代码视图 + 共享层，只此三处。 */
const MEASURERS = [...FORMULA_HOSTS, LAYER];
/** 渲染查找条的宿主：四个。 */
const JSX_HOSTS = [...FORMULA_HOSTS, ...DOM_HOSTS];

/** 取 `const NAME = 12;` 形式的数值常量（读原文，注释已剥的版本里也还在）。 */
function tsConst(src: string, name: string): number {
  const m = new RegExp(String.raw`const ${name} = (\d+)`).exec(src);
  expect(m, `找不到常量 ${name}`).not.toBeNull();
  return Number.parseInt(m![1], 10);
}

/** 取某个选择器规则块里 `--name: value;` 的声明值。 */
function cssVar(selector: string, name: string): string {
  const block = new RegExp(`${selector.replace(/\./g, String.raw`\.`)} \\{([^}]*)\\}`, "m").exec(CSS);
  expect(block, `styles.css 里找不到 ${selector} 规则块`).not.toBeNull();
  const decl = new RegExp(`${name}: ([^;]+);`).exec(block![1]);
  expect(decl, `${selector} 里没有 ${name}`).not.toBeNull();
  return decl![1].trim();
}

/** 剥注释后逐行列出 PAD_TOP 的出现点，返回「不该在这里」的行。 */
function strayPadTopLines(src: string, file: string): string[] {
  return src
    .split("\n")
    .filter((line) => /\bPAD_TOP\b/.test(line))
    .filter((line) => !new RegExp(String.raw`^const PAD_TOP = \d+;$`).test(line.trim()))
    .filter((line) => !line.includes("padTopForFindBar("))
    .map((line) => `${file}: ${line.trim()}`);
}

/** 取某个 useLayoutEffect 块（够长的一段，含依赖数组）。 */
function layoutBlocks(src: string): string[] {
  return [...src.matchAll(/useLayoutEffect\(\(\) => \{[\s\S]*?\n\s*\}, \[/g)].map((m) => m[0]);
}

describe("查找栏顶部净空单一来源（波58 F-8）", () => {
  const lib = readScannedSource(LIB);
  const layer = readScannedSource(LAYER);

  it("公式与条高测量只住在 lib 与共享层，四个宿主都不许自己抄", () => {
    for (const fn of ["padTopForFindBar", "measureFindBarHeight"]) {
      expect(lib, `src/lib/codeScroll.ts 里没有导出 ${fn}`).toContain(`export function ${fn}`);
      for (const file of MEASURERS) {
        expect(readScannedSource(file), `${file} 没有从 lib/codeScroll 引 ${fn}`).toContain(fn);
      }
      // 量 DOM 那一派的净空来自共享层那一个数：宿主里再出现公式名就是第二套编排
      for (const file of DOM_HOSTS) {
        expect(readScannedSource(file), `${file} 自己量了一遍条高（这套编排只许在 useFindLayer 里）`).not.toContain(fn);
      }
    }
    // 条子几何的三个数不许在组件里再写一遍字面量
    for (const file of JSX_HOSTS) {
      const src = readScannedSource(file);
      expect(src, `${file} 里自己声明了查找栏几何常量`).not.toMatch(/const FIND_BAR_/);
      expect(src, `${file} 里抄了净空算式`).not.toMatch(/8 \+ 34 \+ 8|FIND_BAR_FALLBACK_HEIGHT \+/);
    }
    // 四个宿主都把查找栏的状态交给唯一那份编排：量 DOM 那一派必须真的在调共享层
    for (const file of DOM_HOSTS) {
      expect(readScannedSource(file), `${file} 没接 useFindLayer`).toMatch(/useFindLayer\(\{/);
    }
  });

  it("组件里 PAD_TOP 只剩「常量声明 + 交给公式」两处，其余几何一律用派生值", () => {
    for (const file of FORMULA_HOSTS) {
      const src = readScannedSource(file);
      expect(strayPadTopLines(src, file), `${file} 还有第二处按 PAD_TOP 算几何`).toEqual([]);
      // 派生值必须真的被用出去（行号 / 命中行 / 可见区间 / 缩略图）
      expect(src, `${file} 没有将 padTop 用于可见区间`).toMatch(/scrollTop - padTop/);
      expect(src, `${file} 没有将 padTop 用于行定位`).toMatch(/padTop \+ (line|i) \* ROW_H/);
    }
    // 共享层的净空基准是 0：diff / udiff 的正文没有 CSS 基础值，全靠锚点撑
    expect(layer, "共享层不再是「基准 0 + 条高」那一个出口").toMatch(/padTopForFindBar\(\s*0,\s*findOpen,\s*findBarHeight\s*\)/);
  });

  it("净空以 CSS 变量下发，且 CSS 基础值仍等于组件的 PAD_TOP 常量", () => {
    for (const file of FORMULA_HOSTS) {
      const src = readScannedSource(file);
      expect(src, `${file} 没把净空下发成 --code-pad-top`).toMatch(/"--code-pad-top": `\$\{padTop\}px`/);
      const selector = file === CODE_VIEW ? ".code-view" : ".code-editor";
      expect(cssVar(selector, "--code-pad-top")).toBe(`${tsConst(src, "PAD_TOP")}px`);
    }
    // 正文层的 padding-top 必须继续走变量，写死的值会让净空失效
    expect(CSS).toMatch(/padding: var\(--code-pad-top\)/);
  });

  it("量 DOM 那一派把同一个净空接到锚点高度上，关栏归零", () => {
    for (const file of DOM_HOSTS) {
      const src = readScannedSource(file);
      expect(src, `${file} 的锚点高度不再用共享层那个数（自己算就是第二套净空）`).toMatch(
        /className="diff-find-anchor" style=\{\{ height: `\$\{padTop\}px` \}\}/
      );
      expect(src, `${file} 没从共享层取 padTop`).toMatch(/padTop,/);
      // 锚点必须是滚动容器的在流子元素：改成浮层就盖住第一行
      expect(src, `${file} 的查找条不再是正文的在流锚点`).toMatch(/<div className="diff-find-anchor"[\s\S]{0,120}\{findOpen \? \(/);
    }
  });

  it("条高在绘制前量、关栏清零，`.code-find` 那颗 ref 由条子持有、宿主递进去", () => {
    for (const file of MEASURERS) {
      const measure = layoutBlocks(readScannedSource(file)).find((b) => b.includes("measureFindBarHeight"));
      expect(measure, `${file} 的条高测量不在 useLayoutEffect 里（开栏那一帧会先盖住正文再跳开）`).toBeTruthy();
      // 必须真的 observe 那颗条子并收摊：typeof ResizeObserver 的门卫句里也含这个名字，
      // 只 toContain("ResizeObserver") 会把「observe 被删掉」放过去。
      expect(measure, `${file} 量完没挂 ResizeObserver：条子换行时净空不会跟着长`).toMatch(
        /new ResizeObserver\(measure\)[\s\S]*\.observe\(el\)/
      );
      expect(measure, `${file} 的 ResizeObserver 没 disconnect：切文件后会一直量着已卸载的条子`).toMatch(
        /return \(\) => ro\.disconnect\(\)/
      );
      expect(measure, `${file} 关栏没清零条高：下一份内容开栏会用上一个文件的高度`).toMatch(/setFindBarHeight\(0\)/);
    }
    // 轮48：条子只剩一份实现。被测元素挂在自己的 barRef 上，宿主把自己那颗 findBarRef 递进去——
    // 两头钉住，将来谁把测量对象换成「宿主根节点」都会在这里判红（量到的是整页高度，净空凭空变大）。
    const bar = readScannedSource(BAR);
    expect(bar, `${BAR} 里 .code-find 没挂被测的那颗 ref`).toMatch(
      /className="code-find"[\s\S]{0,80}ref=\{barRef\}|ref=\{barRef\}[\s\S]{0,80}className="code-find"/
    );
    for (const file of JSX_HOSTS) {
      expect(readScannedSource(file), `${file} 没把自己那颗 findBarRef 递给条子`).toContain("barRef={findBarRef}");
    }
    // 量 DOM 那一派还要把同一颗 ref 交给共享层去量：递给条子却不递给层 = 净空永远是兜底值
    for (const file of DOM_HOSTS) {
      const call = readScannedSource(file).match(/useFindLayer\(\{[\s\S]*?\}\)/);
      expect(call, `${file} 读不到 useFindLayer 的入参块`).not.toBeNull();
      expect(call![0], `${file} 没把 findBarRef 交给共享量`).toMatch(/^\s*findBarRef,$/m);
      expect(call![0], `${file} 没把 findInputRef 交给共享层`).toMatch(/^\s*findInputRef,$/m);
    }
  });

  it("净空变化没有滚动事件，两个视图都要补一次同步，否则缩略图与行号层按旧偏移排", () => {
    for (const file of FORMULA_HOSTS) {
      const src = readScannedSource(file);
      const block = (src.match(/useLayoutEffect\(\(\) => \{\s*syncScroll\(\);\s*\}, \[[^\]]*\]\)/g) ?? []).find((b) => /padTop/.test(b));
      expect(block, `${file} 缺「净空变了补一次 syncScroll」的 layout 效应`).toBeTruthy();
    }
  });

  it("lib 的公式只增不减、量不到有条高兜底：留少了等于没修", () => {
    expect(lib).toMatch(/if \(!findOpen\) return basePadTop;/);
    expect(lib).toMatch(/Math\.max\(basePadTop, FIND_BAR_TOP \+ barHeight \+ FIND_BAR_GAP\)/);
    expect(lib).toMatch(/measuredBarHeight > 0 \? measuredBarHeight : FIND_BAR_FALLBACK_HEIGHT/);
  });
});

describe("守卫自身不空转：退回第二份测量必须判红（轮49）", () => {
  const layer = readScannedSource(LAYER);

  it("自检一：共享层退回「条高写死常数」必须判红", () => {
    expect(layoutBlocks(layer).find((b) => b.includes("measureFindBarHeight")), "取样点漂了：共享层里读不到条高测量").toBeTruthy();
    const regressed = layer.replace(
      "const measure = () => setFindBarHeight(measureFindBarHeight(findBarRef.current));",
      "const measure = () => setFindBarHeight(34);"
    );
    expect(regressed !== layer, "变异没落到源码里，这条自检是空转").toBe(true);
    expect(layoutBlocks(regressed).find((b) => b.includes("measureFindBarHeight")), "变异后仍然被判成「量了条高」").toBeFalsy();
  });

  it("自检二：宿主自己再抄一份测量必须判红", () => {
    const panel = readScannedSource(DIFF_PANEL);
    // 现状：DiffPanel 确实不自己量（判据才有意义）
    expect(panel, "取样点漂了：DiffPanel 现在自己量了条高").not.toMatch(/measureFindBarHeight/);
    const regressed = panel.replace("const find = useFindLayer({", "const barHeight = measureFindBarHeight(findBarRef.current);\n  const find = useFindLayer({");
    expect(regressed !== panel, "变异没落进被测文本").toBe(true);
    // 同一条判据（DOM 宿主里出现公式名就判红）打在变异体上必须咬住
    expect(regressed, "宿主自己抄测量这一步没有被挡住").toMatch(/measureFindBarHeight/);
  });

  it("自检三：锚点不再吃共享层那个净空必须判红", () => {
    const unified = readScannedSource(UNIFIED_DIFF);
    const honest = /className="diff-find-anchor" style=\{\{ height: `\$\{padTop\}px` \}\}/;
    expect(unified, "取样点漂了").toMatch(honest);
    const regressed = unified.replace("style={{ height: `${padTop}px` }}", "style={{ height: `12px` }}");
    expect(regressed !== unified, "变异没落进被测文本").toBe(true);
    expect(regressed).not.toMatch(honest);
  });
});
