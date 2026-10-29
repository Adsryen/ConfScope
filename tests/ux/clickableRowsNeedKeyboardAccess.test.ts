/**
 * 「整行可点」的容器必须给键盘留出口（R61）。
 *
 * 缺陷长什么样：`<div className="data-list-item" onClick={...}>` 鼠标一点就选中，
 * 但 div 不在 Tab 顺序里，Enter/Space 什么也不发生 —— 键盘用户面对整张列表寸步难行，
 * CSS 里已经写好的 `:focus-visible` 焦点环永远不可能触发。这类问题不报错、不影响渲染，
 * 单测里用 fireEvent.click 又一路绿灯，只有静态扫才拦得住。
 *
 * 口径：
 * 1. 挂 onClick 的非交互元素必须有 role + tabIndex + onKeyDown 三件套，或者 spread 了 `clickableRowProps(...)`；
 * 2. 弹层遮罩与弹层本体豁免（键盘有 Esc 分层兜底），但按文件计配额，只减不增；
 * 3. 豁免的前提是真的注册了 useEscape，Esc 没了就不许再拿遮罩当借口；
 * 4. 凡是能被 Tab 到达的行类，styles.css 里必须有带 outline 的 :focus-visible —— 可达不可见等于没可达。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, readScannedSource, sourceFiles } from "./scanUtils";

/** 原生就能点/能聚焦的东西不归这条守卫管。 */
const NATIVELY_INTERACTIVE = new Set(["button", "input", "select", "textarea", "a", "summary", "label", "details", "option"]);

/** 常见「只是个容器」的标签，挂了 onClick 就必须自报交互语义。 */
const CONTAINER_TAGS = [
  "div",
  "span",
  "li",
  "ul",
  "ol",
  "tr",
  "td",
  "th",
  "p",
  "section",
  "article",
  "figure",
  "header",
  "footer",
  "strong",
  "code",
  "pre",
];

/** 遮罩/弹层本体：给鼠标用户的便利出口，键盘走 Esc。按文件计配额。 */
// 轮14 波32（R53）：遮罩的关闭判定收进 useOverlayDismiss 后展开成 `{...overlayDismiss}`，
// 开标签里不再有字面 onClick，每份弹层只剩「弹层本体 stopPropagation」这一处豁免，配额随之减半。
// 这不是放松：遮罩要再挂回裸 onClick，就得按本守卫的要求补键盘出口，或被 overlayDismiss 守卫拦下。
const OVERLAY_QUOTA: Record<string, number> = {
  "src/components/About.tsx": 1,
  "src/components/AlertModal.tsx": 1,
  "src/components/ConfigBrowser.tsx": 2,
  "src/components/ConfigEditor.tsx": 1,
  "src/components/ConfirmModal.tsx": 1,
  "src/components/ConnectionManager.tsx": 1,
  "src/components/DeleteConfirm.tsx": 1,
  "src/components/EditorDialog.tsx": 1,
  "src/components/ErrorDialog.tsx": 1,
};

// role="option" 的行由外层 listbox 统一接管按键（配置浏览就是这套），行上不再重复写 onKeyDown。
const OPTION_SELECTOR_RE = /role="option"/g;

/** 已经补齐键盘出口的行类，焦点环必须跟着。 */
const FOCUSABLE_ROW_CLASSES = [
  ".data-list-item",
  ".browser-item",
  ".conn-item",
  ".conn-group-title",
  ".conn-env-title",
  ".audit-matrix-row",
  ".history-item-main",
];

/** 从 `<div` 的尖括号起，取到开标签结束（带括号深度与引号状态，别被 `=>` 之外的 `>` 截断）。 */
function openingTagAt(source: string, start: number): string | null {
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
  return null;
}

function classTokens(attrs: string): string[] {
  const literal = attrs.match(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/);
  const raw = literal ? `${literal[1] ?? ""} ${literal[2] ?? ""} ${literal[3] ?? ""}` : "";
  return raw.split(/[\s${}]+/).filter(Boolean);
}

function isOverlay(attrs: string): boolean {
  return classTokens(attrs).some(
    (token) => token === "modal" || token === "modal-overlay" || token.endsWith("-overlay") || token === "overlay"
  );
}

