/**
 * 只读正文（滚动区）必须能被键盘到达（R39 / 轮9 波20）。
 *
 * 缺陷长什么样：错误详情、日志原文、配置正文这类 `overflow: auto` 的只读块，
 * 整块里没有任何可聚焦子孙，Tab 一按就跨过去了 —— 鼠标用户滚轮一看到底，
 * 键盘用户连后半段内容都看不见。这类问题不报错、不影响渲染，
 * 单测里 fireEvent 又永远点得到，只有静态扫才拦得住。
 *
 * 口径：
 * 1. styles.css 里带 overflow: auto|scroll 的类，凡挂在 <pre> 上，开标签必须齐
 *    tabIndex={0} + role="region" + aria-label|aria-labelledby（region 是给读屏的：
 *    aria-label 挂在裸 pre/div 这类隐式 generic 上会被部分读屏忽略）；
 * 2. 高亮叠层这类「假正文」豁免（真焦点在别的元素上），但要钉死数量并验证 aria-hidden；
 * 3. 非 pre 的滚动区靠登记表：合规数与总数都钉死，静默新增或漏改都会红；
 * 4. 能被 Tab 到达就得看得见：styles.css 里该类的 :focus-visible 必须真的画 outline。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, readScannedSource, sourceFiles } from "./scanUtils";

const CSS = readFileSync(join(PROJECT_ROOT, "src/styles.css"), "utf8");

/** styles.css 里带 overflow: auto|scroll 的类名集合（先抹注释，别把说明文字当规则）。 */
function scrollableClasses(): Set<string> {
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const found = new Set<string>();
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/overflow(?:-[xy])?\s*:\s*(auto|scroll)\b/.test(body)) continue;
    for (const part of selector.split(",")) {
      for (const [, name] of part.matchAll(/\.([A-Za-z][\w-]*)/g)) found.add(name);
    }
  }
  return found;
}

const SCROLLABLE = scrollableClasses();

