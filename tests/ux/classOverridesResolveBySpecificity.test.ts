/**
 * 跨类覆盖必须由特异度决胜，不许再赌文档顺序（轮23 R79 / 轮24 R80 / 轮25 R83）。
 *
 * 为什么值得静态守：`styles.css` 里 `.btn{padding:6px 14px}` 和 `.btn-sm{padding:4px 8px}` 特异度相同，
 * 谁写在后面谁赢。今天 .btn-sm 在后面所以看起来是对的，但任何人（包括 IDE 的格式化、一次「整理样式顺序」
 * 的顺手挪动）把这两条换个位置，全站 93 颗小按钮的内边距就静默变回去——没有报错、没有差异截图。
 * 轮23 的 .modal-md 已经真炸过一次（弹层宽度一直是 720px 而不是设计值 640px）。
 *
 * 轮25 把口径补齐的两块盲区：
 * - **简写与长写是同一样东西**：`.btn{border:1px solid transparent}` 里的 transparent 和
 *   `.btn-ghost{border-color:var(--border)}` 抢的是同一个面，旧口径当成两个属性所以静默放过。
 *   现在所有声明统一摊成长写再比。
 * - **`@media` 参与决胜**：轮25 扫出的真 bug 就是这一类——980px 的窄屏堆叠覆盖写在基础规则**前面**，
 *   同特异度被反超，从 45abe25b 写下来的那天起就没生效过。现在单独一类判定「响应式覆盖不许输给基础规则」。
 *
 * 口径（宁可漏报不误报）：
 * - 只看「纯 class 复合选择器」：带组合器/类型选择器/属性选择器/**伪类伪元素**的规则一律不收。
 *   伪类这块是明写的盲区：`.btn-ghost:hover:not(:disabled)` 真实特异度是 (0,3,0)，这里看不见，
 *   所以提特异度时必须人工确认不会把 hover 关系掀反（轮25 就是因为这个才没把 .btn-ghost 提成 .btn.btn-ghost）。
 * - 元素类集合只取 JSX 里 `className="..."` 的**纯静态字符串**；含插值/三元的一律跳过。
 *   运行时拼出来的类名靠人工核（轮25 用 research/r25_blindspots.py 的动态并集 + r25_cooccur.py 共现计数）。
 * - 选择器的全部 class token 都出现在元素上 ⇒ 该规则确定作用于该元素。
 * - 同属性上按 (特异度, 文档顺序) 决胜；只报「特异度相同、写在赢家前面、值还不一样」的败者。
 * - 只在**同一层**互比：都在顶层，或者都在同一个 `@media` 条件字符串里。900px 和 980px 不互比，
 *   免得两个断点互相噪声；跨层的关系交给「响应式覆盖不许输给基础规则」那条。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CSS = readFileSync(join(PROJECT_ROOT, "src/styles.css"), "utf8");

/**
 * 空基线 = 一条都不许有。真出现「设计上就必须同特异度竞争」的场合，把它加进来并写清理由，
 * 但下面「基线只减不增」会盯着它别变成永久赖皮。
 */
const BASELINE: string[] = [];

const PURE_CLASS = /^\.[\w-]+(?:\.[\w-]+)*$/;
const SIDES = ["top", "right", "bottom", "left"] as const;
const LINE_STYLES = ["none", "hidden", "dotted", "dashed", "solid", "double", "groove", "ridge", "inset", "outset"];

interface Decl {
  /** 逗号拆开后的单个选择器 */
  sel: string;
  /** 选择器里的 class token */
  tokens: string[];
  /** 摊平后的长写属性名 */
  prop: string;
  value: string;
  order: number;
  line: number;
  /** 所在 @media/@supports 的条件原文；顶层为 null */
  layer: string | null;
}

/** 注释换成等长空白：属性值里可能正好写着类名，行号也必须对得上原文件。 */
function blankComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

