/**
 * 「减少动态效果」必须全站真的降速（轮6 R50）。
 *
 * 扫出来的问题：CSS 里只有 1/3 条 keyframes 被 reduced-motion 覆盖，草稿加载脉冲和工作流闪烁
 * 在偏好开启时照样闪；更要命的是 JS 发起的 `behavior: "smooth"` 滚动，CSS 媒体查询根本管不到。
 * 所以钉两条：① CSS 用通配选择器一次性压平所有动画与过渡；② JS 侧的滚动行为只许问 lib/motion。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT, readScannedSource, sourceFiles } from "./scanUtils";

const CSS_RAW = readFileSync(join(PROJECT_ROOT, "src/styles.css"), "utf8");
const CSS = CSS_RAW.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));

/** 取 `@media (prefers-reduced-motion: reduce) { ... }` 整块（按花括号配平）。 */
function reducedMotionBlock(): string {
  const at = CSS.indexOf("@media (prefers-reduced-motion: reduce)");
  expect(at, "styles.css 里没有 prefers-reduced-motion 媒体查询").toBeGreaterThan(-1);
  let depth = 0;
  for (let i = CSS.indexOf("{", at); i < CSS.length; i += 1) {
    if (CSS[i] === "{") depth += 1;
    else if (CSS[i] === "}") {
      depth -= 1;
      if (depth === 0) return CSS.slice(at, i + 1);
    }
  }
  return "";
}

const keyframeNames = Array.from(CSS.matchAll(/@keyframes\s+([\w-]+)/g), (m) => m[1]);

describe("减少动态效果", () => {
  it("扫描口径不是空转：CSS 里确实有多条 keyframes 与动画声明", () => {
    expect(keyframeNames.length).toBeGreaterThanOrEqual(3);
    expect(Array.from(CSS.matchAll(/animation(-name)?:\s*[^;]+/g)).length).toBeGreaterThan(0);
  });

  it("reduced-motion 块用通配选择器压平全部动画与过渡（漏一条就会继续闪）", () => {
    const block = reducedMotionBlock();
    expect(block).toMatch(/\*,\s*\*::before,\s*\*::after\s*\{/);
    expect(block).toMatch(/animation-duration:[^;]*!important/);
    expect(block).toMatch(/animation-iteration-count:\s*1!important|animation-iteration-count:\s*1\s*!important/);
    expect(block).toMatch(/transition-duration:[^;]*!important/);
    // 平滑滚动也是动效：CSS 里的 scroll-behavior 也得按偏好回退
    expect(block).toMatch(/scroll-behavior:\s*auto\s*!important/);
  });

  it("每条被用到的动画都真的被降速：要么被通配规则罩住，要么单独点名", () => {
    const block = reducedMotionBlock();
    const universal = /\*,\s*\*::before,\s*\*::after\s*\{[^}]*animation-duration:[^;]*!important/.test(block);
    const named = new Set(Array.from(block.matchAll(/animation(?:-name)?:\s*([^;]+);/g), (m) => m[1]));
    const used = Array.from(new Set(Array.from(CSS.matchAll(/animation(?:-name)?:\s*([^;]+);/g), (m) => m[1])))
      // 媒体查询块自己内部的声明不算「被用到的动画」
      .filter((decl) => !decl.includes("!important"))
      .flatMap((decl) => decl.split(/[\s,]+/).filter((token) => keyframeNames.includes(token)));
    expect(used.length, "没有一条动画被 CSS 用过，改口径前先确认动画声明写法").toBeGreaterThan(0);
    const uncovered = Array.from(new Set(used)).filter((name) => !universal && ![...named].some((decl) => decl.includes(name)));
    expect(uncovered, universal ? "通配规则已覆盖全部动画" : "开了通配规则却没生效？").toEqual([]);
  });

  it('JS 里的 behavior: "smooth" 只许出现在 lib/motion.ts', () => {
    const offenders = sourceFiles()
      .filter((file) => file !== "src/lib/motion.ts")
      .filter((file) => readScannedSource(file).includes('behavior: "smooth"'))
      .map((file) => file);
    expect(offenders).toEqual([]);
  });

  it("带 options 的滚动调用都走 scrollBehavior()", () => {
    const files = sourceFiles();
    const calls = files.flatMap((file) => {
      const source = readScannedSource(file);
      return Array.from(source.matchAll(/\.(scrollTo|scrollIntoView)\(\s*\{/g), (m) => ({ file, index: m.index ?? 0 }));
    });
    expect(calls.length, "一条 JS 滚动都没扫到，说明正则失效").toBeGreaterThan(0);
    const offenders = calls
      .map(({ file, index }) => {
        const source = readScannedSource(file);
        const start = index + source.slice(index).indexOf("{");
        let depth = 0;
        for (let i = start; i < source.length; i += 1) {
          if (source[i] === "{") depth += 1;
          else if (source[i] === "}") {
            depth -= 1;
            if (depth === 0) return { file, body: source.slice(start, i + 1) };
          }
        }
        return { file, body: source.slice(start) };
      })
      .filter(({ body }) => /behavior:/.test(body) && !/behavior:\s*scrollBehavior\(\)/.test(body) && !/behavior:\s*"auto"/.test(body))
      .map(({ file, body }) => `${file} → ${body.slice(0, 60)}`);
    expect(offenders).toEqual([]);
  });

  it("motion.ts 自己带降级：没有 matchMedia 时不能让跳转失效", () => {
    const motion = readScannedSource("src/lib/motion.ts");
    expect(motion).toContain('matchMedia("(prefers-reduced-motion: reduce)")');
    expect(motion).toMatch(/catch/);
    expect(motion).toMatch(/\?\s*"auto"\s*:\s*"smooth"/);
    expect(motion).toMatch(/return\s+false;/);
  });
});
