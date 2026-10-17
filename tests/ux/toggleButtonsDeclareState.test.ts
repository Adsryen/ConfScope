/**
 * 开关与折叠按钮必须把自己的状态播报给辅助技术（轮18 波43 R69）。
 *
 * 背景：全库只有 Combobox / Select 用了 aria-expanded，role="switch" 与 aria-checked 一处都没有，
 * aria-pressed 只有 DiffView 一处。密码显隐、筛选片、排序、原始视图、消息中心浮层、来源面板折叠
 * 这些按钮点下去只是换图标和 className，读屏用户听完标签仍然不知道「现在是开着还是关着」。
 *
 * 为什么守卫自己也要带一套解析器：之前扫描用 `<button\b([^<>]*)>` 抓属性区，
 * 而 `onClick={() => setOpen(!v)}` 里的箭头 `=>` 含 `>`，属性区在第一个 `>` 处就被截断，
 * 于是「图标按钮缺 aria-label = 0 处」「布尔翻转按钮 = 0 处」这类假阴性连续出了两轮。
 * 这里改成按 `{}` 深度扫描，并留一条自证用例（见 describe 末尾），防止守卫被同样的粗匹配替代。
 */
import { describe, expect, it } from "vitest";
import { loadLocale, readScannedSource, sourceFiles } from "./scanUtils";

interface ButtonSite {
  line: number;
  attrs: string;
}

/** 按 `{}` 深度扫属性区：只有深度为 0 的 `>` 才算标签结束。 */
function buttonSites(source: string): ButtonSite[] {
  const sites: ButtonSite[] = [];
  const opener = /<button\b/g;
  let m: RegExpExecArray | null;
  while ((m = opener.exec(source))) {
    let i = m.index + m[0].length;
    let depth = 0;
    const buf: string[] = [];
    while (i < source.length) {
      const ch = source[i];
      if (depth === 0 && ch === "/" && source[i + 1] === ">") break;
      if (depth === 0 && ch === ">") break;
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      buf.push(ch);
      i += 1;
    }
    sites.push({ line: source.slice(0, m.index).split("\n").length, attrs: buf.join("") });
  }
  return sites;
}

