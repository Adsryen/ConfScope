/**
 * 「隐藏 + 悬停/聚焦才显形」的控件，显形规则不许被后面的无条件覆写打哑（R74 / 波46）。
 *
 * 为什么要静态守：`opacity: 0` 配 `:hover / :focus-within → opacity: 1` 是一套完整意图，
 * 但有人在文件靠后随手补一条同选择器的 `opacity: 1`「临时让按钮常显」。同特异度、位置更靠后 →
 * 无条件那条恒赢，上面两条显形规则从此永远不会生效：写规则的人以为做了渐进显形，
 * 屏幕上其实一直是常显，鼠标移开也不会藏起来。tsc 不报错、浏览器不报错、肉眼只看到「按钮在」，
 * 所以把这类打哑写死成基线：只许减，不许加。
 *
 * 只扫顶层规则，且只认「选择器恰好等于被显形类名」的无条件覆写：
 * `.task-item.active .task-item-actions` 这种带状态前提的不算——它本身就是显形规则的同伴。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CSS_PATH = join(PROJECT_ROOT, "src/styles.css");

/** 打哑的历史现场。修一处删一行；下面那条「基线不得留着已消失的条目」会盯着。 */
const BASELINE: Record<string, string[]> = {};

/** 静止态「藏起来」与显形后的「亮出来」成对出现，才构成一套显形意图。 */
const HIDE_SHOW: Array<{ prop: string; hide: string; show: string }> = [
  { prop: "opacity", hide: "0", show: "1" },
  { prop: "visibility", hide: "hidden", show: "visible" },
];

interface Rule {
  selector: string;
  line: number;
  decls: Map<string, string>;
}

function blankComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

/** 顶层规则 = 选择器不以 @ 开头；`@media` 整块跳过（含内部规则），同 duplicateSelectors 口径。 */
function topLevelRules(css: string): Rule[] {
  const text = blankComments(css);
  const rules: Rule[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf("{", cursor);
    if (open === -1) break;
    const selector = text.slice(cursor, open).replace(/\s+/g, " ").trim();
    let depth = 1;
    let end = open + 1;
    while (end < text.length && depth > 0) {
      if (text[end] === "{") depth += 1;
      else if (text[end] === "}") depth -= 1;
      end += 1;
    }
    if (!selector.startsWith("@") && !selector.includes("{")) {
      const decls = new Map<string, string>();
      text
        .slice(open + 1, end - 1)
        .split(";")
        .forEach((part) => {
          const at = part.indexOf(":");
          if (at === -1) return;
          const prop = part.slice(0, at).trim().toLowerCase();
          const value = part
            .slice(at + 1)
            .trim()
            .toLowerCase()
            .replace(/\s+/g, " ");
          if (prop) decls.set(prop, value);
        });
      rules.push({ selector, line: text.slice(0, cursor).split("\n").length, decls });
    }
    cursor = end;
  }
  return rules;
}

/** `.backup-item:hover .backup-item-delete` → 被显形的是最后一段的类名 `.backup-item-delete`。 */
function targetClassOf(compound: string): string | null {
  const segments = compound.trim().split(/\s+/).filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  const match = last.match(/^(\.[-A-Za-z_][-A-Za-z0-9_]*)/);
  return match ? match[1] : null;
}

