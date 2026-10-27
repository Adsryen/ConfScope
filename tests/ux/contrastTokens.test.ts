/**
 * 次要文本的对比度守卫（R15）。
 *
 * 为什么要静态算：对比度是两个颜色的比值，抬亮一处令牌会同时改变全站 150+ 处的结果；
 * jsdom 不做颜色计算，桌面端 Playwright 又拿不到数据，「看着还行」不等于达 AA。
 * 这里直接读 styles.css 的 :root 令牌算 WCAG 相对亮度，把最低 4.5:1 写死成断言，
 * 顺带守最容易漏的一类：列表行选中后底色换成 --bg-active，副标题却还沿用同一个 --text-dim。
 * 与 tests/ux/toasterStacking.test.ts 同一口径：跨文件的数值约束只守一次。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** 注释里也写着颜色值，算之前一律剥掉，免得正则误命中。 */
const CSS = readFileSync(join(PROJECT_ROOT, "src/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/** AA 对正文（<18.66px）的要求；站上的次要文本都是 11–12.5px。 */
const AA = 4.5;

function token(name: string): string {
  const found = new RegExp(`--${name}: ([^;]+);`).exec(CSS);
  expect(found, `styles.css 的 :root 里缺少 --${name}`).not.toBeNull();
  return found![1].trim();
}

/** 支持 `#rgb` / `#rrggbb` / `#rrggbbaa` 与 `rgba(r, g, b, a)` / `rgb(r, g, b)`，返回 0–255 三分量与 alpha。 */
function parseColor(value: string): { r: number; g: number; b: number; a: number } {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (hex) {
    let n = hex[1];
    if (n.length === 3) n = n.split("").map((c) => c + c).join("");
    return {
      r: Number.parseInt(n.slice(0, 2), 16),
      g: Number.parseInt(n.slice(2, 4), 16),
      b: Number.parseInt(n.slice(4, 6), 16),
      a: n.length === 8 ? Number.parseInt(n.slice(6, 8), 16) / 255 : 1,
    };
  }
  const nums = Array.from(value.matchAll(/(\d+(?:\.\d+)?)/g), (m) => Number.parseFloat(m[1]));
  expect(nums.length >= 3, `解析不出颜色：${value}`).toBe(true);
  return { r: nums[0], g: nums[1], b: nums[2], a: nums.length >= 4 ? nums[3] : 1 };
}

function channel(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance(color: string): number {
  const { r, g, b } = parseColor(color);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** alpha 着色叠在不透明底色之后的实际颜色（diff 底色都是 rgba，直接拿它算比值会偏乐观）。 */
function composite(tint: string, base: string): string {
  const top = parseColor(tint);
  const bottom = parseColor(base);
  const mix = (t: number, b: number) => Math.round(t * top.a + b * (1 - top.a));
  return `#${[mix(top.r, bottom.r), mix(top.g, bottom.g), mix(top.b, bottom.b)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * 规则块解析（轮38 R94）。@media 里的规则会被当成独立块匹配，因为 `[^{}]*` 跨不过嵌套花括号。
 * 多行选择器压成一行，方便按逗号拆分后逐条比对。
 */
interface Rule {
  sel: string;
  decls: Record<string, string>;
}

function rules(): Rule[] {
  return Array.from(CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map((match) => {
    const decls: Record<string, string> = {};
    match[2]
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .forEach((d) => {
        const i = d.indexOf(":");
        if (i < 0) return;
        decls[d.slice(0, i).trim()] = d.slice(i + 1).trim();
      });
    return { sel: match[1].replace(/\s+/g, " ").trim(), decls };
  });
}

/** 把 `var(--x)` 还原成 :root 的字面值；已是字面量则原样返回；解析不出（gradient/inherit 等）返回 null。 */
function resolveColor(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  const varRef = /^var\((--[a-z0-9-]+)(?:\s*,[^)]*)?\)$/i.exec(v);
  if (varRef) {
    const found = new RegExp(`${varRef[1]}: ([^;]+);`).exec(CSS);
    return found ? found[1].trim() : null;
  }
  if (/^#[0-9a-f]{3,8}$/i.test(v) || /^rgba?\(/i.test(v)) return v;
  return null;
}

/** 不透明底才能直接算配对；rgba 的 alpha<1 交给「tint ∘ 底色」那条用例处理。 */
function isOpaque(value: string | null): boolean {
  if (!value) return false;
  const { a } = parseColor(value);
  return a >= 1;
}

/** 去掉只表达交互态的部分，让 `.x:hover` 能找回基块 `.x` 的文字色。 */
function normalizeSelector(sel: string): string {
  return sel.replace(/:hover/g, "").replace(/:not\(:disabled\)/g, "").replace(/\s+/g, " ").trim();
}

/** 所有声明了 `color: var(--text-dim-raised)` 的规则块的选择器（轮38 起这类块不止一个，取并集）。 */
function raisedSelectors(): string[] {
  const found = Array.from(CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g))
    .filter((match) => /color:\s*var\(--text-dim-raised\)/.test(match[2]))
    .flatMap((match) => match[1].split(",").map((x) => x.trim()).filter(Boolean));
  expect(found.length, "找不到把次要文本换成 raised 的规则块").toBeGreaterThan(0);
  return found;
}

const BG = token("bg");
const BG2 = token("bg2");
const BG3 = token("bg3");
const BG_HOVER = token("bg-hover");
const BG_ACTIVE = token("bg-active");
const DIM = token("text-dim");
const DIM_RAISED = token("text-dim-raised");

describe("次要文本令牌达 WCAG AA", () => {
  it("--text-dim 在四个基础底色上都 >= 4.5:1", () => {
    [
      ["--bg", BG],
      ["--bg2", BG2],
      ["--bg3", BG3],
      ["--bg-hover", BG_HOVER],
    ].forEach(([name, base]) => {
      expect(contrast(DIM, base), `${DIM} 叠在 ${name}(${base}) 上只有 ${contrast(DIM, base).toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
    });
  });

  it("--text-dim-raised 在选中行底色与三种 diff 着色上都 >= 4.5:1", () => {
    const bases: Array<[string, string]> = [
      ["--bg-active", BG_ACTIVE],
      ["--bg", BG],
      ["--bg2", BG2],
      ["diff-add 叠加", composite(token("diff-add-bg"), BG)],
      ["diff-del 叠加", composite(token("diff-del-bg"), BG)],
      ["diff-mod 叠加", composite(token("diff-mod-bg"), BG)],
    ];
    bases.forEach(([name, base]) => {
      expect(
        contrast(DIM_RAISED, base),
        `${DIM_RAISED} 叠在 ${name}(${base}) 上只有 ${contrast(DIM_RAISED, base).toFixed(2)}:1`
      ).toBeGreaterThanOrEqual(AA);
    });
  });

  it("raised 比 dim 更亮，且真在被使用（不是个装饰令牌）", () => {
    expect(luminance(DIM_RAISED)).toBeGreaterThan(luminance(DIM));
    expect(raisedSelectors().length).toBeGreaterThan(0);
  });

  it("选中行（--bg-active）里的副标题一律换成 raised，漏一处就红", () => {
    const selectors = raisedSelectors();
    [
      ".browser-item.active .browser-item-group",
      ".browser-item.active .browser-item-summary",
      ".history-item.active .history-item-meta",
      ".backup-item.active .backup-item-source",
      ".task-item.active .task-item-meta",
      ".conn-env-title.active",
    ].forEach((selector) => {
      expect(selectors, `规则块里没有 ${selector}`).toContain(selector);
    });
  });

  it("没有规则块把次要文本压在深底（选中行 / 三种 diff 着色）上仍用 --text-dim", () => {
    const offenders: string[] = [];
    // 上一条用例只算「令牌本身够不够亮」，这条才守住用法：diff 着色底上的小字是 #a0a0a0 唯一的失守点（4.45:1）。
    const DEEP_BG = /background:\s*var\(--(bg-active|diff-add-bg|diff-del-bg|diff-mod-bg)\)/;
    Array.from(CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)).forEach((match) => {
      if (DEEP_BG.test(match[2]) && /color:\s*var\(--text-dim\)/.test(match[2])) {
        match[1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .forEach((s) => offenders.push(s));
      }
    });
    expect(offenders, "这些规则在深底上仍用 --text-dim，应当改用 --text-dim-raised").toEqual([]);
  });
});