/** 从 `<pre` 的尖括号起取到开标签结束（带括号深度与引号状态，避免被 `=>` 截断）。 */
function openingTagAt(source: string, start: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
    else if (ch === ">" && depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

/** 开标签上的 className 词元（模板串里的 `${}` 片段先抹平成空白再切）。 */
function classTokens(tag: string): string[] {
  const literal = tag.match(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/);
  const raw = literal ? `${literal[1] ?? ""} ${literal[2] ?? ""} ${literal[3] ?? ""}` : "";
  return raw
    .replace(/[`'"]/g, " ")
    .split(/[\s${}]+/)
    .filter(Boolean);
}

function isKeyboardAccessible(tag: string): boolean {
  const focusable = /tabIndex=\{0\}|tabIndex="0"/.test(tag) && !/tabIndex=\{-1\}/.test(tag);
  return focusable && /role="region"/.test(tag) && /aria-labelledby=|aria-label=/.test(tag);
}

/** 剥注释后的文本行数与原文一致，按换行数算行号，fixture（假路径）也能报行号。 */
function lineOf(stripped: string, index: number): number {
  return stripped.slice(0, index).split("\n").length;
}

interface Site {
  id: string;
  cls: string;
  tag: string;
  attrs: string;
  /** aria-labelledby 指向的变量名；用 aria-label 的站点为 null。 */
  labelRef: string | null;
  accessible: boolean;
}

/** aria-labelledby={foo} 里的 foo。写成模板串的按「查不到」处理，宁严不可漏。 */
function labelRefOf(attrs: string): string | null {
  const found = attrs.match(/aria-labelledby=\{(\w+)\}/);
  return found ? found[1] : null;
}

/** 假正文叠层：真正可聚焦的是外层 textarea，pre 本身必须 aria-hidden。 */
const LAYER_EXCEPTIONS: Record<string, number> = {
  "src/components/CodeEditor.tsx|code-editor-pre": 1,
};

/** 非 pre 的滚动区登记表：合规数与总数都钉死（总数里包含故意不可聚焦的那一份）。 */
const NON_PRE_REGISTRY: Record<string, { accessible: number; total: number }> = {
  // 更新说明是纯文本块，Tab 要能停进去
  "src/components/About.tsx|update-release-notes": { accessible: 1, total: 1 },
  // 左右两栏只有右栏是纯展示（左栏每行带 checkbox，Tab 本来就到得了）
  "src/components/DiffView.tsx|match-side-scroll": { accessible: 1, total: 2 },
};

function scanFile(relPath: string, stripped: string) {
  const preSites: Site[] = [];
  const exceptions: Site[] = [];
  const otherSites: Site[] = [];
  for (const match of stripped.matchAll(/<([a-z][\w-]*)\b/g)) {
    const tag = match[1];
    const start = match.index ?? 0;
    const attrs = openingTagAt(stripped, start);
    if (!attrs) continue;
    const tokens = classTokens(attrs);
    const cls = tokens.find((token) => SCROLLABLE.has(token));
    if (!cls) continue;
    const site: Site = {
      id: `${relPath}|${cls}|${lineOf(stripped, start)}`,
      cls,
      tag,
      attrs,
      labelRef: labelRefOf(attrs),
      accessible: isKeyboardAccessible(attrs),
    };
    if (NON_PRE_REGISTRY[`${relPath}|${cls}`]) otherSites.push(site);
    else if (tag === "pre") (LAYER_EXCEPTIONS[`${relPath}|${cls}`] ? exceptions : preSites).push(site);
  }
  return { preSites, exceptions, otherSites };
}

function scanAll() {
  const acc = { preSites: [] as Site[], exceptions: [] as Site[], otherSites: [] as Site[] };
  sourceFiles().forEach((rel) => {
    const result = scanFile(rel, readScannedSource(rel));
    acc.preSites.push(...result.preSites);
    acc.exceptions.push(...result.exceptions);
    acc.otherSites.push(...result.otherSites);
  });
  return acc;
}

const FOCUS_RING_CLASSES = [
  "code-area",
  "error-detail",
  "history-detail-content",
  "history-detail-error",
  "log-jsonl",
  "log-event-payload",
  "audit-detail-value",
  "inline-error-body",
  "update-release-notes",
  "match-side-scroll",
];

/** 该类的 :focus-visible 里有没有真的画 outline（值为 none 等于没画）。 */
function focusRingFor(cls: string): boolean {
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const found = css.match(new RegExp(`(?:^|[,{}\\s])\\.${cls}:focus-visible[^{]*\\{([^}]*)\\}`, "m"));
  if (!found) return false;
  return /outline:/.test(found[1]) && !/outline:\s*none\b/.test(found[1]);
}

describe("只读滚动区必须能被键盘到达", () => {
  it("样式里有 overflow 的只读 pre 都能 Tab 停进去且有可访问名", () => {
    const sites = scanAll().preSites;
    const bad = sites.filter((site) => !site.accessible).map((site) => site.id);
    expect(bad, `这些只读正文键盘滚不到。补 tabIndex={0} + role="region" + aria-label/aria-labelledby：\n${bad.join("\n")}`).toEqual([]);
    // 轮13 波28 把 9 份手抄的 .inline-error 收进 src/components/InlineError.tsx 后，源码里的
    // 字面站点从 17 降到 9：运行时弹出的错误块数量没变，只是不再各写一份 <pre>。
    // 这份结构自带的 tabIndex/role 由 inlineErrorSingleSource.test.ts 钉住，这里只守住下限。
    expect(sites.length, "命中量低于预期，扫描逻辑可能失效了").toBeGreaterThanOrEqual(9);
  });

  it("假正文叠层豁免只减不增，且必须 aria-hidden", () => {
    const exceptions = scanAll().exceptions;
    Object.entries(LAYER_EXCEPTIONS).forEach(([key, count]) => {
      const hits = exceptions.filter((site) => site.id.split("|").slice(0, 2).join("|") === key);
      expect(hits.length, `${key} 的叠层数量变了，请连理由一起登记`).toBe(count);
      // 豁免只在「这一层对读屏隐藏、真焦点在 textarea 上」时成立，所以查它自己开标签上的 aria-hidden
      hits.forEach((site) => {
        expect(/aria-hidden=\{?["']?true/.test(site.attrs), `${site.id} 是叠层豁免，但没有 aria-hidden`).toBe(true);
      });
    });
    const extra = exceptions.filter((site) => !(site.id.split("|").slice(0, 2).join("|") in LAYER_EXCEPTIONS));
    expect(
      extra.map((site) => site.id),
      "新出现的「假正文」豁免要连同理由一起登记"
    ).toEqual([]);
  });

  it("非 pre 的滚动区按登记表钉死", () => {
    const found = scanAll().otherSites;
    Object.entries(NON_PRE_REGISTRY).forEach(([key, expected]) => {
      const hits = found.filter((site) => site.id.split("|").slice(0, 2).join("|") === key);
      expect(hits.length, `${key} 的站点总数变了（登记 ${expected.total}，实际 ${hits.length}）`).toBe(expected.total);
      const accessible = hits.filter((site) => site.accessible).length;
      expect(accessible, `${key} 需要键盘可达的份数对不上（登记 ${expected.accessible}）`).toBe(expected.accessible);
    });
    const unregistered = found
      .map((site) => site.id.split("|").slice(0, 2).join("|"))
      .filter((key, index, all) => !(key in NON_PRE_REGISTRY) && all.indexOf(key) === index);
    expect(unregistered, "新的非 pre 滚动区要先登记再实现").toEqual([]);
  });

  it("aria-labelledby 指向的 id 在本文件真的挂上了", () => {
    const dangling: string[] = [];
    let checked = 0;
    sourceFiles().forEach((rel) => {
      const stripped = readScannedSource(rel);
      const result = scanFile(rel, stripped);
      const sites = [...result.preSites, ...result.exceptions, ...result.otherSites];
      sites.forEach((site) => {
        if (!site.labelRef) return;
        checked += 1;
        const pattern = new RegExp("id=\\{" + site.labelRef + "\\}|id=\\{[^}]*" + site.labelRef + "[^}]*\\}");
        if (!pattern.test(stripped)) dangling.push(`${site.id} -> ${site.labelRef}`);
      });
    });
    expect(dangling, `这些滚动区的可访问名指向了不存在的 id：\n${dangling.join("\n")}`).toEqual([]);
    expect(checked, "至少要有矩阵详情这类动态命名站点，否则这条守卫是空的").toBeGreaterThanOrEqual(1);
  });

  it("能被 Tab 到达就有看得见的焦点环", () => {
    const missing = FOCUS_RING_CLASSES.filter((cls) => !focusRingFor(cls));
    expect(missing, `这些滚动区可达但不可见：${missing.join(", ")}`).toEqual([]);
  });
});
