/**
 * 守卫：代码/密钥/标识符那类输入框不许被拼写红线标注，且全站兜底必须还在。
 *
 * 现象（轮7 R56）：浏览器默认给可编辑文本开 spellcheck，配置浏览的查找框、SSH 私钥
 * PEM 文本域、审计的 dataId/namespace 输入框里，`maxReadyTime`、`-----BEGIN RSA` 这种
 * 内容全被画成红色波浪线——用户会当成自己写错了，而这里根本没有「拼写」可言。
 * 全站 95 个输入元素里只有 30 个显式关过，其余全靠运气。
 *
 * 口径：
 * 1. 兜底层：App.tsx 的 `.app-shell` 必须带 spellCheck={false}——spellcheck 沿 DOM 继承，
 *    这一条管住所有没写显式声明的输入框（含以后新加的）；
 * 2. 显式层：带 `mono` 类的输入框逐个必须自己声明（动态 `type={x ? "text" : "password"}`
 *    按最坏情况当文本处理；恒为 password/checkbox/number/radio 的跳过，那些本就不拼写检查）；
 * 3. 棘轮：显式声明总数只增不减，输入元素总数要有下限，防扫描空转。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource, sourceFiles } from "./scanUtils";
import { readFileSync } from "node:fs";

/** 取 `<input`/`<textarea` 标签自身的属性文本（花括号内的 > 不算结束）。 */
function openTagAttrs(source: string, start: number): string {
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
    else if (ch === ">" && depth === 0) return source.slice(start, i);
  }
  return source.slice(start);
}

/** 恒为不参与拼写检查的类型才算「不需要声明」；动态三元按最坏情况处理。 */
function alwaysNonTextType(attrs: string): boolean {
  const m = /\btype=(?:"([^"]+)"|\{\s*"([^"]+)"\s*\})/.exec(attrs);
  const staticType = m ? (m[1] ?? m[2]) : null;
  if (staticType) return ["password", "checkbox", "radio", "number", "file", "hidden"].includes(staticType);
  const dynamic = /\btype=\{[^}]*\?[^}]*\}/.test(attrs);
  return dynamic && !/\?\s*"text"/.test(attrs) && !/\?\s*"search"/.test(attrs);
}

describe("输入框的拼写检查红线", () => {
  const elements: { file: string; line: number; tag: string; attrs: string }[] = [];
  for (const rel of sourceFiles()) {
    const source = readScannedSource(rel);
    for (const m of source.matchAll(/<(input|textarea)\b/g)) {
      const start = m.index ?? 0;
      elements.push({ file: rel, line: source.slice(0, start).split("\n").length, tag: m[1], attrs: openTagAttrs(source, start) });
    }
  }

  const declared = elements.filter((e) => /\bspellCheck=/.test(e.attrs));
  const mono = elements.filter((e) => /\bmono\b/.test(e.attrs) && !alwaysNonTextType(e.attrs));
  const monoMissing = mono.filter((e) => !/\bspellCheck=/.test(e.attrs));

  it("扫描要有命中量（口径漂了先在这里红）", () => {
    expect(elements.length).toBeGreaterThanOrEqual(90);
    expect(mono.length).toBeGreaterThanOrEqual(15);
  });

  it("App 根容器必须带全局 spellCheck 兜底", () => {
    const app = readScannedSource("src/App.tsx");
    const shell = /<div className="app-shell"[^>]*>/.exec(app);
    expect(shell, 'App.tsx 里找不到 <div className="app-shell">').not.toBeNull();
    expect(/\bspellCheck=\{false\}/.test(shell![0]), `.app-shell 丢了 spellCheck={false}：${shell![0]}`).toBe(true);
  });

  it("mono 类输入框（代码/密钥/标识符）逐个必须自己关掉拼写检查", () => {
    expect(monoMissing.map((e) => `${e.file}:${e.line} <${e.tag}>`).join("\n")).toBe("");
  });

  it("显式声明数量只增不减（轮48 抽 FindBar 后 44）", () => {
    // 45 → 44：两份重复的查找输入框合成 FindBar 里的一份，spellCheck={false} 跟着只剩一处。
    expect(declared.length).toBeGreaterThanOrEqual(44);
    // 顺带证明这条不是靠「整份文件都一样」蒙过去：locales 之外确实有输入框
    expect(declared.length).toBeLessThan(elements.length);
  });
});