/**
 * 轮38 R94：把「按用途分层」写死成静态守卫。
 *
 * R15 那组用例只算令牌本身够不够亮，够不上解释为什么 `--text-dim` 在 `.env-badge.env-other`
 * 上仍然只有 4.08:1 —— 半透明着色底会把底色抬亮。所以这四条分工：
 *   G1 令牌用途：--accent 系只做填充，文字一律 --accent-text。
 *   G2 同块配对：块里同时写了不透明 background 和 color 的，必须成对达标（含 hover 只改底的情况）。
 *   G3 tint 配对：块里写半透明 background 的，先与 --bg3 合成再算。
 *   G4 字面地板：自带底色的交给 G2，其余文字色一律与 --bg 比，取最宽松的一档当全局地板。
 * 真机渲染（多层底叠加、祖先降透明）由 tests/retest/specs/99-s-contrast.spec.ts 兜底。
 */
const ACCENT = token("accent");
const ACCENT_TEXT = token("accent-text");
const ON_ACCENT = token("on-accent");
const RED_FILL = token("red-fill");
const RED_TEXT = token("red-text");
const PURPLE_TEXT = token("purple-text");

describe("G1 颜色令牌按用途分层", () => {
  it("--accent-text 在四个基础底色上都 >= 4.5:1", () => {
    [
      ["--bg", BG],
      ["--bg2", BG2],
      ["--bg3", BG3],
      ["--bg-hover", BG_HOVER],
    ].forEach(([name, base]) => {
      expect(
        contrast(ACCENT_TEXT, base),
        `${ACCENT_TEXT} 叠在 ${name}(${base}) 上只有 ${contrast(ACCENT_TEXT, base).toFixed(2)}:1`
      ).toBeGreaterThanOrEqual(AA);
    });
  });

  it("--accent-text 在 accent tint chip（着色底 ∘ bg2/bg3）上也达标", () => {
    expect(contrast(ACCENT_TEXT, composite("rgba(0, 122, 204, 0.12)", BG2))).toBeGreaterThanOrEqual(AA);
    expect(contrast(ACCENT_TEXT, composite("rgba(0, 122, 204, 0.15)", BG3))).toBeGreaterThanOrEqual(AA);
  });

  it("全站禁止把 --accent / --accent-h 用作文字色", () => {
    const offenders = rules()
      .filter((rule) => /^var\(--accent(-h)?\)$/.test(rule.decls.color ?? ""))
      .map((rule) => rule.sel);
    expect(offenders, "这些规则把品牌填充色当文字色用，应改用 var(--accent-text)").toEqual([]);
  });

  it("--on-accent 在 --accent 与 --accent-h（btn-primary:hover 的底）上都达标，白字则在 hover 态必然失守", () => {
    expect(contrast(ON_ACCENT, ACCENT)).toBeGreaterThanOrEqual(AA);
    expect(contrast(ON_ACCENT, token("accent-h"))).toBeGreaterThanOrEqual(AA);
    // 这条是「为什么不留白字」的证据：白字在 hover 底上达不到 AA，且无法靠调 hover 底救回。
    expect(contrast("#ffffff", token("accent-h"))).toBeLessThan(AA);
  });

  it("--red-fill 承载白字、--red-text / --purple-text 承载 tint chip 上的文字", () => {
    expect(contrast("#ffffff", RED_FILL)).toBeGreaterThanOrEqual(AA);
    expect(contrast(RED_TEXT, composite(token("diff-del-bg"), BG3))).toBeGreaterThanOrEqual(AA);
    expect(contrast(RED_TEXT, composite("rgba(244, 67, 54, 0.15)", BG3))).toBeGreaterThanOrEqual(AA);
    expect(contrast(PURPLE_TEXT, composite("rgba(156, 39, 176, 0.15)", BG3))).toBeGreaterThanOrEqual(AA);
    expect(contrast(DIM_RAISED, composite("rgba(158, 158, 158, 0.15)", BG3))).toBeGreaterThanOrEqual(AA);
  });

  it("新令牌真在被使用，不是装饰", () => {
    const used = (name: string) => rules().some((rule) => Object.values(rule.decls).some((v) => v.includes(`var(--${name})`)));
    ["accent-text", "on-accent", "red-fill", "red-text", "red-text-raised", "purple-text"].forEach((name) => {
      expect(used(name), `--${name} 定义了却没有任何规则引用`).toBe(true);
    });
  });
});