interface ScanResult {
  offenders: string[];
  overlays: Record<string, number>;
  optionRows: number;
}

/** 剥注释后的文本行数与原文一致，直接按换行数算行号，fixture（假路径）也能报行号。 */
function lineOf(stripped: string, index: number): number {
  return stripped.slice(0, index).split("\n").length;
}

function scanFile(relPath: string, stripped: string): ScanResult {
  const offenders: string[] = [];
  const overlays: Record<string, number> = {};
  let optionRows = 0;
  for (const match of stripped.matchAll(new RegExp(`<(${CONTAINER_TAGS.join("|")})\\b`, "g"))) {
    const tag = match[1];
    if (NATIVELY_INTERACTIVE.has(tag)) continue;
    const start = match.index ?? 0;
    const attrs = openingTagAt(stripped, start);
    if (!attrs || !/\bonClick[=:{]/.test(attrs)) continue;
    if (/\brole[=:]/.test(attrs) && /\btabIndex[=:{]/.test(attrs) && /\bonKeyDown[=:{]/.test(attrs)) continue;
    if (attrs.includes("clickableRowProps(")) continue;
    // listbox 的 option：可聚焦 + 有选中态就够了，Enter / 方向键在外层
    if (/role="option"/.test(attrs) && /\btabIndex[=:{]/.test(attrs) && /aria-selected[=:{]/.test(attrs)) {
      optionRows += 1;
      continue;
    }
    if (isOverlay(attrs)) {
      overlays[relPath] = (overlays[relPath] ?? 0) + 1;
      continue;
    }
    const preview = attrs.replace(/\s+/g, " ").slice(0, 90);
    offenders.push(`${relPath}:${lineOf(stripped, start)} ${preview}`);
  }
  return { offenders, overlays, optionRows };
}

function scanAll(): ScanResult {
  const offenders: string[] = [];
  const overlays: Record<string, number> = {};
  let optionRows = 0;
  sourceFiles().forEach((rel) => {
    const result = scanFile(rel, readScannedSource(rel));
    offenders.push(...result.offenders);
    optionRows += result.optionRows;
    Object.entries(result.overlays).forEach(([file, count]) => {
      overlays[file] = (overlays[file] ?? 0) + count;
    });
  });
  return { offenders, overlays, optionRows };
}

/** 用了 option 语义却没把按键交给外层 listbox 的文件——这些行照样按不动。 */
function optionRowsWithoutListbox(): string[] {
  const bad: string[] = [];
  sourceFiles().forEach((rel) => {
    const stripped = readScannedSource(rel);
    if (!OPTION_SELECTOR_RE.test(stripped)) return;
    OPTION_SELECTOR_RE.lastIndex = 0;
    if (!/role="listbox"/.test(stripped) || !/\bonKeyDown[=:{]/.test(stripped)) {
      bad.push(`${rel} 有 role="option" 的行，却找不到 role="listbox" 与接管按键的 onKeyDown`);
    }
  });
  return bad;
}

const CSS = readFileSync(join(PROJECT_ROOT, "src/styles.css"), "utf8");

/** 该行的 :focus-visible 里有没有真的画 outline（注释先换成等长空白，别拿说明文字当证据）。 */
function focusRingFor(rowClass: string): boolean {
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const pattern = new RegExp(`(?:^|[,{}\\s])\\${rowClass}:focus-visible[^{]*\\{([^}]*)\\}`, "m");
  const found = css.match(pattern);
  if (!found) return false;
  // 写了 outline 但值是 none 等于没写（回溯陷阱：不能用 (?!none) 直接否定）
  return /outline:/.test(found[1]) && !/outline:\s*none\b/.test(found[1]);
}

describe("整行可点的容器必须有键盘出口", () => {
  it("基线之外，挂 onClick 的容器必须自带三件套或 spread clickableRowProps", () => {
    const found = scanAll().offenders;
    expect(
      found,
      `这些行鼠标能点、键盘选不中。补 role + tabIndex + onKeyDown，或直接 spread clickableRowProps()：\n${found.join("\n")}`
    ).toEqual([]);
  });

  it("遮罩豁免按文件计配额，只减不增", () => {
    const found = scanAll().overlays;
    Object.entries(OVERLAY_QUOTA).forEach(([file, count]) => {
      expect(found[file] ?? 0, `${file} 的遮罩/弹层豁免数量变了，请同步基线（只许减）`).toBe(count);
    });
    const extra = Object.entries(found).filter(([file]) => !(file in OVERLAY_QUOTA));
    expect(extra, "新出现的遮罩豁免要连同理由一起登记").toEqual([]);
  });

  it("拿遮罩当借口的文件必须注册了 Esc 兜底", () => {
    Object.keys(OVERLAY_QUOTA).forEach((file) => {
      expect(readScannedSource(file), `${file} 已经不用 useEscape 了，遮罩不能再免键盘`).toContain("useEscape");
    });
  });

  it('role="option" 的行必须由外层 listbox 接管按键', () => {
    const found = optionRowsWithoutListbox();
    expect(found, `配置浏览那套漫游焦点是行上只写 tabIndex、按键交给容器；照抄这套才免写 onKeyDown：\n${found.join("\n")}`).toEqual([]);
    expect(scanAll().optionRows, "配置浏览的 option 行要是没了，这条用例就是在空转").toBeGreaterThan(0);
  });

  it("能被 Tab 到达的行类必须有可见焦点环", () => {
    FOCUSABLE_ROW_CLASSES.forEach((rowClass) => {
      expect(focusRingFor(rowClass), `${rowClass} 缺 :focus-visible 焦点环，键盘焦点落在看不见的地方`).toBe(true);
    });
  });
});

describe("守卫自己：fixture 反例必须能被抓到", () => {
  it("挂 onClick 的裸 div 会被判违规", () => {
    expect(scanFile("x.tsx", `<div className="row" onClick={() => pick()}>`).offenders.length).toBe(1);
  });

  it("三件套齐了放过", () => {
    const src = `<div className="row" onClick={() => pick()} role="button" tabIndex={0} onKeyDown={onKey}>`;
    expect(scanFile("x.tsx", src).offenders).toEqual([]);
  });

  it("只补 role 不补 tabIndex 仍然违规（缺一等于键盘照样进不来）", () => {
    const src = `<div className="row" onClick={() => pick()} role="button" onKeyDown={onKey}>`;
    expect(scanFile("x.tsx", src).offenders.length).toBe(1);
  });

  it("spread clickableRowProps 放过", () => {
    const src = `<div className="row" onClick={() => pick()} {...clickableRowProps(() => pick())}>`;
    expect(scanFile("x.tsx", src).offenders).toEqual([]);
  });

  it("原生可交互元素与带 href 的链接不归这条守卫管", () => {
    expect(scanFile("x.tsx", `<button className="row" onClick={() => pick()}>`).offenders).toEqual([]);
    expect(scanFile("x.tsx", `<label className="row" onClick={() => pick()}>`).offenders).toEqual([]);
    expect(scanFile("x.tsx", `<a href="/x" onClick={() => pick()}>`).offenders).toEqual([]);
  });

  it("遮罩放过但计入配额", () => {
    const result = scanFile("y.tsx", `<div className="modal-overlay" onClick={onClose}>`);
    expect(result.offenders).toEqual([]);
    expect(result.overlays["y.tsx"]).toBe(1);
  });

  it("非遮罩的普通弹层不豁免", () => {
    expect(scanFile("y.tsx", `<div className="drawer-panel" onClick={onClose}>`).offenders.length).toBe(1);
  });

  it('role="option" + tabIndex + aria-selected 的行放过', () => {
    const src = `<div role="option" aria-selected={active} tabIndex={-1} onClick={() => open(item)}>`;
    const result = scanFile("x.tsx", src);
    expect(result.offenders).toEqual([]);
    expect(result.optionRows).toBe(1);
  });

  it("option 行漏了 aria-selected 就判违规", () => {
    const src = `<div role="option" tabIndex={-1} onClick={() => open(item)}>`;
    expect(scanFile("x.tsx", src).offenders.length).toBe(1);
  });

  it("焦点环守卫认得出 outline 与没有 outline 的区别", () => {
    expect(focusRingFor(".browser-item")).toBe(true);
    expect(focusRingFor(".this-class-does-not-exist")).toBe(false);
  });
});
