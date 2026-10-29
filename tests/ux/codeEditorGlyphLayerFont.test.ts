/**
 * 字形层的字体必须与光标层同源（轮132，编辑态光标指错字的根因守卫）。
 *
 * CodeEditor 是两层：透明 textarea 画光标与选区，它下面的 <pre><code> 画看得见的字形。
 * 两层共用同一份字体/字号/行高/内边距是这套结构的**唯一**对齐前提。UA 样式表给 `code`
 * 写着 `font-family: monospace`，作者样式不覆盖就吃这条——而通用 monospace 按系统解析：
 * Linux 落到 DejaVu Sans Mono，Windows/WebView2 落到系统固定宽度默认字体。用户装了
 * SF Mono / JetBrains Mono 时，textarea 用那款、字形层用系统那款，每字符 advance 不同，
 * 光标与选区整体滑到别的字符上：选文字选中的不是看到的那几个字，改内容改的是隔壁。
 *
 * 为什么必须静态读磁盘：本机两种字体解析到同一条，像素判据（真机 CARET-01/02）量不出差，
 * 全绿照样带着这个洞进版；jsdom 也不实现 UA 样式表，组件测试同样是假绿。
 * 只有「谁给 code 声明了字体」这条能钉死它。
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
  });
});
