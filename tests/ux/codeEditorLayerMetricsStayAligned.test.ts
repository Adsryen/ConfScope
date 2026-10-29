/**
 * 编辑态两层文字的度量必须同源（轮107 光标错位事故后新增）。
 *
 * 缺陷形状：配置浏览的编辑态不是普通 textarea，而是「透明 textarea 叠在高亮 <pre> 之上」——
 * 用户看到的字形画在 pre 层（带 .search-hit 命中底、hljs-* 语法色），
 * 光标与选区由 textarea 层自己画。两层靠相同的字体、字号、行高、内边距才能逐字符对齐，
 * 只要有一条只作用于字形层的规则声明了参与布局的属性，两层就从那一刻起错位。
 *
 * 实测代价：给命中词加 padding: 0 1px 之后，单行 4 处命中把可见文字一路推右，
 * 最坏 dx = 8.07px ≈ 1.07 个字符宽（12.5px 等宽字体下 7.53px/字符）。
 * 用户看到的是「光标停在 e 上，实际删掉的是 r」——选区也一样错，改完才发现改错了地方。
 * 底色和描边换成 background + inset box-shadow 之后视觉不减，两层重新对齐。
 *
 * 为什么静态就能判：这类错位不需要跑起来才知道，「只命中字形层的规则里出现布局属性」本身就是错的，
 * 而样式表只有一份，两层的选择器也都固定，正则扫一遍就能钉死。
 * 浏览器不报错、tsc 不管、真机上一眼看不出，只有拿光标去对字的时候才暴露——正是该静态守的静默故障。
 *
 * 判据的精确形状（轮134 精化：轮132 的字体修复被这条守卫自己打红之后才想清楚的）：
 * 字形层不许「自己发明」度量，但允许「把自己交回继承」——
 * UA 样式表给 <code> 写着 font-family: monospace，作者样式不在字形层写一条继承就吃它，
 * 两层从此逐字符错位（轮132 的 P0 光标偏左正是这条）。
 * 所以合法的布局声明只有一种：值恰好是中性值（见 NEUTRAL_METRIC_VALUES）。
 * padding: 0 1px、letter-spacing: .5px、font-family: monospace、display: block 一律判红——
 * 轮107 那次错位就是 .search-hit 的 padding: 0 1px 把字形一路推右（最坏 8.07px ≈ 1.07 个字符）。
 * 中性值之外没有别的豁免基线：真要加一条带自选度量的字形层规则，说明设计已经变了
 * （比如改成单层渲染），那时改的是这份守卫的判据本身，不是往基线里塞一行把它静音。
 *
 * 不在名单里的属性也要说明理由，别当成漏了：
 * - font-style（.hljs-* 的斜体）：等宽字体没有真斜体面，Chromium 用合成倾斜，
 *   实测 advance 宽度差为 0，不产生错位；
 * - height / line-height：行高属于两层共用的那份规则（见「几何属性只在一处声明」用例），
 *   字形层单独改行高会变成上下错位，但垂直方向实测 354 行 dx/dy 均为 0，暂不拦。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CSS_PATH = join(PROJECT_ROOT, "src/styles.css");

/** 字形层：透明 textarea 底下那层高亮文本，命中词与语法着色都画在这里。 */
const GLYPH_LAYER_RE = /\.search-hit|\.hljs-[\w-]*|\[class\*="hljs-"\]|\.code-editor-pre/;
/** 光标层：真的 textarea，光标和选区由它画，内容本身是透明的。 */
const CARET_LAYER_RE = /\.code-editor-ta\b/;

/**
 * 会影响字符水平位置的属性。命中一条就可能让两层错位，所以宁滥勿缺：
 * 位移类（padding/margin/left/transform…）、换字宽类（font/letter-spacing/text-transform…）、
 * 换行排版类（white-space/tab-size/word-break…）都在内。
 */
const METRIC_PROPS = [
  "padding",
  "padding-left",
  "padding-right",
  "padding-top",
  "padding-bottom",
  "margin",
  "margin-left",
  "margin-right",
  "margin-top",
  "margin-bottom",
  "border",
  "border-left",
  "border-right",
  "border-width",
  "border-left-width",
  "border-right-width",
  "letter-spacing",
  "word-spacing",
  "font",
  "font-family",
  "font-size",
  "font-stretch",
  "font-weight",
  "text-transform",
  "text-indent",
  "tab-size",
  "white-space",
  "word-break",
  "overflow-wrap",
  "display",
  "position",
  "left",
  "right",
  "transform",
  "translate",
  "width",
  "max-width",
  "min-width",
  "inline-size",
  "max-inline-size",
  "min-inline-size",
  "zoom",
  "scale",
];

/** 两层共用的那份规则必须声明的几何属性——只在一份规则里写一遍，改一处两层同时生效。 */
/**
 * 字形层唯一合法的布局声明：把这一层交回容器/继承的中性值。
 * 表里没有的那些属性（display / position / width / transform / zoom…）写不出中性值，
 * 出现在只命中字形层的规则里一律判红。
 */
