/**
 * 容器里的链接着色不得越过按钮 tone（轮95 R7，真机普查抓到的实伤）。
 *
 * 缺陷形状（不是假想，是 99-s-contrast 普查的实测读数）：
 * `.about-section a { color: var(--accent-text) }` 特异度 (0,1,1)，
 * `.btn-primary { color: var(--on-accent) }` 只有 (0,1,0)。关于页把「提交 Issue（自动带上环境信息）」
 * 写成 `<ExternalLink className="btn btn-primary btn-sm">`（外链必须是 `<a>`，见
 * src/components/ExternalLink.tsx），于是这颗实心蓝按钮上的字被涂成 #4fc3f7，
 * 落在 --accent #007acc 上实测 **2.25:1**（要求 4.5）。
 *
 * 为什么两道既有守卫都看不见它：
 * - `classOverridesResolveBySpecificity` / `hoverToneRulesResolveBySpecificity` 都只解「纯 class 复合选择器」，
 *   类型选择器 `a` 与伪类一律跳过（口径写在文件头上，宁可漏报不误报）；
 * - `tests/ux/contrastTokens.test.ts` 只算同一条规则块里的前景×底色配对，
 *   而这里的前景是被**另一条**规则涂上去的。
 * 所以单独立一条：凡是能给 `<a>` 着色、且特异度压得过 tone 的规则，必须显式把 `.btn` 排除掉。
 *
 * 口径（宁可漏报不误报，但基线必须为空）：
 * - 只看声明了长写 `color` 的规则；`background-color` / `border-color` / `fill` 一律不算。
 * - 选择器里必须出现**裸元素 `a`**（`\ba\b`，不吃 `.ma` / `article` / `--accent-text` 这类片段）。
 * - 按 CSS 规范算特异度：`:not(X)` 计入参数 X 的特异度，`:where(X)` 计 0。
 * - tone 的字色规则按文件里真实存在的那些取（`#fff` 兜底 `#8` 见 TONES），逐条比较；
 *   压不过任何 tone ⇒ 不收（`a { color }` (0,0,1) 本来就赢不了 class）。
 * - 每条豁免只认 `:not(.btn)`；写 `:where(:not(.btn))` 之类也算，判据看的是选择器里有这个片段。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource } from "./scanUtils";

const CSS = "src/styles.css";
/** 全站按钮 tone 类（src/styles.css 里 .btn-* 上色族）。 */
const TONES = ["btn-primary", "btn-ghost", "btn-danger", "btn-danger-fill", "btn-accent"];
/** 链接着色规则必须带的排除片段。 */
const EXCLUSION = ":not(.btn)";

interface Rule {
  sel: string;
  /** 该规则里 color 长写的值 */
  colorValue: string;
  spec: [number, number, number];
  line: number;
}

/** 注释换成等长空白：值里可能正好写着类名，行号也必须对得上原文件。 */
function blankComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

export function specificity(sel: string): [number, number, number] {
  const clean = sel.replace(/\s+/g, " ").trim();
  let a = 0;
  let b = 0;
  let c = 0;
  // :where(...) 整段计 0，先摘掉；:not(...) 的贡献来自参数，摘出来单独递归
  const rest = clean
    .replace(/:where\([^)]*\)/g, " ")
    .replace(/:not\(([^)]*)\)/g, (_all, inner: string) => {
      const sub = specificity(inner);
      a += sub[0];
      b += sub[1];
      c += sub[2];
      return " ";
    });
  const TOKEN = /(::[\w-]+)|(:[\w-]+(?:\([^)]*\))?)|(#[\w-]+)|(\.[\w-]+)|(\[[^\]]*\])|((?:^|[\s>+~])\*(?=$|[\s>+:.[])|(?:(?:^|[\s>+~])[a-z][\w-]*(?=$|[\s>+:.[])))/gi;
  for (const m of rest.matchAll(TOKEN)) {
    if (m[1]) c += 1;
    else if (m[2]) b += 1;
    else if (m[3]) a += 1;
    else if (m[4] || m[5]) b += 1;
    else if (m[6] && m[6]!.trim() !== "*") c += 1;
  }
  return [a, b, c];
}

/** 特异度比较：> 0 表示 x 压过 y。 */
export function cmpSpec(x: [number, number, number], y: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i]! - y[i]!;
  }
  return 0;
}

/** 扫出所有带 color 长写声明的规则（只认最内层规则块）。 */
export function rulesWithColor(css: string): Rule[] {
  const text = blankComments(css);
  const out: Rule[] = [];
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = m[2] ?? "";
    const decl = /(^|[;{\s])color\s*:\s*([^;]+)/i.exec(body);
    if (!decl) continue;
    const sel = (m[1] ?? "").trim().split("\n").pop()?.trim() ?? "";
    if (!sel || sel.startsWith("@")) continue;
    out.push({ sel, colorValue: (decl[2] ?? "").trim(), spec: specificity(sel), line: text.slice(0, m.index).split("\n").length });
  }
  return out;
}

