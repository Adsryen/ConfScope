/**
 * 截断必须有提示（R35）。
 *
 * `text-overflow: ellipsis` 是设计意图：容器放不下就截成「…」。但截断只对**眼睛**可见，
 * 对读屏和复制都不存在——用户看见 `order-service-ti…` 就无从确认自己点的是哪一条配置，
 * 也抄不出完整 dataId。所以定这条规矩：凡是自身带省略号类的元素，自己或近三层祖先必须给 `title`。
 *
 * 为什么要静态守而不是改完就算：省略号类都在 styles.css 里，新增一条只需一行 CSS，
 * 而「补 title」要回到每个 tsx 用法点——不守的话第二次复制粘贴就漏。
 *
 * 口径细节（都是实测出来的坑）：
 * 1. 只看**最后一段复合选择器**带类的规则。`.apply-item-main span` 截断的是 span 不是容器，
 *    把 `apply-item-main` 当省略号类会误报整片列表；这类「后代规则」单独用 (容器类, 标签) 匹配。
 * 2. `.audit-cell.value` 这种并集选择器要求两个类同时命中，缺一个不算。
 * 3. 表单控件（input/textarea/select 及自定义 Select/NumberField/Combobox）里省略号是浏览器
 *    原生行为，值本身在控件里可见可编辑，不该拿 title 去补——只有 button 例外，它的文本真会被裁。
 * 4. className 常写成模板串 `` `a${x ? " b" : ""}` ``，只认 `className="..."` 会漏掉一半站点。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC = join(PROJECT_ROOT, "src");
const CSS_PATH = join(SRC, "styles.css");

/** 祖先链上找 title 的最大层数（含自身）。再深就不算「这个提示是给它的」了。 */
const TITLE_LOOKUP_DEPTH = 3;

/** 省略号是浏览器原生行为的标签，不参与守卫。 */
const NATIVE_ELLIPSIS_TAGS = new Set(["input", "textarea", "select", "option", "Select", "NumberField", "Combobox"]);

/** 少写样板：把一条 `[类名数组, 选择器]` 包成守卫需要的规则集合。 */
function rulesFor(...entries: [string[], string][]): { classSets: [string[], string][]; descendant: [string, string][] } {
  return { classSets: entries, descendant: [] };
}

interface TruncatedElement {
  file: string;
  line: number;
  tag: string;
  /** 命中的省略号选择器（原样，便于定位到 CSS 的那条规则） */
  selector: string;
  hasTitleSelf: boolean;
  hasTitleAncestor: boolean;
}

/** 行号/列号敏感的注释剥离：注释换成等长空白，字符串与模板字面量原样保留。 */
function stripComments(text: string): string {
  const out: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      let j = text.indexOf("\n", i);
      if (j < 0) j = n;
      out.push(" ".repeat(j - i));
      i = j;
    } else if (c === "/" && text[i + 1] === "*") {
      let j = text.indexOf("*/", i + 2);
      j = j < 0 ? n : j + 2;
      out.push(text.slice(i, j).replace(/[^\n]/g, " "));
      i = j;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === c) {
          j += 1;
          break;
        }
        j += 1;
      }
      out.push(text.slice(i, j));
      i = j;
    } else {
      out.push(c);
      i += 1;
    }
  }
  return out.join("");
}

