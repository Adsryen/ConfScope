/**
 * 查找命中「送进横向视口」只认一个出口（轮27 波58 / F-7）。
 *
 * 缺陷长什么样：编辑态早就用「列 × 隐形探针字宽」算过 scrollLeft，浏览态却压根不写 ——
 * Nacos 里大量单行长 JSON（几 KB 挤一行），搜 serverPort 时查找栏写着「第 1/12 处」，
 * 红字在第 4000 列的屏幕外。用户看到的不是"没搜到"，是"搜到了但看不见"。
 *
 * 更麻烦的是那份列宽算式本身量不准两处系统性偏差：CSS 写着 tab-size: 2 而 column 按码点算，
 * 一个制表符只记 1 列；中日韩字符在等宽字体里占两倍字宽。⇒ 唯一口径改成量命中 <mark> 的实际矩形。
 *
 * 口径：
 * 1. 水平定位只许调 src/lib/codeScroll.ts 的 revealMarkHorizontally，组件里不许再出现算式化的 scrollLeft 赋值；
 * 2. 两个视图（浏览态 / 编辑态）都必须**在提交后**量矩形（useLayoutEffect）：navigate 在 setState 的
 *    updater 里同步滚动，那一刻 DOM 里还是上一处命中，读 DOM 就会量到旧位置；
 * 3. 浏览态的外部搜索词路径（R74 locateFirstExternalHit）也须带上水平定位，别退回只滚垂直；
 * 4. 探针字宽那套旧实现（PROBE_CHARS / measureCharWidth / scrollColumnIntoView）不许复活；
 * 5. 假布局桩（src/test/codeLayout.ts 与 lib 单测的手写 DOM）必须给**视口相对**的 rect：
 *    真浏览器的 rect.left 已减过一次 scrollLeft，桩成内容坐标等于测了个假几何。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource, sourceFiles } from "./scanUtils";

const LIB = "src/lib/codeScroll.ts";
const CODE_VIEW = "src/components/CodeView.tsx";
const CODE_EDITOR = "src/components/CodeEditor.tsx";
const FAKE_LAYOUT = "src/test/codeLayout.ts";
const LIB_TEST = "src/lib/codeScroll.test.ts";

const LIB_IMPORT = /from "\.\.?\/lib\/codeScroll"/;
/** 抓出「赋给 scrollLeft 的右边是什么」。 */
const SCROLL_LEFT_ASSIGN = /\.scrollLeft\s*=\s*([^\n;]*)/g;
/** 组件里允许的唯一形状：把一层的偏移同步给另一层（编辑态 pre 跟着 textarea 走）。 */
const SCROLL_LEFT_SYNC = /^[\w.]*scrollLeft$/;
/** 算式化的水平定位：夹值 / 数学函数 / 字面量，全是第二份实现的形状。 */
const COMPUTED_RHS = /(?:^|[\s(+-])(?:clamp\b|Math\.|[\d.])/;

/** 列出文件里所有「用算式写横向偏移」的赋值点。 */
function computedScrollLeftSites(src: string): string[] {
  return [...src.matchAll(SCROLL_LEFT_ASSIGN)]
    .map((m) => (m[1] ?? "").trim())
    .filter((rhs) => !SCROLL_LEFT_SYNC.test(rhs) && COMPUTED_RHS.test(rhs));
}

/** 抽出文件里的 useLayoutEffect 块（到依赖数组那一行为止）。 */
function layoutEffectBlocks(src: string): string[] {
  return [...src.matchAll(/useLayoutEffect\(\(\) => \{[\s\S]*?\n\s*\}, \[/g)].map((m) => m[0]);
}

describe("查找命中的水平定位单一出口（波58 F-7）", () => {
  const files = sourceFiles();
  /**
   * src/lib 下的模块是这些几何口径的**归属地**（水平定位归 codeScroll、归零归
   * useScrollResetOnContentChange），守卫要防的是站点自己再抄一份算式，不是防 lib 写它自己的活。
   */
  const siteFiles = files.filter((file) => !file.startsWith("src/lib/"));
  const read = readScannedSource;

  it("两个视图都从 lib 引水平定位，各自不再留一份算式", () => {
    for (const file of [CODE_VIEW, CODE_EDITOR]) {
      const src = read(file);
      expect(src, `${file} 没有引用 lib/codeScroll`).toMatch(LIB_IMPORT);
      expect(computedScrollLeftSites(src), `${file} 里出现了第二份算式化的横向定位`).toEqual([]);
    }
  });

  it("编辑态只把偏移同步给高亮层，别的横向赋值一律算第二份实现", () => {
    const offenders = siteFiles.flatMap((file) =>
      computedScrollLeftSites(readScannedSource(file)).map((rhs) => `${file}: .scrollLeft = ${rhs}`)
    );
    expect(offenders, "出现了第二份水平定位实现").toEqual([]);
  });

  it("水平定位写在提交之后：读 DOM 矩形不能发生在 setState updater 里", () => {
    for (const file of [CODE_VIEW, CODE_EDITOR]) {
      const blocks = layoutEffectBlocks(read(file));
      expect(
        blocks.some((block) => block.includes("revealMarkHorizontally")),
        `${file} 没在 useLayoutEffect 里做水平定位（在 updater 里量只能量到上一处命中的矩形）`
      ).toBe(true);
    }
  });

  it("编辑态改完 textarea 的偏移必须同步高亮层，否则着色层与选区错开", () => {
    const editor = read(CODE_EDITOR);
    const block = layoutEffectBlocks(editor).find((b) => b.includes("revealMarkHorizontally")) ?? "";
    expect(block, "编辑态的水平定位块里没找到 revealMarkHorizontally").toContain("revealMarkHorizontally");
    expect(block).toMatch(/syncScroll\(\)/);
  });

  it("内容搜索点开的 R74 路径也带水平定位，不许只滚垂直", () => {
    const src = read(CODE_VIEW);
    const locate = src.slice(src.indexOf("locateFirstExternalHit"), src.indexOf("}, [findOpen, hits, scrollLineIntoView]"));
    expect(locate, "找不到 locateFirstExternalHit 的实现体").not.toBe("");
    expect(locate).toContain("scrollLineIntoView(first.line)");
    expect(locate, "外部搜索词路径又退回只滚垂直：长行里的红字在屏幕外").toContain("revealMarkHorizontally");
  });

  it("探针字宽那套旧实现不许复活（量不准 Tab 与中日韩，还多养一份口径）", () => {
    const editor = read(CODE_EDITOR);
    for (const dead of ["PROBE_CHARS", "measureCharWidth", "scrollColumnIntoView", "code-editor-probe"]) {
      expect(editor, `CodeEditor 里又出现了 ${dead}`).not.toContain(dead);
    }
    const styles = readScannedSource("src/styles.css");
    expect(styles, ".code-editor-probe 的样式残留：探针已删，样式该一起删").not.toContain("code-editor-probe");
  });

  it("假布局与手写 DOM 都桩视口相对的矩形：桩成内容坐标等于测了个假几何", () => {
    expect(readScannedSource(FAKE_LAYOUT)).toMatch(/start \* charWidth - scroller\.scrollLeft/);
    expect(readScannedSource(LIB_TEST)).toMatch(/spec\.left - left/);
  });
});
