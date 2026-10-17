/**
 * 「只有鼠标悬停才显形」的控件必须同时接受键盘焦点（R37）。
 *
 * 为什么要静态守：`opacity: 0` 不是 `visibility: hidden`——按钮照样在 Tab 顺序里、照样能点。
 * 于是键盘用户会遇到两个坑：焦点落在一个看不见的删除按钮上（Enter 直接删快照，还以为是提交），
 * 或者根本找不到这个唯一能触发危险操作的入口。这类缺陷不报错、不影响渲染，肉眼只在鼠标下看得到，
 * 所以把「默认隐藏 + 只靠 :hover 显形」写死成基线：只许减，不许加。
 *
 * 只扫顶层规则：`@media` 里的覆盖本来就该晚于基础规则，混进来只剩噪音（同 duplicateSelectors 口径）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CSS_PATH = join(PROJECT_ROOT, "src/styles.css");

/** 历史上确实只靠 hover 显形的地方。清一处就删一行，下面那条用例盯着「基线不得留着已消失的条目」。 */
const BASELINE: Record<string, string[]> = {};

interface Rule {
  selector: string;
  line: number;
  decls: Array<[string, string]>;
}

/** 注释里也写着属性值，换成等长空白，报出来的行号才对得上原文件。 */
function blankComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

function parseDecls(body: string): Array<[string, string]> {
  return body
    .split(";")
    .map((part) => {
      const at = part.indexOf(":");
      if (at === -1) return null;
      const prop = part.slice(0, at).trim().toLowerCase();
      const value = part
        .slice(at + 1)
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
      return prop ? ([prop, value] as [string, string]) : null;
    })
    .filter((entry): entry is [string, string] => entry !== null);
}

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
      rules.push({ selector, line: text.slice(0, cursor).split("\n").length, decls: parseDecls(text.slice(open + 1, end - 1)) });
    }
    cursor = end;
  }
  return rules;
}

/** `.backup-item:hover .backup-item-delete` → 被显形的是最后一段 `.backup-item-delete`。 */
function targetOf(compound: string): string | null {
  const segments = compound.trim().split(/\s+/).filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  const match = last.match(/^(\.[-A-Za-z_][-A-Za-z0-9_]*)/);
  return match ? match[1] : null;
}

const KEYBOARD_PSEUDOS = [":focus-within", ":focus-visible", ":focus"];

/** 一条复合选择器用了哪些触发方式。 */
function triggersOf(compound: string): { hover: boolean; keyboard: boolean } {
  return {
    hover: compound.includes(":hover"),
    keyboard: KEYBOARD_PSEUDOS.some((pseudo) => compound.includes(pseudo)),
  };
}

interface HiddenTarget {
  target: string;
  line: number;
  how: string;
}

/** 默认藏起来的东西：`opacity: 0` 或 `display: none`，且选择器本身就是那个类（不是父级:hover 形式）。 */
function hiddenTargets(rules: Rule[]): HiddenTarget[] {
  const found: HiddenTarget[] = [];
  rules.forEach((rule) => {
    rule.selector
      .split(",")
      .map((compound) => compound.trim())
      .forEach((compound) => {
        if (targetOf(compound) !== compound) return; // 只认「选择器就是这一个类」的定义处
        rule.decls.forEach(([prop, value]) => {
          if (prop === "opacity" && /^0(\.0+)?$/.test(value)) found.push({ target: compound, line: rule.line, how: "opacity: 0" });
          if (prop === "display" && value === "none") found.push({ target: compound, line: rule.line, how: "display: none" });
        });
      });
  });
  return found;
}

interface Reveal {
  hover: boolean;
  keyboard: boolean;
  line: number;
}

/** 把它显形出来的规则：opacity 拉回非 0，或 display 从 none 换成别的。 */
function revealsFor(rules: Rule[], target: string): Reveal[] {
  const reveals: Reveal[] = [];
  rules.forEach((rule) => {
    const revealsThis = rule.decls.some(
      ([prop, value]) => (prop === "opacity" && value !== "0" && !/^0(\.0+)?$/.test(value)) || (prop === "display" && value !== "none")
    );
    if (!revealsThis) return;
    rule.selector
      .split(",")
      .map((compound) => compound.trim())
      .filter((compound) => targetOf(compound) === target)
      .forEach((compound) => {
        const { hover, keyboard } = triggersOf(compound);
        reveals.push({ hover, keyboard, line: rule.line });
      });
  });
  return reveals;
}

