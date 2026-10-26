/**
 * 死 CSS 守卫（轮9 H 段收尾 + 轮89）。
 *
 * 为什么要静态守：styles.css 里留着一条没人用的类，改它的人以为在改界面，实际什么都没发生；
 * 更糟的是它会误导下一次的搜索——`diff-source-toolbar` 就是这么活到轮89 的：类名听起来像
 * 对比页源区的工具条，新人照着它加样式，加完不生效，回头再去改那条死的。轮9 的复核结论是
 * 「54 条候选九成假阳性，真死类只有 .muted / .planned-page」，那次靠人工逐条判读；
 * 本轮把判读规则写成代码，清完 9 条之后把「不许再长回来」钉死。
 *
 * 假阳性从哪来（三条都必须一次都不复现）：
 * 1. **运行时注入的类名**——hljs-* 由 highlight.js 在浏览器里生成，源码里搜不到字面量。
 * 2. **模板串拼名**——op-${...}、message-${...}、merge-${...}、block-${...}、env-${...}、
 *    toast-${...}、apply-action-${...}、task-status-${...}、is-${...}。字面量搜不到，类却真在用。
 * 3. **注释里的类名**——CSS 注释允许出现在选择器与 `{` 之间，「…两条 is-xxx…」这种说明
 *    会被当选择器读进来。解析前必须先把注释换成等长空白（保留换行，行号才对得上原文件）。
 *
 * 动态族不许口头豁免：每条豁免都要给一个「源码里必须还在的字面量」（proof），拼名写法一旦
 * 被改掉或删掉，豁免当场失效；同时每条豁免必须真的救回 ≥2 条类——proof 还在却一条都没救回
 * 的空转豁免也算红。两条合起来才堵得住「基线只许减」被绕开的两种写法。
 *
 * 测试文件里的引用不算活着：`.batch-diff-toolbar` 在轮89 之前只出现在 DiffView.test.tsx 的注释说明和
 * 一条 not.toBeInTheDocument 断言里，组件从不渲染它——那正是本守卫要抓的东西，所以语料只取 src/ 下
 * 非 *.test.* 的文件。反过来，守卫删掉死类后，注释里那句「只剩死样式」也会变成假话，
 * 所以本轮一并更正了那两处注释；引用同类名时只说「真实组件从未渲染」，别再依赖样式表的当前状态。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CSS_PATH = join(PROJECT_ROOT, "src/styles.css");
const SRC_ROOT = join(PROJECT_ROOT, "src");

/** 一条动态拼名族的豁免：prefix 是被拼出来的类名前缀，proof 是源码里必须还在的字面量。 */
export interface DynamicFamily {
  prefix: string;
  /** src/ 语料里必须包含这段字面量，否则豁免失效（拼名点没了 = 类真的死了）。 */
  proof: string;
  /** 为什么豁免，写清拼名点在哪，免得下一个人当成噪音删掉。 */
  why: string;
}

export const DYNAMIC_FAMILIES: DynamicFamily[] = [
  {
    prefix: "hljs-",
    proof: "highlight.js/lib/core",
    why: "highlight.js 运行时给 token 打标，源码里没有类名字面量",
  },
  { prefix: "op-", proof: "op-${", why: "HistoryView.tsx 的 op op-${h.opType}" },
  { prefix: "message-", proof: "message-${", why: "MessageCenter.tsx 的 message-${item.level}" },
  { prefix: "merge-", proof: "merge-${", why: "DiffPanel.tsx 的 merge-${mergeState.direction}" },
  { prefix: "block-", proof: "block-${", why: "DiffPanel.tsx 的 block-${blockPosition}" },
  { prefix: "env-", proof: "env-${", why: "环境徽章 tone 由 environmentTone() 算出后拼接" },
  { prefix: "toast-", proof: "toast-${", why: "Toaster.tsx 的 toast-${item.type}" },
  { prefix: "apply-action-", proof: "apply-action-${", why: "ApplyPlanView.tsx 的动作胶囊" },
  { prefix: "task-status-", proof: "task-status-${", why: "ApplyPlanView.tsx 的任务状态徽章" },
  { prefix: "is-", proof: "is-${", why: "HistoryChangeDetailPanel.tsx 的动作与结论三态" },
];