/** 含裸元素 `a` 的选择器片段（不吃 .ma / article / 属性值里的字母）。 */
function hasBareAnchor(sel: string): boolean {
  return /(^|[\s>+~(])a(?=$|[\s>+~:.[])/.test(sel);
}

function linkColorRules(rules: Rule[]): Rule[] {
  return rules.filter((r) => hasBareAnchor(r.sel));
}

function toneColorRules(rules: Rule[]): Rule[] {
  return rules.filter((r) => TONES.some((t) => r.sel === `.${t}`) && r.colorValue);
}

/** 判据本体：能压过任一 tone 的链接着色规则，必须排除 .btn。 */
export function findViolations(cssText: string): { sel: string; line: number; spec: string; beats: string[] }[] {
  const rules = rulesWithColor(cssText);
  const tones = toneColorRules(rules);
  return linkColorRules(rules)
    .filter((r) => !r.sel.includes(EXCLUSION))
    .map((r) => {
      const beats = tones.filter((t) => cmpSpec(r.spec, t.spec) > 0).map((t) => `${t.sel} (${t.spec.join(",")})`);
      return beats.length ? { sel: r.sel, line: r.line, spec: r.spec.join(","), beats } : null;
    })
    .filter((x): x is { sel: string; line: number; spec: string; beats: string[] } => x !== null);
}

describe("链接着色不越过按钮 tone（轮95 R7）", () => {
  const violations = findViolations(readScannedSource(CSS));

  it("styles.css 里不存在能压过 tone 又没排除 .btn 的链接着色规则", () => {
    expect(
      violations,
      `这些规则会把挂 .btn 的外链按钮文字涂成链接色（关于页那颗 2.25:1 就是这么来的）：\n${JSON.stringify(violations, null, 2)}\n修法：选择器加 ${EXCLUSION}`,
    ).toEqual([]);
  });

  it("正控：去掉 :not(.btn) 必须判红", () => {
    const mutated = readScannedSource(CSS).replace(".about-section a:not(.btn) {", ".about-section a {");
    expect(mutated).not.toBe(readScannedSource(CSS));
    const hits = findViolations(mutated);
    expect(hits.map((h) => h.sel)).toContain(".about-section a");
    expect(hits[0]!.beats.some((b) => b.startsWith(".btn-primary"))).toBe(true);
  });

  it("正控：写法换成 :where(a) 之类压不过 tone 的形态就不该报", () => {
    // `.about-section :where(a)` 特异度 (0,1,0)，与 .btn-primary 同层，靠它自己赢不了
    expect(specificity(".about-section :where(a)")).toEqual([0, 1, 0]);
    expect(cmpSpec(specificity(".about-section a"), specificity(".btn-primary"))).toBeGreaterThan(0);
  });

  it("特异度函数本身要对着 CSS 规范，不能只是自洽", () => {
    // [a,b,c]：ID / 类·属性·伪类 / 元素·伪元素。这份表是判据的地基，写错会整条守卫空转。
    const table: [string, [number, number, number]][] = [
      ["a", [0, 0, 1]],
      [".btn-primary", [0, 1, 0]],
      [".about-section a", [0, 1, 1]],
      [".about-section a:not(.btn)", [0, 2, 1]],
      [".about-section a:not(.btn):hover", [0, 3, 1]],
      [".btn-primary:hover:not(:disabled)", [0, 3, 0]],
      [".btn.btn-ghost", [0, 2, 0]],
      ["#root .x a", [1, 1, 1]],
      [".a[data-x] b::before", [0, 2, 2]],
      [".foo :where(a.b)", [0, 1, 0]],
      [".list > li + li", [0, 1, 2]],
      [".wrap *", [0, 1, 0]],
    ];
    for (const [sel, want] of table) {
      expect(specificity(sel), `${sel} 的特异度算法读数不对`).toEqual(want);
    }
  });

  it("正控：裸 a 的识别不吃 .ma / article / 带类的 a.btn", () => {
    expect(hasBareAnchor(".nav .ma")).toBe(false);
    expect(hasBareAnchor("article p")).toBe(false);
    expect(hasBareAnchor(".about-section a")).toBe(true);
    expect(hasBareAnchor(".about-section a:not(.btn)")).toBe(true);
    expect(hasBareAnchor("a.btn-primary")).toBe(true);
  });

  it("正控：color 的识别不吃 background-color / border-color", () => {
    const fake = ".foo a { background-color: #000; border-color: #000; }";
    expect(rulesWithColor(fake)).toEqual([]);
    expect(rulesWithColor(".foo a { color: #000; }")[0]?.sel).toBe(".foo a");
  });

  it("tone 族按文件里真实存在的字色规则取，别守着一个空集合自嗨", () => {
    const tones = toneColorRules(rulesWithColor(readScannedSource(CSS)));
    expect(tones.length, "styles.css 里一个 tone 字色规则都没扫到，判据就是空转").toBeGreaterThanOrEqual(3);
    expect(tones.map((t) => t.sel)).toContain(".btn-primary");
  });

  it("关于页那颗实心蓝外链按钮现在读到的必须是 tone 自己的字色", () => {
    const css = readScannedSource(CSS);
    const primary = /--on-accent\s*:\s*([^;]+);/.exec(css)?.[1]?.trim();
    expect(primary, "--on-accent 令牌没定义，.btn-primary 的字色无处可取").toBeTruthy();
    // 链接色规则确实还管着正文链接（修完不能把这条规则整条删掉，否则正文链接失去着色口径）
    expect(css).toContain(".about-section a:not(.btn) {\n  color: var(--accent-text);");
  });
});