describe("G2 同块不透明填充与文字必须成对达标", () => {
  it("块里自带不透明 background + color 的组合，全部 >= 4.5:1", () => {
    const baseByNorm = new Map<string, Record<string, string>>();
    rules().forEach((rule) => {
      if (normalizeSelector(rule.sel) === rule.sel && !baseByNorm.has(rule.sel)) baseByNorm.set(rule.sel, rule.decls);
    });
    const offenders: string[] = [];
    let pairs = 0;
    rules().forEach((rule) => {
      const bgRaw = rule.decls.background ?? rule.decls["background-color"];
      const bg = resolveColor(bgRaw);
      if (!isOpaque(bg)) return;
      // :hover 常常只换底色，文字色留在基块；此时以基块 color 为准。
      // 若 hover 块自己写了 color，则以它为准（否则 .conn-item-del 的基块 #a0a0a0 会算出 1.99 的假阳性）。
      const ownColor = resolveColor(rule.decls.color);
      const color = ownColor ?? resolveColor(baseByNorm.get(normalizeSelector(rule.sel))?.color);
      if (!color) return;
      pairs += 1;
      const ratio = contrast(color, bg!);
      if (ratio < AA) offenders.push(`${rule.sel}: ${rule.decls.color ?? "(继承)"} on ${bgRaw} = ${ratio.toFixed(2)}`);
    });
    expect(pairs, "一条同块配对都没解析出来，多半是规则解析器失效了").toBeGreaterThan(50);
    expect(offenders, "这些块的文字压在自己声明的填充色上不达 AA").toEqual([]);
  });
});