/** 按顶层空格切值（括号里的空格不算，`rgba(0 0 0 / .5)` 这种才切得对）。 */
function splitRaw(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    if (ch === " " && depth === 0) {
      if (cur) parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

/** 把 1/2/3/4 个值按 CSS 的 top right bottom left 规则补齐。 */
function splitVals(value: string, n: number): string[] {
  const parts = splitRaw(value);
  if (parts.length === 0) return Array.from({ length: n }, () => "");
  if (parts.length === 1) return n === 4 ? Array(4).fill(parts[0]) : [...parts, ...Array(n - 1).fill("")];
  if (parts.length === 2) return n === 4 ? [parts[0], parts[1], parts[0], parts[1]] : parts;
  if (parts.length === 3) return n === 4 ? [parts[0], parts[1], parts[2], parts[1]] : parts;
  return parts.slice(0, n);
}

/** `border` 简写的三个值顺序随意（width || style || color），按 token 类型认；没写的补初始值。 */
function splitBorder(value: string): [string, string, string] {
  let width = "";
  let style = "";
  let color = "";
  splitRaw(value).forEach((part) => {
    if (LINE_STYLES.includes(part)) style = part;
    else if (/^(?:0|[.\d]+(?:px|em|rem|pt|%)?|thin|medium|thick)$/.test(part)) width = part;
    else color = part;
  });
  return [width || "medium", style || "none", color || "currentcolor"];
}

/**
 * 简写摊成长写。**只摊值里真的出现的那一面**：`background: rgba(..)` 只算 background-color，
 * 不去补「顺手把 image/clip/attachment 重置成初始值」那一串——那会把八竿子打不着的规则
 * 也算成竞争者，误报把真问题淹掉。认不出来的写法原样返回（前后一致就能比）。
 */
function expandShorthand(prop: string, value: string): Array<[string, string]> {
  const v = value.trim();
  const side = /^border-(top|right|bottom|left)$/.exec(prop);
  if (prop === "border" || side) {
    const [width, style, color] = splitBorder(v);
    const sides = side ? [side[1]] : SIDES;
    return sides.flatMap((sd) => [
      [`border-${sd}-width`, width],
      [`border-${sd}-style`, style],
      [`border-${sd}-color`, color],
    ]) as Array<[string, string]>;
  }
  if (prop === "border-width" || prop === "border-style" || prop === "border-color") {
    const suffix = prop.slice("border-".length);
    return SIDES.map((sd) => [`border-${sd}-${suffix}`, v]) as Array<[string, string]>;
  }
  if (prop === "padding" || prop === "margin" || prop === "inset") {
    const prefix = prop === "inset" ? "" : `${prop}-`;
    return SIDES.map((sd, i) => [`${prefix}${sd}`, splitVals(v, 4)[i]]) as Array<[string, string]>;
  }
  if (prop === "gap") {
    const parts = splitVals(v, 2);
    return [
      ["row-gap", parts[0]],
      ["column-gap", parts[1]],
    ];
  }
  if (prop === "overflow") {
    const parts = splitVals(v, 2);
    return [
      ["overflow-x", parts[0]],
      ["overflow-y", parts[1] || parts[0]],
    ];
  }
  if (prop === "background") {
    return [[v.includes("url(") || v.includes("gradient(") ? "background-image" : "background-color", v]];
  }
  return [[prop, v]];
}

/**
 * 收集规则：`@media` / `@supports` / `@container` 递归进去并记住条件，其余 at-rules（`@keyframes`）
 * 整块跳过。order 按文档位置递增，跨层的顺序比较才可信。
 */
function collectDecls(css: string): Decl[] {
  const text = blankComments(css);
  const decls: Decl[] = [];
  let order = 0;

  const visit = (start: number, end: number, layer: string | null) => {
    let cursor = start;
    while (cursor < end) {
      const open = text.indexOf("{", cursor);
      if (open === -1 || open >= end) break;
      const head = text.slice(cursor, open);
      const selector = head.replace(/\s+/g, " ").trim();
      let depth = 1;
      let e = open + 1;
      while (e < end && depth > 0) {
        if (text[e] === "{") depth += 1;
        else if (text[e] === "}") depth -= 1;
        e += 1;
      }
      if (selector.startsWith("@")) {
        if (/^@(media|supports|container)\b/.test(selector)) visit(open + 1, e - 1, selector);
      } else if (selector && !selector.includes("{")) {
        const thisOrder = order;
        order += 1;
        const line = text.slice(0, cursor + (head.length - head.replace(/^\s+/, "").length)).split("\n").length;
        selector
          .split(",")
          .map((part) => part.trim())
          .filter((part) => PURE_CLASS.test(part))
          .forEach((sel) => {
            text
              .slice(open + 1, e - 1)
              .split(";")
              .forEach((part) => {
                const at = part.indexOf(":");
                if (at === -1) return;
                const prop = part.slice(0, at).trim().toLowerCase();
                const value = part
                  .slice(at + 1)
                  .trim()
                  .replace(/\s+/g, " ")
                  .toLowerCase();
                if (!/^[-a-z]+$/i.test(prop) || !value) return;
                expandShorthand(prop, value).forEach(([longProp, longValue]) => {
                  decls.push({
                    sel,
                    tokens: sel.match(/\.([\w-]+)/g)!.map((t) => t.slice(1)),
                    prop: longProp,
                    value: longValue,
                    order: thisOrder,
                    line,
                    layer,
                  });
                });
              });
          });
      }
      cursor = e;
    }
  };

  visit(0, text.length, null);
  return decls;
}

function walk(dir: string, out: string[] = []): string[] {
  readdirSync(dir).forEach((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".tsx") && !name.includes(".test.")) out.push(full);
  });
  return out;
}

