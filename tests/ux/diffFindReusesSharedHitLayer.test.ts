/**
 * 差异视图的查找必须复用共享命中层（轮48 立口径，轮49 换形状）。
 *
 * 缺陷长什么样：DiffPanel 的一行是**两格**（左 = 旧值 / 右 = 新值），`findCodeHits` 把整份文本
 * 当一个文本流的前提在这里不成立。这种「形状对不上」最容易的收场就是组件里手搓一份正则 + 自己拼
 * `<mark>` —— 轮41 在 UnifiedDiff 上钉过的两条老路（二次转义 `&amp;amp;`、列表命中数与正文标红分叉）
 * 会原样重来一遍。轮48 把二维扫描收进 lib/diffFind，轮49 把「本地状态 + 副作用编排」收进
 * src/lib/useFindLayer.ts，于是守卫分三层，少钉一层就退回那一层各自一份：
 *
 * 1. **宿主（DiffPanel / UnifiedDiff）**：只负责「渲染出来的行集」与两条标记出口，
 *    不许出现第二份匹配 / 第二份标记 / 第二份状态机；
 * 2. **共享层（useFindLayer）**：命中表、当前组、量 DOM 定位、净空编排的唯一出处；
 * 3. **lib/diffFind**：只做二维表上的扫描，口径透传给 findCodeHits，不碰 DOM、不自己转义。
 *
 * 另钉一条与形状无关的钱（轮28 F-14）：「当前命中」只切 DOM 类，标记层 memo 不许依赖它——
 * 否则按一次 Enter 就把整篇 HTML 重新解析一遍。
 *
 * 轮56 再补第四层：外部内容搜索词的**纵向定位**同样只认共享层这一处出口。缺陷长什么样：批量对比
 * 左栏写着「A 2 · B 3 第 25 行」，点下去右侧整篇标红却停在第 1 行——`useFindLayer` 里那条当前命中
 * 落地效果被 `!findOpen` 门死了，而外部词从不打开查找栏，于是这条路径上没人负责滚动。修法只许一种：
 * 能力写在共享层，宿主挂到自己**已有的**滚动复位 onReset 上。谁在 DiffView / DiffPanel 里再写一份
 * `scrollTop =`，diff 派就有了第三套滚动实现（与 detailScrollResetSingleSource、codeRevealSingleSource
 * 的口径同源：几何与滚动的第二份实现就是下一轮 bug 的出处）。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource } from "./scanUtils";

const PANEL = "src/components/DiffPanel.tsx";
const UNIFIED = "src/components/UnifiedDiff.tsx";
const DIFF_VIEW = "src/components/DiffView.tsx";
const LAYER = "src/lib/useFindLayer.ts";
const LIB = "src/lib/diffFind.ts";
const HOSTS = [PANEL, UNIFIED];

/** 取某个 useLayoutEffect 块（含依赖数组），口径与 currentHitMustNotRehighlightDocument 一致。 */
function layoutEffects(src: string): Array<{ body: string; deps: string }> {
  return [...src.matchAll(/useLayoutEffect\(\(\) => \{[\s\S]*?\n\s*\}, \[([^\]]*)\]\);/g)].map((m) => ({
    body: m[0],
    deps: (m[1] ?? "").replace(/\s+/g, " ").trim(),
  }));
}

/**
 * 外部搜索词的定位接线（轮56）：宿主只许把共享层那条能力挂到**已有的**滚动复位上，
 * 顺序由那个 hook 保证（绘制前归零 → 再定位），所以不许宿主自己排两条 effect。
 */
const LOCATE_WIRING = /useScrollResetOnContentChange\([^;]*find\.locateFirstExternalHit\s*\)/;
/** 「同一份正文里改词」那条出口：依赖数组只许写 externalTerm（R4，多一颗就会把用户拽回第一处）。 */
const LOCATE_EFFECT = /useEffect\(\(\) => \{\s*locateFirstExternalHit\(\);\s*\}, \[externalTerm\]\);/;
/** 自己动手写滚动偏移——diff 派只许共享层那一处。 */
const SCROLL_ASSIGN = /\.scroll(?:Top|Left)\s*=/;

