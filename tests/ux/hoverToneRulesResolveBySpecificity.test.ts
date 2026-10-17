/**
 * 按钮 hover 底色 / 边框必须由特异度决胜，且 disabled 期间不许有任何 hover 反馈（轮26 R85）。
 *
 * 为什么轮25 的守卫看不见这件事：`classOverridesResolveBySpecificity` 只收「纯 class 复合选择器」，
 * 伪类一律排除——而按钮的 tone 恰恰全在 `:hover:not(:disabled)` 上。盲区里藏着两个真 bug：
 *
 * 1. `.btn-ghost:hover:not(:disabled)` 是 (0,3,0)，`.btn-danger:hover` 只有 (0,2,0)。
 *    于是 `btn btn-ghost btn-danger`（SettingsView:333「清空本地历史」、:397「清理缓存」）
 *    悬停时底色是中性 --bg-hover，和旁边的普通 ghost 按钮一模一样：危险操作在最需要它发红的时候不红。
 * 2. danger 族当年没写 `:not(:disabled)`，ghost/primary 都写了。于是 `btn btn-danger`
 *    在 disabled 期间（DeleteConfirm 的确认按钮 busy 时）照样画红底 = 假可点性。
 *
 * 口径（和轮25 一样宁可漏报不误报）：
 * - 只解「复合选择器」：含组合器（空格 / > / + / ~）、类型选择器、属性选择器的规则跳过并登记。
 * - 伪类只认 `:hover` / `:disabled` / `:not(:disabled)` / `:where(...)`（`:where` 计 0 特异度且不要求类名），
 *   其余（`:focus-visible`、`:last-child`、`:nth-*`、伪元素等）跳过并登记——基线为空，新增跳过必须写明原因。
 * - `@media` 里的规则不参与决胜（媒体块单独一条用例钉住「不许在媒体块里写 btn 的 hover 覆盖」）。
 * - 决胜 = (a,b,c) 特异度 → 文档顺序，取最后赢家的值。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CSS = readFileSync(join(PROJECT_ROOT, "src/styles.css"), "utf8");

interface Decl {
  /** 选择器里必须全部出现在元素上的类名（`:where(...)` 里的不算） */
  classes: string[];
  /** 选择器里的伪类，规范化成 `hover` / `not-disabled` / `disabled` */
  conditions: string[];
  prop: string;
  value: string;
  spec: number;
  order: number;
  line: number;
  sel: string;
}

/** 注释换成等长空白：值里可能正好写着类名，行号也必须对得上原文件。 */
function blankComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

/** 去掉顶层 @media / @supports 块（含其内部大括号），留给单独那条用例处理。 */
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
    // 用等长空白占位，保证后面的行号与文档顺序仍对应原文件
    out += css.slice(found.index, j).replace(/[^\n]/g, " ");
    i = j;
  }
  return out;
}

const SUPPORTED_PSEUDO = new Set(["hover", "disabled", "not-disabled", "enabled"]);

/** 拆选择器：能解返回 {classes, conditions}，解不了返回 null（跳过并登记）。 */
function parseSelector(sel: string): { classes: string[]; conditions: string[] } | null {
  const raw = sel.trim();
  if (!raw) return null;
  // 组合器（空格 / > / + / ~）、属性选择器、伪元素、类型选择器 → 不在本守卫的口径里
  if (/[>+~\s[\]]/.test(raw) || raw.includes("::")) return null;
  if (/^[a-z]/i.test(raw)) return null;

  const classes: string[] = [];
  const conditions: string[] = [];
  let rest = raw;
  // :where(...) 计 0 特异度、不要求类名——摘掉它，别把它里面的类当条件
  rest = rest.replace(/:where\([^)]*\)/g, "");
  const tokens = rest.match(/\.[\w-]+|:[\w-]+(?:\([^)]*\))?/g) ?? [];
  if (tokens.join("") !== rest) return null; // 有不认识的碎片，宁可跳过
  for (const token of tokens) {
    if (token.startsWith(".")) {
      classes.push(token.slice(1));
      continue;
    }
    const name = token.slice(1).split("(")[0];
    if (token.includes("(")) {
      const inner = token.slice(token.indexOf("(") + 1, -1).trim();
      if (inner.startsWith(":") && SUPPORTED_PSEUDO.has(inner.slice(1))) {
        conditions.push(`not-${inner.slice(1)}`);
        continue;
      }
      return null; // :not(其它东西)：语义太多，不猜
    }
    if (!SUPPORTED_PSEUDO.has(name)) return null;
    conditions.push(name);
  }
  return { classes, conditions };
}

