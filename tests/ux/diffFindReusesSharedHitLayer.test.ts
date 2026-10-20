/**
 * 并排差异的查找必须复用共享命中层（轮48）。
 *
 * 缺陷长什么样：DiffPanel 的一行是**两格**（左 = 旧值 / 右 = 新值），`findCodeHits` 把整份文本
 * 当一个文本流的前提在这里不成立。这种「形状对不上」最容易的收场就是组件里手搓一份正则 + 自己拼
 * `<mark>` —— 轮41 在 UnifiedDiff 上钉过的两条老路（二次转义 `&amp;amp;`、列表命中数与正文标红分叉）
 * 会原样重来一遍。本轮把二维扫描收进 lib/diffFind，匹配口径仍走 textMatch，标红仍走 markHighlightedHtml。
 *
 * 守卫钉五件事，少钉一件就退回第二份实现：
 * 1. 组件不许出现第二份匹配 / 第二份标记：`new RegExp` / `<mark` / 写死 `search-hit` / 手搓 `[data-hit=`；
 * 2. 组件不许经 `findCodeHits` 自己数命中，必须经 `findDiffHits`，命中表再经
 *    `marksForRowSide` / `toLineHits` / `baseIndexForSide` 喂给共享标记层；
 * 3. 定位必须量 DOM（`revealRowVertically`）——`.diff-cell` 是 pre-wrap + break-all，
 *    代码视图那套 `padTop + i * ROW_H` 在这里根本不成立；横向 reveal 本轮明确排除；
 * 4. 「当前是哪一组」只有一个出处（`currentDiffGroup` 的 memo），组件里不许再夹一次序号；
 *    「当前命中」只切 DOM 类，标记层 memo 不许依赖它（轮28 F-14 同一条钱）；
 * 5. lib/diffFind 只做二维表上的扫描：口径透传给 findCodeHits，不碰 DOM、不自己转义、不自己大小写。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource } from "./scanUtils";

const PANEL = "src/components/DiffPanel.tsx";
const LIB = "src/lib/diffFind.ts";

/** 取某个 useLayoutEffect 块（含依赖数组），口径与 currentHitMustNotRehighlightDocument 一致。 */
function layoutEffects(src: string): Array<{ body: string; deps: string }> {
  return [...src.matchAll(/useLayoutEffect\(\(\) => \{[\s\S]*?\n\s*\}, \[([^\]]*)\]\);/g)].map((m) => ({
    body: m[0],
    deps: (m[1] ?? "").replace(/\s+/g, " ").trim(),
  }));
}

/** 取 `decl` 这条 memo 的依赖数组内容；解析不到返回 null。 */
function depsOf(src: string, decl: string): string | null {
  const start = src.indexOf(decl);
  if (start < 0) return null;
  const found = /,\s*\[([^\]]*)\]\s*\);/.exec(src.slice(start, start + 2000));
  return found ? (found[1] ?? "").replace(/\s+/g, " ").trim() : null;
}

