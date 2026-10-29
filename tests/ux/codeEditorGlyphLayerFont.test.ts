/**
 * 字形层与光标层同源（轮132，编辑态光标指错字的根因守卫）。
 *
 * CodeEditor 是两层：透明 textarea 画光标与选区，它下面的 <pre><code> 画看得见的字形。
 * 两层共用同一份字体/字号/字距/左内边距是这套结构的**唯一**对齐前提。UA 样式表给 `code`
 * 写着 `font-family: monospace`，作者样式不覆盖就吃这条——而通用 monospace 按系统解析：
 * Linux 落到 DejaVu Sans Mono，Windows/WebView2 落到 Chrome 的等宽默认字体（Courier New 一档）。
 * 光标层那条栈在 Windows 上通常落到 Consolas：0.55em vs 0.6em，每字符差 0.62px，
 * 第 60 列就偏 37px ≈ 5 个字，且**字形层更宽 ⇒ 光标看着停在左边的字上**——
 * 用户报的「编辑窗口光标始终在实际位置靠前、只要编辑模式就不对」就是这个方向。
 *
 * 为什么必须静态读磁盘：本机两种字体若解析到同一条，像素判据（真机 CARET-01/02）量不出差，
 * 全绿照样带着洞进版；jsdom 不实现 UA 样式表，组件测试同样假绿。
 * 轮133 用用户级 fontconfig 别名把栈里的 "SF Mono" 指到窄一档的 Ubuntu Mono（7.00px/字符）、
 * 通用 monospace 留在 DejaVu（7.526px/字符），在这台 Linux 上造出与 Windows 等价的条件：
 * 修复前真机量到 worstDx=36.28px 判红，修复后 0.09px 判绿。配方记在
 * tests/retest/specs/99-s-editor-caret-alignment.spec.ts 顶部。
 *
 * 这里钉三件事，缺一层就还能复发：
 *   1. 两份字形层容器（浏览态 .code-area、编辑态 .code-editor-pre）的 code 都被拉回 inherit；
 *   2. 没有任何一条**能匹配到那块 code** 的规则另写 font-family / font-size / font 简写 /
 *      letter-spacing / padding-left——选择器特异度与书写顺序都可能赢过第 1 条，
 *      所以不能只认这两条精确选择器（轮132 之前漏的就是「有人给 code 补了字体却没人拦」）；
 *   3. 两层共用一份几何声明（.code-editor-pre 与 .code-editor-ta 同块）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CSS = readFileSync(join(PROJECT_ROOT, "src/styles.css"), "utf8");
const EDITOR = readFileSync(join(PROJECT_ROOT, "src/components/CodeEditor.tsx"), "utf8");
const VIEW = readFileSync(join(PROJECT_ROOT, "src/components/CodeView.tsx"), "utf8");

/** 字形层里承载高亮 HTML 的那个 `<code>`：浏览态在 .code-area 内，编辑态在 .code-editor-pre 内。 */
const GLYPH_CODE_SELECTORS = [".code-area code", ".code-editor-pre code"];

/**
 * 代码层链上会出现的容器标记。选择器末段是 `code` 且带了这些上下文之一，就可能压到字形层那块
 * code 上；`pre` 单独按词边界判，免得 .code-prefix / .prepare 之类蹭成假阳性。
 */
const CODE_LAYER_CONTEXT_TOKENS = ["code-editor", "editor-host", "code-view", "code-area", "mono", "hljs"];

interface Rule {
  selectors: string[];
  body: string;
}

/** 把 CSS 拆成规则块（注释先去掉，否则注释里的 {} 会把切分带偏）。 */
function rules(css: string): Rule[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) {
    const selectors = m[1]
      .split(",")
      .map((s) => s.trim().replace(/\s+/g, " "))
      .filter(Boolean);
    out.push({ selectors, body: m[2] });
  }
  return out;
}

/** 这条选择器落在的元素是不是 `<code>` 本身（末段必须是裸 code，`.code-tree` 与 `code.hljs` 都不算）。 */
function endsWithCodeElement(selector: string): boolean {
  return /(^|[\s>+~])code(?![\w-])\s*$/.test(selector);
}

/** 这条选择器有没有可能匹配到字形层那块 code。 */
function canMatchGlyphCode(selector: string): boolean {
  if (!endsWithCodeElement(selector)) return false;
  if (selector === "code") return true; // 裸 code 全局压得到
  if (/(^|[.\s>+~:-])pre([.\s>+~:-]|$)/.test(selector)) return true; // pre code / pre>code 之类
  return CODE_LAYER_CONTEXT_TOKENS.some((token) => new RegExp(`[.\\s>:+~-]${token}\\b`).test(selector));
}