describe("G3 半透明着色底（chip / diff 高亮）上的文字", () => {
  it("块内 background 为 rgba 时，先与 --bg3 合成再算，全部 >= 4.5:1", () => {
    const offenders: string[] = [];
    let checked = 0;
    rules().forEach((rule) => {
      const bgRaw = rule.decls.background ?? rule.decls["background-color"];
      const bg = resolveColor(bgRaw);
      if (!bg) return;
      const { a } = parseColor(bg);
      if (a >= 1) return;
      const color = resolveColor(rule.decls.color);
      if (!color) return;
      checked += 1;
      const eff = composite(bg, BG3);
      const ratio = contrast(color, eff);
      if (ratio < AA) offenders.push(`${rule.sel}: ${rule.decls.color} on ${bgRaw}∘--bg3(${eff}) = ${ratio.toFixed(2)}`);
    });
    expect(checked, "一条 tint 配对都没解析出来，多半是规则解析器失效了").toBeGreaterThan(10);
    expect(offenders, "这些 tint chip 上的文字不达 AA（.env-badge.env-other 当年就是这么漏的）").toEqual([]);
  });
});

describe("G4 文字色对全局地板", () => {
  /** Tier-3 白名单：按 3:1（SC 1.4.11 非文字图形 / 表单标记）判定，不参与正文 4.5 地板。 */
  it("除自带不透明底（归 G2）外，所有文字色 vs --bg >= 4.5:1", () => {
    const offenders: string[] = [];
    let checked = 0;
    rules().forEach((rule) => {
      const color = resolveColor(rule.decls.color);
      if (!color) return;
      const ownBg = resolveColor(rule.decls.background ?? rule.decls["background-color"]);
      if (ownBg && parseColor(ownBg).a >= 1) return;
      checked += 1;
      const ratio = contrast(color, BG);
      if (ratio < AA) offenders.push(`${rule.sel}: ${rule.decls.color} → ${color} vs --bg = ${ratio.toFixed(2)}`);
    });
    expect(checked, "几乎没有文字色被检查到，多半是规则解析器失效了").toBeGreaterThan(200);
    expect(
      offenders,
      "这些文字色连最宽松的 --bg 地板都达不到；若是图标/表单标记请一并加进 Tier-3 白名单并写明 3:1 口径"
    ).toEqual([]);
  });
});

