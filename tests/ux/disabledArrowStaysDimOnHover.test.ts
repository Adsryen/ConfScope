/**
 * 点不动的合并箭头不许在任何交互态下亮成「能点」（轮27 F-9）。
 *
 * 这条规则有两处会静默复发：
 * 1. 摘掉原生 `disabled` 换 `aria-disabled`（原生 disabled 上 Blink 整段跳过 title，
 *    而这颗箭头是 icon-only，「为什么加不进去」除了 tooltip 没有第二个出口）。
 *    换了写法，`:not(:disabled)` 这道挡 hover 的闸就跟着失效了——它挡不住 aria-disabled。
 * 2. 禁用态当年只写了裸 `.diff-merge-btn:disabled`（0,2,0），而提亮规则
 *    `.diff-row:hover .diff-merge-center .diff-merge-btn` 是 (0,4,0)：鼠标一进这一行，
 *    禁用态被提亮盖掉。Playwright 实测（本任务 research/arrow_aria_disabled_probe.cjs）：
 *    静止 opacity=0.28 → 行 hover opacity=1，禁用/可用在视觉上完全分不开。
 *
 * 所以口径写成「靠特异度决胜、不靠文档顺序」：禁用态必须在**每个**出现提亮的上下文里
 * 各留一条对应形式（裸 / :focus-within / .diff-row:hover），且特异度严格高于该上下文的提亮规则。
 * 与轮26 的 hoverToneRulesResolveBySpecificity 同一口径，但那条只认纯 class 复合选择器
 * （伪类之外的属性选择器、组合器一律跳过），盖不到这里 ⇒ 单独一条守卫。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, readScannedSource } from "./scanUtils";

const CSS_FILE = "src/styles.css";
const PANEL = "src/components/DiffPanel.tsx";
const VIEW = "src/components/DiffView.tsx";

/** 注释换成等长空白：注释里也写着这些选择器，不剥会当成正文规则。 */
function blankComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

/** 摘掉顶层 @media / @keyframes 块（等长空白占位，保住文档顺序与行号）。 */
function withoutAtBlocks(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const at = /@[a-z-]+[^{]*\{/gi;
    at.lastIndex = i;
    const found = at.exec(css);
    if (!found) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, found.index);
    let depth = 1;
    let j = found.index + found[0].length;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") depth += 1;
      else if (css[j] === "}") depth -= 1;
      j += 1;
    }
    out += css.slice(found.index, j).replace(/[^\n]/g, " ");
    i = j;
  }
  return out;
}

interface Rule {
  /** 逗号拆开后的每个选择器 */
  selectors: string[];
  /** 声明：属性名 → 值（同一条规则里重复属性取最后一条） */
  decls: Record<string, string>;
  line: number;
}

function rulesTouchingArrow(css: string): Rule[] {
  const text = withoutAtBlocks(blankComments(css));
  const out: Rule[] = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(text))) {
    const selList = m[1].trim();
    if (!selList || selList.startsWith("@")) continue;
    if (!selList.includes("diff-merge-btn")) continue;
    const decls: Record<string, string> = {};
    for (const decl of m[2].split(";")) {
      const idx = decl.indexOf(":");
      if (idx < 0) continue;
      const name = decl.slice(0, idx).trim();
      const value = decl.slice(idx + 1).trim();
      if (name) decls[name] = value;
    }
    out.push({
      selectors: selList.split(",").map((s) => s.replace(/\s+/g, " ").trim()),
      decls,
      line: text.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

/**
 * 特异度 (a,b,c) 折成一个可比的数。`:not()` 本身不计、参数计（与浏览器一致）；
 * 伪元素不计。本守卫只看 class / 属性 / 伪类 / id，出现类型选择器直接判失败——
 * 那意味着口径外元素也能套上这颗箭头，值算不准。
 */
function spec(sel: string): number {
  expect(sel, "本守卫不处理类型选择器").not.toMatch(/(?:^|[\s>+~(])[a-z][a-z0-9-]*[.\s)]/i);
  const s = sel.trim();
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const stripped = s.replace(/::[\w-]+(?:\([^)]*\))?/g, " ");
  let b = (stripped.match(/\.[\w-]+/g) ?? []).length + (stripped.match(/\[[^\]]*\]/g) ?? []).length;
  for (const p of stripped.match(/:(?!:)[\w-]+(?:\([^)]*\))?/g) ?? []) {
    if (p.startsWith(":not(")) {
      b -= 1;
      b += spec(p.slice(5, -1));
    } else {
      b += 1;
    }
  }
  return ids * 10000 + b * 100;
}

/** 选择器里 `.diff-merge-btn` 之前的那截（提亮与压暗必须落在同一个上下文里比）。 */
function contextOf(sel: string): string {
  const idx = sel.lastIndexOf(".diff-merge-btn");
  return idx < 0 ? sel : sel.slice(0, idx).trim();
}