const NEUTRAL_METRIC_VALUES: Record<string, string[]> = {
  font: ["inherit"],
  "font-family": ["inherit"],
  "font-size": ["inherit"],
  "font-weight": ["inherit"],
  "font-stretch": ["inherit"],
  "letter-spacing": ["inherit", "normal"],
  "word-spacing": ["inherit", "normal"],
  "text-indent": ["inherit", "0px", "0"],
  "text-transform": ["inherit", "none"],
  "white-space": ["inherit"],
  "word-break": ["inherit", "normal"],
  "overflow-wrap": ["inherit", "normal"],
  "tab-size": ["inherit"],
  padding: ["0", "0 0", "0px", "0px 0px"],
  "padding-left": ["0", "0px"],
  "padding-right": ["0", "0px"],
  "padding-top": ["0", "0px"],
  "padding-bottom": ["0", "0px"],
  margin: ["0", "0 0", "0px", "0px 0px"],
  "margin-left": ["0", "0px"],
  "margin-right": ["0", "0px"],
  "margin-top": ["0", "0px"],
  "margin-bottom": ["0", "0px"],
  border: ["0", "none", "0px"],
  "border-left": ["0", "none", "0px"],
  "border-right": ["0", "none", "0px"],
  "border-width": ["0", "0px"],
  "border-left-width": ["0", "0px"],
  "border-right-width": ["0", "0px"],
};

/** 这条声明是不是「交回继承 / 零偏移」的中性值：多值（padding: 0 0）要每一段都中性才算。 */
function isNeutralMetric(decl: { prop: string; value: string }): boolean {
  const allowed = NEUTRAL_METRIC_VALUES[decl.prop];
  if (!allowed) return false;
  const parts = decl.value.split(/\s+/).filter(Boolean);
  return parts.length > 0 && parts.every((part) => allowed.includes(part));
}

/** 一条规则里真正会让两层错位的声明：命中布局属性且不是中性值。 */
function metricOffenders(rule: Rule): Array<{ prop: string; value: string; line: number }> {
  return rule.decls.filter((decl) => METRIC_PROPS.includes(decl.prop) && !isNeutralMetric(decl));
}

const SHARED_GEOMETRY_PROPS = ["font-family", "font-size", "line-height", "padding", "tab-size", "white-space"];

interface Rule {
  /** 逗号拆开的选择器项，浏览器认的是每一项 */
  sels: string[];
  line: number;
  decls: Array<{ prop: string; value: string; line: number }>;
}

/** 注释里也写着属性和值，算之前一律换成等长空白，行号才对得上原文件。 */
function blankComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

function parseDecls(body: string, startLine: number): Array<{ prop: string; value: string; line: number }> {
  const out: Array<{ prop: string; value: string; line: number }> = [];
  let cursor = 0;
  body.split(";").forEach((part) => {
    const at = part.indexOf(":");
    if (at !== -1) {
      const prop = part.slice(0, at).trim().toLowerCase();
      const value = part
        .slice(at + 1)
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
      if (prop) out.push({ prop, value, line: startLine + body.slice(0, cursor + at).split("\n").length - 1 });
    }
    cursor += part.length + 1;
  });
  return out;
}

/**
 * 收集规则：@media / @supports / @layer / @container 要跟着下钻（响应式里给字形层加 padding 同样错位），
 * @keyframes / @font-face 的块里没有元素选择器，整块跳过。
 */
function collectRules(text: string, baseLine = 1): Rule[] {
  const rules: Rule[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf("{", cursor);
    if (open === -1) break;
    const head = text.slice(cursor, open).replace(/\s+/g, " ").trim();
    let depth = 1;
    let end = open + 1;
    while (end < text.length && depth > 0) {
      if (text[end] === "{") depth += 1;
      else if (text[end] === "}") depth -= 1;
      end += 1;
    }
    const body = text.slice(open + 1, end - 1);
    const bodyStartLine = baseLine + text.slice(0, open + 1).split("\n").length - 1;
    if (head.startsWith("@")) {
      if (/^@(media|supports|layer|container)/.test(head)) {
        rules.push(...collectRules(body, bodyStartLine));
      }
    } else if (head) {
      const sels = head
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      rules.push({
        sels,
        line:
          baseLine +
          text.slice(0, cursor + (text.slice(cursor, open).length - text.slice(cursor, open).replace(/^\s+/, "").length)).split("\n")
            .length -
          1,
        decls: parseDecls(body, bodyStartLine),
      });
    }
    cursor = end;
  }
  return rules;
}

const CSS = blankComments(readFileSync(CSS_PATH, "utf8"));
const RULES = collectRules(CSS);