/** 只认完全静态的 className 字符串——条件类名不等于「两族永远共存」。 */
function staticElements(files: string[]): Array<{ where: string; classes: Set<string> }> {
  const els: Array<{ where: string; classes: Set<string> }> = [];
  files.forEach((file) => {
    const src = readFileSync(file, "utf8");
    const found = src.match(/className="([^"]*)"/g) ?? [];
    found.forEach((hit) => {
      const value = hit.slice('className="'.length, -1).trim();
      if (!value || value.includes("{") || value.includes("}") || value.includes("`")) return;
      els.push({
        where: `${file.slice(PROJECT_ROOT.length + 1)}:${src.slice(0, src.indexOf(hit)).split("\n").length}`,
        classes: new Set(value.split(/\s+/)),
      });
    });
  });
  return els;
}

const beats = (a: Decl, b: Decl) => a.tokens.length > b.tokens.length || (a.tokens.length === b.tokens.length && a.order > b.order);

function applicable(decls: Decl[], classes: Set<string>): Decl[] {
  return decls.filter((decl) => decl.tokens.every((token) => classes.has(token)));
}

function byProp(decls: Decl[]): Map<string, Decl[]> {
  const out = new Map<string, Decl[]>();
  decls.forEach((decl) => {
    const bucket = out.get(decl.prop);
    if (bucket) bucket.push(decl);
    else out.set(decl.prop, [decl]);
  });
  return out;
}

/** 同层内：同特异度、写在赢家前面、值还不一样 = 只是「恰好写在后面」才生效。 */
function orderDecidedConflicts(css: string): string[] {
  const decls = collectDecls(css);
  const elements = staticElements(walk(join(PROJECT_ROOT, "src")));
  const layers = new Map<string | null, Decl[]>();
  decls.forEach((decl) => {
    const bucket = layers.get(decl.layer);
    if (bucket) bucket.push(decl);
    else layers.set(decl.layer, [decl]);
  });
  const hits: string[] = [];
  const seen = new Set<string>();
  elements.forEach(({ where, classes }) => {
    layers.forEach((layerDecls, layer) => {
      const candidates = applicable(layerDecls, classes);
      byProp(candidates).forEach((rivals, prop) => {
        const winner = rivals.reduce((best, cur) => (beats(cur, best) ? cur : best));
        rivals.forEach((cand) => {
          if (cand === winner || cand.tokens.length !== winner.tokens.length) return;
          if (cand.order >= winner.order || cand.value === winner.value) return;
          const key = `${[...classes].sort().join(" ")}|${prop}|${layer ?? ""}`;
          if (seen.has(key)) return;
          seen.add(key);
          hits.push(
            `${cand.sel} { ${prop}: ${cand.value} } 被同特异度的 ${winner.sel} { ${prop}: ${winner.value} } ` +
              `按文档顺序盖掉（元素 ${where}${layer ? `，${layer}` : ""}）`
          );
        });
      });
    });
  });
  return hits.sort();
}

