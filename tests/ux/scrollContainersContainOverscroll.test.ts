/**
 * 自滚动容器必须自己收口（轮12 R46）。
 *
 * 扫出来的真 bug：`.history-detail-content`（`max-height: 280px; overflow: auto`）里渲染
 * `<UnifiedDiff>` → `.udiff` 也是 `overflow: auto`；在版本历史的 diff 里滚到底，滚动会链到外层
 * 面板，整块内容一起跳。同类双层滚动还有 `.audit-page` ⊃ `.audit-detail-value`、
 * `.about-modal` ⊃ `.modal-body`、`.browser-items` 与代码区并排等——全站 43 个自滚动容器，
 * 原先只有 `.match-side-scroll`、`.batch-diff-nav-scroll` 两处声明了 `overscroll-behavior`。
 *
 * 约定：谁的 `overflow` 是 auto/scroll，谁就显式写 `overscroll-behavior`，
 * 值只能是 `contain`（保住内层滚动、只切断链式传递）或 `none`（连回弹也一起去掉）。
 * 文档级 `body{height:100vh;overflow:hidden}` 不滚，所以收益点在容器之间，不冲突。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "./scanUtils";

const CSS_PATH = join(PROJECT_ROOT, "src/styles.css");
const OVERFLOW = /^\s*overflow(?:-x|-y)?\s*:\s*(auto|scroll)\s*;\s*$/;
const OVERSCROLL = /^\s*overscroll-behavior\s*:\s*([a-z-]+)\s*;\s*$/;

interface Block {
  selector: string;
  line: number;
  body: string[];
}

/** 按大括号配对切块（@media 里的嵌套块同样成立），块首行回捞选择器文本。 */
function blocksOf(css: string): Block[] {
  const lines = css.split("\n");
  const out: Block[] = [];
  const stack: { start: number }[] = [];
  lines.forEach((raw, i) => {
    for (const ch of raw) {
      if (ch === "{") stack.push({ start: i });
      else if (ch === "}" && stack.length) {
        const { start } = stack.pop()!;
        if (start !== i - 1) {
          const first = lines[start].trim().replace(/\{$/, "").trim();
          let sel = first;
          for (let k = start - 1; k >= 0 && !lines[k].includes("{") && !lines[k].includes("}"); k -= 1) {
            const t = lines[k].trim();
            if (!t || t.startsWith("/*") || t.startsWith("*/") || t.startsWith("@")) break;
            sel = `${t} ${sel}`.trim();
          }
          out.push({ selector: sel || `L${start + 1}`, line: start + 1, body: lines.slice(start + 1, i) });
        }
      }
    }
  });
  return out;
}

describe("滚动链必须收在容器内（波26 R46）", () => {
  const css = readFileSync(CSS_PATH, "utf8");
  const scrollers = blocksOf(css).filter((b) => b.body.some((l) => OVERFLOW.test(l)));

  it("自滚动容器都要声明 overscroll-behavior", () => {
    const violations = scrollers.filter((b) => !b.body.some((l) => OVERSCROLL.test(l))).map((b) => `${b.selector} (styles.css:${b.line})`);
    expect(violations).toEqual([]);
  });

  it("取值只能是 contain/none，auto 等于没写", () => {
    const wrong: string[] = [];
    for (const b of scrollers) {
      for (const l of b.body) {
        const m = OVERSCROLL.exec(l);
        if (m && m[1] !== "contain" && m[1] !== "none") wrong.push(`${b.selector}: ${m[1]}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("扫描器真的在数东西：自滚动容器不得少于 40 个（防空转）", () => {
    expect(scrollers.length).toBeGreaterThanOrEqual(40);
  });

  it("已收口的代表站点不能被悄悄删掉", () => {
    for (const sel of [
      ".code-area",
      ".udiff",
      ".diff-body",
      ".history-detail-error",
      ".audit-detail-value",
      ".modal-body",
      ".match-side-scroll",
    ]) {
      const block = scrollers.find((b) => b.selector.includes(sel));
      expect(block, sel).toBeDefined();
      expect(
        block!.body.some((l) => /^\s*overscroll-behavior\s*:\s*contain\s*;/.test(l)),
        sel
      ).toBe(true);
    }
  });
});