export interface CssRule {
  /** 选择器原文（可含逗号、属性选择器、伪类）。 */
  selector: string;
  /** 1 起算的行号，指向注释被抹平后的文本——与原文件行号一致。 */
  line: number;
  /** 是否来自 @media / @supports 里嵌的一层。 */
  nested: boolean;
}

/** 注释换成等长空白（换行保留）：不把注释里的类名读进来，也不让行号漂移。 */
export function blankComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

/**
 * 解析规则：顶层 selector { ... } 一层，@media/@supports 里再嵌一层。
 * 选择器 = 上一段结束位置到下一个 `{` 之间的文本。@keyframes 的 from / 50% 这类帧选择器
 * 提不出类名，不会污染判定，所以整块跳过嵌套。
 */
export function parseRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  const scan = (text: string, lineOffset: number, nested: boolean) => {
    let pos = 0;
    for (;;) {
      const open = text.indexOf("{", pos);
      if (open === -1) break;
      const selector = text.slice(pos, open).trim();
      let depth = 1;
      let close = open + 1;
      while (close < text.length && depth > 0) {
        if (text[close] === "{") depth++;
        else if (text[close] === "}") depth--;
        close++;
      }
      const body = text.slice(open + 1, close - 1);
      const line = text.slice(0, open).split("\n").length + lineOffset;
      if (selector.startsWith("@")) {
        if (!nested && /@media|@supports/.test(selector)) {
          const innerOffset = lineOffset + text.slice(0, open).split("\n").length - 1;
          scan(body, innerOffset, true);
        }
      } else if (selector) {
        rules.push({ selector, line, nested });
      }
      pos = close;
    }
  };
  scan(css, 0, false);
  return rules;
}

/** 选择器里的类名 token。属性选择器里的点不是类名，先剥掉属性选择器再提。 */
export function classTokens(selector: string): string[] {
  const stripped = selector.replace(/\[[^\]]*\]/g, "");
  return [...stripped.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((match) => match[1]);
}

/** src/ 下非测试文件 = 应用真正会渲染出来的字面量语料。 */
export function readAppCorpus(): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) files.push(full);
    }
  };
  walk(SRC_ROOT);
  return files.map((file) => readFileSync(file, "utf8")).join("\n");
}

export interface AnalysisInput {
  css: string;
  corpus: string;
  families: DynamicFamily[];
}

export interface AnalysisResult {
  rules: CssRule[];
  /** 死类 -> 出现在哪几条规则的行号。 */
  dead: Map<string, number[]>;
  /** 族前缀 -> 被它豁免的类名。 */
  rescued: Map<string, string[]>;
  /** proof 在源码里已经找不到的族（豁免失效）。 */
  staleFamilies: DynamicFamily[];
  /** proof 还在、却一条类都没救回的族（豁免空转）。 */
  idleFamilies: DynamicFamily[];
  allClasses: string[];
}

/** 核心判定：字面量命中 = 活着；动态族豁免；其余全是死的。 */
export function analyze(input: AnalysisInput): AnalysisResult {
  const rules = parseRules(blankComments(input.css));
  const occurrences = new Map<string, number[]>();
  for (const rule of rules) {
    for (const cls of classTokens(rule.selector)) {
      const seen = occurrences.get(cls) ?? [];
      seen.push(rule.line);
      occurrences.set(cls, seen);
    }
  }
  const rescued = new Map<string, string[]>();
  const dead = new Map<string, number[]>();
  for (const [cls, lines] of occurrences) {
    const family = input.families.find((f) => cls.startsWith(f.prefix));
    if (family) {
      if (!input.corpus.includes(family.proof)) continue; // 交给 staleFamilies 报
      const bucket = rescued.get(family.prefix) ?? [];
      bucket.push(cls);
      rescued.set(family.prefix, bucket);
      continue;
    }
    if (!input.corpus.includes(cls)) dead.set(cls, lines);
  }
  const staleFamilies = input.families.filter((f) => !input.corpus.includes(f.proof));
  const idleFamilies = input.families.filter((f) => !staleFamilies.includes(f) && !(rescued.get(f.prefix)?.length ?? 0));
  return { rules, dead, rescued, staleFamilies, idleFamilies, allClasses: [...occurrences.keys()] };
}

