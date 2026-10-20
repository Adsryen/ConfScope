/**
 * 「正文视图」分段控件必须说实话（轮49 R49-03）。
 *
 * 缺陷长什么样（真机取证见 .trellis/tasks/10-20-ui-ux-49/prd.md）：`.content-box-head` 里原本只有
 * 一颗按钮，它同时改文案、改 active、改 aria-pressed，而三者指向的是**另一个**视图——
 * 屏幕上显示「高亮变更」时，按钮上写着「原始内容」却是按下态，读屏念出
 * 「原始内容，已按下」，把人指到了一个根本没显示的东西；看不见颜色的人还会以为
 * 按下态=当前视图，点一下反而把自己刚看到的视图关掉。
 *
 * 修法是拆成两颗**恒定命名**的按钮：哪个视图在屏上，按下态就在同名那颗上。
 * 这类「四者同向」的不变式光靠肉眼最容易退回单颗切换按钮，所以守卫把它拆成四根指针钉死：
 *   按钮名（labelKey）↔ 按下态（aria-pressed 极性）↔ 视觉态（class 里的 " active" 落在哪个分支）
 *   ↔ 点下去写入的值（setRawView(true|false)）↔ 那个值下真正在屏的组件（CodeView / UnifiedDiff）。
 * 少钉任意一根都能被改回去：只钉文案就允许「文案对、按下态反」；只钉按下态就允许
 * 按下态对、在屏分支被调换。故守卫实现成一个纯函数 `viewModeViolations`，
 * 自检用例逐条退回旧写法，确认每一根指针都真的在挡（见 describe 末尾）。
 *
 * 注释一律剥掉再算（与 scanUtils 同一口径），否则注释里抄着的类名会被当成实现。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, loadLocale, readScannedSource } from "./scanUtils";

const HISTORY = "src/components/HistoryView.tsx";
const STATE_FLAG = "rawView";
const SETTER = "setRawView";
/** 注释里也写着类名，算之前一律剥掉。 */
const CSS = readFileSync(join(PROJECT_ROOT, "src/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** 真相表：按钮名 ↔ 写入的状态值 ↔ 该值下在屏的组件。 */
const EXPECTED: Array<{ labelKey: string; stateValue: boolean; view: string }> = [
  { labelKey: "history.highlightChanges", stateValue: false, view: "UnifiedDiff" },
  { labelKey: "history.rawContent", stateValue: true, view: "CodeView" },
];

function cssBlock(selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, (ch) => "\\" + ch);
  const found = new RegExp(`${escaped} \\{([^}]*)\\}`, "m").exec(CSS);
  return found ? found[1] : null;
}

/** 从标签名之后扫到属性区结束（深度 0 的 `>`），箭头函数里的 `>` 不能截断。 */
function attrRegion(source: string, afterName: number): { attrs: string; bodyStart: number } | null {
  let i = afterName;
  let depth = 0;
  const buf: string[] = [];
  while (i < source.length) {
    const ch = source[i];
    if (depth === 0 && ch === ">") return { attrs: buf.join("").trim(), bodyStart: i + 1 };
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    buf.push(ch);
    i += 1;
  }
  return null;
}

/** 取 name={...} 的表达式体（同样按花括号深度配对）。 */
function exprOf(attrs: string, name: string): string {
  const key = `${name}={`;
  const start = attrs.indexOf(key);
  if (start < 0) return "";
  let i = start + key.length;
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
  return buf.join("").trim();
}

/** 只认「恒定命名的按钮」：整个按钮体必须恰好是 {t("history.xxx")}，带三元就判不出来说的是谁。 */
function labelKeyOf(body: string): string {
  const found = /^\{\s*t\(\s*"([^"]+)"\s*\)\s*\}$/.exec(body.trim());
  return found ? found[1] : "";
}

function polarity(expr: string): string {
  if (!expr) return "missing";
  if (expr === STATE_FLAG) return "state";
  if (expr === `!${STATE_FLAG}`) return "!state";
  return `other:${expr}`;
}

/** class 里的 " active" 落在三元哪个分支：onTrue = rawView 为真时按下，none = 根本没有按下态。 */
function activePolarity(expr: string): string {
  const found = new RegExp(
    `\\$\\{\\s*${STATE_FLAG}\\s*\\?\\s*"([^"]*)"\\s*:\\s*"([^"]*)"\\s*\\}`
  ).exec(expr);
  if (!found) return /active/.test(expr) ? "static" : "none";
  const onTrue = found[1].includes("active");
  const onFalse = found[2].includes("active");
  if (onTrue && onFalse) return "always";
  if (onTrue) return "onTrue";
  if (onFalse) return "onFalse";
  return "none";
}

/** 点下去写入什么：只许显式常量，翻转（setRawView(!rawView)）等于按钮不知道自己在说谁。 */
function setterValue(expr: string): string {
  if (!expr) return "missing";
  const found = new RegExp(`\\b${SETTER}\\(\\s*(true|false)\\s*\\)`).exec(expr);
  if (found) return found[1];
  if (new RegExp(`\\b${SETTER}\\(\\s*(?:\\(\\s*\\w+\\s*\\)\\s*=>\\s*!|\\s*!)`).test(expr)) return "flip";
  return "other";
}

/** 那颗 .view-mode 容器的属性区与内部片段（按 <div>/</div> 配对，不靠第一个 </div> 侥幸）。 */
function groupSpan(source: string): { attrs: string; body: string } | null {
  const at = source.indexOf('className="view-mode"');
  if (at < 0) return null;
  const openTag = source.lastIndexOf("<div", at);
  if (openTag < 0) return null;
  const region = attrRegion(source, openTag + 4);
  if (!region) return null;
  let depth = 0;
  let i = region.bodyStart;
  while (i < source.length) {
    if (source.startsWith("</div>", i)) {
      if (depth === 0) break;
      depth -= 1;
      i += 6;
      continue;
    }
    if (source.startsWith("<div", i)) {
      depth += 1;
      i += 4;
      continue;
    }
    i += 1;
  }
  return { attrs: region.attrs, body: source.slice(region.bodyStart, i) };
}

interface ButtonFacts {
  line: number;
  labelKey: string;
  pressed: string;
  active: string;
  sets: string;
  isButtonType: boolean;
}

function buttonFacts(body: string): ButtonFacts[] {
  const out: ButtonFacts[] = [];
  const opener = /<button\b/g;
  let m: RegExpExecArray | null;
  while ((m = opener.exec(body))) {
    const region = attrRegion(body, m.index + m[0].length);
    if (!region) break;
    const end = body.indexOf("</button>", region.bodyStart);
    const attrs = region.attrs;
    out.push({
      line: body.slice(0, m.index).split("\n").length,
      labelKey: labelKeyOf(end < 0 ? "" : body.slice(region.bodyStart, end)),
      pressed: polarity(exprOf(attrs, "aria-pressed")),
      active: activePolarity(exprOf(attrs, "className")),
      sets: setterValue(exprOf(attrs, "onClick")),
      isButtonType: /(^|\s)type="button"/.test(attrs),
    });
  }
  return out;
}

/** 在屏分支：`rawView ? (在屏A) : (在屏B)`，返回两个分支各自渲染的组件名。 */
function screenBranches(source: string): { trueView: string; falseView: string } | null {
  const found = new RegExp(`${STATE_FLAG}\\s*\\?\\s*\\(`).exec(source);
  if (!found) return null;
  const after = source.slice(found.index + found[0].length);
  const split = after.indexOf(") : (");
  if (split < 0) return null;
  const elseStart = split + ") : (".length;
  const first = /<([A-Z][A-Za-z0-9_]*)/.exec(after.slice(0, split))?.[1] ?? "";
  const second = /<([A-Z][A-Za-z0-9_]*)/.exec(after.slice(elseStart))?.[1] ?? "";
  return { trueView: first, falseView: second };
}

function viewModeViolations(source: string): string[] {
  const violations: string[] = [];
  const groupCount = source.split('className="view-mode"').length - 1;
  if (groupCount !== 1) violations.push(`.view-mode 容器应当只有一颗，实际 ${groupCount}`);
  const group = groupSpan(source);
  if (!group) {
    violations.push("找不到 .view-mode 分段控件容器");
    return violations;
  }
  if (!/(^|\s)role="group"/.test(group.attrs)) violations.push(".view-mode 缺 role=\"group\"，两颗按钮读起来不成一个控件");
  const groupLabel = exprOf(group.attrs, "aria-label");
  if (groupLabel !== 't("history.viewMode")') {
    violations.push(`分段控件的组名必须是恒定的 t("history.viewMode")，实际「${groupLabel || "无"}」`);
  }

  const buttons = buttonFacts(group.body);
  if (buttons.length !== EXPECTED.length) {
    violations.push(`分段控件应当有 ${EXPECTED.length} 颗按钮，实际 ${buttons.length}`);
    return violations;
  }
  const branches = screenBranches(source);
  if (!branches) violations.push(`找不到 ${STATE_FLAG} 的在屏分支，无法核对「按钮名 ↔ 屏上视图」`);

  for (const exp of EXPECTED) {
    const hits = buttons.filter((b) => b.labelKey === exp.labelKey);
    if (hits.length !== 1) {
      violations.push(`${exp.labelKey} 应当恰好出现一次（当前 ${hits.length} 次；按钮名不许多态也不许缺席）`);
      continue;
    }
    const btn = hits[0];
    const where = `${exp.labelKey}（容器内第 ${btn.line} 行）`;
    if (!btn.isButtonType) violations.push(`${where} 缺 type="button"，在表单里点它会顺手提交`);
    if (btn.pressed !== (exp.stateValue ? "state" : "!state")) {
      violations.push(`${where} 的 aria-pressed=${btn.pressed}，应指向 ${exp.stateValue}`);
    }
    if (btn.active !== (exp.stateValue ? "onTrue" : "onFalse")) {
      violations.push(`${where} 的 " active" 落在 ${btn.active}，与按下态不同向（视觉与读屏各说一套）`);
    }
    if (btn.sets !== String(exp.stateValue)) {
      violations.push(`${where} 点下去写入 ${btn.sets}，应写入 ${exp.stateValue}`);
    }
    if (branches) {
      const shown = exp.stateValue ? branches.trueView : branches.falseView;
      if (shown !== exp.view) {
        violations.push(`${where} 说自己是 ${exp.view}，但 ${exp.stateValue} 下在屏的是 ${shown || "?"}`);
      }
    }
  }
  const others = buttons.filter((b) => !EXPECTED.some((exp) => exp.labelKey === b.labelKey));
  for (const b of others) violations.push(`分段控件出现未知按钮名「${b.labelKey || "非恒定文案"}」`);
  return violations;
}

describe("历史正文视图分段控件说实话（轮49 R49-03 守卫）", () => {
  const src = readScannedSource(HISTORY);

  it("按钮名 / 按下态 / 视觉态 / 写入值 / 在屏视图五者同向", () => {
    expect(viewModeViolations(src)).toEqual([]);
  });

  it("解析器自证：真的从生产源码里取到两颗按钮，且每根指针都有取值", () => {
    const group = groupSpan(src);
    expect(group).not.toBeNull();
    const buttons = buttonFacts(group!.body);
    expect(buttons).toHaveLength(2);
    for (const btn of buttons) {
      expect(btn.labelKey).toMatch(/^history\./);
      expect(["state", "!state"]).toContain(btn.pressed);
      expect(["onTrue", "onFalse"]).toContain(btn.active);
      expect(["true", "false"]).toContain(btn.sets);
    }
    expect(screenBranches(src)).toEqual({ trueView: "CodeView", falseView: "UnifiedDiff" });
  });

  it("默认落在「高亮变更」，切换的初值不许漂", () => {
    expect(src).toMatch(new RegExp(`const \\[${STATE_FLAG}, ${SETTER}\\] = useState\\(false\\);`));
  });

  it("按下态在 CSS 里真的看得见，而不只是 aria 上说说", () => {
    const shell = cssBlock(".view-mode");
    expect(shell, ".view-mode 容器规则缺失").toBeTruthy();
    expect(shell).toMatch(/display:\s*inline-flex/);
    const active = cssBlock(".view-mode .btn.active");
    expect(active, ".view-mode .btn.active 规则缺失（按下态没样式=按钮在说谎）").toBeTruthy();
    expect(active).toMatch(/color:\s*var\(--text-hi\)/);
    expect(active).toMatch(/background:\s*var\(--bg-active\)/);
    expect(active, "按下态背景透明，等于没有按下态").not.toMatch(/background:\s*(?:transparent|none)/);
  });

  it("中英两份都有组名与两个视图名，互不相同且不写成动作", () => {
    for (const file of ["zh-CN.json", "en-US.json"]) {
      const flat = loadLocale(file);
      const values = ["history.highlightChanges", "history.rawContent", "history.viewMode"].map(
        (key) => flat[key]
      );
      for (const [index, value] of values.entries()) {
        expect(value, `${file} 缺第 ${index} 颗键`).toBeTruthy();
      }
      const [highlight, raw, group] = values as [string, string, string];
      // 组名与按钮名撞车时，读屏会念出「原始内容，组：原始内容」——用户分不清哪个在屏
      expect(new Set([highlight, raw, group]).size, `${file} 三个名称彼此重复`).toBe(3);
      for (const label of [highlight, raw, group]) {
        expect(label, `${file} 的「${label}」把视图写成了动作`).not.toMatch(/切换|查看|Switch|Toggle/i);
      }
    }
  });

  it("不许退回「文案跟着状态改」的单颗按钮", () => {
    expect(src, "文案又开始跟着 rawView 变").not.toMatch(new RegExp(`${STATE_FLAG}\\s*\\?\\s*t\\(`));
    expect(src, "t() 的参数变成动态，等于按钮名不固定").not.toMatch(new RegExp(`t\\(\\s*${STATE_FLAG}`));
    // 旧写法：一颗按钮同时是标签、状态与「另一个视图」的名字
    expect(src).not.toMatch(new RegExp(`aria-label=\\{${STATE_FLAG}`));
    for (const key of ["history.highlightChanges", "history.rawContent"]) {
      expect(src.split(`t("${key}")`).length - 1, `t("${key}") 出现不止一次`).toBe(1);
    }
  });

  it("自检：逐条变异真的被挡住（不是正则空转）", () => {
    const flipped = src.replace('aria-pressed={!rawView}', 'aria-pressed={rawView}');
    expect(flipped, "变异没落进被测文本").not.toBe(src);
    expect(viewModeViolations(flipped), "aria-pressed 极性反转没有被挡住").not.toEqual([]);

    const lostActive = src.replace('${rawView ? "" : " active"}', "");
    expect(lostActive).not.toBe(src);
    expect(viewModeViolations(lostActive), "丢掉 active 视觉态没有被挡住").not.toEqual([]);

    const wrongSetter = src.replace("onClick={() => setRawView(false)}", "onClick={() => setRawView(true)}");
    expect(wrongSetter).not.toBe(src);
    expect(viewModeViolations(wrongSetter), "写入值与按钮名脱钩没有被挡住").not.toEqual([]);

    const lyingLabel = src.replace(
      '{t("history.highlightChanges")}',
      '{rawView ? t("history.highlightChanges") : t("history.rawContent")}'
    );
    expect(lyingLabel).not.toBe(src);
    expect(viewModeViolations(lyingLabel), "文案回到随状态变化没有被挡住").not.toEqual([]);

    // 在屏分支整体搬走：按钮名还在，屏上却换了组件
    const branchless = src.replace(/rawView \?\s*\(\s*<CodeView/, "rawView ? (\n                  <MessageCenter");
    expect(branchless, "分支变异没落进被测文本").not.toBe(src);
    expect(viewModeViolations(branchless), "在屏视图与按钮名不同名没有被挡住").not.toEqual([]);

    const noGroupRole = src.replace('<div className="view-mode" role="group"', '<div className="view-mode"');
    expect(noGroupRole).not.toBe(src);
    expect(viewModeViolations(noGroupRole), "丢掉 role=\"group\" 没有被挡住").not.toEqual([]);

    const flipSetter = src.replace("onClick={() => setRawView(true)}", "onClick={() => setRawView(!rawView)}");
    expect(flipSetter).not.toBe(src);
    expect(viewModeViolations(flipSetter), "退回布尔翻转没有被挡住").not.toEqual([]);

    const swappedViews = src
      .replace(/rawView \?\s*\(\s*<CodeView/, "rawView ? (\n                  <UnifiedDiff")
      .replace(/\)\s*:\s*\(\s*\n\s*<UnifiedDiff/, ")\n                ) : (\n                  <CodeView");
    expect(swappedViews, "分支互换没落进被测文本").not.toBe(src);
    expect(viewModeViolations(swappedViews), "两个视图的分支互换没有被挡住").not.toEqual([]);
  });
});