describe("并排差异复用共享命中层（轮48）", () => {
  const panel = readScannedSource(PANEL);
  const lib = readScannedSource(LIB);

  it("组件里不许出现第二份匹配与第二份标记", () => {
    const legacy: Array<[string, RegExp]> = [
      ["手搓匹配正则（大小写 / 全词只归 textMatch）", /new RegExp\(/],
      ["自己拼 <mark> 标签（二次转义事故的老路）", /<mark/],
      ["在组件里写死标记类名（类名只许 lib 与 CSS 两侧同源）", /search-hit/],
      ["绕过 currentHitSelector 手搓命中选择器（编号语义会分叉）", /\[data-hit/],
      ["直接调一维文本流的枚举（一行两格的前提在这儿不成立）", /findCodeHits|MAX_CODE_HITS/],
    ];
    legacy.forEach(([label, re]) => {
      expect(panel, `DiffPanel 里出现「${label}」`).not.toMatch(re);
    });
  });

  it("命中表与标记层都经 lib 的共享入口", () => {
    expect(panel).toMatch(/from "\.\.\/lib\/diffFind"/);
    ["findDiffHits", "marksForRowSide", "toLineHits", "baseIndexForSide", "currentDiffGroup"].forEach((entry) => {
      expect(panel, `DiffPanel 不再经 lib/diffFind 的 ${entry}`).toContain(entry);
    });
    expect(panel).toMatch(/from "\.\.\/lib\/codeLines"/);
    ["markHighlightedHtml", "currentHitSelector", "CURRENT_HIT_CLASS"].forEach((entry) => {
      expect(panel, `DiffPanel 的标红不再复用共享标记层的 ${entry}`).toContain(entry);
    });
    // 命中表只扫渲染出来的行集：勾掉「仅显示变更」后隐藏行留在编号里 = Enter 落到 DOM 里不存在的 mark
    expect(panel, "命中表的行集不再是渲染出来的那份 rows").toMatch(
      /const findRows = useMemo<DiffFindRow\[\]>\(\s*\(\) => rows\.map\(/
    );
  });

  it("定位量 DOM，不用代码视图的行高公式；横向 reveal 本轮排除", () => {
    expect(panel).toMatch(/from "\.\.\/lib\/codeScroll"/);
    expect(panel, "DiffPanel 不再量矩形定位（换回行高公式就会跳错行）").toContain("revealRowVertically(");
    expect(panel, "DiffPanel 不再用同一个条高净空出口").toContain("padTopForFindBar(");
    expect(panel).toContain("measureFindBarHeight(");
    const banned: Array<[string, RegExp]> = [
      ["代码视图的行高常量（pre-wrap + break-all 下这个等式不成立）", /ROW_H/],
      ["代码视图的固定行距净空（diff 的净空是锚点高度，不是一个常数）", /PAD_TOP\b/],
      ["给 diff 正文做横向 reveal（本轮明确排除，要做得连 DOM 一起量）", /revealMarkHorizontally/],
    ];
    banned.forEach(([label, re]) => {
      expect(panel, `DiffPanel 出现「${label}」`).not.toMatch(re);
    });
    // 锚点必须是 .diff-body 的在流子元素：靠它撑净空，不动 padding / overflow
    expect(panel, "查找条不再是 diff 正文的在流锚点（改成浮层就会盖住第一行）").toMatch(
      /<div className="diff-find-anchor"[^>]*>\s*\{findOpen \? \(/
    );
  });

  it("「当前是哪一组」只有一个出处", () => {
    const effect = layoutEffects(panel).find((block) => block.body.includes("revealRowVertically"));
    expect(effect, "找不到当前命中的落地效果（切类 + 定位那条）").toBeTruthy();
    expect(effect!.body, "落地效果又自己夹了一遍序号：行号变红与 <mark> 打类会各说各话").toContain("currentGroup.");
    expect(effect!.body, "落地效果直接按下标取组（第二套编号语义）").not.toMatch(/findResult\.groups\[/);
    expect(effect!.body).not.toMatch(/clampIndex\(/);
    expect(effect!.deps, "落地效果的依赖数组变了").toBe("currentGroup, findOpen, navTick");
    expect(effect!.deps, "依赖里不许出现滚动位置：用户自己拖走之后不该被拽回来").not.toMatch(/scroll/i);
    expect(panel, "组件里还留着第二份序号夹取").not.toMatch(/function clampIndex\(/);
    // 先切类、后量矩形（轮27 的坑换个方向再踩一次）
    expect(
      effect!.body.indexOf("classList.add(CURRENT_HIT_CLASS)") < effect!.body.indexOf("revealRowVertically("),
      "又先量矩形后切类：量到的是上一处的位置"
    ).toBe(true);
  });

  it("当前命中只切 DOM 类，标记层 memo 不依赖它", () => {
    const base = depsOf(panel, "const baseHtml = useMemo(");
    expect(base, "单元格的基础高亮层解析不到依赖").toBeTruthy();
    expect(base!, `只许跟「这一格的文本 + 格式」有关：${base}`).toBe("text, format");
    const marked = depsOf(panel, "const markedHtml = useMemo(");
    expect(marked, "单元格的标记层解析不到依赖").toBeTruthy();
    expect(marked!, `标记层只许跟「本格分到哪几处」有关：${marked}`).toBe("baseHtml, marks");
    expect(marked!, "当前命中又圈回标记层依赖（按一次 Enter 重解析一遍 HTML）").not.toMatch(/activeIdx|current/);
    // 命中表本身也不许因为序号变化重算
    const hits = depsOf(panel, "const findResult = useMemo(");
    expect(hits!, "命中表依赖里出现了当前序号").not.toMatch(/activeIdx|currentGroup|navTick/);
    // 空命中必须是同一份常量引用，否则每次渲染都重算 diff 命中表
    expect(lib, "空结果不再是同一份常量引用").toMatch(/return EMPTY_DIFF_FIND;/);
  });

  it("lib/diffFind 只做二维表上的扫描", () => {
    const banned: Array<[string, RegExp]> = [
      ["自己搓匹配正则", /new RegExp\(/],
      ["自己做大小写折叠（口径只归 textMatch）", /toLowerCase|toUpperCase/],
      ["自己拼标记 HTML", /<mark|dangerouslySetInnerHTML/],
      ["碰 DOM", /document\.|querySelector|scrollTop/],
      ["自己数命中（必须委托 findCodeHits）", /while \(idx/i],
    ];
    banned.forEach(([label, re]) => {
      expect(lib, `lib/diffFind 里出现「${label}」`).not.toMatch(re);
    });
    expect(lib).toMatch(/import \{ findCodeHits, MAX_CODE_HITS, type CodeHit \} from "\.\/codeLines";/);
    // 口径与预算都必须原样透传，且停在「标红单元」这一层而不是「格」这一层
    expect(lib, "findCodeHits 不再收到 options").toMatch(/findCodeHits\(text, needle, options, limit - marks\.length\)/);
    expect(lib, "默认预算不再是代码视图那个上限").toMatch(/limit = MAX_CODE_HITS/);
    expect(lib, "上限停在格这一层就不拦 DOM 膨胀了").toMatch(/if \(marks\.length >= limit\)/);
    // 组内编号连号是 currentHitSelector 能选出正确节点的前提
    expect(lib, "编号不再按标红单元逐个分配（组内会重号）").toMatch(/const index = marks\.length;/);
  });

  it("换文件必须滚动归零（本轮修的那条真 bug）", () => {
    expect(panel, "DiffPanel 又没接页面级滚动复位：批量态换文件会带着上一份的滚动位置").toContain(
      "useScrollResetOnContentChange("
    );
    expect(panel).toMatch(/from "\.\.\/lib\/useScrollResetOnContentChange"/);
    expect(panel, "复位条件不再看正文本身").toMatch(/leftText, rightText/);
  });

  it("自检：退回第二份实现必须判红", () => {
    // 变异一：行高公式回来
    const withRowH = panel.replace("revealRowVertically(body,", "const ROW_H = 18;\n    revealRowVertically(body,");
    expect(/ROW_H/.test(withRowH), "变异没落到源码里，这条自检是空转").toBe(true);
    // 变异二：落地效果自己夹序号
    const withClamp = panel.replace("currentGroup.markIndexes", "findResult.groups[clampIndex(activeIdx, 0)].markIndexes");
    expect(withClamp !== panel, "变异二没落进源码").toBe(true);
    expect(/findResult\.groups\[/.test(withClamp), "按下标取组这条判据没咬住").toBe(true);
    // 变异三：当前命中圈回标记层依赖
    const marked = depsOf(panel, "const markedHtml = useMemo(");
    expect(marked).toBe("baseHtml, marks");
    expect(panel.split(`[${marked}]`).length - 1, "标记层依赖的字面在源码里不止一处，变异会打偏").toBe(1);
    const markedMutant = panel.replace(`[${marked}]`, `[${marked}, activeIdx]`);
    expect(depsOf(markedMutant, "const markedHtml = useMemo("), "变异三没落进依赖数组").toBe("baseHtml, marks, activeIdx");
  });
});
