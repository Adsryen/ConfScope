/**
 * 守卫：每个 `<input>` 必须自己写清 `type=`，不许吃 HTML 默认值。
 *
 * 现象（轮7 R57）：全站 92 个 `<input>` 里 51 个没写 type。读代码时看不出这个框收什么，
 * 更拦不住「本该是数字/搜索的框忘了写 type」；`autoComplete`、键盘类型、原生校验行为
 * 全都跟着 type 走，默认值把这些一并定死了，却没人声明过。
 *
 * 口径：
 * 1. `<input>` 缺 `type=` 直接红（`<textarea>` 没有 type 概念，不在范围内）；
 * 2. 棘轮：显式 `type="text"` 的数量只增不减（波15 交付时 53 = 新补 51 + 原有 2），防「删掉声明改成吃默认值」；
 * 3. 命中量下限：扫描本身要有产出，正则漂掉时先在第 3 条红，而不是让前两条空转变绿。
 *
 * 已知边界：动态 `type={cond ? "a" : "b"}` 算已声明；本守卫不判断类型选得对不对
 * （把 URL 框写成 text 是语义问题，不是这里要拦的回归）。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource, sourceFiles } from "./scanUtils";

/** 取 `<input` 开标签的文本（花括号/引号里的 `>` 不算结束）。 */
function openTag(source: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
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
  return source.slice(start);
}

interface InputSite {
  file: string;
  line: number;
  attrs: string;
}

function scanInputs(): InputSite[] {
  const sites: InputSite[] = [];
  for (const rel of sourceFiles()) {
    const source = readScannedSource(rel);
    for (const m of source.matchAll(/<input\b/g)) {
      const start = m.index ?? 0;
      sites.push({ file: rel, line: source.slice(0, start).split("\n").length, attrs: openTag(source, start) });
    }
  }
  return sites;
}

describe("输入元素必须显式声明 type", () => {
  const sites = scanInputs();
  const missing = sites.filter((s) => !/\btype\s*=/.test(s.attrs));
  const textType = sites.filter((s) => /\btype=(?:"text"|\{\s*"text"\s*\})/.test(s.attrs));

  it("扫描要有命中量（口径漂了先在这里红）", () => {
    expect(sites.length).toBeGreaterThanOrEqual(90);
  });

  it("不许有 <input> 吃 HTML 默认的 type=text", () => {
    expect(missing.map((s) => `${s.file}:${s.line}`).join("\n")).toBe("");
  });

  it('显式 type="text" 的数量只增不减（轮48 抽 FindBar 后 52）', () => {
    // 53 → 52：两份重复的查找输入框合成 FindBar 里的一份，是去重不是漏标。
    expect(textType.length).toBeGreaterThanOrEqual(52);
    // 这条断言不能靠「所有 input 都是 text」成立：确实存在 password/checkbox 等其他类型
    const nonText = sites.filter((s) => /\btype\s*=/.test(s.attrs) && !/\btype=(?:"text"|\{\s*"text")/.test(s.attrs));
    expect(nonText.length).toBeGreaterThanOrEqual(10);
  });
});