function collectDecls(css: string): { decls: Decl[]; skipped: string[] } {
  const decls: Decl[] = [];
  const skipped: string[] = [];
  let order = 0;
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(css))) {
    const selList = m[1].trim();
    const body = m[2];
    if (!selList || selList.startsWith("@")) continue;
    const line = css.slice(0, m.index).split("\n").length;
    for (const one of selList.split(",")) {
      const parsed = parseSelector(one);
      if (!parsed) {
        skipped.push(`L${line}:${one.trim()}`);
        continue;
      }
      const spec = parsed.classes.length + parsed.conditions.length;
      for (const stmt of body.split(";")) {
        const decl = /^\s*([a-z-]+)\s*:\s*(.+)$/is.exec(stmt);
        if (!decl) continue;
        decls.push({
          classes: parsed.classes,
          conditions: parsed.conditions,
          prop: decl[1].toLowerCase(),
          value: decl[2].trim(),
          spec,
          order: order++,
          line,
          sel: one.trim(),
        });
      }
    }
  }
  return { decls, skipped };
}

interface Context {
  hover: boolean;
  disabled: boolean;
}

function applies(decl: Decl, combo: string[], ctx: Context): boolean {
  if (!decl.classes.every((c) => combo.includes(c))) return false;
  for (const cond of decl.conditions) {
    if (cond === "hover" && !ctx.hover) return false;
    if (cond === "disabled" && !ctx.disabled) return false;
    if (cond === "enabled" && ctx.disabled) return false;
    if (cond === "not-disabled" && ctx.disabled) return false;
  }
  return true;
}

/** 取元素在该上下文里最终生效的值（(特异度, 文档顺序) 决胜）。 */
function resolve(decls: Decl[], combo: string[], prop: string, ctx: Context): { value?: string; winner?: string } {
  const winners = new Map<string, Decl>();
  for (const decl of decls) {
    if (decl.prop !== prop || !applies(decl, combo, ctx)) continue;
    const current = winners.get(prop);
    if (!current || decl.spec > current.spec || (decl.spec === current.spec && decl.order >= current.order)) {
      winners.set(prop, decl);
    }
  }
  const win = winners.get(prop);
  return { value: win?.value, winner: win ? `${win.sel} (L${win.line})` : undefined };
}

/**
 * 全站按钮类名组合（来源见每条注释）。hover 底色期望值 = 「这个按钮此刻该长什么样」的设计意图：
 * danger 无论跟不跟 ghost 都要红；result-action 那三条要跟着 tone 走（轮25 CSS 注释里写明的口径）。
 */
const COMBOS: Array<{ classes: string[]; hoverBackground: string; where: string }> = [
  { classes: ["btn", "btn-primary"], hoverBackground: "var(--accent-h)", where: "ConfigEditor.tsx:197 发布" },
  {
    classes: ["btn", "btn-primary", "btn-sm"],
    hoverBackground: "var(--accent-h)",
    where: "ConfigBrowser.tsx:1233 保存 / AuditView 筛选项",
  },
  {
    classes: ["btn", "btn-ghost"],
    hoverBackground: "var(--bg-hover)",
    where: "ApplyPlanView 取消 / 大量普通按钮",
  },
  {
    classes: ["btn", "btn-ghost", "btn-sm"],
    hoverBackground: "var(--bg-hover)",
    where: "Pager / BackupView 小按钮",
  },
  {
    classes: ["btn", "btn-sm", "btn-ghost"],
    hoverBackground: "var(--bg-hover)",
    where: "AuditView 三元拼出来的那一条（顺序与上一条相反，值必须一样）",
  },
  {
    classes: ["btn", "btn-danger"],
    hoverBackground: "rgba(244, 67, 54, 0.15)",
    where: "DeleteConfirm.tsx:113 确认删除",
  },
  {
    classes: ["btn", "btn-sm", "btn-danger"],
    hoverBackground: "rgba(244, 67, 54, 0.15)",
    where: "HistoryView.tsx:375 回滚（三元 danger/ghost）",
  },
  {
    classes: ["btn", "btn-ghost", "btn-danger"],
    hoverBackground: "rgba(244, 67, 54, 0.15)",
    where: "SettingsView.tsx:333 / :397 —— 轮26 R85 修的就是这条",
  },
  {
    classes: ["btn", "btn-ghost", "btn-sm", "result-action", "result-action-back"],
    hoverBackground: "var(--bg-hover)",
    where: "DiffView.tsx:1775（轮25 注释要求 ghost hover 仍压过 result-action 着色）",
  },
  {
    classes: ["btn", "btn-ghost", "btn-sm", "result-action", "result-action-export"],
    hoverBackground: "var(--bg-hover)",
    where: "DiffView.tsx:1799",
  },
  {
    classes: ["btn", "btn-primary", "btn-sm", "result-action", "result-action-plan"],
    hoverBackground: "var(--accent-h)",
    where: "DiffView.tsx:1819",
  },
];

