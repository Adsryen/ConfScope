/**
 * 顶层重复选择器守卫（R31）。
 *
 * 为什么要静态守：同一个 `.env-badge` 在文件里写两遍，浏览器不报错、tsc 不报错、肉眼也看不出问题，
 * 只是**后一份静默赢**。于是出现了「颜色来自 A、圆角来自 B、截断来自 A」谁都不认的混合结果，
 * 改前一份的人以为自己在改配色，实际什么都没发生。复制粘贴一段样式正是最容易发生的时刻，
 * 所以把「同选择器 + 同属性」写死成基线：只许减，不许加。
 *
 * 只扫顶层规则：`@media` 里的覆盖本来就该晚于基础规则，属正常写法，混进来只会让基线噪音盖过真问题。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CSS_PATH = join(PROJECT_ROOT, "src/styles.css");

/**
 * 历史遗留的重复定义。key 是选择器，value 是在多份规则里被重复声明的属性。
 * 清掉一处就同时删掉这一行——下面「基线不得留着已经消失的重复」那条用例会盯着这点。
 * 波8 R31 已清掉 `.btn-sm` / `.field-error` / `.history-item:hover` / `.env-badge` / `.env-*` 六组。
 * 波45 R31 又把剩下 12 组清零，方向统一为「删掉被后面那份盖掉的较早声明」：
 * 同选择器同特异度，后一份对同一批元素恒赢，所以删前一份不改任何生效值，可静态证明。
 * 反过来把生效声明往上搬则不安全——两份之间同特异度、能命中同一元素的第三方声明会反超。
 */
const BASELINE: Record<string, string[]> = {
  // 波45 R31 已清掉 12 组：about 边框、history 页/筛选栏/列表/行/行头/行元信息/时间/dataId/
  // 详情操作区/详情正文、备份删除按钮。方向只有一个——删掉被后面那份静默盖掉的**较早声明**，
  // 生效值原地不动，所以 computed style 逐属性对拍为零差异（脚本 /tmp 侧对拍见任务 PRD）。
  ".task-item-actions": ["opacity"], // 波46 R74 收尾：这条不是噪音，是被抬成常显的真 bug
};

/** R31 合并过的选择器：这些一旦再出现第二份，就是「改了不生效」的坑，直接拦死。 */
const SINGLE_SOURCE_SELECTORS = [
  ".btn-sm",
  ".field-error",
  ".history-item:hover",
  ".env-badge",
  ".env-dev",
  ".env-test",
  ".env-staging",
  ".env-prod",
  ".env-canary",
  ".env-local",
  ".env-other",
];

interface Rule {
  selector: string;
  line: number;
  decls: Array<[string, string]>;
}

/** 注释里也写着属性和颜色值，算之前一律换成等长空白，行号才对得上原文件。 */
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

/** 顶层规则 = 选择器不以 @ 开头，且 `{}` 成对；`@media` 整块跳过（连同它内部的规则）。 */
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

interface Repeat {
  selector: string;
  prop: string;
  /** 每份规则里的行号与取值，顺序即层叠顺序——最后一条才是屏幕上生效的那条 */
  sites: Array<{ line: number; value: string }>;
}

function repeatedDeclarations(rules: Rule[]): Repeat[] {
  const bySelector = new Map<string, Rule[]>();
  rules.forEach((rule) => {
    const bucket = bySelector.get(rule.selector);
    if (bucket) bucket.push(rule);
    else bySelector.set(rule.selector, [rule]);
  });
  const repeats: Repeat[] = [];
  bySelector.forEach((bucket, selector) => {
    if (bucket.length < 2) return;
    const byProp = new Map<string, Array<{ line: number; value: string }>>();
    bucket.forEach((rule) => {
      rule.decls.forEach(([prop, value]) => {
        const sites = byProp.get(prop);
        if (sites) sites.push({ line: rule.line, value });
        else byProp.set(prop, [{ line: rule.line, value }]);
      });
    });
    byProp.forEach((sites, prop) => {
      if (sites.length > 1) repeats.push({ selector, prop, sites });
    });
  });
  return repeats.sort((a, b) => a.selector.localeCompare(b.selector) || a.prop.localeCompare(b.prop));
}

function describeRepeat(repeat: Repeat): string {
  const values = repeat.sites.map((site) => `L${site.line}: ${repeat.prop}=${site.value}`).join(" / ");
  return `${repeat.selector} { ${repeat.prop} } → ${values}`;
}

const RULES = topLevelRules(readFileSync(CSS_PATH, "utf8"));
const REPEATS = repeatedDeclarations(RULES);

describe("顶层重复选择器不得继续变多", () => {
  it("基线之外的重复（同选择器 + 同属性）一个都不许有", () => {
    const offenders = REPEATS.filter((repeat) => !(repeat.selector in BASELINE) || !BASELINE[repeat.selector].includes(repeat.prop)).map(
      describeRepeat
    );
    expect(
      offenders,
      `这些属性在同一个选择器上被写了两遍，后一份会静默盖掉前一份。要么合并成一份，要么换选择器作用域：\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("基线只减不增：已经清掉的重复要从基线里删掉", () => {
    const alive = new Set(REPEATS.map((repeat) => `${repeat.selector}|${repeat.prop}`));
    const stale = Object.entries(BASELINE)
      .flatMap(([selector, props]) => props.map((prop) => `${selector}|${prop}`))
      .filter((key) => !alive.has(key));
    expect(stale, "这些重复其实已经不存在了，请把基线里对应条目删掉").toEqual([]);
  });

  it("R31 合并过的选择器各自只剩一份", () => {
    const counts = new Map<string, number>();
    RULES.forEach((rule) => counts.set(rule.selector, (counts.get(rule.selector) ?? 0) + 1));
    const duplicated = SINGLE_SOURCE_SELECTORS.filter((selector) => (counts.get(selector) ?? 0) > 1);
    expect(duplicated, "这些选择器又出现第二份定义了").toEqual([]);
    SINGLE_SOURCE_SELECTORS.forEach((selector) => {
      expect(counts.get(selector), `styles.css 里找不到 ${selector}，改名或删除要连这条守卫一起改`).toBe(1);
    });
  });

  it("环境徽章的截断保护还得真的生效", () => {
    const badge = RULES.find((rule) => rule.selector === ".env-badge");
    expect(badge, "找不到 .env-badge 定义").toBeTruthy();
    const decls = new Map(badge!.decls);
    // 光有 text-overflow 没用：flex 容器上它不生效，长环境名会被硬裁半个字（R31 合并时踩到的点）
    expect(decls.get("display"), "display 不是 inline-block 的话省略号不会出现").toBe("inline-block");
    ["max-width", "overflow", "text-overflow", "white-space", "min-width", "border"].forEach((prop) => {
      expect(decls.has(prop), `.env-badge 少了 ${prop}，长环境名又会撑破行`).toBe(true);
    });
    expect(decls.get("text-overflow")).toBe("ellipsis");
  });
});