/** 跨层：某个 `@media` 条件里写的覆盖，在它自己的视口范围内被基础规则吃掉 = 这意图从来没生效。 */
function mediaOverridesNeverTakingEffect(css: string): string[] {
  const decls = collectDecls(css);
  const elements = staticElements(walk(join(PROJECT_ROOT, "src")));
  const base = decls.filter((decl) => decl.layer === null);
  const layers = new Map<string, Decl[]>();
  decls
    .filter((decl) => decl.layer !== null)
    .forEach((decl) => {
      const bucket = layers.get(decl.layer as string);
      if (bucket) bucket.push(decl);
      else layers.set(decl.layer as string, [decl]);
    });
  const hits: string[] = [];
  const seen = new Set<string>();
  layers.forEach((layerDecls, layer) => {
    elements.forEach(({ where, classes }) => {
      const inLayer = applicable(layerDecls, classes);
      const inBase = applicable(base, classes);
      byProp(inLayer).forEach((rivals, prop) => {
        const loser = rivals.reduce((best, cur) => (beats(cur, best) ? cur : best));
        const baseRivals = byProp(inBase).get(prop);
        if (!baseRivals) return;
        // 基础规则里同属性的生效者：同样按 (特异度, 文档顺序) 决胜，不能抓第一条就算
        const taken = baseRivals.reduce((best, cur) => (beats(cur, best) ? cur : best));
        if (taken.value === loser.value) return;
        if (!beats(taken, loser)) return;
        const key = `${[...classes].sort().join(" ")}|${prop}|${layer}`;
        if (seen.has(key)) return;
        seen.add(key);
        hits.push(
          `${layer} 里 ${loser.sel} { ${prop}: ${loser.value} } 被基础规则 ${taken.sel} { ${prop}: ${taken.value} } ` +
            `吃掉（${taken.tokens.length > loser.tokens.length ? "基础规则特异度更高" : "基础规则写在媒体块之后"}），` +
            `这条响应式覆盖从未生效（元素 ${where}）`
        );
      });
    });
  });
  return hits.sort();
}