const parsed = collectDecls(withoutAtBlocks(blankComments(CSS)));
const DECLS = parsed.decls;

/**
 * danger 与 ghost 共现时，红底必须**靠特异度**赢，不许靠文档顺序。
 * 为什么要单独判这条：把复合选择器摘掉后，`.btn-danger:hover:not(:disabled)` 与
 * `.btn-ghost:hover:not(:disabled)` 都是 (0,3,0)，红底因为写在文件后面**照样赢**——
 * 值一样、意图一样，但谁挪一下顺序就静默变回中性灰。只有「赢家特异度严格高于中性那条」
 * 才说明这是设计而不是巧合。
 */
function redWinsBySpecificityProblems(css: string): string[] {
  const { decls } = collectDecls(withoutAtBlocks(blankComments(css)));
  const combo = ["btn", "btn-ghost", "btn-danger"];
  const ctx: Context = { hover: true, disabled: false };
  const candidates = decls.filter((d) => d.prop === "background" && applies(d, combo, ctx));
  const problems: string[] = [];
  const red = candidates.filter((d) => d.value.includes("244, 67, 54"));
  if (red.length === 0) return ["danger 的 hover 红底规则不存在"];
  const neutral = candidates.filter((d) => d.value === "var(--bg-hover)");
  const redSpec = Math.max(...red.map((d) => d.spec));
  const neutralSpec = neutral.length ? Math.max(...neutral.map((d) => d.spec)) : 0;
  if (redSpec <= neutralSpec) {
    problems.push(`红底最高特异度 (0,${redSpec},0) 没严格高于中性 --bg-hover 的 (0,${neutralSpec},0)，现在赢只因为写在后面`);
  }
  if (Math.max(...candidates.map((d) => d.spec)) !== redSpec) {
    problems.push("还有比红底特异度更高的规则压着它（赢家见用例日志）");
  }
  return problems;
}