/** 省略号规则：[类的并集, 原始选择器]；后代规则（末段不带类）另存 [容器类, 标签]。 */
function ellipsisRules(css: string): { classSets: [string[], string][]; descendant: [string, string][] } {
  const classSets: [string[], string][] = [];
  const descendant: [string, string][] = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null = ruleRe.exec(css);
  while (match) {
    const body = match[2].replace(/\/\*[\s\S]*?\*\//g, " ");
    if (!/text-overflow\s*:[^;]*ellipsis/.test(body)) {
      match = ruleRe.exec(css);
      continue;
    }
    const sel = match[1]
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\s+/g, " ")
      .trim();
    sel.split(",").forEach((part) => {
      const pieces = part
        .trim()
        .split(/[\s>+~]+/)
        .filter(Boolean);
      const last = pieces[pieces.length - 1] ?? "";
      const classes = [...last.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
      if (classes.length > 0) {
        classSets.push([classes, part.trim()]);
      } else if (pieces.length > 1) {
        // `.apply-ledger strong`：截断的是 strong，容器类是 apply-ledger
        const parentClasses = [...pieces[pieces.length - 2].matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
        parentClasses.forEach((cls) => descendant.push([cls, last]));
      }
    });
    match = ruleRe.exec(css);
  }
  return { classSets, descendant };
}

/** 从标签的属性串里解析 className 的类名集合，支持字符串、模板串、三元里的嵌套字符串。 */
function classTokens(attrs: string): string[] {
  const m = /\bclassName\s*=\s*/.exec(attrs);
  if (!m) return [];
  const tokens: string[] = [];
  let start = m.index + m[0].length;
  while (start < attrs.length && /\s/.test(attrs[start])) start += 1;
  // 模板串里 `${expr}` 会紧贴类名（`match-dataid${cond ? " x" : ""}`），插值符号也当分隔符
  const quoteWords = (raw: string) => raw.split(/[\s{}$"'"`]+/).filter(Boolean);
  const collect = (from: number, open: string): number => {
    // 从 from 开始读一个以 open 定界的字面量，返回结束位置（含定界符）
    let j = from + 1;
    while (j < attrs.length) {
      const ch = attrs[j];
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === open) return j + 1;
      if (open === "`" && ch === "$" && attrs[j + 1] === "{") {
        // 模板插值：跳过平衡的 }，内部再捞一层字面量
        let depth = 1;
        let k = j + 2;
        let inner = "";
        while (k < attrs.length && depth > 0) {
          const ic = attrs[k];
          if (ic === "{") depth += 1;
          else if (ic === "}") {
            depth -= 1;
            if (depth === 0) break;
          }
          inner += ic;
          k += 1;
        }
        [...inner.matchAll(/["'`]([^"'`]*)["'`]/g)].forEach((im) => tokens.push(...quoteWords(im[1])));
        j = k + 1;
        continue;
      }
      j += 1;
    }
    return j;
  };
  const open = attrs[start];
  if (open === '"' || open === "'" || open === "`") {
    tokens.push(...quoteWords(attrs.slice(start + 1, collect(start, open) - 1)));
  } else if (open === "{") {
    let depth = 0;
    let k = start;
    let expr = "";
    while (k < attrs.length) {
      const ch = attrs[k];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) break;
      } else expr += ch;
      k += 1;
    }
    [...expr.matchAll(/(["'`])(.*?)\1/g)].forEach((im) => tokens.push(...quoteWords(im[2])));
  }
  return [...new Set(tokens)];
}

/** 扫一份 tsx：找出「自身带省略号类/命中后代规则」且自身与近三层祖先都没有 title 的元素。 */
export function findTruncatedWithoutTitle(
  source: string,
  rules: { classSets: [string[], string][]; descendant: [string, string][] },
  fileLabel: string
): TruncatedElement[] {
  const src = stripComments(source);
  const hits: TruncatedElement[] = [];
  const stack: { tag: string; classes: string[]; hasTitle: boolean }[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    if (src[i] !== "<") {
      i += 1;
      continue;
    }
    const next = src[i + 1];
    if (next === "/") {
      const j = src.indexOf(">", i);
      const name = src.slice(i + 2, j < 0 ? n : j).trim();
      for (let k = stack.length - 1; k >= 0; k -= 1) {
        if (stack[k].tag === name) {
          stack.length = k;
          break;
        }
      }
      i = j < 0 ? n : j + 1;
      continue;
    }
    if (!/[A-Za-z]/.test(next ?? "")) {
      i += 1;
      continue;
    }
    // 读一个开始标签：> 只在花括号深度 0 处结束（onClick={() => x > 1} 不会误断）
    let j = i + 1;
    let depth = 0;
    while (j < n) {
      const ch = src[j];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      else if (ch === ">" && depth === 0) break;
      j += 1;
    }
    const tagText = src.slice(i, j + 1);
    const nameMatch = /^<([A-Za-z][A-Za-z0-9_.]*)/.exec(tagText);
    const tag = nameMatch ? nameMatch[1] : "?";
    const attrs = tagText.slice(nameMatch ? nameMatch[0].length : 1);
    const classes = classTokens(attrs);
    const hasTitle = /(^|[\s{])title\s*=/.test(attrs);
    const line = src.slice(0, i).split("\n").length;
    const parent = stack[stack.length - 1];
    const chain = stack.slice(-TITLE_LOOKUP_DEPTH);

    const matched: string[] = [];
    rules.classSets.forEach(([set, selector]) => {
      if (set.every((c) => classes.includes(c))) matched.push(selector);
    });
    rules.descendant.forEach(([cls, tagName]) => {
      if (tag === tagName && parent && parent.classes.includes(cls)) matched.push(`.${cls} ${tagName}`);
    });

    if (matched.length > 0 && !NATIVE_ELLIPSIS_TAGS.has(tag)) {
      const ancestorTitle = chain.some((el) => el.hasTitle);
      if (!hasTitle && !ancestorTitle) {
        hits.push({ file: fileLabel, line, tag, selector: matched[0], hasTitleSelf: false, hasTitleAncestor: false });
      }
    }
    if (!tagText.endsWith("/>")) stack.push({ tag, classes, hasTitle });
    i = j + 1;
  }
  return hits;
}

function productionSources(dir: string, out: string[] = []): string[] {
  readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) productionSources(full, out);
    else if (/\.tsx$/.test(entry.name) && !/\.(test|spec)\.tsx$/.test(entry.name)) out.push(full);
  });
  return out;
}

/**
 * 现存豁免（文件:行 → 选择器）。**只许减不许加**：
 * 加一条豁免等于承认「这里截断了但没人负责说明」，必须先补 title 再删这行。
 */
const BASELINE: Record<string, string> = {};

const css = stripComments(readFileSync(CSS_PATH, "utf8"));
const rules = ellipsisRules(css);

describe("截断的文本必须能悬停看全文（R35）", () => {
  it("CSS 侧确实扫到省略号类，守卫不是空跑", () => {
    expect(rules.classSets.length).toBeGreaterThan(20);
    expect(rules.descendant.length).toBeGreaterThan(5);
    const classes = rules.classSets.map(([set]) => set[0]);
    ["env-badge", "audit-dataid", "combo-val", "task-item-name", "side-label"].forEach((c) => {
      expect(classes).toContain(c);
    });
  });

  it("fixture：省略号元素自身与祖先都没有 title → 必须报", () => {
    const fixture = `const A = () => (\n  <div className="x">\n    <span className="audit-dataid">{row.dataId}</span>\n  </div>\n);\n`;
    const found = findTruncatedWithoutTitle(fixture, rulesFor([["audit-dataid"], ".audit-dataid"]), "fixture.tsx");
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(3);
  });

  it("fixture：近三层祖先有 title 就放过（容器级提示是本仓库既有写法）", () => {
    const fixture = `const A = () => (\n  <div className="x" title={full}>\n    <span className="audit-key-path">\n      <span className="audit-dataid">{row.dataId}</span>\n    </span>\n  </div>\n);\n`;
    expect(findTruncatedWithoutTitle(fixture, rulesFor([["audit-dataid"], ".audit-dataid"]), "fixture.tsx")).toHaveLength(0);
  });

  it("fixture：并集选择器要求两个类同时命中", () => {
    const noValue = `const A = () => <div className="audit-cell key">{x}</div>;\n`;
    const withValue = `const A = () => <div className="audit-cell value">{x}</div>;\n`;
    const set = rulesFor([["audit-cell", "value"], ".audit-cell.value"]);
    expect(findTruncatedWithoutTitle(noValue, set, "f.tsx")).toHaveLength(0);
    expect(findTruncatedWithoutTitle(withValue, set, "f.tsx")).toHaveLength(1);
  });

  it('fixture：模板串 className 也要认（只认 className="" 等于漏掉大半站点）', () => {
    const fixture = 'const A = () => <span className={`sel-value${cur ? "" : " placeholder"}`}>{x}</span>;\n';
    const found = findTruncatedWithoutTitle(fixture, rulesFor([["sel-value"], ".sel-value"]), "f.tsx");
    expect(found).toHaveLength(1);
  });

  it("fixture：原生表单控件的省略号不算问题，button 算", () => {
    const inputs = 'const A = () => <input className="audit-dataid" value={v} />;\n';
    const button = 'const A = () => <button className="snapshot-action-btn">{label}</button>;\n';
    const set = {
      classSets: [
        [["audit-dataid"], ".audit-dataid"],
        [["snapshot-action-btn"], ".snapshot-action-btn"],
      ],
      descendant: [],
    };
    expect(findTruncatedWithoutTitle(inputs, set, "f.tsx")).toHaveLength(0);
    expect(findTruncatedWithoutTitle(button, set, "f.tsx")).toHaveLength(1);
  });

  it("fixture：后代规则（.apply-ledger strong）盯的是被截的子元素", () => {
    const fixture = 'const A = () => (\n  <div className="apply-ledger">\n    <strong>{plan.id}</strong>\n  </div>\n);\n';
    const found = findTruncatedWithoutTitle(fixture, { classSets: [], descendant: [["apply-ledger", "strong"]] }, "f.tsx");
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(3);
  });

  it("真实代码：不允许出现基线之外的无提示截断", () => {
    const violations = productionSources(SRC).flatMap((file) =>
      findTruncatedWithoutTitle(readFileSync(file, "utf8"), rules, relative(PROJECT_ROOT, file).replace(/\\/g, "/"))
    );
    const keys = violations.map((v) => `${v.file}:${v.line}`);
    expect(keys.filter((k) => !(k in BASELINE))).toEqual([]);
  });

  it("基线里的豁免必须还存在（防止守卫悄悄空跑）", () => {
    const violations = productionSources(SRC).flatMap((file) =>
      findTruncatedWithoutTitle(readFileSync(file, "utf8"), rules, relative(PROJECT_ROOT, file).replace(/\\/g, "/"))
    );
    const keys = new Set(violations.map((v) => `${v.file}:${v.line}`));
    expect(Object.keys(BASELINE).filter((k) => !keys.has(k))).toEqual([]);
  });
});