describe("跨类覆盖由特异度决胜，不赌文档顺序（R83）", () => {
  const OFFENDERS = orderDecidedConflicts(CSS);
  const DEAD_MEDIA = mediaOverridesNeverTakingEffect(CSS);

  it("同特异度靠顺序决胜的跨类覆盖一个都不许有", () => {
    expect(
      OFFENDERS.filter((row) => !BASELINE.some((base) => row.startsWith(base))),
      `这些声明只是「恰好写在后面」才生效，任何一次顺序调整都会静默改渲染：\n${OFFENDERS.join("\n")}`
    ).toEqual([]);
  });

  it("响应式覆盖不许输给基础规则", () => {
    expect(DEAD_MEDIA, `这些 @media 里的声明从写下来就没生效过，窄屏看到的是基础规则的样子：\n${DEAD_MEDIA.join("\n")}`).toEqual([]);
  });

  it("基线只减不增：已经不存在的机会要一起删掉", () => {
    const alive = new Set(OFFENDERS);
    expect(
      BASELINE.filter((base) => !alive.has(base)),
      "这些冲突其实已经没了，请把基线条目删掉"
    ).toEqual([]);
  });

  it("自检：把复合选择器退回裸类名必须判红", () => {
    const weakened = orderDecidedConflicts(CSS.replace(".btn.btn-sm {", ".btn-sm {"));
    expect(weakened.length, "探测器失去牙齿（改解析口径或改 CSS 结构时要一起看这里）").toBeGreaterThan(0);
    expect(
      weakened.some((row) => row.startsWith(".btn { padding-")),
      `复合选择器退回裸类名后，.btn/.btn-sm 的 padding 必须回到竞争名单里：\n${weakened.join("\n")}`
    ).toBe(true);
  });

  it("自检：新冒出的同特异度竞争者，写在前面和后面都必须判红", () => {
    // .badge 和 .badge-success 同时命中 About.tsx 里的 <span className="badge badge-success">。
    // 往 .badge 规则前/后各插一条同特异度的 font-size 竞争者：无论插哪儿，两条里总有一条只是
    // 「恰好写在后面」才生效，必须判红，而且输家会跟着插入位置换人——探测器不能只盯某一边。
    const anchor = "\n.badge {\n";
    expect(CSS.split(anchor).length - 1, "探测器锚点：.badge 规则必须唯一").toBe(1);
    const start = CSS.indexOf(anchor) + 1;
    const end = CSS.indexOf("\n}\n", start) + 3;
    const rival = ".badge-success { font-size: 14px; }\n";
    const insertedBefore = orderDecidedConflicts(CSS.slice(0, start) + rival + CSS.slice(start));
    const insertedAfter = orderDecidedConflicts(CSS.slice(0, end) + rival + CSS.slice(end));

    expect(insertedBefore.length, "竞争者写在前面时必须判红").toBeGreaterThan(0);
    expect(
      insertedBefore.some((row) => row.startsWith(".badge-success { font-size: 14px }")),
      `写在前面时输家应该是新来的竞争者：\n${insertedBefore.join("\n")}`
    ).toBe(true);

    expect(insertedAfter.length, "竞争者写在后面时同样必须判红").toBeGreaterThan(0);
    expect(
      insertedAfter.some((row) => row.startsWith(".badge { font-size: 12px }")),
      `写在后面时输家应该是原来的 .badge：\n${insertedAfter.join("\n")}`
    ).toBe(true);
  });

  it("自检：简写与长写算同一样东西，退回去必须判红", () => {
    // .about-section 写了 padding / border 简写，.about-links 只撤上边。把复合形式退回裸类名，
    // 按旧口径（border-top-color 与 border 是两个属性）会一条都不报；摊成长写后必须看见 4 个边。
    const weakened = orderDecidedConflicts(CSS.replace(".about-section.about-links {", ".about-links {"));
    expect(
      weakened.filter((row) => row.startsWith(".about-section { border-top-")),
      `简写没摊成长写就等于探测器瞎了一块：\n${weakened.join("\n")}`
    ).toEqual(expect.arrayContaining([expect.stringMatching(/border-top-color/)]));
    expect(
      weakened.some((row) => row.startsWith(".about-section { padding-top:")),
      "padding 简写没摊成长写，.about-section 的上边距竞争就看不见"
    ).toBe(true);
  });

  it("自检：基础规则写在媒体块之后要把覆盖吃掉，必须判红", () => {
    // 轮25 的真 bug 就是这个形状：980px 里 .diff-sources 要单列，基础规则在后面又写了三列。
    const dead = mediaOverridesNeverTakingEffect(`${CSS}\n\n.diff-sources { grid-template-columns: repeat(3, 1fr); }\n`);
    expect(
      dead.filter((row) => row.includes(".diff-sources { grid-template-columns: repeat(3, 1fr) } 吃掉")),
      `基础规则后置就该判红：\n${dead.join("\n")}`
    ).toHaveLength(1);
    // 换成「基础规则特异度更高」这个形状，同样得判红。
    const higher = mediaOverridesNeverTakingEffect(`${CSS}\n\n.diff-sources.diff-sources { grid-template-columns: 1fr 2fr; }\n`);
    expect(
      higher.some((row) => row.includes("基础规则特异度更高")),
      `基础规则更具体时同样必须判红：\n${higher.join("\n")}`
    ).toBe(true);
    // 反向自检：把媒体块挪到基础规则之后（就是本轮落地的写法）必须不报这一条。
    expect(
      mediaOverridesNeverTakingEffect(CSS).filter((row) => row.includes("diff-sources")),
      "本轮修完之后不该再有 diff-sources 的失效覆盖"
    ).toEqual([]);
  });

  it("轮24/轮25 提特异度的那批成对写法必须两边都在", () => {
    // 任何一处被改回裸类名，上面的用例会红；这里再钉住「并列写法不许只留一条」，
    // 否则 .check-field 的裸用法会被打死。
    // 轮74 A1：`.btn-danger,` 这条并列没了——danger 拆成描边档（只以 .btn-ghost.btn-danger 出现）
    // 和实心档 .btn-danger-fill 两个类名，裸 btn-danger 在全站 0 处用法，
    // 「静止态必须有底色」由 hoverToneRulesResolveBySpecificity 的 danger-fill 用例钉。
    // 轮102 R102-D5：`.check-field` 这条成对写法拆成了两条不同内容的规则
    // （裸类名管一行里的复选框，复合管表单列里的复选框），并列反而会把行内复选框钉回竖排。
    // 它由下面那条按 sel 精确指认的用例接管，不是把守卫删了。
    const PAIRS = [
      [".data-split,", ".data-split.backup-content,"],
      [".data-split,", ".data-split.history-content,"],
      [".data-split,", ".data-split.task-center-content"],
    ];
    const blanked = blankComments(CSS);
    PAIRS.forEach(([first, second]) => {
      expect(blanked.includes(first) && blanked.includes(second), `${first} 与 ${second} 必须成对出现`).toBe(true);
    });

    // R83 落地的复合形式：少一条就退回「同特异度赌顺序」，上面的主用例会跟着红，这里只负责指认是哪一处。
    const COMPOUNDS = [
      ".env-badge.env-dev {",
      ".env-badge.env-test {",
      ".env-badge.env-staging {",
      ".env-badge.env-prod {",
      ".env-badge.env-canary {",
      ".env-badge.env-local {",
      ".env-badge.env-other {",
      ".about-section.about-links {",
      ".data-list.backup-list,",
      ".data-list.task-list {",
    ];
    COMPOUNDS.forEach((sel) => {
      expect(blanked.includes(sel), `styles.css 里找不到 ${sel}，退回裸类名要连这条守卫一起改`).toBe(true);
    });

    // 窄屏堆叠必须排在被覆盖的基础规则之后——轮25 就是被这个形状坑了一整个多月。
    const baseSources = blanked.indexOf("\n.diff-sources {\n");
    const stackMedia = blanked.indexOf(".diff-sources {\n    grid-template-columns: 1fr;");
    expect(baseSources, "找不到 .diff-sources 基础规则").toBeGreaterThan(-1);
    expect(stackMedia, "找不到窄屏堆叠那个 @media 里的 .diff-sources").toBeGreaterThan(baseSources);
  });

  it("轮102 R102-D5：复选框两种用法各自一条规则，不许合并回同特异度赌顺序", () => {
    // ConnectionManager.tsx:1375 是 `field check-field`（表单列里的复选框），:1717 是裸 `check-field`
    // （同一行里的复选框）。轮102 把复选框从 .field 的竖排里拆出来：竖排会把方框顶到标签下一行还左对齐，
    // 而这两种用法的宽度意图本来就不同（列内贴右缘 / 行内占 120px），所以两条规则声明的内容不再相同。
    const decls = collectDecls(CSS);
    const bare = decls.filter((d) => d.sel === ".check-field");
    const compound = decls.filter((d) => d.sel === ".field.check-field");
    expect(bare.length > 0, "找不到裸 .check-field 规则：:1717 那处复选框会失去宽度").toBe(true);
    expect(compound.length > 0, "找不到 .field.check-field 规则：:1375 那处会退回 .field 的竖排").toBe(true);
    const declOf = (list: Decl[], prop: string) => list.find((d) => d.prop === prop)?.value;
    expect(declOf(compound, "flex-direction"), "复选框必须行内排布，写回 column 就是把方框顶到下一行").toBe("row");

    // 防假绿：整条复合规则被摘掉时，主守卫必须当场指出「同特异度赌顺序」回来了。
    const stripped = CSS.replace(/\.field\.check-field \{[^}]*\}/, "");
    expect(stripped, "变异对照没命中复合规则，这条自检本身失效了").not.toContain(".field.check-field {");
    const hits = orderDecidedConflicts(stripped).filter((row) => row.includes("check-field"));
    expect(hits.length > 0, "摘掉复合规则却没人报警，上面的指认等于没写").toBe(true);
  });

  it("R83：.btn 不许再声明 border-color，否则 tone 的长写又跟它赌顺序", () => {
    const btn = collectDecls(CSS).filter((decl) => decl.sel === ".btn" && decl.layer === null);
    expect(btn.length > 0, "找不到 .btn 规则").toBe(true);
    const offending = btn.filter(
      (decl) => decl.prop === "border-color" || (decl.prop.startsWith("border-") && decl.prop.endsWith("-color"))
    );
    expect(
      offending.map((decl) => `${decl.prop}: ${decl.value}`),
      "border-color 归 tone 所有；.btn 里写回来就等于把 transparent 和 var(--border) 摆成同特异度竞争"
    ).toEqual([]);
    // 兜底必须在 :where(.btn) 里（特异度 0），它压不过任何带 class 的规则。
    expect(CSS, "无 tone 按钮的 border-color 兜底得还在").toMatch(/:where\(\.btn\)\s*\{\s*border-color:\s*transparent/);
  });
});
