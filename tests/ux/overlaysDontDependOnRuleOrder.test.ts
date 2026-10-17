/**
 * 弹层覆盖必须靠特异度赢，不许再靠文档顺序决胜（R78 / 波53）。
 *
 * 为什么要静态守：`.modal-md { width: min(560px, calc(100vw - 32px)) }` 躺在 1862 行，
 * 一行都不生效——它和 4132 行的 `.modal { width: 720px }` 同为 (0,1,0)，同特异度谁写在后面谁赢，
 * 于是 ConfigBrowser 的「就地批量替换计划确认」和「应用目标选择」两个弹层被撑成 720px。
 * 这类 bug 三不报错：tsc 不报错、浏览器不报错、grep 还能看到那条规则活得好好的。
 * 更要命的是它随时能复发：谁整理样式把两段挪个位置，今天侥幸写在后面的
 * `.modal-sm` / `.modal-lg` / `.about-modal` / portal 的 `right: auto` 就换一批失效
 * ——`min-width: 100%` 在 fixed 元素上以视口为基准，不被中和的话下拉框直接铺满一屏宽。
 *
 * 所以这里做一件可以静态证明的事：修饰类一律写成 `.基础类.修饰类`，让覆盖者特异度严格高于
 * 基础类，胜负与文档顺序无关。守卫按真实元素的类集合跑一遍迷你级联，断言三件事：
 *   1. 赢家就是那条修饰类规则，且值与下面的契约表一致；
 *   2. 候选里没有任何「同特异度且值不同」的竞争者——有就说明还得靠先后决胜；
 *   3. 候选里没人用 !important 掀桌（important 绕过特异度，等价于把胜负重新交给顺序）。
 *
 * 口径与轮23 的探测器 .trellis/tasks/10-18-uiux-round23-class-override-single-source/
 * research/r23_conflict.py 保持一致：只扫顶层规则（跳过 @media，波46 假阳性教训）、
 * 选择器按逗号拆项、只认纯 class 复合选择器、元素类集合取 JSX 里 className 的纯静态字符串。
 * 带组合器/伪类/属性选择器的规则不算——「两族是否永远共存」在静态阶段证不了，宁可漏报不误报。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readScannedSource, sourceFiles } from "./scanUtils";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CSS_PATH = join(PROJECT_ROOT, "src/styles.css");

/**
 * 契约表：每条 = 一个「修饰类必须赢过基础类」的现场。
 * selector 是 styles.css 里必须存在的复合选择器；classes 是组件上共存的额外类名
 * （两个批量替换弹层除了 modal + modal-md 还挂了第三个类，它同样能凑出同特异度的竞争者）；
 * pins 是这一族的尺寸契约——PRD 里点名「不许变的东西」，改尺寸的人必须连这张表一起改，
 * 于是「顺手把 .modal 撑成 100vw」这类静默变化会被拦下来讨论，而不是直接飘到屏幕上。
 */
interface OverrideCase {
  selector: string;
  classes?: string[];
  pins?: Record<string, string>;
}

const CASES: OverrideCase[] = [
  { selector: ".modal.modal-sm", pins: { width: "460px" } },
  {
    selector: ".modal.modal-md",
    classes: ["browser-replace-modal"],
    pins: { width: "min(560px, calc(100vw - 32px))" },
  },
  {
    selector: ".modal.modal-md",
    classes: ["browser-target-modal"],
    pins: { width: "min(560px, calc(100vw - 32px))" },
  },
  { selector: ".modal.modal-lg", pins: { width: "860px" } },
  {
    selector: ".modal.modal-error",
    pins: { width: "min(760px, calc(100vw - 32px))", "max-height": "calc(100vh - 48px)" },
  },
  {
    selector: ".modal.about-modal",
    pins: {
      width: "560px",
      "max-width": "90vw",
      "max-height": "85vh",
      "overflow-y": "auto",
      "overscroll-behavior": "contain",
    },
  },
  { selector: ".modal-overlay.error-overlay", pins: { "z-index": "420" } },
  { selector: ".sel-menu.sel-menu-portal", pins: { right: "auto", "min-width": "0" } },
  { selector: ".combo-menu.combo-menu-portal", pins: { right: "auto", "min-width": "0" } },
];

/** 基础类自己：值也得钉住，否则「这个 720px 是哪来的」下次还要重查一遍。 */
const BASE_PINS: OverrideCase[] = [
  { selector: ".modal", pins: { width: "720px", "max-width": "92vw", "max-height": "88vh" } },
  { selector: ".modal-overlay", pins: { "z-index": "100" } },
];

interface Decl {
  prop: string;
  value: string;
  important: boolean;
}

interface Rule {
  /** 逗号拆开的每一项 */
  selectors: string[];
  line: number;
  /** 文档顺序（顶层规则序号）：同特异度时后写的赢 */
  order: number;
  decls: Decl[];
}