/**
 * G5 文字色地板必须按「实际承托面」算（轮44 R94 重写）。
 *
 * 为什么 G4 拦不住这一类：G4 的地板是最宽松的 --bg，而 `.hljs-*` 自己从不声明 background——
 * 底色由祖先（`.diff-row.add .diff-cell.right`、`.code-area .search-hit`）给。
 * 于是 #569cd6 在 G4 里 5.36:1 全绿，真机上落在 mod 底 #393932 却只有 3.95:1，
 * 连续几轮都是「普查扫到哪、临时补哪」⇒ 本轮把它写成静态地板，一次堵死。
 *
 * 承托面按真机实测钉死（Playwright 探针逐层读 computed background，数值记在 .trellis 轮44 research）：
 *   1. 代码区正文与行号槽、统一视图正文与 `.udiff-text` 行底，有效底色都是 --bg #1e1e1e：
 *      `.udiff-text .search-hit` 实测有效底 #5a2929，与 composite(rgba(244,67,54,.28), --bg) 逐位吻合
 *      （承托面若真是 --bg3，这里应读到 #653436）⇒ 上一版按臆想补的 4 个 `∘--bg3` 配对已删。
 *   2. 唯一真正亮一档的承托面是行号槽：`.udiff-gutter` 底实测 --bg2 #252526，
 *      所以 dim / --red-h 在 A2 单列一档；不必为它再抬亮任何令牌。
 *   3. 带色行底（选中 --bg-active / 悬停 --bg-hover）把 18% 红 tint 抬到 #334769 / #593a3f，
 *      --red-text 实测 4.26 / 4.56 ⇒ 这类底上的命中词只允许 --red-text-raised，
 *      由下面那条 scoped CSS 结构守卫兜住，规则被删即判红。
 *
 * 配对只按可达性列成 surfaces，不做 palette × bases 笛卡尔积：全交叉会连「实心红底上的彩色 token」
 * 这种无解组合一起逼，最后只能靠抬平层级来迁就，正是几轮返工的根源。
 *
 * 为什么 add/del/mod 这三档只能静态守：retest 环境的历史变更 diff 永远只有 ctx 行
 * （republish 反复播种同内容，census 实测 add=0 del=0 ctx=56），真机量不到语义 tint 底；
 * 能实测到的是配置对比页的 `.diff-cell`，其底 add=#263935 / del=#402525 / mod=#393932
 * 正是 tint ∘ --bg，与下面 B1/B2/B3 同源（锚点用例把这几个十六进制值钉住，要改先重新实测）。
 */
