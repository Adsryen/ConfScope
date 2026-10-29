/**
 * 弹层必须是真 dialog，还要带焦点陷阱（R38 / 轮9 波19）。
 *
 * 为什么要静态守：`.modal` 只是个带阴影的 div。读屏不会把它当成对话框播报，
 * 屏幕阅读器用户听不到「进入弹层」，Tab 一路走到被遮住的背景里去改别的表单，
 * 再按 Esc 关掉的可能是背景那一层——这是所有弹层共有的三个缺陷，
 * 复制粘贴一个漏配的新弹层只需要十行代码，所以把「面板 = dialog 语义 + 陷阱」钉死在这里。
 *
 * 口径说明：
 * - 面板 = class 词元里**恰好**出现 `modal`（`.modal-overlay`/`.modal-header` 这类复合名不算），
 *   或者 `startup-dialog`（应用启动那一层用的是 section，不套 .modal 类）。
 * - 陷阱的认定不只看文件里 import 了 useDialogFocus，而是要求这个面板的 `ref`
 *   确实被某个 `containerRef: <同名>` 用到——不然会出现「面板 A 有陷阱、面板 B 蹭过去」的假绿。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource, sourceFiles } from "./scanUtils";

/** 弹层面板的应有语义：role、aria-modal、指向本文件内某处的 label、被 containerRef 引用的 ref。 */
interface Panel {
  file: string;
  line: number;
  tag: string;
  className: string;
  role: string;
  ariaModal: string;
  ariaLabel: string;
  ariaLabelledby: string;
  refName: string;
}

/** 已登记的面板：新增弹层不在这里登记就会红（漏语义也是红），删掉一个也红。 */
const REGISTERED: string[] = [
  "src/components/About.tsx#modal about-modal",
  "src/components/AlertModal.tsx#modal modal-sm",
  "src/components/ConfirmModal.tsx#modal modal-sm",
  "src/components/ConfigBrowser.tsx#modal modal-md browser-replace-modal",
  "src/components/ConfigBrowser.tsx#modal modal-md browser-target-modal",
  "src/components/ConfigEditor.tsx#modal modal-lg",
  "src/components/ConnectionManager.tsx#modal",
  "src/components/DeleteConfirm.tsx#modal modal-sm",
  "src/components/ErrorDialog.tsx#modal modal-error",
  // r136：第三步「人工微调」与第四步「编辑目标内容」共用的长文本弹层外壳。
  // 它自己不含 CodeEditor，正文由宿主经 children 传进来，所以陷阱与 dialog 语义必须在壳上过一次。
  "src/components/EditorDialog.tsx#modal modal-editor",
  "src/components/StartupDialog.tsx#startup-dialog",
];

/** class 词元：模板串里的 `${...}` 与引号都不是类名的一部分，先抹掉再按空白切。 */
function classTokens(value: string): string[] {
  return value
    .replace(/['"`]/g, " ")
    .replace(/\$\{[^}]*\}/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function isPanelClass(value: string): boolean {
  const tokens = classTokens(value);
  return tokens.includes("modal") || tokens.includes("startup-dialog");
}

/** 剥掉注释后扫描 JSX 开标签，返回属性表。只处理 src 里实际存在的写法（无跨行泛型标签）。 */
function openingTags(src: string): { tag: string; attrs: Map<string, string>; index: number }[] {
  const found: { tag: string; attrs: Map<string, string>; index: number }[] = [];
  for (const m of src.matchAll(/<([a-z][\w-]*)/g)) {
    const body = readTagBody(src, m.index + m[0].length);
    if (body) found.push({ tag: m[1], attrs: parseAttrs(body.text), index: m.index });
  }
  return found;
}

/** 从属性区起点扫到本标签的 `>`（跳过字符串与 `{}` 里的内容），返回属性文本。 */
function readTagBody(src: string, from: number): { text: string; end: number } | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === ">" && depth === 0) return { text: src.slice(from, i), end: i };
    else if (ch === "<" && depth === 0) return null; // 属性里出现下一个标签：这不是合法开标签
  }
  return null;
}

