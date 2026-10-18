/**
 * 查找栏打开时的顶部净空只认一个出口（轮27 波58 / F-8）。
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
 * 1. 净空公式住在 src/lib/codeScroll.ts（padTopForFindBar / measureFindBarHeight），组件只调用；
 * 2. 组件里除了「常量声明 + 调公式」两处，不许再出现 PAD_TOP —— 任何一处漏改就是第 N 行错位；
 * 3. 条高必须**绘制前**在 useLayoutEffect 里量（窄容器 flex-wrap 成两行是真会发生的事），
 *    且关栏时把量到的值清零，否则下一份文件带着旧条高开栏；
 * 4. styles.css 的 `--code-pad-top` 基础值仍等于各组件的 PAD_TOP 常量：净空只由内联覆盖下发，
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
const CSS_FILE = "src/styles.css";

const CSS = readFileSync(join(PROJECT_ROOT, CSS_FILE), "utf8");

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

describe("查找栏顶部净空单一来源（波58 F-8）", () => {
  const lib = readScannedSource(LIB);
  const view = readScannedSource(CODE_VIEW);
  const editor = readScannedSource(CODE_EDITOR);

  it("公式与条高测量住在 lib，两个视图都只调用", () => {
    for (const fn of ["padTopForFindBar", "measureFindBarHeight"]) {
      expect(lib, `src/lib/codeScroll.ts 里没有导出 ${fn}`).toContain(`export function ${fn}`);
      for (const [file, src] of [
        [CODE_VIEW, view],
        [CODE_EDITOR, editor],
      ] as const) {
        expect(src, `${file} 没有从 lib/codeScroll 引 ${fn}`).toContain(fn);
      }
    }
    // 条子几何的三个数不许在组件里再写一遍字面量
    for (const [file, src] of [
      [CODE_VIEW, view],
      [CODE_EDITOR, editor],
    ] as const) {
      expect(src, `${file} 里自己声明了查找栏几何常量`).not.toMatch(/const FIND_BAR_/);
      expect(src, `${file} 里抄了净空算式`).not.toMatch(/8 \+ 34 \+ 8|FIND_BAR_FALLBACK_HEIGHT \+/);
    }
  });

  it("组件里 PAD_TOP 只剩「常量声明 + 交给公式」两处，其余几何一律用派生值", () => {
    expect(strayPadTopLines(view, CODE_VIEW), "CodeView 还有第二处按 PAD_TOP 算几何").toEqual([]);
    expect(strayPadTopLines(editor, CODE_EDITOR), "CodeEditor 还有第二处按 PAD_TOP 算几何").toEqual([]);
    // 派生值必须真的被用出去（行号 / 命中行 / 可见区间 / 缩略图）
    for (const [file, src] of [
      [CODE_VIEW, view],
      [CODE_EDITOR, editor],
    ] as const) {
      expect(src, `${file} 没有将 padTop 用于可见区间`).toMatch(/scrollTop - padTop/);
      expect(src, `${file} 没有将 padTop 用于行定位`).toMatch(/padTop \+ (line|i) \* ROW_H/);
    }
  });

  it("净空以 CSS 变量下发，且 CSS 基础值仍等于组件的 PAD_TOP 常量", () => {
    expect(view).toMatch(/"--code-pad-top": `\$\{padTop\}px`/);
    expect(editor).toMatch(/"--code-pad-top": `\$\{padTop\}px`/);
    expect(cssVar(".code-view", "--code-pad-top")).toBe(`${tsConst(view, "PAD_TOP")}px`);
    expect(cssVar(".code-editor", "--code-pad-top")).toBe(`${tsConst(editor, "PAD_TOP")}px`);
    // 正文层的 padding-top 必须继续走变量，写死的值会让净空失效
    expect(CSS).toMatch(/padding: var\(--code-pad-top\)/);
  });

  it("条高在绘制前量、关栏清零，`.code-find` 挂着被测的那颗 ref", () => {
    const blocks = (src: string) => [...src.matchAll(/useLayoutEffect\(\(\) => \{[\s\S]*?\n\s*\}, \[/g)].map((m) => m[0]);
    for (const [file, src] of [
      [CODE_VIEW, view],
      [CODE_EDITOR, editor],
    ] as const) {
      const measure = blocks(src).find((b) => b.includes("measureFindBarHeight"));
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
      expect(src, `${file} 的查找条没挂 ref`).toMatch(
        /className="code-find"[\s\S]{0,80}ref=\{findBarRef\}|ref=\{findBarRef\}[\s\S]{0,80}className="code-find"/
      );
    }
  });

  it("净空变化没有滚动事件，两个视图都要补一次同步，否则缩略图与行号层按旧偏移排", () => {
    for (const [file, src] of [
      [CODE_VIEW, view],
      [CODE_EDITOR, editor],
    ] as const) {
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