function offenders(css: string): string[] {
  const rules = topLevelRules(css);
  const bad: string[] = [];
  hiddenTargets(rules).forEach(({ target, line, how }) => {
    if (target in BASELINE && BASELINE[target].includes(how)) return;
    const reveals = revealsFor(rules, target);
    const byHover = reveals.some((reveal) => reveal.hover && !reveal.keyboard);
    const byKeyboard = reveals.some((reveal) => reveal.keyboard);
    if (byHover && !byKeyboard) {
      const lines = reveals
        .filter((reveal) => reveal.hover)
        .map((reveal) => `L${reveal.line}`)
        .join(", ");
      bad.push(`${target}（${how} @ L${line}）只在 :hover ${lines} 显形，键盘 Tab 进去时它已经能被聚焦却看不见`);
    }
  });
  return bad;
}

const CSS = readFileSync(CSS_PATH, "utf8");

describe("hover 独显的控件必须对键盘焦点同样显形", () => {
  it("基线之外的「默认隐藏 + 只认 :hover」一个都不许有", () => {
    const found = offenders(CSS);
    expect(
      found,
      `这些控件平时靠 opacity:0 / display:none 藏着，只有鼠标悬停才露出来。给它们的容器补一条 :focus-within（或自身 :focus-visible）并列选择器：\n${found.join("\n")}`
    ).toEqual([]);
  });

  it("基线只减不增：已经改好的条目要一起删掉", () => {
    const alive = new Set(hiddenTargets(topLevelRules(CSS)).map(({ target, how }) => `${target}|${how}`));
    const stale = Object.entries(BASELINE)
      .flatMap(([target, hows]) => hows.map((how) => `${target}|${how}`))
      .filter((key) => !alive.has(key));
    expect(stale, "这些 hover 独显其实已经修好了，请把基线里对应条目删掉").toEqual([]);
  });

  it("R37 修好的两处必须仍然同时接受 hover 与 focus-within", () => {
    [".backup-item-delete", ".task-item-actions"].forEach((target) => {
      const reveals = revealsFor(topLevelRules(CSS), target);
      expect(
        reveals.some((reveal) => reveal.hover),
        `${target} 现在连 :hover 显形都没有了，检查选择器是否被改动`
      ).toBe(true);
      expect(
        reveals.some((reveal) => reveal.keyboard),
        `${target} 的 :focus-within 显形丢了，键盘用户又会摸到看不见的按钮`
      ).toBe(true);
    });
  });
});

describe("守卫自己：fixture 反例必须能被抓到", () => {
  it("只有 :hover 显形的 opacity:0 控件会被判违规", () => {
    const css = `.row-del { opacity: 0; } .row:hover .row-del { opacity: 1; }`;
    expect(offenders(css).join("\n")).toContain(".row-del");
  });

  it("补了 :focus-within 并列选择器就放过", () => {
    const css = `.row-del { opacity: 0; } .row:hover .row-del, .row:focus-within .row-del { opacity: 1; }`;
    expect(offenders(css)).toEqual([]);
  });

  it("display:none 换成 display:flex 同样纳入检查", () => {
    const css = `.row-actions { display: none; } .row:hover .row-actions { display: flex; }`;
    expect(offenders(css).join("\n")).toContain(".row-actions");
  });

  it("自身 :focus-visible 显形也算键盘可达", () => {
    const css = `.find-btn { opacity: 0; } .body:hover .find-btn, .find-btn:focus-visible { opacity: 1; }`;
    expect(offenders(css)).toEqual([]);
  });

  it("没有被默认藏起来的东西不关这条守卫的事", () => {
    const css = `.row-del { color: red; } .row:hover .row-del { color: blue; }`;
    expect(offenders(css)).toEqual([]);
  });

  it("注释里的 opacity: 0 不算数，且行号保持对齐", () => {
    const css = `/* .row-del { opacity: 0; } */\n.row:hover .row-del { opacity: 1; }`;
    expect(offenders(css)).toEqual([]);
  });
});
