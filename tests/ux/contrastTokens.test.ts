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

/** 支持 `#rrggbb` 与 `rgba(r, g, b, a)` / `rgb(r, g, b)`，返回 0–255 三分量与 alpha。 */
function parseColor(value: string): { r: number; g: number; b: number; a: number } {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const n = hex[1];
    return { r: Number.parseInt(n.slice(0, 2), 16), g: Number.parseInt(n.slice(2, 4), 16), b: Number.parseInt(n.slice(4, 6), 16), a: 1 };
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

/** 取声明了 `color: var(--text-dim-raised)` 的规则块的选择器列表。 */
function raisedSelectors(): string[] {
  const blocks = Array.from(CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g));
  const hit = blocks.find((match) => /color:\s*var\(--text-dim-raised\)/.test(match[2]));
  expect(hit, "找不到把次要文本换成 raised 的规则块").toBeTruthy();
  return hit![1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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
