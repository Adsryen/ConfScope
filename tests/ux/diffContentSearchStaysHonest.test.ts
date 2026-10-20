/**
 * 批量对比的跨项内容搜索必须「既截断，又说实话」（轮55 C线）。
 *
 * 这条守卫盯的是两类静默失败，都是配置浏览那条线已经付过学费的：
 * 1. **假上限**：扫完再 `slice` 看着有上限，实际一分钟都省不下（与 tests/ux/hitCapMustBeVisibleInCount
 *    同一族纪律）。截断还必须发生在扫描循环里，且「刚好凑满上限且已扫到最后一条」不许报成触顶——
 *    那时数字是真总数，多挂一句「仅列出前 100 个」是在把用户引到一个不存在的截断上。
 * 2. **作用域说谎**：搜的是已加载的对比正文，不是整个命名空间。计数文案必须同时给出
 *    命中配置数、命中处数、以及截断时的上限与作用域条数，否则「没搜到」会被读成「这里没有」。
 * 3. **词分叉**：左栏列表与右侧 diff 必须读同一颗已提交的词。列表按 A 词计数、diff 按 B 词标红，
 *    就是轮44 钉过的「列表说命中了、正文标不出来」那类偏差的第二次发生。
 */
import { describe, expect, it } from "vitest";
import { loadLocale, readScannedSource } from "./scanUtils";

const LIB = "src/lib/diffContentSearch.ts";
const VIEW = "src/components/DiffView.tsx";