function declOf(body: string, prop: string): string | null {
  const m = new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`, "m").exec(body.replace(/\n/g, ";"));
  return m ? m[1].trim() : null;
}

/** 判据本体：给一份 CSS，返回违背「字形层字体与光标层同源」的问题清单。变异对照用它。 */
export function glyphLayerFontProblems(css: string): string[] {
  const problems: string[] = [];
  const list = rules(css);
  for (const target of GLYPH_CODE_SELECTORS) {
    const covering = list.filter((r) => r.selectors.includes(target));
    if (!covering.length) {
      problems.push(`没有任何规则覆盖 ${target}：它会吃 UA 的 font-family: monospace，两层字体不同，光标与选区整体滑到别的字符上`);
      continue;
    }
    // 至少一条把它拉回继承，且没有任何一条给它另写一套字体族/字号。
    const inherits = covering.some((r) => declOf(r.body, "font") === "inherit" || declOf(r.body, "font-family") === "inherit");
    if (!inherits) {
      problems.push(`${target} 的规则块里没有 font: inherit / font-family: inherit，照样吃 UA 的 monospace`);
    }
    for (const r of covering) {
      const fam = declOf(r.body, "font-family");
      const size = declOf(r.body, "font-size");
      const shorthand = declOf(r.body, "font");
      if (fam && fam !== "inherit") problems.push(`${target} 被另写了 font-family: ${fam}，字形层与光标层不再是同一份字体`);
      if (size && size !== "inherit") problems.push(`${target} 被另写了 font-size: ${size}，两层逐字符 advance 会不一致`);
      // font 简写只要不是 inherit 就是第二套口径（写 monospace 也好、写 13px 也好，一律拦）。
      if (shorthand && shorthand !== "inherit") {
        problems.push(`${target} 的 font 简写不是 inherit 而是「${shorthand}」，等于另起一套字体口径`);
      }
      // 左内边距是**固定量**错位源：字形层比光标层多几 px，光标整条网格就恒偏左（同族症状，别留口子）。
      const pad = declOf(r.body, "padding");
      const padLeft = declOf(r.body, "padding-left");
      if (padLeft && padLeft !== "0" && padLeft !== "0px")
        problems.push(`${target} 写了 padding-left: ${padLeft}，字形层整体右移，光标恒偏左`);
      if (pad && !/^0(px)?(\s+0(px)?)*$/.test(pad)) problems.push(`${target} 的 padding 不是 0（${pad}），同上：固定量偏移`);
    }
  }
  // 特异度/顺序可能让另一条选择器赢过上面那两条：任何能匹配到这块 code 的规则都不许另写影响 advance 的声明。
  for (const r of list) {
    const matched = r.selectors.filter((s) => canMatchGlyphCode(s) && !GLYPH_CODE_SELECTORS.includes(s));
    if (!matched.length) continue;
    const offenders: string[] = [];
    for (const prop of ["font", "font-family", "font-size", "letter-spacing"]) {
      const value = declOf(r.body, prop);
      if (value && value !== "inherit" && value !== "normal") offenders.push(`${prop}: ${value}`);
    }
    const padLeft = declOf(r.body, "padding-left");
    const pad = declOf(r.body, "padding");
    if (padLeft && padLeft !== "0" && padLeft !== "0px") offenders.push(`padding-left: ${padLeft}`);
    if (pad && !/^0(px)?(\s+0(px)?)*$/.test(pad)) offenders.push(`padding: ${pad}`);
    if (offenders.length) {
      problems.push(
        `${matched.join(" / ")} 能压到字形层的 code 上却声明了 ${offenders.join(" / ")}：` +
          "特异度或书写顺序一旦赢过 font: inherit，两层 advance 就又分叉了（光标与选区整体偏移）"
      );
    }
  }
  // 光标层自己得有一份明确的字体声明，否则「继承」继承不到东西。
  const shared = list.find((r) => r.selectors.includes(".code-editor-pre") && r.selectors.includes(".code-editor-ta"));
  if (!shared) problems.push("找不到 .code-editor-pre 与 .code-editor-ta 共用的规则块：两层字体分头声明就没有同源可言");
  else {
    for (const prop of ["font-family", "font-size", "line-height", "tab-size"]) {
      if (!declOf(shared.body, prop)) problems.push(`.code-editor-pre, .code-editor-ta 块里没有 ${prop}`);
    }
  }
  return problems;
}

describe("字形层与光标层同源", () => {
  it("两份字形层容器都真的在用 <code> 装高亮 HTML（判据不空转）", () => {
    expect(EDITOR).toContain("<code dangerouslySetInnerHTML={{ __html: html }} />");
    expect(VIEW).toContain("<code");
  });

  it("真实 styles.css 过判据", () => {
    expect(glyphLayerFontProblems(CSS)).toEqual([]);
  });

  it("能匹配字形层 code 的选择器都被抓得到，无关作用域不误伤", () => {
    expect(canMatchGlyphCode(".code-editor-pre code")).toBe(true);
    expect(canMatchGlyphCode(".code-area code")).toBe(true);
    expect(canMatchGlyphCode("code")).toBe(true);
    expect(canMatchGlyphCode("pre code")).toBe(true);
    expect(canMatchGlyphCode(".mono code")).toBe(true);
    expect(canMatchGlyphCode(".code-view .code-area code")).toBe(true);
    // 末段不是裸 code 元素（类名里带 code、或 code.hljs）都不算
    expect(canMatchGlyphCode(".code-tree")).toBe(false);
    expect(canMatchGlyphCode("code.hljs")).toBe(false);
    expect(canMatchGlyphCode(".settings-data-location-path code")).toBe(false);
    expect(canMatchGlyphCode(".update-handoff-command code")).toBe(false);
    expect(canMatchGlyphCode(".dup-check-key code")).toBe(false);
    expect(canMatchGlyphCode(".code-prefix code")).toBe(false);
  });

  it("变异对照：拆掉任何一环都必须判红", () => {
    // 变异夹具一律按「找到那条真实规则再改它」来构造，别写死后文当锚点：
    // 上一行注释、下一条规则的名字都可能变，锚点一漂就把空变异当有效证据。
    const target = /\.code-area code,[\s\n]*\.code-editor-pre code \{[^}]*\}/;
    const hit = target.exec(CSS);
    expect(hit, "styles.css 里找不到字形层那条 font: inherit 规则，判据已经空转").not.toBeNull();
    const block = hit![0];

    const dropped = CSS.replace(target, "/* 被删掉了 */");
    expect(glyphLayerFontProblems(dropped).filter((x) => x.includes("没有任何规则覆盖"))).toHaveLength(2);

    const noInherit = CSS.replace(target, block.replace(/[\s]*font: inherit;/, ""));
    expect(noInherit).not.toBe(CSS);
    expect(glyphLayerFontProblems(noInherit).filter((x) => x.includes("没有 font: inherit"))).toHaveLength(2);

    const secondSource = CSS.replace(target, `${block.replace(/\{[\s]*/, "{\n  font-family: Consolas, monospace;\n  font-size: 13px;")}`);
    expect(secondSource).not.toBe(CSS);
    const problems = glyphLayerFontProblems(secondSource);
    expect(problems.filter((x) => x.includes("另写了 font-family"))).toHaveLength(2);
    expect(problems.filter((x) => x.includes("另写了 font-size"))).toHaveLength(2);

    const shorthandDrift = CSS.replace(target, block.replace("font: inherit;", "font: 12.5px monospace;"));
    expect(shorthandDrift).not.toBe(CSS);
    expect(glyphLayerFontProblems(shorthandDrift).filter((x) => x.includes("font 简写不是 inherit"))).toHaveLength(2);

    const splitLayers = CSS.replace(".code-editor-pre,\n.code-editor-ta {", ".code-editor-ta {");
    expect(splitLayers).not.toBe(CSS);
    expect(glyphLayerFontProblems(splitLayers).some((x) => x.includes("共用的规则块"))).toBe(true);

    // 新增那一层：别人补一条赢过 font: inherit 的规则（特异度相同但写得更后），必须当场判红
    for (const injected of [
      "pre code {\n  font-family: Consolas, monospace;\n}\n",
      "code {\n  font-size: 12px;\n}\n",
      ".mono code {\n  letter-spacing: 0.2px;\n}\n",
      ".code-editor code {\n  padding-left: 6px;\n}\n",
      ".code-editor .code-editor-pre code {\n  padding: 4px 0 0 0;\n}\n",
    ]) {
      const poisoned = `${CSS}\n${injected}`;
      const found = glyphLayerFontProblems(poisoned);
      expect(found.length, `注入的这条规则没被抓到：${injected.trim()}`).toBeGreaterThan(0);
      expect(
        found.some((x) => x.includes("能压到字形层的 code")),
        `注入的这条规则没落到「能匹配」那条判据上：${injected.trim()} —— 实际报的是 ${found.join(" | ")}`
      ).toBe(true);
    }

    // 直接改在那两条精确选择器上的固定量偏移，走的是另一路判据，也要单独钉住
    const paddedTarget = CSS.replace(target, block.replace("padding: 0;", "padding-left: 6px;"));
    expect(paddedTarget).not.toBe(CSS);
    expect(glyphLayerFontProblems(paddedTarget).filter((x) => x.includes("光标恒偏左"))).toHaveLength(2);
  });
});
