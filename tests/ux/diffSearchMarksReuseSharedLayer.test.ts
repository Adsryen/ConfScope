/**
 * 「高亮变更」视图里的正文搜索标记只许复用共享标记层（轮41 R41-2 / R41-3 / R41-6）。
 *
 * 缺陷长什么样（真机取证见 `.trellis/tasks/10-19-10-19-ui-ux-41/prd.md`）：历史 tab 的默认视图是
 * UnifiedDiff（`rawView` 初值 false），轮40 只把页面搜索词接到了「原始内容」的 CodeView，
 * 于是那一屏正文一处都不标（实测 `.diff-panel` 内 mark = 0，而行文本里确实有 enabled）。
 *
 * 本轮接的是复用：`markLineSearchHits` = `findCodeHits` + `markHighlightedHtml`，
 * 偏移按「这一行自己的文本流」从 0 起算。守卫钉四件事，少钉一件就会退回第二份实现：
 * 1. 组件只许经共享入口叠标记，不许自己拼 `<mark>` / `replace` / 手搓正则 ——
 *    那是二次转义事故（`&amp;amp;`）与「列表命中数 vs 正文标红分叉」的老路；
 * 2. 逐行标记的 `data-hit` 只是**行内下标**，跨行重号 ⇒ 这条路径不许借用
 *    `currentHitSelector` / `CURRENT_HIT_CLASS` 那套「全篇唯一编号」的当前命中语义；
 * 3. 词只有一个出处：ConfigBrowser 算一次，HistoryView 原样透传给两个内容视图，
 *    中间任何一环再算一遍 `searchMode` / `isContentSearchActive` 就是第三份判定；
 * 4. diff 行的语义背景色（add 绿 / del 红）不许被搜索色覆盖，命中行指示只走行号变红。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, readScannedSource } from "./scanUtils";

const DIFF = "src/components/UnifiedDiff.tsx";
const HISTORY = "src/components/HistoryView.tsx";
const BROWSER = "src/components/ConfigBrowser.tsx";
/** 注释里也写着颜色与类名，算之前一律剥掉（与 contrastTokens 同一口径）。 */
const CSS = readFileSync(join(PROJECT_ROOT, "src/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** 取某个选择器规则块里的声明文本。 */
function cssBlock(selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, (ch) => "\\" + ch);
  const found = new RegExp(`${escaped} \\{([^}]*)\\}`, "m").exec(CSS);
  return found ? found[1] : null;
}

describe("diff 视图的搜索标记复用共享层（轮41）", () => {
  const diffSrc = readScannedSource(DIFF);

  it("标记必须经 codeLines 的共享入口，组件内不许出现第二份标记实现", () => {
    expect(diffSrc, "UnifiedDiff 必须用 ../lib/codeLines 的 markLineSearchHits").toMatch(/markLineSearchHits/);
    expect(diffSrc).toMatch(/from "\.\.\/lib\/codeLines"/);

    const legacy: Array<[string, RegExp]> = [
      ["自己拼 <mark> 标签（二次转义事故的老路）", /<mark/],
      ["在组件里写死标记类名（类名只许在 lib 与 CSS 两侧同源）", /search-hit/],
      ["绕开 findCodeHits 自己匹配（列表口径会分叉）", /\bmatchLiteral\b/],
      ["手搓匹配正则（大小写 / 全词只归 textMatch）", /new RegExp\(/],
    ];
    for (const [label, re] of legacy) {
      expect(diffSrc, `UnifiedDiff 里出现「${label}」`).not.toMatch(re);
    }
  });

  it("行内标记不许借用「全篇唯一编号」的当前命中语义（R41-6）", () => {
    expect(diffSrc, "data-hit 在逐行标记下只是行内下标，跨行重号").not.toMatch(/currentHitSelector/);
    expect(diffSrc).not.toMatch(/CURRENT_HIT_CLASS|search-hit-current|data-hit/);
  });

  it("词只有一个出处：ConfigBrowser 算一次，HistoryView 原样透传给两个内容视图", () => {
    const browserSrc = readScannedSource(BROWSER);
    const historySrc = readScannedSource(HISTORY);

    expect(browserSrc.match(/isContentSearchActive/g)?.length).toBeGreaterThan(0);
    expect(historySrc, "HistoryView 不许复制 searchMode 判定").not.toMatch(/isContentSearchActive|searchMode/);
    expect(diffSrc, "UnifiedDiff 不许自己判定搜索态、也不许起第二份词状态").not.toMatch(
      /isContentSearchActive|searchMode|useState[^\n]*[Tt]erm/
    );

    // 两个内容视图同源于同一个 prop，不许出现第三种传词形状
    const passes = [...historySrc.matchAll(/searchTerm=\{([^}]*)\}/g)].map((m) => m[1].trim());
    expect(passes, "CodeView 与 UnifiedDiff 都要接词，且只透传 prop").toEqual(["searchTerm", "searchTerm"]);
  });

  it("命中指示只走行号变红，diff 行的语义背景色不被搜索色覆盖（R41-3）", () => {
    const gutter = cssBlock(".udiff-gutter.is-hit");
    expect(gutter, "缺少 .udiff-gutter.is-hit：diff 视图的命中行指示通道").not.toBeNull();
    expect(gutter).toMatch(/var\(--red-h\)/);

    expect(cssBlock(".udiff-text .search-hit"), "diff 里的命中词底色要与 .code-area 同档").toMatch(/rgba\(244, 71, 71, 0\.28\)/);

    // 语义色必须还是那两个令牌，且不许出现「搜索命中行」背景类
    expect(cssBlock(".udiff-row.add")).toMatch(/background: var\(--diff-add-bg\)/);
    expect(cssBlock(".udiff-row.del")).toMatch(/background: var\(--diff-del-bg\)/);
    expect(CSS, "不许给 diff 行叠搜索背景：那会把语义色挤掉").not.toMatch(/\.udiff-row\.is-hit|\.udiff-row\.search-hit/);
  });

  it("轮49：两条标红出口互斥——栏没开时才走外部词那颗，不许叠两层红", () => {
    const memo = diffSrc.slice(diffSrc.indexOf("const markedLines = useMemo("), diffSrc.indexOf("const identical"));
    expect(memo.length, "读不到 markedLines 那条 memo（取样点漂了）").toBeGreaterThan(0);
    expect(memo, "开栏 / 关栏两条分支不见了").toMatch(/if \(findOpen\) \{/);
    const openBranch = memo.slice(memo.indexOf("if (findOpen) {"), memo.indexOf("const marked = markLineSearchHits"));
    const closedBranch = memo.slice(memo.indexOf("const marked = markLineSearchHits"));
    expect(openBranch, "开栏时不再经共享命中层标红（会绕开 Aa / ab| 口径）").toMatch(/markHighlightedHtml\(/);
    expect(
      closedBranch,
      "关栏后不再走轮41 那条外部词路径：浏览态「按内容搜索」点进历史默认视图又标不上了"
    ).toMatch(/markLineSearchHits\(baseHtml, l\.text, searchTerm \?\? ""\)/);
    expect(openBranch, "开栏分支里同时出现两颗词来源（外部词与栏内词会叠红）").not.toMatch(/markLineSearchHits/);
    expect(closedBranch, "外部词路径借用「全篇唯一编号」就是 R41-6 那条老路").not.toMatch(/baseIndexForSide|toLineHits|marksForRowSide/);
    // 计数与正文同源：外部词进共享层做命中表，栏一开由 effectiveTerm 接管（CodeView 同一句话）
    expect(diffSrc, "UnifiedDiff 的外部词没交给共享命中层（计数与标红会各说各话）").toMatch(/externalTerm: searchTerm \?\? "",/);
    expect(diffSrc, "UnifiedDiff 起了第二份词状态").not.toMatch(/useState[^\n]*[Tt]erm/);
  });

  it("自检：把两条出口的条件反过来必须判红", () => {
    const honest = "if (findOpen) {";
    expect(diffSrc, "取样点漂了：源码里读不到那条分支").toContain(honest);
    const regressed = diffSrc.replace(honest, "if (!findOpen) {");
    expect(regressed !== diffSrc, "变异没落进被测文本").toBe(true);
    expect(regressed).not.toMatch(/if \(findOpen\) \{/);
  });
});