/** 循环里攒够就收手（注释已被剥成等长空白，所以允许中间夹说明）。 */
const EARLY_STOP = /if\s*\(\s*hits\.length\s*>=\s*MAX_DIFF_SEARCH_ITEMS\s*\)\s*\{[\s\S]{0,400}?\bbreak\s*;/;
/** 反模式：扫完再切一刀。 */
const LATE_TRUNCATION = /\.slice\(\s*0\s*,\s*MAX_DIFF_SEARCH_ITEMS\s*\)/;

function scanFunctionBody(source: string): string {
  const start = source.indexOf("export function searchDiffContent(");
  expect(start, "找不到 searchDiffContent 的定义").toBeGreaterThanOrEqual(0);
  const rest = source.slice(start);
  const end = rest.search(/\nexport (function|const|interface|type)\b/);
  return end > 0 ? rest.slice(0, end) : rest;
}

describe("跨项内容搜索的截断与作用域（轮55 C线）", () => {
  it("上限常量只有一份，截断发生在扫描循环里", () => {
    const source = readScannedSource(LIB);
    const consts = Array.from(source.matchAll(/export const MAX_DIFF_SEARCH_ITEMS\s*=\s*(\d+)/g), (m) => Number(m[1]));
    expect(consts, "MAX_DIFF_SEARCH_ITEMS 必须且只能定义一次").toHaveLength(1);
    expect(consts[0]).toBeGreaterThan(0);

    const body = scanFunctionBody(source);
    expect(body, "命中没在扫描循环里提前停：扫到底再截断省不下任何时间").toMatch(EARLY_STOP);
    expect(body, "出现「扫完再 slice」的假上限").not.toMatch(LATE_TRUNCATION);
  });

  it("「触顶」= 还有配置没扫，凑满上限但已扫完不算触顶", () => {
    const body = scanFunctionBody(readScannedSource(LIB));
    expect(body, "触顶判定不再是「后面还有没扫的」").toMatch(/capped\s*=\s*i\s*\+\s*1\s*<\s*items\.length/);
    expect(body, "触顶判定退回无条件 true").not.toMatch(/capped\s*=\s*true;/);
  });

  it("空词不发搜索：短路返回空结果，但仍报作用域条数", () => {
    const body = scanFunctionBody(readScannedSource(LIB));
    expect(body, "空词短路不见了：清空输入框会把所有配置算成命中").toMatch(/if\s*\(!needle\)\s*\{/);
    expect(body, "空词分支没把作用域条数带出去").toMatch(/scopeItems\s*,/);
  });

  it("视图只算一次词，列表与 diff 读同一颗已提交的词", () => {
    const view = readScannedSource(VIEW);
    expect(view, "searchDiffContent 在视图里被调了两次以上（两份命中表迟早分叉）").toMatch(
      /const diffSearch = useMemo\(\(\) => searchDiffContent\(batchSearchItems, contentSearchTerm\)/
    );
    expect(view.match(/searchDiffContent\(/g)?.length, "视图里出现了额外的 searchDiffContent 调用站点").toBeLessThanOrEqual(2);
    expect(view, "右侧 diff 没接左栏那颗词（列表命中、正文不标）").toMatch(
      /searchTerm=\{isContentSearchActive \? contentSearchTerm : undefined\}/
    );
    expect(view, "列表项渲染退回未过滤的全量 batchResults（「只看命中项」会被吃掉）").toMatch(
      /\{visibleBatchResults\.map\(\(item\) =>/
    );
  });

  it("中英都把命中配置数、处数与截断上限写进可见文案", () => {
    for (const file of ["zh-CN.json", "en-US.json"]) {
      const locale = loadLocale(file);
      const count = locale["diff.contentSearchCount"];
      const capped = locale["diff.contentSearchCapped"];
      const empty = locale["diff.contentSearchEmpty"];
      expect(count, `${file} 缺 diff.contentSearchCount`).toBeTruthy();
      expect(count, `${file} 的计数丢了命中配置数`).toContain("{items}");
      expect(count, `${file} 的计数丢了命中处数`).toContain("{matches}");
      expect(capped, `${file} 缺 diff.contentSearchCapped`).toBeTruthy();
      expect(capped, `${file} 的截断文案没告诉用户上限是多少`).toContain("{max}");
      expect(capped, `${file} 的截断文案没说作用域有多大`).toContain("{scope}");
      expect(empty, `${file} 缺 diff.contentSearchEmpty`).toBeTruthy();
      expect(empty, `${file} 的无命中文案丢了搜索词`).toContain("{term}");
      expect(empty, `${file} 的无命中文案没说搜了几个配置`).toContain("{scope}");
    }
  });

  // ---- 自检：三种「退回」都必须判红，否则上面的守卫只是装饰 ----
  it("自检一：退回「扫完再 slice」必须判红", () => {
    const body = scanFunctionBody(readScannedSource(LIB));
    const mutant = body.replace(EARLY_STOP, "").replace("return {\n    term: needle,", "return hits.slice(0, MAX_DIFF_SEARCH_ITEMS) && {\n    term: needle,");
    expect(mutant, "变异没落到源码形状上，这条自检是空转").not.toBe(body);
    expect(mutant, "去掉提前 break 后仍满足 EARLY_STOP").not.toMatch(EARLY_STOP);
    expect(mutant, "换成尾部 slice 必须被反模式规则抓到").toMatch(LATE_TRUNCATION);
  });

  it("自检二：触顶判定退回无条件 true 必须判红", () => {
    const body = scanFunctionBody(readScannedSource(LIB));
    const regressed = body.replace(/capped = i \+ 1 < items\.length;/, "capped = true;");
    expect(regressed, "变异没落到源码里").not.toBe(body);
    expect(regressed).not.toMatch(/capped\s*=\s*i\s*\+\s*1\s*<\s*items\.length/);
  });

  it("自检三：diff 出口退回不吃外部词必须判红", () => {
    const view = readScannedSource(VIEW);
    const regressed = view.replace("searchTerm={isContentSearchActive ? contentSearchTerm : undefined}", "active={active}");
    expect(regressed, "变异没落到源码里").not.toBe(view);
    expect(regressed).not.toMatch(/searchTerm=\{isContentSearchActive \? contentSearchTerm : undefined\}/);
  });
});
