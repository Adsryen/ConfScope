/**
 * 编辑态行号槽的跨文件几何一致性守卫（R22）。
 *
 * 为什么读磁盘而不是断言渲染结果：行号、命中行底色、跳到第 N 行的滚动量全靠
 * 「行 i 的 top = PAD_TOP + i * ROW_H」这条公式，而它同时写在两个地方——
 * CodeEditor.tsx / CodeView.tsx 的常量与 styles.css 的自定义属性。jsdom 没有布局引擎，
 * 数值一旦对不上，单测全绿但真机上行号会逐行错位（正是本仓库历史上反复踩的坑）。
 * 这类「CSS 与 TS 同源」的约束只能用静态读文件守住。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CSS = readFileSync(join(PROJECT_ROOT, "src/styles.css"), "utf8");
const EDITOR = readFileSync(join(PROJECT_ROOT, "src/components/CodeEditor.tsx"), "utf8");
const VIEW = readFileSync(join(PROJECT_ROOT, "src/components/CodeView.tsx"), "utf8");

/** 取 `const NAME = 12;` 形式的数值常量。 */
function tsConst(src: string, name: string): number {
  const m = new RegExp(String.raw`const ${name} = (\d+)`, "m").exec(src);
  expect(m, `找不到常量 ${name}`).not.toBeNull();
  return Number.parseInt(m![1], 10);
}

/** 取某个选择器规则块里 `--name: value;` 的声明值。 */
function cssVar(selector: string, name: string): string {
  const block = new RegExp(`${selector.replace(/\./g, String.raw`\.`)} \\{([^}]*)\\}`, "m").exec(CSS);
  expect(block, `styles.css 里找不到 ${selector} 规则块`).not.toBeNull();
  const decl = new RegExp(`${name}: ([^;]+);`).exec(block![1]);
  expect(decl, `${selector} 里没有 ${name}`).not.toBeNull();
  return decl![1].trim();
}

describe("编辑态与浏览态共用同一套行网格", () => {
  it("CodeEditor 的 ROW_H / GUTTER_W / PAD_TOP 与 .code-editor 的 CSS 变量逐值相等", () => {
    expect(cssVar(".code-editor", "--code-row-h")).toBe(`${tsConst(EDITOR, "ROW_H")}px`);
    expect(cssVar(".code-editor", "--code-gutter-w")).toBe(`${tsConst(EDITOR, "GUTTER_W")}px`);
    expect(cssVar(".code-editor", "--code-pad-top")).toBe(`${tsConst(EDITOR, "PAD_TOP")}px`);
  });

  it("两个视图同网格：编辑态与浏览态的行高、槽宽一致", () => {
    expect(tsConst(EDITOR, "ROW_H")).toBe(tsConst(VIEW, "ROW_H"));
    expect(tsConst(EDITOR, "GUTTER_W")).toBe(tsConst(VIEW, "GUTTER_W"));
  });

  it("编辑态文本让出行号槽：padding-left = 槽宽 + 内边距，行高用变量而不是相对倍数", () => {
    expect(cssVar(".code-editor", "--code-pad-left")).toBe(`calc(var(--code-gutter-w) + ${tsConst(EDITOR, "PAD_LEFT_EXTRA")}px)`);
    // .code-editor-pre/.code-editor-ta 是合并规则块
    expect(CSS).toMatch(/\.code-editor-pre,\n\.code-editor-ta \{[\s\S]*?padding: var\(--code-pad-top\)[\s\S]*?var\(--code-pad-left\);/);
    expect(CSS).toMatch(/\.code-editor-pre,\n\.code-editor-ta \{[\s\S]*?line-height: var\(--code-row-h\);/);
  });

  it("行号槽复用浏览态的同一套类名，不再各写一份", () => {
    expect(EDITOR).toContain('className="code-gutter"');
    expect(EDITOR).toContain("code-ln");
    expect(EDITOR).toContain('className="code-lines"');
  });
});
