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
    ["accent-text", "on-accent", "red-fill", "red-text", "purple-text"].forEach((name) => {
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