/** 只命中字形层、没同时命中光标层的规则——它的布局属性只会被一层吃到。 */
function glyphOnlyRules(rules: Rule[] = RULES): Rule[] {
  const hitGlyph = (rule: Rule) => rule.sels.some((sel) => GLYPH_LAYER_RE.test(sel));
  const hitCaret = (rule: Rule) => rule.sels.some((sel) => CARET_LAYER_RE.test(sel));
  return rules.filter((rule) => hitGlyph(rule) && !hitCaret(rule));
}

function sharedRule(): Rule | undefined {
  return RULES.find((rule) => rule.sels.some((sel) => GLYPH_LAYER_RE.test(sel)) && rule.sels.some((sel) => CARET_LAYER_RE.test(sel)));
}

describe("编辑态字形层与光标层的度量对齐", () => {
  it("守卫不是空转：字形层规则确实被扫到了", () => {
    expect(glyphOnlyRules().length, "styles.css 里找不到任何字形层规则，选择器改名要连这份守卫一起改").toBeGreaterThan(5);
  });

  it("自检：中性值表只放过去「交回继承」，轮107 那条 padding: 0 1px 必须照样判红", () => {
    // 这份判据是这轮新加的，不加一条反向自证就等于没加：
    // 把表写得松一点（比如 padding 允许任意值）今天照样全绿，明天又把人放过去。
    const synthetic = `
.code-editor-pre code {
  font: inherit;
  padding: 0;
}
.code-editor-pre .search-hit {
  padding: 0 1px;
}
.code-editor-ta,
.code-editor-pre {
  white-space: pre;
}
.code-editor-pre code {
  letter-spacing: 0.5px;
}
.code-editor-pre code {
  display: block;
}
`;
    const offenders = glyphOnlyRules(collectRules(synthetic)).flatMap((rule) =>
      metricOffenders(rule).map((decl) => `${decl.prop}: ${decl.value}`)
    );
    // 中性值（font: inherit / padding: 0）与两层共用的那条规则都不该出现在这里
    expect(offenders, "中性值表放行了不该放行的声明").toEqual(["padding: 0 1px", "letter-spacing: 0.5px", "display: block"]);
    // 共用规则必须被排除在「只命中字形层」之外，否则这条守卫会把正确写法也打红
    expect(glyphOnlyRules(collectRules(synthetic)).some((rule) => rule.sels.some((sel) => sel === ".code-editor-ta"))).toBe(false);
  });

  it("只作用于字形层的规则不许自选度量，只许把度量交回继承", () => {
    const offenders = glyphOnlyRules().flatMap((rule) =>
      metricOffenders(rule).map((decl) => `L${decl.line}: ${rule.sels.join(", ")} { ${decl.prop}: ${decl.value} }`)
    );
    expect(
      offenders,
      `这些属性只落在字形层、落不到透明 textarea 上，两层会逐字符错位（光标与选区指错字）。\n底色用 background、描边用 inset box-shadow，两者都不参与布局：\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("两层共用的几何只在一份规则里声明", () => {
    const rule = sharedRule();
    expect(rule, "找不到同时命中 .code-editor-pre 与 .code-editor-ta 的那份共用规则，改名要连这份守卫一起改").toBeDefined();
    const declared = new Set((rule?.decls ?? []).map((decl) => decl.prop));
    const missing = SHARED_GEOMETRY_PROPS.filter((prop) => !declared.has(prop));
    expect(missing, `这些几何属性必须在两层共用的规则里写一遍，拆到两层各写一份迟早对不上：${missing.join(", ")}`).toEqual([]);
  });

  it("命中高亮只用不参与布局的手段表达", () => {
    const searchHit = RULES.find((rule) => rule.sels.includes(".search-hit"));
    expect(searchHit, "styles.css 里找不到 .search-hit").toBeDefined();
    const props = (searchHit?.decls ?? []).map((decl) => decl.prop);
    expect(props.filter((prop) => METRIC_PROPS.includes(prop))).toEqual([]);
    ["background", "color", "box-shadow"].forEach((prop) => {
      expect(props, `.search-hit 少了 ${prop}，命中词会看不清`).toContain(prop);
    });
  });

  it("透明 textarea 的选区自己定色，字形才不被刷掉", () => {
    const selection = RULES.find((rule) => rule.sels.includes(".code-editor-ta::selection"));
    expect(selection, "选区规则被删掉了：textarea 默认选区是实心蓝加白字，会把 pre 层画出来的字形糊掉").toBeDefined();
    const decls = selection?.decls ?? [];
    expect(
      decls.some((decl) => decl.prop === "color" && decl.value === "transparent"),
      "选区里的 color 必须是 transparent，字形要靠字形层透出来"
    ).toBe(true);
    expect(
      decls.some((decl) => decl.prop.startsWith("background")),
      "选区必须自己声明底色，否则又是浏览器默认实心蓝"
    ).toBe(true);
  });
});