const DYN_PREFIX = "dyn-" + "${";

describe("守卫自身的判据（内联 fixture，不碰真文件）", () => {
  const corpus = ['<div className="live-card" />', "className={`" + DYN_PREFIX + "kind}`"].join("\n");

  it("注释里的类名不算类", () => {
    const css = "/* 说明里提到 .ghost-only 这条已经没了 */\n.live-card { color: red; }";
    const result = analyze({ css, corpus, families: [] });
    expect([...result.dead.keys()]).toEqual([]);
    expect(result.allClasses).not.toContain("ghost-only");
  });

  it("字面量没命中的判死，命中的判活", () => {
    const css = ".live-card { color: red; }\n.never-used { color: blue; }";
    const result = analyze({ css, corpus, families: [] });
    expect([...result.dead.keys()]).toEqual(["never-used"]);
  });

  it("动态族只在 proof 还在时豁免", () => {
    const css = ".dyn-a { color: red; }\n.dyn-b { color: blue; }";
    const family = { prefix: "dyn-", proof: DYN_PREFIX, why: "拼名" };
    expect([...analyze({ css, corpus, families: [family] }).dead.keys()]).toEqual([]);
    const noProof = analyze({
      css,
      corpus: corpus.replace(DYN_PREFIX, "dyn-nope"),
      families: [family],
    });
    expect(noProof.staleFamilies.map((f) => f.prefix)).toEqual(["dyn-"]);
    expect(noProof.rescued.get("dyn-")).toBeUndefined();
  });

  it("豁免空转也算红：proof 还在却一条类都没救回", () => {
    const family = { prefix: "gone-", proof: DYN_PREFIX, why: "已经没有这种类了" };
    const result = analyze({ css: ".live-card { color: red; }", corpus, families: [family] });
    expect(result.idleFamilies.map((f) => f.prefix)).toEqual(["gone-"]);
  });

  it("逗号分组里的死类照样报，行号指向原文件位置", () => {
    const css = ".live-card {\n  color: red;\n}\n.alive-a,\n.dead-b {\n  margin: 0;\n}";
    const result = analyze({ css, corpus: corpus + "alive-a", families: [] });
    expect([...result.dead.keys()]).toEqual(["dead-b"]);
    expect(result.dead.get("dead-b")).toEqual([5]);
  });

  it("@media 里嵌的一起扫，帧选择器不产类名", () => {
    const css =
      "@media (max-width: 900px) {\n  .media-dead { display: none; }\n}\n@keyframes slide { from { opacity: 0 } to { opacity: 1 } }";
    const result = analyze({ css, corpus, families: [] });
    expect([...result.dead.keys()]).toEqual(["media-dead"]);
  });

  it("属性选择器里的点不是类名", () => {
    expect(classTokens('.live-card[title="a.b"]')).toEqual(["live-card"]);
    const result = analyze({ css: '.live-card[title="a.b"] { color: red; }', corpus, families: [] });
    expect([...result.dead.keys()]).toEqual([]);
  });
});

describe("src/styles.css 现状", () => {
  const css = readFileSync(CSS_PATH, "utf8");
  const corpus = readAppCorpus();
  const result = analyze({ css, corpus, families: DYNAMIC_FAMILIES });

  it("解析器不是空转：规则数与类名数都要过下限", () => {
    // 读法出问题时最常见的表现是「什么都没解析出来」，守卫于是永远绿。
    expect(result.rules.length).toBeGreaterThan(1000);
    expect(result.allClasses.length).toBeGreaterThan(600);
  });

  it("死类清零", () => {
    const report = [...result.dead.entries()].map(([cls, lines]) => `.${cls} @ styles.css:${lines.join(",")}`);
    expect(report).toEqual([]);
  });

  it("动态族豁免没有失效的、也没有空转的", () => {
    expect(result.staleFamilies.map((f) => f.prefix)).toEqual([]);
    expect(result.idleFamilies.map((f) => f.prefix)).toEqual([]);
    for (const family of DYNAMIC_FAMILIES) {
      expect(result.rescued.get(family.prefix)?.length ?? 0, family.why).toBeGreaterThanOrEqual(2);
    }
  });
});