describe("G5 文字色对实际承托面（承托面按真机实测配对）", () => {
  const TEXT = token("text");
  const RED_H = token("red-h");
  const RED_TEXT_RAISED = token("red-text-raised");
  const AMBER_H = token("amber-h");

  const tintOf = (sel: string): string => {
    const rule = rules().find((r) => normalizeSelector(r.sel) === sel);
    const bg = rule?.decls.background;
    expect(bg && bg.includes("rgba"), `找不到 ${sel} 的 rgba 背景：承托面矩阵需要人工复核`).toBeTruthy();
    return bg!;
  };
  const HIT18 = tintOf(".search-hit");
  const HIT28 = tintOf(".code-area .search-hit");
  const LINE_HIT = tintOf(".code-line.is-hit");
  const LINE_CURRENT = tintOf(".code-line.is-current");
  // 代码区与统一视图正文共用同一档命中 tint，分叉了就要重新按面实测。
  expect(tintOf(".udiff-text .search-hit"), "统一视图命中底与代码区不同档，承托面矩阵需要按实测拆行").toBe(HIT28);

  /** 代码/差异正文可能出现的文字色：所有不透明 `.hljs-*` 字面值 + 正文令牌。 */
  const codeColors: Array<[string, string]> = [];
  const seenColors = new Set<string>();
  rules().forEach((rule) => {
    if (!rule.sel.includes(".hljs-")) return;
    const color = resolveColor(rule.decls.color);
    if (!color || !isOpaque(color) || seenColors.has(color)) return;
    seenColors.add(color);
    codeColors.push([rule.sel.split(",")[0]!.trim(), color]);
  });
  expect(codeColors.length, "一条 .hljs-* 颜色都没解析出来，多半是规则解析器失效了").toBeGreaterThanOrEqual(6);
  codeColors.push(["--text", TEXT]);

  /**
   * 琥珀警告条一族（W1/W2）：底色必须是 rgba tint 写法，叠在面板底上。
   * 为什么 tintOf 只认 rgba——轮96 K2 写过 `color-mix(in srgb, var(--amber) 12%, var(--bg-panel))`，
   * `--bg-panel` 全站没声明，于是整条 background 静默失效，提示条只剩一圈边框（承托面根本不存在，
   * 这张表也无从谈起）。改回 rgba 之后，tintOf 能拿到真实 tint，族内两处一旦分叉也当场报红。
   */
  const WARN_AMBER = tintOf(".browser-remote-moved");
  expect(tintOf(".test-msg.warn"), "琥珀警告条底色分叉了，W1/W2 承托面要按新的那一档重新列")
    .toBe(WARN_AMBER);

  const DIM_P: [string, string] = ["--text-dim", DIM];
  const RAISED_P: [string, string] = ["--text-dim-raised", DIM_RAISED];
  const TEXT_P: [string, string] = ["--text", TEXT];
  const RED_TEXT_P: [string, string] = ["--red-text", RED_TEXT];
  const RED_RAISED_P: [string, string] = ["--red-text-raised", RED_TEXT_RAISED];
  const RED_H_P: [string, string] = ["--red-h", RED_H];
  const AMBER_H_P: [string, string] = ["--amber-h", AMBER_H];

  const surfaces: Array<{ name: string; bg: string; colors: Array<[string, string]> }> = [
    { name: "A1 --bg（代码区正文与行号槽 / 统一视图正文）", bg: BG, colors: [...codeColors, DIM_P, RAISED_P, RED_TEXT_P, RED_H_P] },
    { name: "A2 --bg2（统一视图行号槽实测底 / 列表底）", bg: BG2, colors: [DIM_P, RAISED_P, RED_H_P, TEXT_P, RED_TEXT_P] },
    { name: "A3 --bg3（查找条等 chrome 底）", bg: BG3, colors: [DIM_P, RAISED_P, RED_H_P, TEXT_P] },
    { name: "B1 add tint ∘ --bg", bg: composite(token("diff-add-bg"), BG), colors: [...codeColors, DIM_P, RAISED_P, RED_TEXT_P] },
    { name: "B2 del tint ∘ --bg", bg: composite(token("diff-del-bg"), BG), colors: [...codeColors, DIM_P, RAISED_P, RED_TEXT_P, RED_H_P] },
    { name: "B3 mod tint ∘ --bg", bg: composite(token("diff-mod-bg"), BG), colors: [...codeColors, DIM_P, RAISED_P, RED_TEXT_P] },
    { name: "C1 hit18 ∘ --bg（列表摘要 / 差异正文的命中词）", bg: composite(HIT18, BG), colors: [RED_TEXT_P, RED_RAISED_P] },
    { name: "C2 hit18 ∘ --bg2（列表普通行的命中词）", bg: composite(HIT18, BG2), colors: [RED_TEXT_P, RED_RAISED_P] },
    { name: "C3 hit18 ∘ --bg-active（选中行命中：只许 raised）", bg: composite(HIT18, BG_ACTIVE), colors: [RED_RAISED_P] },
    { name: "C4 hit18 ∘ --bg-hover（悬停行命中：只许 raised）", bg: composite(HIT18, BG_HOVER), colors: [RED_RAISED_P] },
    { name: "D1 hit28 ∘ --bg（代码区 / 统一视图正文的命中词）", bg: composite(HIT28, BG), colors: [RED_TEXT_P, RED_RAISED_P] },
    { name: "D2 hit28 ∘ is-hit ∘ --bg（命中行上的命中词）", bg: composite(HIT28, composite(LINE_HIT, BG)), colors: [RED_TEXT_P, RED_RAISED_P] },
    { name: "E1 is-hit ∘ --bg（命中行正文）", bg: composite(LINE_HIT, BG), colors: [...codeColors, RED_TEXT_P] },
    { name: "E2 is-current ∘ --bg（当前命中行正文）", bg: composite(LINE_CURRENT, BG), colors: [...codeColors, RED_TEXT_P] },
    // 警告条正文 --amber-h、条内 ghost 按钮 --text（.btn-ghost 背景 transparent，字直接落在 tint 上）。
    // dim 不放进来：它在这一档上实测 3.88，而条内确实没有次要文本——将来要加就得换成 raised。
    { name: "W1 amber warn tint ∘ --bg（草稿基线交换提示条：承托面按样式表链推导）", bg: composite(WARN_AMBER, BG), colors: [AMBER_H_P, TEXT_P] },
    { name: "W2 amber warn tint ∘ --bg-hover（同一配对在更亮的面板上也必须达标）", bg: composite(WARN_AMBER, BG_HOVER), colors: [AMBER_H_P, TEXT_P] },
    { name: "F --red-fill（当前命中实心红底）", bg: RED_FILL, colors: [["#ffffff", "#ffffff"]] },
  ];

  it("每张承托面上的每一种文字色都 >= 4.5:1", () => {
    expect(surfaces.length, "承托面少于 14 张，多半是矩阵被误删了行").toBeGreaterThanOrEqual(14);
    const offenders: string[] = [];
    let checked = 0;
    surfaces.forEach((surface) => {
      surface.colors.forEach(([label, color]) => {
        checked += 1;
        const ratio = contrast(color, surface.bg);
        if (ratio < AA) offenders.push(`${label}(${color}) on ${surface.name}(${surface.bg}) = ${ratio.toFixed(2)}`);
      });
    });
    expect(checked, "一条配对都没算出来，多半是 .hljs-* 规则解析器失效了").toBeGreaterThan(50);
    expect(offenders, "这些文字色在实际承托面上不达 AA（轮44 真机普查就是这么炸的）").toEqual([]);
  });

  /**
   * 实测锚点：把破案用的那几个合成值钉死。
   * 这里不是在算达不达标，而是在钉「承托面是谁」——上一版把它当 --bg3 用，
   * 于是凭空多出 4 个配对，逼着把 #86b471 / #a8a8a8 再抬一档，层级就没了。
   * 数值若变了，说明底或 tint 改过，必须先回真机重测再改这张表，不许就地放宽。
   */
  it("承托面实测锚点：合成底仍是真机读到的那几个值（要改先重新实测）", () => {
    expect(BG.toLowerCase(), "--bg 实测 #1e1e1e").toBe("#1e1e1e");
    expect(BG2.toLowerCase(), "行号槽实测 #252526 = --bg2").toBe("#252526");
    expect(composite(HIT28, BG), "代码区命中底实测 #5a2929").toBe("#5a2929");
    expect(composite(HIT18, BG_ACTIVE), "选中行命中底实测 #334769").toBe("#334769");
    expect(composite(token("diff-del-bg"), BG), "del 单元格底实测 #402525（与 tint ∘ --bg 完全相同）").toBe("#402525");
    expect(composite(token("diff-add-bg"), BG)).toBe("#263935");
    expect(composite(token("diff-mod-bg"), BG)).toBe("#393932");
  });

  it("抬亮不许顺手抹平层级（dim < raised < text，命中词两档、语法色三档各自有序）", () => {
    expect(luminance(DIM)).toBeLessThan(luminance(DIM_RAISED));
    expect(luminance(DIM_RAISED)).toBeLessThan(luminance(TEXT));
    expect(luminance(RED_TEXT)).toBeLessThan(luminance(RED_TEXT_RAISED));
    const comment = rules().find((r) => r.sel.includes(".hljs-comment"))?.decls.color;
    const string = rules().find((r) => r.sel.includes(".hljs-string"))?.decls.color;
    const number = rules().find((r) => r.sel.includes(".hljs-number"))?.decls.color;
    expect(comment && string && number && luminance(comment) < luminance(string), "注释色不能亮过字符串").toBe(true);
    expect(string && number && luminance(string) < luminance(number), "字符串色不能亮过数字，否则强调层级反了").toBe(true);
  });

  /**
   * C3/C4 为什么只放 raised：--red-text 在选中/悬停行底上实测 4.26 / 4.56（摘要 11px，走 4.5 档）。
   * 缺口靠 scoped 规则补（与 R15 的 --text-dim-raised 同一条路子：底变亮就抬前景，不动行底色）。
   * 这条是那张表唯一的防线——规则一旦被删，矩阵里的 C3/C4 依然全绿，所以必须单独钉结构。
   */
  it("选中/悬停行底上的命中词必须仍由 raised 令牌 + scoped 规则兜住", () => {
    expect(contrast(RED_TEXT, composite(HIT18, BG_ACTIVE)), "--red-text 在选中行命中底上若已达标，说明承托面又变了，需重测").toBeLessThan(AA);
    const guard = rules().find((rule) =>
      rule.decls.color === "var(--red-text-raised)" &&
      rule.sel.split(",").some((sel) => /^\.browser-item\.active \.browser-item-summary \.search-hit$/.test(sel.trim()))
    );
    expect(guard, '找不到 .browser-item.active .browser-item-summary .search-hit { color: var(--red-text-raised) } —— 选中行命中词会掉回 4.26:1').toBeTruthy();
    guard!.sel.split(",").forEach((raw) => {
      const sel = raw.trim();
      // 特异度：类 / 属性选择器 / 伪类各算一档。(0,4,0) 才稳过 .search-hit(0,1,0) 与
      // .search-hit.search-hit-current(0,2,0)，不跟文档顺序赌。
      const weight =
        (sel.match(/\.[\w-]+/g) ?? []).length + (sel.match(/\[[^\]]+\]/g) ?? []).length + (sel.match(/:[\w-]+/g) ?? []).length;
      expect(weight, `scoped 规则 ${sel} 特异度只有 ${weight}，会被当前命中或基础规则盖住`).toBeGreaterThanOrEqual(4);
    });
  });

  it("命中范围内语法 token 一律回继承色：实心 --red-fill 上彩色字没有解", () => {
    const guard = rules().find((r) => r.decls.color === "inherit" && r.sel.includes('[class*="hljs-"]'));
    expect(guard, '找不到 .search-hit 里 [class*="hljs-"] { color: inherit } 这条兜底规则').toBeTruthy();
    const selectors = guard!.sel.split(",").map((s) => s.trim());
    selectors.forEach((sel) => {
      expect(sel, `兜底选择器 ${sel} 必须限定在命中范围内`).toContain("search-hit");
      // (0,3,0) 起步：压得过 .hljs-meta .hljs-string 这类成对 token 规则，不靠文档顺序决胜
      const weight = (sel.match(/\.[\w-]+/g) ?? []).length + (sel.match(/\[[^\]]+\]/g) ?? []).length;
      expect(weight, `兜底选择器 ${sel} 特异度只有 ${weight}，会被成对 token 规则盖住`).toBeGreaterThanOrEqual(3);
    });
    // 白字压实心红底是这条方案的另一半，G1 已算过；这里再钉一次它仍是当前命中的文字色
    const currentHit = rules().find((r) => normalizeSelector(r.sel) === ".code-area .search-hit.search-hit-current");
    expect(currentHit?.decls.background, "当前命中不再是实心红底：请同步复核彩色 token 的兜底").toBe("var(--red-fill)");
    expect(["#fff", "#ffffff"]).toContain(currentHit?.decls.color);
  });
});