const DIM = "0.28";
/**
 * 静止底色与禁用态的契约值。
 * 轮44 R94：0.46 把 #a0a0a0 合成成 #626264，在 --bg3 上实测 2.25:1，可用控件进不了禁用豁免
 * ⇒ 静止档抬到 0.8、基色改 --text-dim-raised（合成 #a7a7a7 → 5.71:1）。
 * 0.28 仍严格低于静止档，禁用态照旧被压住。
 */
const BASE_OPACITY = "0.8";
/** 灰态取值：出现这些值的声明不算「点亮」（--text-dim-raised 仍是灰阶令牌，不是高亮色） */
const DIM_VALUES = new Set(["var(--text-dim)", "var(--text-dim-raised)", "rgba(255, 255, 255, 0.04)", DIM, BASE_OPACITY]);

/** 会把箭头「点亮」的声明：透明度高于静止档，或文字/描边换成非灰 token */
function brightenProps(decls: Record<string, string>): string[] {
  const hits: string[] = [];
  if (decls.opacity && Number.parseFloat(decls.opacity) > Number.parseFloat(BASE_OPACITY)) hits.push("opacity");
  if (decls.color && !DIM_VALUES.has(decls.color)) hits.push("color");
  if (decls["border-color"] && !DIM_VALUES.has(decls["border-color"])) hits.push("border-color");
  return hits;
}

/**
 * 这些选择器本身就不会落在「点不动的箭头」上，不参与决胜，但必须逐条登记：
 * - `:not([aria-disabled="true"])` / `[aria-disabled="true"]` / `:disabled`：写法已自证；
 * - `.active`：只有点成功才挂得上，点不动的箭头永远进不了这个态。
 */
function exemptReason(sel: string): string | null {
  if (sel.includes(':not([aria-disabled="true"])')) return "self-exempt";
  if (sel.includes('[aria-disabled="true"]')) return "aria-disabled";
  if (sel.includes(":disabled")) return "disabled";
  if (sel.includes(".active")) return "active";
  return null;
}

const CSS = readFileSync(join(PROJECT_ROOT, CSS_FILE), "utf8");
const RULES = rulesTouchingArrow(CSS);
const dimRules = RULES.filter((r) => brightenProps(r.decls).length === 0 && r.decls.opacity === DIM);
const brightRules = RULES.filter((r) => brightenProps(r.decls).length > 0);

/** 禁用态在 aria-disabled 写法下覆盖到的上下文 → 特异度 */
const dimByContext = new Map<string, number>();
for (const sel of dimRules[0]?.selectors ?? []) {
  if (!sel.includes('[aria-disabled="true"]')) continue;
  const ctx = contextOf(sel);
  dimByContext.set(ctx, Math.max(dimByContext.get(ctx) ?? 0, spec(sel)));
}