/** 取共享层 locateFirstExternalHit 的实现体（剥注释后按两个出口之间的片段算）。 */
function locateImpl(src: string): string {
  const start = src.indexOf("const locateFirstExternalHit = useCallback(");
  if (start < 0) return "";
  const end = src.indexOf("useEffect(", start);
  return src.slice(start, end < 0 ? start + 1_500 : end);
}

/** 取 `decl` 这条 memo 的依赖数组内容；解析不到返回 null。 */
function depsOf(src: string, decl: string): string | null {
  const start = src.indexOf(decl);
  if (start < 0) return null;
  const found = /,\s*\[([^\]]*)\]\s*\);/.exec(src.slice(start, start + 2000));
  return found ? (found[1] ?? "").replace(/\s+/g, " ").trim() : null;
}

describe("差异视图复用共享命中层（轮48/轮49）", () => {
  const panel = readScannedSource(PANEL);
  const unified = readScannedSource(UNIFIED);
  const layer = readScannedSource(LAYER);
  const lib = readScannedSource(LIB);

  it("两个宿主里不许出现第二份匹配、第二份标记、第二份状态机", () => {
    const legacy: Array<[string, RegExp]> = [
      ["手搓匹配正则（大小写 / 全词只归 textMatch）", /new RegExp\(/],
      ["自己拼 <mark> 标签（二次转义事故的老路）", /<mark/],
      ["在组件里写死标记类名（类名只许 lib 与 CSS 两侧同源）", /search-hit/],
      ["绕过 currentHitSelector 手搓命中选择器（编号语义会分叉）", /\[data-hit/],
      ["直接调一维文本流的枚举（一行两格的前提在这儿不成立）", /findCodeHits|MAX_CODE_HITS/],
      // 轮49：状态与编排已在共享层，宿主再出现下面任何一颗就是第四份 state
      ["自己写查找栏开关状态", /\bsetFindOpen\b/],
      ["自己算顶部净空", /padTopForFindBar|measureFindBarHeight/],
      ["自己定位命中行", /revealRowVertically/],
      ["自己数当前组（第二套编号）", /currentDiffGroup|clampIndex\(/],
    ];
    for (const file of HOSTS) {
      const src = readScannedSource(file);
      for (const [label, re] of legacy) {
        expect(src, `${file} 里出现「${label}」`).not.toMatch(re);
      }
      expect(src, `${file} 没接共享层 useFindLayer`).toMatch(/useFindLayer\(\{/);
    }
  });

  it("命中表住在共享层，标记层住在两个宿主（都经 lib 的共享入口）", () => {
    // 命中枚举 / 当前组 / 中性口径只在共享层出现一次
    expect(layer).toMatch(/from "\.\/diffFind"/);
    for (const entry of ["findDiffHits", "currentDiffGroup", "currentHitSelector", "CURRENT_HIT_CLASS"]) {
      expect(layer, `共享层不再经 ${entry}`).toContain(entry);
    }
    expect(layer, "命中表不再是「渲染行集 + 提交后的词 + 口径」这一份").toMatch(
      /findDiffHits\(\s*rows,\s*effectiveTerm\.trim\(\),\s*matchOptions\s*\)/
    );
    // 宿主侧负责把命中摊到「这一格」上：标红仍走共享标记层
    expect(panel).toMatch(/from "\.\.\/lib\/diffFind"/);
    expect(unified).toMatch(/from "\.\.\/lib\/diffFind"/);
    for (const file of HOSTS) {
      const src = readScannedSource(file);
      for (const entry of ["marksForRowSide", "toLineHits", "baseIndexForSide", "markHighlightedHtml"]) {
        expect(src, `${file} 的标红不再复用共享层的 ${entry}`).toContain(entry);
      }
      expect(src, `${file} 的标记层不再从 lib/codeLines 引入口`).toMatch(/from "\.\.\/lib\/codeLines"/);
    }
    // 命中表只扫渲染出来的行集：勾掉「仅显示变更」后隐藏行留在编号里 = Enter 落到 DOM 里不存在的 mark
    expect(panel, "DiffPanel 的命中行集不再是渲染出来的那份 rows").toMatch(
      /const findRows = useMemo<DiffFindRow\[\]>\(\s*\(\) => rows\.map\(/
    );
    expect(unified, "UnifiedDiff 的命中行集不再是渲染出来的那份 lines").toMatch(
      /const findRows = useMemo<DiffFindRow\[\]>\(\s*\(\) => lines\.map\(/
    );
  });

  it("定位量 DOM，不用代码视图的行高公式；横向 reveal 本轮排除", () => {
    expect(layer).toMatch(/from "\.\/codeScroll"/);
    expect(layer, "共享层不再量矩形定位（换回行高公式就会跳错行）").toContain("revealRowVertically(");
    expect(layer, "共享层不再用同一个条高净空出口").toContain("padTopForFindBar(");
    expect(layer).toContain("measureFindBarHeight(");
    const banned: Array<[string, RegExp]> = [
      ["代码视图的行高常量（pre-wrap + break-all 下这个等式不成立）", /ROW_H/],
      ["代码视图的固定行距净空（diff 的净空是锚点高度，不是一个常数）", /PAD_TOP\b/],
      ["给 diff 正文做横向 reveal（本轮明确排除，要做得连 DOM 一起量）", /revealMarkHorizontally/],
    ];
    banned.forEach(([label, re]) => {
      expect(layer, `共享层出现「${label}」`).not.toMatch(re);
    });
    // 锚点必须是滚动容器的在流子元素：靠它撑净空，不动 padding / overflow
    for (const file of HOSTS) {
      const src = readScannedSource(file);
      expect(src, `${file}：查找条不再是正文的在流锚点（改成浮层就会盖住第一行）`).toMatch(
        /<div className="diff-find-anchor"[\s\S]{0,120}\{findOpen \? \(/
      );
      expect(src, `${file}：定位用的行号属性被删了`).toContain("data-row-index={");
    }
  });

  it("「当前是哪一组」只有一个出处", () => {
    const effect = layoutEffects(layer).find((block) => block.body.includes("revealRowVertically"));
    expect(effect, "找不到当前命中的落地效果（切类 + 定位那条）").toBeTruthy();
    expect(effect!.body, "落地效果又自己夹了一遍序号：行号变红与 <mark> 打类会各说各话").toContain("currentGroup.");
    expect(effect!.body, "落地效果直接按下标取组（第二套编号语义）").not.toMatch(/\.groups\[/);
    expect(effect!.body).not.toMatch(/clampIndex\(/);
    expect(effect!.deps, "落地效果的依赖数组变了").toBe("bodyRef, currentGroup, findOpen, navTick");
    expect(effect!.deps, "依赖里不许出现滚动位置：用户自己拖走之后不该被拽回来").not.toMatch(/scroll/i);
    expect(layer, "共享层里留着第二份序号夹取").not.toMatch(/function clampIndex\(/);
    // 先切类、后量矩形（轮27 的坑换个方向再踩一次）
    expect(
      effect!.body.indexOf("classList.add(CURRENT_HIT_CLASS)") < effect!.body.indexOf("revealRowVertically("),
      "又先量矩形后切类：量到的是上一处的位置"
    ).toBe(true);
    // 每个宿主实例一份记录，不许退回模块级单例（两个并排面板会互相摘掉对方的标记）
    expect(layer, "current 类的记账不再是 hook 内 useRef").toMatch(/const currentHitMarksRef = useRef<HTMLElement\[\]>\(\[\]\);/);
    expect(layer, "current 类的记账又变成模块级单例").not.toMatch(/^let currentHitMarksRef/m);
  });

  it("当前命中只切 DOM 类，标记层 memo 不依赖它", () => {
    const base = depsOf(panel, "const baseHtml = useMemo(");
    expect(base, "单元格的基础高亮层解析不到依赖").toBeTruthy();
    expect(base!, `只许跟「这一格的文本 + 格式」有关：${base}`).toBe("text, format");
    const marked = depsOf(panel, "const markedHtml = useMemo(");
    expect(marked, "单元格的标记层解析不到依赖").toBeTruthy();
    expect(marked!, `标记层只许跟「本格分到哪几处」有关：${marked}`).toBe("baseHtml, marks");
    expect(marked!, "当前命中又圈回标记层依赖（按一次 Enter 重解析一遍 HTML）").not.toMatch(/activeIdx|current/);
    // 轮49：单列视图同一条钱——HTML memo 不许看当前组，行号变红在渲染时算
    const unifiedMarked = depsOf(unified, "const markedLines = useMemo(");
    expect(unifiedMarked, "单列视图的标记层解析不到依赖").toBeTruthy();
    expect(unifiedMarked!, `单列视图的标记层不许看当前序号：${unifiedMarked}`).not.toMatch(/activeIdx|currentGroup|currentMarkIndexes|navTick/);
    expect(unified, "单列视图的行号命中态不再在渲染时算").toMatch(/gutterClass\(l\.hits, i\)/);
    // 命中表本身也不许因为序号变化重算
    const hits = depsOf(layer, "const result = useMemo(");
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
    expect(lib, "默认预算不再是代码视图那个上限").toMatch(/limit = MAX_CODE_HITS/
    );
    expect(lib, "上限停在格这一层就不拦 DOM 膨胀了").toMatch(/if \(marks\.length >= limit\)/);
    // 组内编号连号是 currentHitSelector 能选出正确节点的前提
    expect(lib, "编号不再按标红单元逐个分配（组内会重号）").toMatch(/const index = marks\.length;/);
  });

  it("换文件必须滚动归零（轮48 修的那条真 bug）", () => {
    expect(panel, "DiffPanel 又没接页面级滚动复位：批量态换文件会带着上一份的滚动位置").toContain(
      "useScrollResetOnContentChange("
    );
    expect(panel).toMatch(/from "\.\.\/lib\/useScrollResetOnContentChange"/);
    expect(panel, "复位条件不再看正文本身").toMatch(/leftText, rightText/);
    // 轮49：换内容的查找出口是一条按名字说清语义的 reset，不许复用会移焦的 closeFind
    expect(panel, "DiffPanel 换内容不再走共享层的 resetFindForNewContent").toContain("resetFindForNewContent(");
    expect(panel, "DiffPanel 换内容误用 closeFind（会把焦点从用户点的列表项上抢走）").not.toMatch(/closeFind\(\);/);
    expect(layer, "共享层不再有「换内容收起」这条不移焦的出口").toMatch(/const resetFindForNewContent = useCallback\(/);
  });

  it("外部搜索词的定位只认共享层这一处出口（轮56）", () => {
    const impl = locateImpl(layer);
    expect(impl, "共享层没有 locateFirstExternalHit：外部搜索词又回到只标红不滚动").not.toBe("");
    expect(layer, "共享层少把这条能力导给宿主（宿主就会自己写 scrollTop）").toMatch(/locateFirstExternalHit: \(\) => boolean;/);
    expect(layer, "共享层的 return 少了这条能力").toMatch(/\n    locateFirstExternalHit,/);

    // 三道门与 CodeView 的 R74 逐条对齐，少一道就会误伤别的口径
    const gates: Array<[string, RegExp]> = [
      ["查找栏开着不插手（栏有自己的当前命中语义）", /if \(findOpen\) return false;/],
      ["空词不插手", /if \(!externalTerm\.trim\(\)\) return false;/],
      ["零命中不插手（用户就该看到文件开头）", /const first = result\.groups\[0\];\s*if \(!first\) return false;/],
      ["落在**第一处**命中那一行", /revealRowVertically\(body, body\.querySelector\(`\[data-row-index="\$\{first\.rowIndex\}"\]`\)\)/],
    ];
    for (const [label, re] of gates) {
      expect(impl, `locateFirstExternalHit 少了「${label}」`).toMatch(re);
    }
    // 量不到高度那一道归 lib/codeScroll（neededScrollTopToCenter 是唯一的判据处），本层重复写
    // 就有第二处真相，而且变异测试下会假绿——轮56 的电池第一轮就是这么抓到重复门的。
    expect(impl, "共享层又抄了一份容器高度判据：几何口径只许 lib/codeScroll 那一处").not.toMatch(/clientHeight/);
    expect(impl, "共享层绕过 lib/codeScroll 直接写偏移").not.toMatch(SCROLL_ASSIGN);

    // 两条出口各管一半：改词走共享层这条，换正文走宿主那条
    expect(layer, "「改词」出口的依赖数组不再只认 externalTerm").toMatch(LOCATE_EFFECT);
    for (const file of HOSTS) {
      const src = readScannedSource(file);
      expect(src, `${file} 换正文时没把定位接到滚动复位的 onReset：点批量列表的下一个命中行会停在文件开头`).toMatch(LOCATE_WIRING);
      expect(src, `${file} 里出现了第二份滚动赋值`).not.toMatch(SCROLL_ASSIGN);
    }
    // DiffView 手里就攥着「第 N 行」那个数字，它最容易顺手自己滚（scrollIntoView 那条是步进导航，不算）
    expect(readScannedSource(DIFF_VIEW), "DiffView 自己写了一份滚动赋值：diff 派的定位出口就有了第二处").not.toMatch(SCROLL_ASSIGN);
  });

  it("自检：退回第二份实现必须判红", () => {
    // 变异一：行高公式回来
    const withRowH = layer.replace("revealRowVertically(body,", "const ROW_H = 18;\n    revealRowVertically(body,");
    expect(/ROW_H/.test(withRowH), "变异没落到源码里，这条自检是空转").toBe(true);
    // 变异二：落地效果自己夹序号
    const withClamp = layer.replace("currentGroup.markIndexes", "result.groups[clampIndex(activeIdx, 0)].markIndexes");
    expect(withClamp !== layer, "变异二没落进源码").toBe(true);
    expect(/result\.groups\[/.test(withClamp), "按下标取组这条判据没咬住").toBe(true);
    // 变异三：当前命中圈回标记层依赖
    const marked = depsOf(panel, "const markedHtml = useMemo(");
    expect(marked).toBe("baseHtml, marks");
    expect(panel.split(`[${marked}]`).length - 1, "标记层依赖的字面在源码里不止一处，变异会打偏").toBe(1);
    const markedMutant = panel.replace(`[${marked}]`, `[${marked}, activeIdx]`);
    expect(depsOf(markedMutant, "const markedHtml = useMemo("), "变异三没落进依赖数组").toBe("baseHtml, marks, activeIdx");
    // 变异四（轮49）：宿主退回自己攥一份状态机
    const hostMutant = unified.replace("const find = useFindLayer({", "const [findOpen, setFindOpen] = useState(false);\n  const find = useFindLayer({");
    expect(hostMutant !== unified, "变异四没落进源码").toBe(true);
    expect(hostMutant, "宿主自己攥状态这一步没被挡住").toMatch(/\bsetFindOpen\b/);
    // 变异五（轮56）：宿主摘掉定位接线（退回「只标红不滚动」）
    const wiringMutant = panel.replace(", find.locateFirstExternalHit)", ")");
    expect(wiringMutant !== panel, "变异五没落进源码").toBe(true);
    expect(wiringMutant, "宿主摘掉 locateFirstExternalHit 这一步没被挡住").not.toMatch(LOCATE_WIRING);
    // 变异六（轮56）：改词出口的依赖数组多攢一颗，用户自己滚开的位置会被反复拽回第一处
    const depsMutant = layer.replace("}, [externalTerm]);", "}, [externalTerm, locateFirstExternalHit]);");
    expect(depsMutant !== layer, "变异六没落进源码").toBe(true);
    expect(depsMutant, "依赖数组多攢一颗这一步没被挡住").not.toMatch(LOCATE_EFFECT);
    // 变异七（轮56）：本层重复写高度判据（看着更保险，实际把几何口径劈成两处，还让电池假绿）
    const dupGate = locateImpl(layer).length > 0 && layer.replace("if (!body) return false;", "if (!body || body.clientHeight <= 0) return false;");
    expect(dupGate !== layer, "变异七没落进源码").toBe(true);
    expect(locateImpl(dupGate as string), "本层重复判高度这一步没被挡住").toMatch(/clientHeight/);
  });
});