/** 属性表：`foo` → "true"，`foo="bar"` → "bar"，`foo={x}` → "x"（外层括号已剥）。 */
function parseAttrs(body: string): Map<string, string> {
  const attrs = new Map<string, string>();
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i += 1;
    const name = /^[A-Za-z_$][\w$]*(?:[-:][\w$]+)*/.exec(body.slice(i));
    if (!name) break;
    i += name[0].length;
    let eq = i;
    while (eq < body.length && /\s/.test(body[eq])) eq += 1;
    if (body[eq] !== "=") {
      attrs.set(name[0], "true");
      continue;
    }
    let v = eq + 1;
    while (v < body.length && /\s/.test(body[v])) v += 1;
    let end = v;
    if (body[v] === '"' || body[v] === "'" || body[v] === "`") {
      const q = body[v];
      end = body.indexOf(q, v + 1) + 1;
      if (end === 0) break;
      attrs.set(name[0], body.slice(v + 1, end - 1));
    } else if (body[v] === "{") {
      let depth = 0;
      let quote: string | null = null;
      for (; end < body.length; end += 1) {
        const ch = body[end];
        if (quote) {
          if (ch === "\\") end += 1;
          else if (ch === quote) quote = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") quote = ch;
        else if (ch === "{") depth += 1;
        else if (ch === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      attrs.set(name[0], body.slice(v + 1, end).trim());
      end += 1; // 跳过收尾的右花括号，否则下一轮把它当成属性名开头
    } else break;
    i = end;
  }
  return attrs;
}

function refNameOf(value: string | undefined): string {
  if (!value) return "";
  const m = /^(?:[A-Za-z_$][\w$]*|{[^}]*})$/.exec(value.trim());
  return m ? value.trim() : "";
}

function panelsIn(relPath: string, src = readScannedSource(relPath)): { panel: Panel; traps: string[] }[] {
  const traps = Array.from(src.matchAll(/containerRef:\s*([A-Za-z_$][\w$]*)/g), (t) => t[1]);
  const out: { panel: Panel; traps: string[] }[] = [];
  for (const { tag, attrs, index } of openingTags(src)) {
    const className = attrs.get("className");
    if (!className || !isPanelClass(className)) continue;
    out.push({
      panel: {
        file: relPath,
        line: src.slice(0, index).split("\n").length,
        tag,
        className: classTokens(className).join(" "),
        role: attrs.get("role") ?? "",
        ariaModal: attrs.get("aria-modal") ?? "",
        ariaLabel: attrs.get("aria-label") ?? "",
        ariaLabelledby: attrs.get("aria-labelledby") ?? "",
        refName: refNameOf(attrs.get("ref")),
      },
      traps,
    });
  }
  return out;
}

function allPanels(): { panel: Panel; traps: string[] }[] {
  return sourceFiles()
    .filter((f) => f.endsWith(".tsx"))
    .flatMap((f) => panelsIn(f));
}

/** 语义齐不齐：缺什么列什么，报错直接可读。 */
function violations(entry: { panel: Panel; traps: string[] }, src: string): string[] {
  const { panel, traps } = entry;
  const bad: string[] = [];
  if (panel.role !== "dialog") bad.push(`缺 role="dialog"（现在是「${panel.role || "无"}」），读屏不会播报这是对话框`);
  if (panel.ariaModal !== "true") bad.push(`缺 aria-modal="true"（现在是「${panel.ariaModal || "无"}」），背景内容不会被屏蔽`);
  if (!panel.ariaLabel && !panel.ariaLabelledby) bad.push("既没有 aria-label 也没有 aria-labelledby，弹层没有可播报的标题");
  if (panel.ariaLabelledby) {
    const id = panel.ariaLabelledby.trim();
    const exists = src.includes(`id="${id}"`) || src.includes(`id={${id}}`);
    if (!exists) bad.push(`aria-labelledby 指向的「${id}」在这个文件里找不到对应 id，标题念不出来`);
  }
  if (!panel.refName) bad.push("面板本体没有 ref，焦点陷阱无从挂上去");
  else if (!traps.includes(panel.refName)) bad.push(`没有 useDialogFocus 用 containerRef: ${panel.refName}，Tab 会逃到被遮住的背景`);
  return bad;
}

function offenders() {
  return allPanels()
    .map((entry) => ({ entry, bad: violations(entry, readScannedSource(entry.panel.file)) }))
    .filter((row) => row.bad.length > 0);
}

describe("每个弹层面板都要有 dialog 语义和焦点陷阱", () => {
  it("src 里的弹层没有缺语义或缺陷阱的", () => {
    const found = offenders();
    const report = found.map(
      (row) => `${row.entry.panel.file}:L${row.entry.panel.line} .${row.entry.panel.className}\n    - ${row.bad.join("\n    - ")}`
    );
    expect(report, `这些弹层对键盘和读屏还是透明的：\n${report.join("\n")}`).toEqual([]);
  });

  it("面板总数与登记表一致：新增要登记，漏一个也要响", () => {
    const keys = allPanels()
      .map((row) => `${row.panel.file}#${row.panel.className}`)
      .sort();
    expect(keys, "弹层面板数量与登记表不符（新增的 .modal 请先加进 REGISTERED 并补语义）").toEqual([...REGISTERED].sort());
  });

  it("登记表不为空，命中量要够（守卫别退化成永真）", () => {
    expect(allPanels().length).toBeGreaterThanOrEqual(10);
  });
});

describe("守卫自己：反例必须能被抓到", () => {
  const GOOD = `<div ref={m} className="modal modal-sm" role="dialog" aria-modal="true" aria-labelledby={t}><h3 id={t}>标题</h3></div>; useDialogFocus({ active, containerRef: m });`;

  it("合格的弹层不报", () => {
    const rows = panelsIn("x.tsx", GOOD);
    expect(rows).toHaveLength(1);
    expect(violations(rows[0], GOOD)).toEqual([]);
  });

  it("遮罩和头部不会被误当面板", () => {
    expect(panelsIn("x.tsx", `<div className="modal-overlay"><div className="modal-header"><h3>a</h3></div></div>`)).toHaveLength(0);
  });

  it("剥掉 role 判违规", () => {
    const src = GOOD.replace(' role="dialog"', "");
    expect(violations(panelsIn("x.tsx", src)[0], src).join("|")).toContain('role="dialog"');
  });

  it("剥掉 aria-modal 判违规", () => {
    const src = GOOD.replace(' aria-modal="true"', "");
    expect(violations(panelsIn("x.tsx", src)[0], src).join("|")).toContain('aria-modal="true"');
  });

  it("没有标题判违规", () => {
    const src = GOOD.replace(" aria-labelledby={t}", "");
    expect(violations(panelsIn("x.tsx", src)[0], src).join("|")).toContain("aria-labelledby");
  });

  it("aria-labelledby 指向不存在的 id 判违规", () => {
    const src = GOOD.replace("<h3 id={t}>标题</h3>", "<h3>标题</h3>");
    expect(violations(panelsIn("x.tsx", src)[0], src).join("|")).toContain("找不到对应 id");
  });

  it("面板有 ref 但没人拿它当 containerRef 判违规", () => {
    const src = GOOD.replace("containerRef: m", "containerRef: other");
    expect(violations(panelsIn("x.tsx", src)[0], src).join("|")).toContain("containerRef: m");
  });

  it("整个弹层没有 ref 判违规", () => {
    const src = GOOD.replace(" ref={m}", "");
    expect(violations(panelsIn("x.tsx", src)[0], src).join("|")).toContain("没有 ref");
  });

  it("新加一个无语义的面板判违规", () => {
    const src = `${GOOD}\n<div className="modal modal-md"><h3>x</h3></div>`;
    const rows = panelsIn("x.tsx", src);
    expect(rows).toHaveLength(2);
    expect(violations(rows[1], src).length).toBeGreaterThanOrEqual(4);
  });
});