interface Candidate {
  selector: string;
  /** 纯 class 复合选择器 ⇒ 特异度就是类名个数 */
  spec: number;
  order: number;
  line: number;
  value: string;
  important: boolean;
}

/** 注释里也写着属性名和类名，算之前一律换成等长空白，行号才对得上原文件。 */
function blankComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

/** 顶层规则 = 选择器不以 @ 开头；`@media` 整块跳过（含内部规则），同 duplicateSelectors 口径。 */
function parseRules(css: string): Rule[] {
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
      const decls: Decl[] = [];
      text
        .slice(open + 1, end - 1)
        .split(";")
        .forEach((part) => {
          const at = part.indexOf(":");
          if (at === -1) return;
          const prop = part.slice(0, at).trim().toLowerCase();
          if (!/^[-a-z]+$/.test(prop)) return;
          const value = part
            .slice(at + 1)
            .trim()
            .toLowerCase()
            .replace(/\s+/g, " ");
          if (!value) return;
          decls.push({ prop, value: value.replace(/\s*!\s*important$/, ""), important: /!\s*important$/.test(value) });
        });
      rules.push({
        selectors: selector
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean),
        line: text.slice(0, cursor).split("\n").length,
        order: rules.length,
        decls,
      });
    }
    cursor = end;
  }
  return rules;
}

const PURE_CLASS = /^\.[\w-]+(?:\.[\w-]+)*$/;

/** 纯 class 复合选择器 → 类名 token 列表；带组合器/伪类/属性选择器的返回 null（共现证不了）。 */
function classTokens(selector: string): string[] | null {
  if (!PURE_CLASS.test(selector)) return null;
  return selector.split(".").filter(Boolean);
}

/** 迷你级联：某元素类集合上、某属性的全部候选声明，按 (important, 特异度, 文档顺序) 决胜。 */
function candidatesFor(rules: Rule[], classes: string[], prop: string): Candidate[] {
  const present = new Set(classes);
  const found: Candidate[] = [];
  rules.forEach((rule) => {
    rule.selectors.forEach((selector) => {
      const tokens = classTokens(selector);
      if (!tokens || !tokens.every((token) => present.has(token))) return;
      rule.decls.forEach((decl) => {
        if (decl.prop !== prop) return;
        found.push({ selector, spec: tokens.length, order: rule.order, line: rule.line, value: decl.value, important: decl.important });
      });
    });
  });
  return found.sort((a, b) => Number(b.important) - Number(a.important) || b.spec - a.spec || b.order - a.order);
}

function ruleFor(rules: Rule[], selector: string): Rule | undefined {
  return rules.find((rule) => rule.selectors.includes(selector));
}

function label(candidate: Candidate): string {
  return `${candidate.selector}:${candidate.line}=${candidate.value}${candidate.important ? " !important" : ""}`;
}

/** 元素类集合：复合选择器自身的 token + 组件上共存的额外类名。 */
function elementClasses(item: OverrideCase): string[] {
  return [...new Set([...(classTokens(item.selector) ?? []), ...(item.classes ?? [])])];
}

/** 一条契约的违例：赢家不对 / 有同特异度竞争者 / 值与契约表不符。 */
function violationsFor(rules: Rule[], item: OverrideCase, props: string[]): string[] {
  const offenders: string[] = [];
  const rule = ruleFor(rules, item.selector);
  if (!rule) {
    return [`${item.selector}：styles.css 里找不到这条规则，修饰类必须写成 .基础类.修饰类 的复合形式`];
  }
  const classes = elementClasses(item);
  const shown = [...classes].sort().join(" ");
  const own = classTokens(item.selector)?.length ?? 0;
  props.forEach((prop) => {
    if (!rule.decls.some((decl) => decl.prop === prop)) {
      if (item.pins?.[prop] !== undefined) {
        offenders.push(`${item.selector} [${prop}]：规则里已经没有这条声明了，契约表里的这一行要一起删掉`);
      }
      return;
    }
    const candidates = candidatesFor(rules, classes, prop);
    const winner = candidates[0];
    if (!winner) {
      offenders.push(`${item.selector} [${prop}] @{${shown}}：一条候选声明都找不到，规则被删空了？`);
      return;
    }
    if (winner.selector !== item.selector) {
      const reason = winner.important
        ? "生效的那条用 !important 绕过了特异度"
        : winner.spec > own
          ? `冒出了更高特异度的 ${winner.selector}`
          : "同特异度时靠文档顺序决胜，写在后面的赢";
      offenders.push(`${item.selector} [${prop}] @{${shown}}：生效的是 ${label(winner)}，修饰类没赢 —— ${reason}`);
      return;
    }
    const rivals = candidates.filter(
      (other) => other !== winner && other.spec === winner.spec && other.important === winner.important && other.value !== winner.value
    );
    if (rivals.length > 0) {
      offenders.push(
        `${item.selector} [${prop}] @{${shown}}：与 ${rivals.map(label).join(" / ")} 同特异度(${winner.spec})，` +
          "谁写在后面谁赢；请提特异度，别赌顺序"
      );
    }
    const expected = item.pins?.[prop];
    if (expected !== undefined && winner.value !== expected) {
      offenders.push(`${item.selector} [${prop}]：生效值 ${winner.value} 与契约表 ${expected} 不符（要改尺寸请连本表一起改）`);
    }
  });
  return offenders;
}