/** 选择器里带了状态前提（伪类 / 属性 / 额外类名）就不是无条件规则。 */
function isConditional(selector: string): boolean {
  return /[:[]/.test(selector) || selector.split(/\s+/).some((compound) => compound.trim().split(".").length > 2);
}

function findSilencedReveals(rules: Rule[]): string[] {
  const offenders: string[] = [];
  for (const { prop, hide, show } of HIDE_SHOW) {
    const hidden = rules.filter((rule) => rule.selector === targetOfHidden(rule) && rule.decls.get(prop) === hide);
    for (const base of hidden) {
      const cls = base.selector;
      const reveals = rules.filter(
        (rule) =>
          rule.line > base.line && rule.decls.get(prop) === show && targetClassOf(rule.selector) === cls && isConditional(rule.selector)
      );
      if (reveals.length === 0) continue;
      const lastRevealLine = Math.max(...reveals.map((rule) => rule.line));
      const silencers = rules.filter((rule) => rule.selector === cls && rule.decls.get(prop) === show && rule.line > lastRevealLine);
      if (silencers.length > 0) {
        offenders.push(
          `${cls}|${prop}：显形规则 L${reveals.map((r) => r.line).join("/L")} 被无条件覆写 L${silencers.map((r) => r.line).join("/L")} 打哑`
        );
      }
    }
  }
  return offenders;
}

/** 只有「选择器本身就是一个类名」的规则才配当静止基线：`.x .y` 是条件规则，不算基线。 */
function targetOfHidden(rule: Rule): string | null {
  return /^[.][-A-Za-z_][-A-Za-z0-9_]*$/.test(rule.selector) ? rule.selector : null;
}

const RULES = topLevelRules(readFileSync(CSS_PATH, "utf8"));
const OFFENDERS = findSilencedReveals(RULES);
const OFFENDER_KEYS = OFFENDERS.map((text) => text.split("：")[0]);

describe("显形规则不许被无条件覆写打哑", () => {
  it("基线之外的「隐藏 + 状态显形 + 后面无条件抬成显形值」一处都不许有", () => {
    const offenders = OFFENDERS.filter((text) => {
      const key = text.split("：")[0];
      return !(BASELINE[key.split("|")[0]] ?? []).includes(key.split("|")[1]);
    });
    expect(offenders, `这些显形规则永远不会生效，等于没写：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("基线只减不增：已经修好的条目要一起删掉", () => {
    const alive = new Set(OFFENDER_KEYS);
    const stale = Object.entries(BASELINE)
      .flatMap(([selector, props]) => props.map((prop) => `${selector}|${prop}`))
      .filter((key) => !alive.has(key));
    expect(stale, "这些打哑其实已经不存在了，请把基线里对应条目删掉").toEqual([]);
  });

  it("任务行操作区：静止隐藏，鼠标、键盘、选中三种途径都能显形", () => {
    const base = RULES.find((rule) => rule.selector === ".task-item-actions" && rule.decls.get("opacity") === "0");
    expect(base, "找不到 .task-item-actions 的静止隐藏基线，操作区又常显了？").toBeTruthy();
    const reveal = RULES.filter((rule) => rule.decls.get("opacity") === "1" && targetClassOf(rule.selector) === ".task-item-actions");
    const selectors = reveal.flatMap((rule) => rule.selector.split(",").map((part) => part.trim()));
    ["hover", "focus-within", "active"].forEach((trigger) => {
      expect(
        selectors.some((selector) => selector.includes(trigger)),
        `显形少了 ${trigger} 这条途径`
      ).toBe(true);
    });
    expect(
      selectors.every((selector) => selector.includes(".task-item")),
      "显形规则得挂在任务行上，别飘到别的选择器"
    ).toBe(true);
  });

  it(".task-item-actions 不许再出现无条件 opacity 覆写", () => {
    const unconditional = RULES.filter((rule) => rule.selector === ".task-item-actions" && rule.decls.has("opacity"));
    expect(
      unconditional,
      `.task-item-actions 只能有一份 opacity（静止态隐藏）：${unconditional.map((rule) => `L${rule.line}`).join(", ")}`
    ).toHaveLength(1);
  });

  it("对照组：备份删除按钮的显形同样是 hover + focus-within 双通道", () => {
    const reveal = RULES.filter((rule) => rule.decls.get("opacity") === "1" && targetClassOf(rule.selector) === ".backup-item-delete");
    const selectors = reveal.flatMap((rule) => rule.selector.split(",").map((part) => part.trim()));
    expect(
      selectors.some((selector) => selector.includes(":hover")),
      "备份删除按钮的 hover 显形被删了"
    ).toBe(true);
    expect(
      selectors.some((selector) => selector.includes(":focus-within")),
      "备份删除按钮的键盘显形被删了"
    ).toBe(true);
  });
});