describe("按钮 hover 底色由特异度决胜（轮26 R85）", () => {
  it("解析器要真的读到 hover 规则，不然整条守卫会假绿", () => {
    const hoverBackgroundRules = DECLS.filter((d) => d.prop === "background" && d.conditions.includes("hover"));
    expect(hoverBackgroundRules.length, "styles.css 里一条 hover 底色规则都没解析到，先修解析器").toBeGreaterThan(3);
    expect(
      hoverBackgroundRules.some((d) => d.classes.includes("btn-danger") && d.conditions.includes("not-disabled")),
      "必须解析到 danger 的 :hover:not(:disabled) 底色规则"
    ).toBe(true);
  });

  it("每条按钮组合的 hover 底色都必须是设计意图的那一族", () => {
    const wrong: string[] = [];
    COMBOS.forEach((combo) => {
      const got = resolve(DECLS, combo.classes, "background", { hover: true, disabled: false });
      if (got.value !== combo.hoverBackground) {
        wrong.push(`${combo.where} [${combo.classes.join(" ")}] 期望 ${combo.hoverBackground}，实得 ${got.value}（赢家 ${got.winner}）`);
      }
    });
    expect(wrong, "hover 底色被别的规则反超：\n" + wrong.join("\n")).toEqual([]);
  });

  it("danger 与 ghost 共现时，红底必须靠特异度赢，不许靠文档顺序", () => {
    const combo = ["btn", "btn-ghost", "btn-danger"];
    const ctx: Context = { hover: true, disabled: false };
    const candidates = DECLS.filter((d) => d.prop === "background" && applies(d, combo, ctx));
    const topSpec = Math.max(...candidates.map((d) => d.spec));
    const red = candidates.filter((d) => d.value.includes("244, 67, 54"));
    expect(red.length, "danger 的 hover 红底规则不存在").toBeGreaterThan(0);
    expect(Math.max(...red.map((d) => d.spec)), "红底规则的特异度必须严格高于中性 --bg-hover 那条，否则又是赌顺序").toBeGreaterThan(
      candidates.find((d) => d.value === "var(--bg-hover)")?.spec ?? 0
    );
    expect(topSpec, "最高特异度那一条必须就是红底，顺序无所谓").toBe(Math.max(...red.map((d) => d.spec)));
  });

  it("disabled 期间不许有任何 hover 反馈（假可点性）", () => {
    const lying: string[] = [];
    COMBOS.forEach((combo) => {
      (["background", "border-color"] as const).forEach((prop) => {
        const offHover = resolve(DECLS, combo.classes, prop, { hover: false, disabled: true });
        const onHover = resolve(DECLS, combo.classes, prop, { hover: true, disabled: true });
        if (offHover.value !== onHover.value) {
          lying.push(
            `${combo.classes.join(" ")} 的 ${prop}：禁用态悬停从 ${offHover.value} 变成 ${onHover.value}（赢家 ${onHover.winner}）`
          );
        }
      });
    });
    expect(lying, "禁用按钮仍在画 hover 态：\n" + lying.join("\n")).toEqual([]);
  });

  it("@media 里不许再写按钮 tone 的 hover 覆盖（媒体块不参与本守卫决胜）", () => {
    const blocks = Array.from(blankComments(CSS).matchAll(/@media[^{]*\{([\s\S]*?)\n\}/g));
    const hits: string[] = [];
    blocks.forEach((block) => {
      collectDecls(block[1]).decls.forEach((d) => {
        if (d.classes.some((c) => c.startsWith("btn-")) && d.conditions.includes("hover")) {
          hits.push(d.sel);
        }
      });
    });
    expect(hits, "媒体块里的按钮 hover 覆盖会把决胜变成「看谁在哪个断点」，本轮口径先禁掉：\n" + hits.join("\n")).toEqual([]);
  });

  it("danger 与 ghost 共现时，红底必须靠特异度赢，不许靠文档顺序", () => {
    expect(redWinsBySpecificityProblems(CSS), "本轮 R85 的修法被打回").toEqual([]);
  });

  it("被跳过的规则里不许藏着按钮 tone 的 hover 规则（否则本守卫会假绿）", () => {
    const blind = parsed.skipped.filter((sel) => /:hover/.test(sel) && /(^|\.)btn[-.]/.test(sel));
    expect(blind, "这些 hover 规则没进决胜，先扩口径再收工：\n" + blind.join("\n")).toEqual([]);
  });

  it("自检：摘掉 danger×ghost 复合 hover 选择器必须判红", () => {
    const mutated = CSS.replace(
      ".btn-danger:hover:not(:disabled),\n.btn-ghost.btn-danger:hover:not(:disabled) {",
      ".btn-danger:hover:not(:disabled) {"
    );
    expect(mutated, "变异锚点没命中，样式写法变了要一起改这条自检").not.toBe(CSS);
    const problems = redWinsBySpecificityProblems(mutated);
    expect(problems.length, "摘掉复合选择器 = 退回赌顺序，必须判红").toBeGreaterThan(0);
    // 值本身此刻还是红的（写在后面所以赢），这正是「只看值」抓不到的那类回归。
    const decls = collectDecls(withoutAtBlocks(blankComments(mutated))).decls;
    expect(resolve(decls, ["btn", "btn-ghost", "btn-danger"], "background", { hover: true, disabled: false }).value).toBe(
      "rgba(244, 67, 54, 0.15)"
    );
  });

  it("自检：摘掉 danger hover 的 :not(:disabled) 必须判红", () => {
    const mutated = CSS.replace(".btn-danger:hover:not(:disabled),", ".btn-danger:hover,");
    expect(mutated, "变异锚点没命中").not.toBe(CSS);
    const decls = collectDecls(withoutAtBlocks(blankComments(mutated))).decls;
    const off = resolve(decls, ["btn", "btn-danger"], "background", { hover: false, disabled: true });
    const on = resolve(decls, ["btn", "btn-danger"], "background", { hover: true, disabled: true });
    expect(on.value, "禁用中的 danger 按钮又画红底了，假可点性必须被抓住").not.toBe(off.value);
  });
});
