/**
 * 审计矩阵的两条实现契约（轮142 A2/A3）。
 *
 * 为什么要静态钉：这两件事都是「眼下能用、日后会被顺手改坏」的类型——
 * 1. **行高只有一个事实源**：窗口化渲染（r111）靠固定行高算 spacer 总高与 translateY。
 *    TS 里的常量与 styles.css 里的 height 是两处字面量，改一处忘另一处不会报错，
 *    只会让滚动条与行位置漂开：轻则错位几百 px，重则最后几行永远滚不到。
 *    换行档（108px）是同一份机制的第二档，所以两个常量必须各自在 CSS 里找到配对。
 * 2. **改忽略规则只许本地重算**：buildAuditMatrix 是纯函数，吃已经取回的 sources。
 *    谁哪天把它改成「重新跑一遍审计」，行内那颗「忽略」钮就从秒生效变成几分钟，
 *    还会白烧一遍 Nacos/MSE 请求——而界面上一切照旧，没人会发现。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, readScannedSource, stripComments } from "./scanUtils";

const VIEW = "src/components/AuditView.tsx";
const CSS = join(PROJECT_ROOT, "src/styles.css");

/** 取函数/常量声明体：从 anchor 起按花括号配对截到闭合处。 */
function sliceFrom(source: string, anchor: string, label: string): string {
  const start = source.indexOf(anchor);
  expect(start, `源码里找不到 ${label}`).toBeGreaterThan(-1);
  let depth = 0;
  let seen = false;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === "{") {
      depth += 1;
      seen = true;
    } else if (source[i] === "}") {
      depth -= 1;
      if (seen && depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

/** CSS 里 `.audit-matrix-body .audit-matrix-row` 规则族声明过的 height 值集合。 */
function matrixRowHeights(css: string): Set<string> {
  const heights = new Set<string>();
  const clean = stripComments(css);
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = match[1].replace(/\s+/g, " ").trim();
    if (!/\.audit-matrix-body\s+\.audit-matrix-row/.test(sel)) continue;
    for (const decl of match[2].split(";")) {
      const found = /^\s*height:\s*(\d+)px\s*$/.exec(decl);
      if (found) heights.add(found[1]);
    }
  }
  return heights;
}

describe("审计矩阵的行高与本地重算（轮142 A2/A3）", () => {
  it("A3：TS 两档行高常量与 styles.css 的 height 一一配对，多一档少一档都判红", () => {
    const source = stripComments(readScannedSource(VIEW));
    const single = /const MATRIX_ROW_HEIGHT = (\d+);/.exec(source);
    const wrap = /const MATRIX_ROW_WRAP_HEIGHT = (\d+);/.exec(source);
    expect(single, "AuditView 里找不到 MATRIX_ROW_HEIGHT 常量").toBeTruthy();
    expect(wrap, "AuditView 里找不到 MATRIX_ROW_WRAP_HEIGHT 常量（换行档依赖它）").toBeTruthy();

    const expected = new Set([single![1], wrap![1]]);
    const actual = matrixRowHeights(readFileSync(CSS, "utf8"));
    expect([...actual].sort(), "styles.css 里 .audit-matrix-body .audit-matrix-row 的 height 与 TS 常量不配对").toEqual(
      [...expected].sort()
    );
  });

  it("A3：窗口化列表内部不许再引用单档常量，只许用 props 传进来的 rowHeight", () => {
    const source = stripComments(readScannedSource(VIEW));
    const list = sliceFrom(source, "function AuditMatrixList(", "AuditMatrixList");
    expect(list, "AuditMatrixList 里出现了行高常量字面量：换行档会按 48px 算窗口").not.toMatch(/MATRIX_ROW_(HEIGHT|WRAP_HEIGHT)/);
    expect(list).toMatch(/rowHeight/);
  });

  it("A2：快速忽略与撤销只走本地重算，一次都不许多取数", () => {
    const source = stripComments(readScannedSource(VIEW));
    const sites: Array<[string, string]> = [
      ["const rebuildFromLocalRules = useCallback(", "rebuildFromLocalRules"],
      ["const addQuickIgnore = useCallback(", "addQuickIgnore"],
      ["const undoQuickIgnore = useCallback(", "undoQuickIgnore"],
      ["const buildMatrix = useCallback(", "buildMatrix"],
    ];
    for (const [anchor, label] of sites) {
      const body = sliceFrom(source, anchor, label);
      expect(body, `${label} 里出现了取数调用：改规则应当本地重算，不许重跑审计`).not.toMatch(/\b(listAllConfigs|getConfig)\s*\(/);
    }
    // 本地重算必须吃那份共享的 sources，否则就成了第二次全量拉取
    const rebuild = sliceFrom(source, sites[0][0], sites[0][1]);
    expect(rebuild).toMatch(/auditSources/);
    expect(rebuild).toMatch(/buildMatrix\(/);
  });

  it("A2：忽略规则用归一化后的 dataId（匹配桶口径），不许顺手改成 originalDataIds", () => {
    const source = stripComments(readScannedSource(VIEW));
    const add = sliceFrom(source, "const addQuickIgnore = useCallback(", "addQuickIgnore");
    expect(add).toMatch(/row\.dataId/);
    expect(add, "originalDataIds 是各环境的原始名，归一化开着时按它写规则永远命中不了").not.toMatch(/originalDataIds/);
  });

  it("A4：折叠可见性必须让「没跑过审计」永远展开，条件区不许在用户还没配好环境时消失", () => {
    const source = stripComments(readScannedSource(VIEW));
    expect(source).toMatch(/const condVisible = rows\.length === 0 \|\| condOpen;/);
    expect(source).toMatch(/const settingsVisible = condVisible && showSettings;/);
    // aria-expanded 读派生值而不是原始开关，否则折叠后按钮会说谎
    const settingsBtn = /className="btn btn-ghost btn-sm audit-settings-toggle"[^>]*aria-expanded=\{([^}]*)\}/.exec(source);
    expect(settingsBtn, "设置折叠钮没挂 aria-expanded").toBeTruthy();
    expect(settingsBtn![1].trim()).toBe("settingsVisible");
  });
});