function findOffenders(css: string): string[] {
  const rules = parseRules(css);
  const offenders: string[] = [];
  CASES.forEach((item) => {
    const rule = ruleFor(rules, item.selector);
    offenders.push(...violationsFor(rules, item, rule ? [...new Set(rule.decls.map((decl) => decl.prop))] : []));
  });
  BASE_PINS.forEach((base) => offenders.push(...violationsFor(rules, base, Object.keys(base.pins ?? {}))));
  return offenders;
}

/** 真实组件里静态 className 的类集合，用来证明契约表对应的元素确实存在。 */
function staticClassSets(): string[][] {
  const acc: string[][] = [];
  sourceFiles().forEach((file) => {
    if (!file.endsWith(".tsx")) return;
    const source = readScannedSource(file);
    Array.from(source.matchAll(/className="([^"]*)"/g)).forEach((match) => {
      const value = match[1].trim();
      if (!value || value.includes("{") || value.includes("`")) return;
      acc.push(value.split(/\s+/).filter(Boolean));
    });
  });
  return acc;
}

const CSS = readFileSync(CSS_PATH, "utf8");
const OFFENDERS = findOffenders(CSS);

describe("弹层覆盖靠特异度赢，不靠文档顺序", () => {
  it("契约表里的修饰类全部生效，且没有同特异度的顺序赌局", () => {
    expect(OFFENDERS, `\n${OFFENDERS.join("\n")}`).toEqual([]);
  });

  it("每条契约都对应真实组件上共存的类名，不许守已经消失的现场", () => {
    const sets = staticClassSets();
    const missing = CASES.map((item) => {
      const classes = elementClasses(item);
      const hit = sets.some((present) => classes.every((token) => present.includes(token)));
      return hit ? null : `${item.selector} 对应的 [${classes.join(" ")}] 在 src 下没有任何静态 className 命中`;
    }).filter(Boolean);
    expect(missing, `\n${missing.join("\n")}`).toEqual([]);
  });

  it("契约表只减不增：属性不再被那条规则声明时，表里要一起删", () => {
    const rules = parseRules(CSS);
    const stale = CASES.flatMap((item) => {
      const rule = ruleFor(rules, item.selector);
      if (!rule) return [];
      const props = new Set(rule.decls.map((decl) => decl.prop));
      return Object.keys(item.pins ?? {})
        .filter((prop) => !props.has(prop))
        .map((prop) => `${item.selector} 已不再声明 ${prop}，请删掉契约表里的这一行`);
    });
    expect(stale, `\n${stale.join("\n")}`).toEqual([]);
  });

  it("自检一：修饰类退回裸类名必须判红", () => {
    const mutations: Array<[string, string]> = [
      [".modal.modal-md {", ".modal-md {"],
      [".sel-menu.sel-menu-portal,", ".sel-menu-portal,"],
      [".modal-overlay.error-overlay {", ".error-overlay {"],
    ];
    mutations.forEach(([from, to]) => {
      expect(CSS, `自检锚点找不到：${from}`).toContain(from);
      const offenders = findOffenders(CSS.replace(from, to));
      expect(offenders.length, `退回裸类名（${from} → ${to}）后守卫竟然全绿`).toBeGreaterThan(0);
    });
  });

  it("自检二：冒出同特异度的第三方覆盖，写在前面、写在后面都必须判红", () => {
    // 只认「赢家是修饰类」不够——修饰类今天侥幸赢了，明天有人补一条同特异度的就是掷骰子。
    const rival = ".modal.browser-replace-modal {\n  width: 640px;\n}\n";
    const cases: Array<[string, string, string]> = [
      ["追加在末尾（竞争者反过来赢）", `${CSS}\n${rival}`, "生效的是 .modal.browser-replace-modal"],
      ["写在最前面（修饰类侥幸赢）", `${rival}\n${CSS}`, "同特异度(2)"],
    ];
    cases.forEach(([where, css, expected]) => {
      const offenders = findOffenders(css).filter((text) => text.includes("browser-replace-modal"));
      expect(offenders.join("\n"), `${where}：同特异度竞争者没被抓住（报错里应有「${expected}」）`).toContain(expected);
    });
  });
});
