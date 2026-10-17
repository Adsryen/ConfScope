/**
 * 文案参数插值只认一个实现（轮14 波31 / R52）。
 *
 * `String.prototype.replace` 的第二参**是字符串**时会解析 `$&` / `` $` `` / `$'` / `$1` / `$$`，
 * 而文案参数位上放的常是用户搜索词、底层异常原文、文件路径这类带 `$` 的数据。
 * 波24 R43 只把 lib 的 `translate()` 改成函数回调，组件侧 `t()` 仍是字符串替换，
 * 124 个 `t(key, {…})` 调用点一起漏（实测 `term: "a$&b"` 渲染成「未找到包含 a{term}b」）。
 * 本波把两处收敛到 `src/locales` 的 `interpolate()`，这里静态钉住不再长出第二份。
 */
import { describe, expect, it, vi } from "vitest";
import { interpolate, translate } from "../../src/locales";
import { readScannedSource, sourceFiles } from "./scanUtils";

/** 插值的唯一实现所在地。 */
const IMPLEMENTATION = "src/locales/index.ts";
/** 组件侧 t() 所在地（它必须委托 interpolate，不许自己搓正则）。 */
const PROVIDER = "src/i18n/index.tsx";
/** 组件路径的行为用例（防止守卫只盯静态形态、用例却被删空）。 */
const BEHAVIOR_TEST = "src/i18n/index.test.tsx";

/** `.replace(new RegExp(…), <第二参>)`：把第二参的起点定位出来，再判它是函数还是字符串。 */
const REPLACE_INLINE = /\.replace\(\s*new RegExp\([^;]*?\)\s*,\s*/g;
/** 安全的第二参：箭头函数或 function（值不再被当替换模式解析）。 */
const FUNCTION_ARG = /^\s*(?:\([^)]*\)|[\w$]+)\s*=>|^\s*function\b/;
/** 逐个 key 循环插值：值里字面出现的 {otherKey} 会被后一趟二次插值。 */
const MULTI_PASS_LOOP = /Object\.entries\(\s*params\s*\)\s*\.\s*(?:forEach|reduce|for)/;

function stringReplacementViolations(source: string): Array<{ line: number; text: string }> {
  const lines = source.split("\n");
  const out: Array<{ line: number; text: string }> = [];
  for (const match of source.matchAll(REPLACE_INLINE)) {
    const start = (match.index ?? 0) + match[0].length;
    const secondArg = source.slice(start, start + 80);
    if (FUNCTION_ARG.test(secondArg)) continue;
    const line = source.slice(0, start).split("\n").length;
    out.push({ line: line, text: lines[line - 1].trim().slice(0, 120) });
  }
  return out;
}

function useLocale(locale: string): void {
  vi.stubGlobal("localStorage", { getItem: () => locale, setItem: () => {}, removeItem: () => {}, clear: () => {} });
}

describe("文案插值单一出口（波31 R52）", () => {
  it("守卫自检：字符串第二参的写法必须被判违规，函数回调不算", () => {
    const bad = "text = text.replace(new RegExp(`\\\\{${k}\\\\}`, 'g'), String(v));";
    const good = 'text = text.replace(new RegExp(`\\\\{${name}\\\\}`, "g"), () => String(value));';
    const goodMultiArg = "out = text.replace(new RegExp(`\\\\{(${names.join('|')})\\\\}`, 'g'), (whole, name) => String(params[name]));";
    expect(stringReplacementViolations(bad)).toHaveLength(1);
    expect(stringReplacementViolations(good)).toHaveLength(0);
    expect(stringReplacementViolations(goodMultiArg)).toHaveLength(0);
  });

  it("src/ 里除 interpolate 外不许出现 .replace(new RegExp(…), 字符串)", () => {
    const violations: string[] = [];
    for (const file of sourceFiles()) {
      for (const hit of stringReplacementViolations(readScannedSource(file))) {
        violations.push(file + ":" + hit.line + " " + hit.text);
      }
    }
    const impl = readScannedSource(IMPLEMENTATION);
    for (const hit of stringReplacementViolations(impl)) {
      violations.push(IMPLEMENTATION + ":" + hit.line + " " + hit.text);
    }
    expect(violations).toEqual([]);
  });

  it("t() 与 translate() 都委托 interpolate，且不许保留多趟循环", () => {
    const provider = readScannedSource(PROVIDER);
    expect(provider).toContain("interpolate");
    expect(provider).toMatch(/interpolate\(\s*getTranslation\(locale,\s*key\)\s*,\s*params\s*\)/);
    const impl = readScannedSource(IMPLEMENTATION);
    expect(impl).toMatch(/return interpolate\(\s*getTranslation\(currentLocale\(\),\s*key\)\s*,\s*params\s*\)/);
    for (const source of [provider, impl]) {
      expect(MULTI_PASS_LOOP.test(source)).toBe(false);
    }
  });

  it("interpolate：$ 系列逐字保留、值里的占位符不被二次插值、未传参的占位符原样留着", () => {
    const template = "共 {count} 项，命中「{term}」";
    for (const value of ["a$&b", "a$`b", "a$'b", "a$1b", "a$$b", "$&"]) {
      expect(interpolate(template, { count: 1, term: value })).toBe("共 1 项，命中「" + value + "」");
    }
    expect(interpolate(template, { count: 2, term: "{count}" })).toBe("共 2 项，命中「{count}」");
    // 只替换传进来的占位符：漏参（或 key 写错）时界面留 `{unknown}`，不会变成 undefined 串
    expect(interpolate("未替换的 {unknown} 保持原样", { known: "x" })).toBe("未替换的 {unknown} 保持原样");
    expect(interpolate("{a} 与 {b}", { a: "1", b: "$&" })).toBe("1 与 $&");
    expect(interpolate("同一占位出现多次 {term}/{term}", { term: "$&" })).toBe("同一占位出现多次 $&/$&");
    expect(interpolate("无参即原样", {})).toBe("无参即原样");
    expect(interpolate("", { term: "x" })).toBe("");
    expect(interpolate("{count} 个", { count: 0 })).toBe("0 个");
  });

  it("translate() 走同一实现：中英两种界面都把 $ 原文回显", () => {
    useLocale("zh-CN");
    expect(translate("config.contentSearchEmpty", { term: "a$&b" })).toBe("内容搜索没有命中「a$&b」");
    useLocale("en-US");
    expect(translate("config.contentSearchEmpty", { term: "a$&b" })).toBe('No content matches "a$&b"');
    vi.unstubAllGlobals();
  });

  it("防死钩子：t(key, {…}) 调用点仍在一处以上，组件行为用例仍在盯 $&", () => {
    const delegated = sourceFiles().reduce((sum, file) => {
      const matches = readScannedSource(file).matchAll(/\bt\(\s*["'][\w.]+["']\s*,\s*\{/g);
      return sum + Array.from(matches).length;
    }, 0);
    expect(delegated).toBeGreaterThanOrEqual(100);
    const behavior = readScannedSource(BEHAVIOR_TEST);
    expect(behavior).toContain("$&");
    expect(behavior).toContain("config.contentSearchEmpty");
  });
});
