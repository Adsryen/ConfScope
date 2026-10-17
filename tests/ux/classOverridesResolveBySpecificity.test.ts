/**
 * 跨类覆盖必须由特异度决胜，不许再赌文档顺序（轮23 R79 / 轮24 R80）。
 *
 * 为什么值得静态守：`styles.css` 里 `.btn{padding:6px 14px}` 和 `.btn-sm{padding:4px 8px}` 特异度相同，
 * 谁写在后面谁赢。今天 .btn-sm 在后面所以看起来是对的，但任何人（包括 IDE 的格式化、一次「整理样式顺序」
 * 的顺手挪动）把这两条换个位置，全站 93 颗小按钮的内边距就静默变回去——没有报错、没有差异截图。
 * 轮23 的 .modal-md 已经真炸过一次（弹层宽度一直是 720px 而不是设计值 640px）。
 *
 * 口径（与 research/r23_conflict.py 一致，宁可漏报不误报）：
 * - 只扫顶层规则，`@media` 整块跳过（响应式覆盖本来就该晚于基础规则）。
 * - 只看「纯 class 复合选择器」：带组合器/类型选择器/属性选择器/伪类伪元素的规则证不了「两族永远共存」。
 * - 元素类集合只取 JSX 里 `className="..."` 的**纯静态字符串**；含插值/三元的一律跳过。
 * - 选择器的全部 class token 都出现在元素上 ⇒ 该规则确定作用于该元素。
 * - 同属性上按 (特异度, 文档顺序) 决胜；只报「特异度相同、写在赢家前面、值还不一样」的败者。
 *
 * 已知盲区（写在这儿，别当成已覆盖）：
 * - `@media` 里的覆盖不参与判定 ⇒ 提特异度时必须人工去段尾补复合形式（见 R80 那批注释）。
 * - 简写与长写不互通：`.badge{border:…}` 与 `.badge.badge-success{border-color:…}` 被视为两个属性。
 * - 动态 className 覆盖不到 ⇒ 「变体类是否总与基础类同时出现」要人工核 r24_cooccur.py 的输出。
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

interface Decl {
  /** 逗号拆开后的单个选择器 */
  sel: string;
  /** 选择器里的 class token */
  tokens: string[];
  prop: string;
  value: string;
  order: number;
  line: number;
}

/** 注释换成等长空白：属性值里可能正好写着类名，行号也必须对得上原文件。 */
function blankComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

/** 顶层规则 = 选择器不以 @ 开头且 `{}` 成对；`@media` 整块连同内部规则一起跳过。 */
function topLevelDecls(css: string): Decl[] {
  const text = blankComments(css);
  const decls: Decl[] = [];
  let order = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf("{", cursor);
    if (open === -1) break;
    const head = text.slice(cursor, open);
    const selector = head.replace(/\s+/g, " ").trim();
    let depth = 1;
    let end = open + 1;
    while (end < text.length && depth > 0) {
      if (text[end] === "{") depth += 1;
      else if (text[end] === "}") depth -= 1;
      end += 1;
    }
    if (selector && !selector.startsWith("@") && !selector.includes("{")) {
      const thisOrder = order;
      order += 1;
      const line = text.slice(0, cursor + (head.length - head.replace(/^\s+/, "").length)).split("\n").length;
      selector
        .split(",")
        .map((part) => part.trim())
        .filter((part) => PURE_CLASS.test(part))
        .forEach((sel) => {
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
                .replace(/\s+/g, " ")
                .toLowerCase();
              if (!/^[-a-z]+$/i.test(prop) || !value) return;
              decls.push({ sel, tokens: sel.match(/\.([\w-]+)/g)!.map((t) => t.slice(1)), prop, value, order: thisOrder, line });
            });
        });
    }
    cursor = end;
  }
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

function orderDecidedConflicts(css: string): string[] {
  const decls = topLevelDecls(css);
  const elements = staticElements(walk(join(PROJECT_ROOT, "src")));
  const bySelector = new Map<string, Decl[]>();
  decls.forEach((decl) => {
    const bucket = bySelector.get(decl.sel);
    if (bucket) bucket.push(decl);
    else bySelector.set(decl.sel, [decl]);
  });
  const selectors = [...bySelector.keys()];
  const hits: string[] = [];
  const seen = new Set<string>();
  elements.forEach(({ where, classes }) => {
    const applicable = selectors.filter((sel) => bySelector.get(sel)!.every((decl) => decl.tokens.every((t) => classes.has(t))));
    const byProp = new Map<string, Decl[]>();
    applicable.forEach((sel) =>
      bySelector.get(sel)!.forEach((decl) => {
        const bucket = byProp.get(decl.prop);
        if (bucket) bucket.push(decl);
        else byProp.set(decl.prop, [decl]);
      })
    );
    byProp.forEach((candidates, prop) => {
      const winner = candidates.reduce((best, cur) =>
        cur.tokens.length > best.tokens.length || (cur.tokens.length === best.tokens.length && cur.order > best.order) ? cur : best
      );
      candidates.forEach((cand) => {
        if (cand === winner || cand.tokens.length !== winner.tokens.length) return;
        if (cand.order >= winner.order || cand.value === winner.value) return;
        const key = `${[...classes].sort().join(" ")}|${prop}`;
        if (seen.has(key)) return;
        seen.add(key);
        hits.push(
          `${cand.sel} { ${prop}: ${cand.value} } 被同特异度的 ${winner.sel} { ${prop}: ${winner.value} } ` +
            `按文档顺序盖掉（元素 ${where}）`
        );
      });
    });
  });
  return hits.sort();
}

describe("跨类覆盖由特异度决胜，不赌文档顺序（R80）", () => {
  const OFFENDERS = orderDecidedConflicts(CSS);

  it("同特异度靠顺序决胜的跨类覆盖一个都不许有", () => {
    expect(
      OFFENDERS.filter((row) => !BASELINE.some((base) => row.startsWith(base))),
      `这些声明只是「恰好写在后面」才生效，任何一次顺序调整都会静默改渲染：\n${OFFENDERS.join("\n")}`
    ).toEqual([]);
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
      weakened.some((row) => row.startsWith(".btn-sm { padding:")),
      true
    );
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

  it("轮24 提特异度的那批成对写法必须两边都在", () => {
    // R80 落地的复合/并列形式：任何一处被改回裸类名，上面两条用例就会红；
    // 这里再钉住「并列写法不许只留一条」，否则 .btn-danger / .check-field 的裸用法会被打死。
    const PAIRS = [
      [".btn-danger,", ".btn-ghost.btn-danger {"],
      [".check-field,", ".field.check-field {"],
      [".data-split,", ".data-split.backup-content,"],
      [".data-split,", ".data-split.history-content,"],
      [".data-split,", ".data-split.task-center-content"],
    ];
    const blanked = blankComments(CSS);
    PAIRS.forEach(([first, second]) => {
      expect(blanked.includes(first) && blanked.includes(second), `${first} 与 ${second} 必须成对出现`).toBe(true);
    });
  });
});
