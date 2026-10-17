/**
 * 全站最小字号下限（轮15 波34 / R56）。
 *
 * 缺陷长什么样：styles.css 的字号分布实测是 10px×8、10.5px×3、11px×64、11.5px×11、12px×106 ——
 * 也就是说全站本来就有一条「11px 以下不排印」的事实下限，只有 11 条规则漏在下面。漏的又恰好都是
 * 徽章、步骤号、状态标签这类字数最少的位置（`.task-status` 还要 uppercase），10px 在 100% 缩放的
 * 桌面窗口里发虚。这类问题不报错、不影响功能、截图对比也看不出来，只能静态钉住。
 *
 * 口径：
 * 1. `src/styles.css` 是全站唯一样式表，里面不许出现低于 11px 的 `font-size`；
 * 2. 单位只许 px（或 `inherit`）：`0.6rem` 这类写法会绕过字号阶梯，按缺陷处理；
 * 3. 本波抬上来的 11 条规则逐条钉成 11px，防止有人偷偷调回去；
 * 4. 组件内联 `fontSize` 同样受限，防止绕开样式表另开一条更小的档位；
 * 5. 守卫自身防永真：字号声明总数、11px 档位计数、站点名单长度都钉了下限。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, readScannedSource, sourceFiles, stripComments } from "./scanUtils";

const CSS = "src/styles.css";
const MIN_FONT_PX = 11;

/** 允许出现在 font-size 里的非 px 值（`inherit` 跟着父级字号，本身不设新档位）。 */
const NON_PX_ALLOWLIST = new Set(["inherit"]);

/** 本波从 10px / 10.5px 抬到 11px 的站点。 */
const FLOOR_SITES = [
  ".message-badge",
  ".sel-arrow",
  ".history-hint",
  ".op",
  ".diff-workflow-step-mark",
  ".help-tip",
  ".batch-diff-nav-stats .stat",
  ".conn-ssh-badge",
  ".conn-provider-badge",
  ".ssh-badge",
  ".task-status",
];

const FONT_SIZE_DECL = /font-size:\s*([^;{}]+);/g;
const PX_VALUE = /^(\d+(?:\.\d+)?)px$/;

/** 摊平样式表里的 font-size 声明：已剥注释，值取 trim 后的原文。 */
function fontDecls(source: string): string[] {
  return Array.from(source.matchAll(FONT_SIZE_DECL), (m) => m[1].trim());
}

/** 低于下限的字号，report 里带值方便定位。 */
function belowFloor(values: string[]): string[] {
  return values.filter((v) => {
    if (!PX_VALUE.test(v)) return !NON_PX_ALLOWLIST.has(v);
    return Number.parseFloat(PX_VALUE.exec(v)![1]) < MIN_FONT_PX;
  });
}

/**
 * 取某个选择器规则块的主体（不含首尾花括号）。
 *
 * 按「选择器独占一行且行首无缩进」定位，命中多份直接报错——重复选择器的取舍归
 * duplicateSelectors 守卫管，这里不猜哪一份生效。
 */
function ruleBody(source: string, selector: string): string {
  const anchor = "\n" + selector + " {";
  const hits: number[] = [];
  for (let at = source.indexOf(anchor); at >= 0; at = source.indexOf(anchor, at + 1)) hits.push(at);
  if (hits.length !== 1) {
    throw new Error(`${selector}: 期望在 ` + CSS + ` 里唯一定位到一条规则，实际 ${hits.length} 处`);
  }
  let cursor = hits[0] + anchor.length - 1;
  let depth = 0;
  for (let i = cursor; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(cursor + 1, i);
    }
  }
  throw new Error(selector + ": 规则块没有闭合的花括号");
}

describe("全站最小字号下限", () => {
  it("样式表里不存在低于 11px 的字号", () => {
    const values = fontDecls(stripComments(readScannedSource(CSS)));
    expect(belowFloor(values)).toEqual([]);
  });

  it("font-size 的单位只许 px 或 inherit", () => {
    const values = fontDecls(stripComments(readScannedSource(CSS)));
    const odd = values.filter((v) => !PX_VALUE.test(v) && !NON_PX_ALLOWLIST.has(v));
    expect(odd).toEqual([]);
  });

  it("本波抬到 11px 的站点逐条钉住", () => {
    const source = stripComments(readScannedSource(CSS));
    for (const selector of FLOOR_SITES) {
      const decls = fontDecls(ruleBody(source, selector));
      const label = `${selector}: `;
      expect(decls.length, `${label}${JSON.stringify(decls)}`).toBe(1);
      expect(decls[0], label).toBe("11px");
    }
  });

  it("组件内联 fontSize 不得绕过下限或另开单位", () => {
    const INLINE = /fontSize\s*[:=]\s*\{?\s*(?:["'](-?\d+(?:\.\d+)?)(px|rem|em|pt|%|vh|vw)?["']|-?(\d+(?:\.\d+)?)(px|rem|em|pt|%)?)/g;
    const offenders: string[] = [];
    for (const rel of sourceFiles()) {
      const source = readScannedSource(rel);
      for (const m of source.matchAll(INLINE)) {
        const value = Number.parseFloat(m[1] ?? m[3]);
        const unit = m[2] ?? m[4] ?? "";
        if (unit !== "px" && unit !== "") {
          offenders.push(`${rel}: fontSize ${value}${unit} 用了 px 之外的单位`);
          continue;
        }
        if (value < MIN_FONT_PX) offenders.push(`${rel}: fontSize ${value}${unit} 低于 ${MIN_FONT_PX}px`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("守卫不永真：字号声明总数与 11px 档位计数钉下限", () => {
    const values = fontDecls(stripComments(readScannedSource(CSS)));
    expect(values.length).toBeGreaterThanOrEqual(200);
    expect(values.filter((v) => v === "11px").length).toBeGreaterThanOrEqual(70);
    expect(FLOOR_SITES.length).toBeGreaterThanOrEqual(11);
  });

  it("样式表只有 src/styles.css 一份，新文件不得绕开守卫", () => {
    const cssFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(join(PROJECT_ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        else if (entry.name.endsWith(".css")) cssFiles.push(rel);
      }
    };
    walk("src");
    expect(cssFiles).toEqual([CSS]);

    const html = stripComments(readFileSync(join(PROJECT_ROOT, "index.html"), "utf8"));
    expect(belowFloor(fontDecls(html))).toEqual([]);
  });
});