describe("点不动的合并箭头靠特异度保持禁用态（轮27 F-9）", () => {
  it("禁用态只有一条规则，且每个提亮上下文都配齐 :disabled 与 [aria-disabled] 两种写法", () => {
    expect(dimRules, "禁用态规则应恰好一条（拆成多份就会重新靠文档顺序决胜）").toHaveLength(1);
    const [{ selectors, decls }] = dimRules;
    expect(selectors).toEqual([
      ".diff-merge-center .diff-merge-btn:disabled",
      '.diff-merge-center .diff-merge-btn[aria-disabled="true"]',
      ".diff-merge-center:focus-within .diff-merge-btn:disabled",
      '.diff-merge-center:focus-within .diff-merge-btn[aria-disabled="true"]',
      ".diff-row:hover .diff-merge-center .diff-merge-btn:disabled",
      '.diff-row:hover .diff-merge-center .diff-merge-btn[aria-disabled="true"]',
    ]);
    // 禁用态的四件套：淡、不许 pointer、文字回灰、边框回灰
    expect(decls.opacity).toBe(DIM);
    expect(decls.cursor).toBe("not-allowed");
    expect(decls.color).toBe("var(--text-dim)");
    expect(decls["border-color"]).toBe("rgba(255, 255, 255, 0.04)");
  });

  it("命中 aria-disabled 的提亮规则，必须被同上下文的禁用态严格压过", () => {
    expect(brightRules.length, "至少该有 hover/focus 提亮规则在守").toBeGreaterThan(0);
    const exempted: string[] = [];
    const judged: string[] = [];
    for (const rule of brightRules) {
      if (dimRules.includes(rule)) continue;
      for (const sel of rule.selectors) {
        const reason = exemptReason(sel);
        if (reason) {
          exempted.push(`${sel} ← ${reason}`);
          continue;
        }
        judged.push(sel);
        const dim = dimByContext.get(contextOf(sel));
        expect(
          dim !== undefined && dim > spec(sel),
          `${CSS_FILE}:${rule.line} 「${sel}」(spec ${spec(sel)}) 会把点不动的箭头提亮；` +
            `同上下文禁用态 ${dim === undefined ? "缺席" : `spec ${dim}`}——必须严格更高，靠先后顺序不算赢`
        ).toBe(true);
      }
    }
    // 豁免名单也要钉住：新增一条「自证不亮」的选择器必须写进这里，评审时才看得见
    expect(exempted.sort()).toEqual(
      [
        '.diff-merge-btn:focus-visible:not(:disabled):not([aria-disabled="true"]) ← self-exempt',
        ".diff-merge-btn.left-to-right.active ← active",
        ".diff-merge-btn.right-to-left.active ← active",
        '.diff-merge-btn:hover:not(:disabled):not([aria-disabled="true"]) ← self-exempt',
      ].sort()
    );
    expect(judged.sort()).toEqual(
      [".diff-merge-center:focus-within .diff-merge-btn", ".diff-row:hover .diff-merge-center .diff-merge-btn"].sort()
    );
  });

  it("静止档 0.8 也要被禁用态严格压过，不留顺序决胜", () => {
    const base = RULES.filter((r) => r.decls.opacity === BASE_OPACITY);
    expect(base, "静止底色规则应恰好一条").toHaveLength(1);
    for (const sel of base[0].selectors) {
      const dim = dimByContext.get(contextOf(sel));
      expect(
        dim !== undefined && dim > spec(sel),
        `静止底色「${sel}」(spec ${spec(sel)}) 与禁用态 ${dim ?? "缺席"} 打平或更低：靠写在后面赢不了多久`
      ).toBe(true);
    }
  });

  it("提亮（文字/描边）自带豁免，焦点环却不许豁免 aria-disabled", () => {
    const textBright = brightRules.filter((r) => r.decls.color === "var(--text-hi)");
    expect(textBright, "hover/focus 提亮文字的规则不在了").toHaveLength(1);
    for (const sel of textBright[0].selectors) {
      expect(sel, `提亮规则 ${sel} 必须写明 aria-disabled 不亮`).toContain(':not([aria-disabled="true"])');
      expect(sel).toContain(":not(:disabled)");
      expect(sel).toMatch(/:hover|:focus-visible/);
    }
    const ring = RULES.filter((r) => r.decls["box-shadow"] === "var(--focus-ring-shadow)");
    expect(ring, "焦点环规则不在了：键盘走到箭头时必须看得见焦点").toHaveLength(1);
    for (const sel of ring[0].selectors) {
      expect(sel, "焦点环不许把 aria-disabled 排除掉——点不动也要看得见自己在哪").not.toContain("[aria-disabled");
    }
  });

  it("DiffPanel：箭头用 aria-disabled + 点击早退，不再挂原生 disabled", () => {
    const src = readScannedSource(PANEL);
    expect(src, "原生 disabled 会把 title 一起吞掉，禁用理由等于没写").not.toMatch(/(^|[^\w-])disabled=\{!canMerge/);
    expect(src).toMatch(/aria-disabled=\{!canMergeLeftToRight \|\| undefined\}/);
    expect(
      src.match(/if \(!canMergeLeftToRight\) return;/),
      "早退闸就是点不动的实现本身（Enter/Space 在原生 button 上合成 click）"
    ).not.toBeNull();
    // 不可用时 title 必须是理由，可用时才是动作名
    expect(src).toMatch(
      /const leftToRightTitle = \(!canMergeLeftToRight && mergeActionUnavailableReason\) \|\| mergeActionLabels\?\.leftToRight \|\| ""/
    );
    expect(src).toMatch(/title=\{leftToRightTitle\}/);
    expect(src).toMatch(/aria-label=\{mergeActionLabels\.leftToRight\}/);
  });

  it("DiffView：右侧独有项要把理由传给箭头", () => {
    const src = readScannedSource(VIEW);
    expect(src).toMatch(/mergeActionUnavailableReason=\{/);
    expect(src).toMatch(/selectedBatchItem\.presence === "right-only" \? t\("diff\.mergeUnavailableRightOnly"\)/);
  });

  it("理由文案两种语言都在，且读起来是「为什么」而不是错误码", () => {
    for (const file of ["zh-CN.json", "en-US.json"]) {
      const tree = JSON.parse(readFileSync(join(PROJECT_ROOT, "src/locales", file), "utf8")) as Record<string, Record<string, string>>;
      const value = tree.diff.mergeUnavailableRightOnly;
      expect(value, `${file} 缺 diff.mergeUnavailableRightOnly`).toBeTruthy();
      expect(value).not.toMatch(/^[A-Z_]+$/);
    }
  });
});