/** 取出 onClick={...} 的表达式体（同样按深度配对花括号）。 */
function onClickExpr(attrs: string): string {
  const start = attrs.indexOf("onClick={");
  if (start < 0) return "";
  let i = start + "onClick={".length;
  let depth = 1;
  const buf: string[] = [];
  while (i < attrs.length && depth > 0) {
    const ch = attrs[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
    buf.push(ch);
    i += 1;
  }
  return buf.join("");
}

/** 布尔翻转：setX(v => !v) / setX(!x) / toggleX(...)。 */
const FLIP = /set[A-Z]\w*\(\s*(?:\(\s*\w+\s*\)\s*=>\s*!|\s*!)|(?:toggle|flip)[A-Z]\w*\(/;
const STATE_ATTR = /aria-(?:pressed|expanded)=|role="switch"|aria-checked=/;

/** 波43 修掉的 13 处站点：文件 + 必须出现的那条属性表达式（取值必须来自组件现有状态）。 */
const FIXED_SITES: Array<[string, string]> = [
  ["src/components/AuditView.tsx", "aria-expanded={showSettings}"],
  ["src/components/AuditView.tsx", "aria-pressed={statusFilter.has(status)}"],
  ["src/components/AuditView.tsx", "aria-pressed={sortKey === key}"],
  ["src/components/ConnectionManager.tsx", "aria-pressed={showPwd}"],
  ["src/components/ConnectionManager.tsx", "aria-pressed={showSSHPwd}"],
  ["src/components/ConnectionManager.tsx", "aria-pressed={showSSHPassphrase}"],
  ["src/components/ConnectionManager.tsx", "aria-expanded={showSSHConfig}"],
  ["src/components/DiffView.tsx", "aria-expanded={!sourcesCollapsed}"],
  ["src/components/HistoryView.tsx", "aria-pressed={!rawView}"],
  ["src/components/MessageCenter.tsx", "aria-expanded={open}"],
];

const DISCLOSURE_FILES = [
  "src/components/AuditView.tsx",
  "src/components/ConnectionManager.tsx",
  "src/components/DiffView.tsx",
  "src/components/MessageCenter.tsx",
];

function scannedTsx(): string[] {
  return sourceFiles()
    .map((f) => f.replace(/\\/g, "/"))
    .filter((f) => f.endsWith(".tsx"));
}

describe("布尔翻转按钮必须声明状态（R69 守卫）", () => {
  it("全库不存在「点一下只翻布尔、却不告诉辅助技术状态」的按钮", () => {
    const violations: string[] = [];
    for (const rel of scannedTsx()) {
      const source = readScannedSource(rel);
      for (const site of buttonSites(source)) {
        if (site.attrs.includes("aria-label={") && !site.attrs.includes("onClick")) continue;
        if (!FLIP.test(onClickExpr(site.attrs))) continue;
        if (STATE_ATTR.test(site.attrs)) continue;
        violations.push(`${rel}:${site.line}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("波43 的站点逐个钉住，属性值来自组件状态而非常量占位", () => {
    for (const [rel, attr] of FIXED_SITES) {
      const source = readScannedSource(rel);
      expect(source, `${rel} 应当包含 ${attr}`).toContain(attr);
    }
    // 常量占位（aria-pressed={true} / aria-expanded={false}）等于永远说谎
    for (const rel of scannedTsx()) {
      expect(readScannedSource(rel)).not.toMatch(/aria-(?:pressed|expanded)=\{(?:true|false)\}/);
    }
  });

  it("密码显隐按钮：label 固定描述动作，状态只由 aria-pressed 承担", () => {
    const source = readScannedSource("src/components/ConnectionManager.tsx");
    const toggles = buttonSites(source).filter((s) => s.attrs.includes('className="pwd-toggle"'));
    expect(toggles).toHaveLength(6);
    for (const site of toggles) {
      // 带三元运算的 label 会和 aria-pressed 打架：读屏会听到「隐藏，已按下」这种自相矛盾的播报
      expect(site.attrs).toContain('aria-label={t("connection.revealPassword")}');
      expect(site.attrs).not.toMatch(/aria-label=\{[^}]*\?/);
      expect(site.attrs).toMatch(/aria-pressed=\{/);
    }
  });

  it("展开/收起一块内容的按钮用 aria-expanded，不许混用 aria-pressed", () => {
    const pairs: Array<[string, string]> = [
      ["src/components/AuditView.tsx", "aria-expanded={showSettings}"],
      ["src/components/ConnectionManager.tsx", "aria-expanded={showSSHConfig}"],
      ["src/components/DiffView.tsx", "aria-expanded={!sourcesCollapsed}"],
      ["src/components/MessageCenter.tsx", "aria-expanded={open}"],
    ];
    for (const [rel, attr] of pairs) {
      expect(DISCLOSURE_FILES).toContain(rel);
      const source = readScannedSource(rel);
      const site = buttonSites(source).find((s) => s.attrs.includes(attr));
      expect(site, `${rel} 应当有带 ${attr} 的按钮`).toBeTruthy();
      expect(site!.attrs).not.toMatch(/aria-pressed=/);
    }
  });

  it("zh / en 两份 locale 都有密码显隐的动作文案", () => {
    for (const file of ["zh-CN.json", "en-US.json"]) {
      // loadLocale 返回摊平后的 key -> 文案映射，键名带命名空间前缀
      const flat = loadLocale(file);
      expect(flat["connection.revealPassword"], `${file} 缺 connection.revealPassword`).toBeTruthy();
      expect(flat["connection.revealPassword"]).not.toMatch(/[?{}]/);
    }
  });

  it("解析器自证：箭头函数里的 > 不会截断属性区（粗匹配会漏，深度扫描不漏）", () => {
    const fixture =
      '  <button\n    className="pwd-toggle"\n    onClick={() => setOpen((v) => !v)}\n    aria-pressed={open}\n  >\n    eye\n  </button>';
    const [site] = buttonSites(fixture);
    // 粗匹配 [^<>]* 在 `() =>` 的 > 处就停了，既看不到 onClick 尾部，也看不到 aria-pressed
    const naive = /<button\b([^<>]*)>/.exec(fixture);
    expect(naive?.[1] ?? "").not.toContain("aria-pressed");
    expect(site.attrs).toContain("aria-pressed={open}");
    expect(FLIP.test(onClickExpr(site.attrs))).toBe(true);
    expect(STATE_ATTR.test(site.attrs)).toBe(true);
  });

  it("永远达不到的下限：布尔翻转的判定本身不是空集（防止正则退化让守卫假绿）", () => {
    const hits: number[] = [];
    for (const rel of scannedTsx()) {
      const source = readScannedSource(rel);
      for (const site of buttonSites(source)) {
        if (FLIP.test(onClickExpr(site.attrs))) hits.push(1);
      }
    }
    expect(hits.length).toBeGreaterThan(12);
  });
});
