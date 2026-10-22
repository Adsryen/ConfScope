/**
 * 并排 diff 的串侧守卫只许有一处实现，且 TS 类名与 CSS 选择器不许分叉（轮66）。
 *
 * 缺陷长什么样：`.diff-body` 里每行的顺序是「左行号 → 左 cell → 合并箭头 → 右行号 → 右 cell」，
 * 选区取的是文档序区间而不是视觉列区间 ⇒ 只沿左栏往下拖 3 行，真机实测也会命中右侧 2 格、
 * 复制出 173 字符的两栏混合文本。修法是「非起手侧临时 user-select:none」，
 * 靠的是引擎对不可选子树**高亮与复制文本一起**剔除（行号槽一直靠这条）。
 *
 * 三条约束各挡一种分叉：
 * 1. CSS 必须按侧收口（命中对侧的 .diff-cell），写成整块 body 不可选就把正文和行号一起废了；
 * 2. TS 里导出的两个类名必须与 CSS 用到的完全一致——改一边忘另一边等于守卫静默失效，
 *    表现是「有时候串侧有时候不串」，比没修更难查；
 * 3. 挂载点必须是 `.diff-body` 本体（滚动容器 + 选区宿主），挂到 .diff-panel 上会连
 *    查找条与警告区一起管进来，pointerdown 落点判定就错了。
 * 变异对照：类名改名、选择器去掉 `.diff-cell`、hook 的 ref 换成 rootRef，都必须判红。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, stripComments } from "./scanUtils";

const CSS = stripComments(readFileSync(join(PROJECT_ROOT, "src/styles.css"), "utf8"));
const GUARD = stripComments(readFileSync(join(PROJECT_ROOT, "src/lib/sideSelectionGuard.ts"), "utf8"));
const PANEL = stripComments(readFileSync(join(PROJECT_ROOT, "src/components/DiffPanel.tsx"), "utf8"));

/** 从 CSS 里捞出「不可选」那一条规则的选择器串。 */
function unselectableSelectors(): string[] {
  const out: string[] = [];
  for (const m of CSS.matchAll(/([^{}]+)\{[^}]*user-select:\s*none;[^}]*\}/g)) {
    for (const sel of m[1].split(",")) out.push(sel.trim());
  }
  return out;
}

describe("串侧守卫的类名单一事实源", () => {
  const classNames = ["side-select-left", "side-select-right"];

  it("TS 侧两个类名都写死在导出里", () => {
    expect(GUARD).toContain(`= "${classNames[0]}"`);
    expect(GUARD).toContain(`= "${classNames[1]}"`);
  });

  it("CSS 侧这两个类各有一条按侧收口的规则，且落在 .diff-cell 上", () => {
    const sels = unselectableSelectors();
    expect(sels).toContain(".diff-body.side-select-left .diff-cell.right");
    expect(sels).toContain(".diff-body.side-select-right .diff-cell.left");
  });

  it("不许图省事把整块正文置为不可选（那会把正文与行号一起废掉）", () => {
    for (const sel of unselectableSelectors()) {
      if (!/side-select-(left|right)/.test(sel)) continue;
      expect(sel, sel).toMatch(/\.diff-cell\.(left|right)$/);
    }
  });
});

describe("挂载点", () => {
  it("DiffPanel 在 bodyRef 上装守卫，并成对卸载", () => {
    expect(PANEL).toMatch(/installSideSelectionGuard\(\s*body\s*\)/);
    expect(PANEL).toMatch(/return installSideSelectionGuard/);
  });

  it("守卫装的那块就是 .diff-body（选区宿主），不是 .diff-panel", () => {
    // 三段都得钉住：JSX 上 ref 挂对元素、effect 里取的是那个 ref、装的就是它。
    // 只查前两段的写法挡不住「const body = rootRef.current」这种就地换靶子的改法（变异对照实测漏网）。
    expect(/className="diff-body[^"]*"\s+ref=\{bodyRef\}/.test(PANEL), "bodyRef 必须挂在 .diff-body 上").toBe(true);
    expect(/className="diff-panel"\s+ref=\{bodyRef\}/.test(PANEL), ".diff-panel 用的是 rootRef").toBe(false);
    const install = PANEL.indexOf("installSideSelectionGuard(body)");
    expect(install, "必须装到变量 body 上").toBeGreaterThan(-1);
    const window_ = PANEL.slice(Math.max(0, install - 220), install);
    expect(window_, "effect 里取的靶子必须是 bodyRef.current").toContain("bodyRef.current");
    expect(window_, "不许换成 rootRef（那会把查找条与警告区一起管进来）").not.toContain("rootRef.current");
  });

  it("守卫不靠 React state 翻面（那一帧浏览器会按旧样式把两侧都刷蓝）", () => {
    expect(GUARD).toMatch(/classList\.toggle/);
    expect(GUARD).not.toMatch(/setState|useState/);
    expect(GUARD).toMatch(/addEventListener\(\s*"pointerdown"\s*,\s*onPointerDown\s*,\s*true\s*\)/);
  });
});
