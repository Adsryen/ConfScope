/**
 * 守卫：每个输入控件都要有「不会消失的名字」（轮10 R40）。
 *
 * 现象：全站 111 个 input/textarea/select 里，5 个完全没名字、10 个只写了 placeholder、
 * 1 个 checkbox 只写了 title。读屏走到这些框只能念「编辑框」，用户听不出这是搜配置的、
 * 筛连接的，还是确认删除的。placeholder 在输入第一个字符时就消失，title 只在鼠标悬停时
 * 出现，两者都撑不起「名字」这个职责——所以本守卫明确不认它们。
 *
 * 口径（命中任一即合规）：
 * 1. 自己写 `aria-label` / `aria-labelledby`；
 * 2. 同文件里 `id=` 与某个 `<label htmlFor=>` 配成对；
 * 3. 被 `<label>` 包住（HTML 隐式关联）；
 * 4. 经共享组件时（Combobox / NumberField / CodeEditor）：组件本体必须有 `aria-label` 兜底，
 *    调用点要么在 `<label>` 内，要么显式传 `ariaLabel=`。
 *
 * 范围：`type="hidden|submit|button|image|reset"` 不查（按钮的 `value` 自带名字），
 * `checkbox` / `radio` 一律要查——它们是本轮唯一「只剩 title」的漏网类型。
 *
 * 防永真：命中量下限（控件总数、checkbox 数、placeholder 数、各合规来源各自的下限）。
 * 扫描口径漂掉时先在数量上红，而不是让合规判定空转把违规吞掉。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource, sourceFiles } from "./scanUtils";

/** 需要名字的裸标签 */
const CONTROLS = new Set(["input", "textarea", "select"]);
/** 内部自带 input/textarea 的共享组件 */
const SHARED_COMPONENTS = new Set(["Combobox", "NumberField", "CodeEditor"]);
/** 不指望外部给名字的 input 类型 */
const EXEMPT_TYPES = new Set(["hidden", "submit", "button", "image", "reset"]);
/** 共享组件本体必须留着的兜底写法：先取调用方给的名字，再退到 placeholder */
const FALLBACK_RE = /aria-label=\{ariaLabel \?\? placeholder\}/;
/** 兜底写法必须存在的文件 */
const FALLBACK_FILES = ["src/components/Combobox.tsx", "src/components/NumberField.tsx", "src/components/CodeEditor.tsx"];

/** 取开标签的属性文本：花括号/引号里的 `>` 不算结束（`onChange={(e) => x}` 里全是 `>`）。 */
function tagHead(source: string, start: number): { attrs: string; selfClosing: boolean } {
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
    else if (ch === ">" && depth === 0) {
      const body = source.slice(start, i);
      return { attrs: body.replace(/\/$/, ""), selfClosing: /\/$/.test(body) };
    }
  }
  return { attrs: source.slice(start), selfClosing: false };
}

/** 属性字面量值：`x="a"` / `x='a'` / `x={a}` 三种写法统一取出来。 */
function attrValue(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{\\s*([^}]+?)\\s*\\})`).exec(attrs);
  if (!m) return undefined;
  return (m[1] ?? m[2] ?? m[3] ?? "").trim();
}

/** 全文某属性的所有字面量值：用来把 `<label htmlFor=>` 收成配对集合。 */
function allAttrValues(source: string, name: string): Set<string> {
  const acc = new Set<string>();
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{\\s*([^}]+?)\\s*\\})`, "g");
  for (const m of source.matchAll(re)) acc.add((m[1] ?? m[2] ?? m[3] ?? "").trim());
  return acc;
}

interface Site {
  file: string;
  line: number;
  name: string;
  type: string;
  attrs: string;
  /** true = 裸标签，false = 共享组件调用点 */
  isControl: boolean;
  viaAria: boolean;
  viaAssociate: boolean;
  viaLabel: boolean;
  viaProp: boolean;
}

/** 摊平 src 下所有「要名字的站点」：裸标签 + 三个共享组件的调用点，带 label 祖先判定。 */
function scanSites(): Site[] {
  const sites: Site[] = [];
  for (const rel of sourceFiles()) {
    if (!rel.endsWith(".tsx")) continue;
    const source = readScannedSource(rel);
    const labelFors = allAttrValues(source, "htmlFor");
    const stack: string[] = [];
    for (const m of source.matchAll(/<(\/?)([A-Za-z][\w.:-]*)/g)) {
      const name = m[2];
      const at = m.index ?? 0;
      if (m[1]) {
        // 闭合标签：回退到同名开标签，中间的元素一并出栈
        for (let i = stack.length - 1; i >= 0; i -= 1) {
          if (stack[i] === name) {
            stack.length = i;
            break;
          }
        }
        continue;
      }
      const head = tagHead(source, at + m[0].length);
      if (CONTROLS.has(name) || SHARED_COMPONENTS.has(name)) {
        const type = attrValue(head.attrs, "type") ?? "";
        if (!(name === "input" && EXEMPT_TYPES.has(type))) {
          const controlId = attrValue(head.attrs, "id");
          sites.push({
            file: rel,
            line: source.slice(0, at).split("\n").length,
            name,
            type,
            attrs: head.attrs,
            isControl: CONTROLS.has(name),
            viaAria: /(?:^|\s)aria-(label|labelledby)\s*=/.test(head.attrs),
            viaAssociate: controlId !== undefined && controlId !== "" && labelFors.has(controlId),
            viaLabel: stack.includes("label"),
            viaProp: /(?:^|\s)ariaLabel\s*=/.test(head.attrs),
          });
        }
      }
      if (!head.selfClosing && !CONTROLS.has(name)) stack.push(name);
    }
  }
  return sites;
}

function where(site: Site): string {
  return `${site.file}:${site.line} <${site.name}${site.type ? ` type="${site.type}"` : ""}>`;
}

function hasName(site: Site): boolean {
  return site.viaAria || site.viaAssociate || site.viaLabel || site.viaProp;
}

describe("输入控件必须有不消失的可访问名", () => {
  const sites = scanSites();
  const controls = sites.filter((s) => s.isControl);
  const components = sites.filter((s) => !s.isControl);
  const unnamed = sites.filter((s) => !hasName(s));
  const placeholderOnly = controls.filter(
    (s) => attrValue(s.attrs, "placeholder") !== undefined && !s.viaAria && !s.viaAssociate && !s.viaLabel
  );
  const titleOnly = sites.filter((s) => attrValue(s.attrs, "title") !== undefined && !s.viaAria && !s.viaProp);
  const checkboxRadio = controls.filter((s) => s.type === "checkbox" || s.type === "radio");

  it("扫描要有命中量（口径漂了先在这里红）", () => {
    expect(controls.length).toBeGreaterThanOrEqual(110);
    expect(components.length).toBeGreaterThanOrEqual(9);
    expect(checkboxRadio.length).toBeGreaterThanOrEqual(20);
    // placeholder 是最容易被误当名字的来源，命中量要够，否则「placeholder 不算名字」那条会空转
    // 45 → 44：轮48 把浏览态 / 编辑态两份重复的查找输入框抽成 FindBar 一份（少一处 placeholder）。
    expect(controls.filter((s) => attrValue(s.attrs, "placeholder") !== undefined).length).toBeGreaterThanOrEqual(44);
  });

  it("不许有没有名字的输入控件或共享组件调用点", () => {
    expect(unnamed.map(where).join("\n")).toBe("");
  });

  it("placeholder 不能单独当名字", () => {
    expect(placeholderOnly.map(where).join("\n")).toBe("");
  });

  it("title 不能单独当名字（波21 修掉的 LanguageSwitch / HistoryView 不许退回）", () => {
    expect(titleOnly.map(where).join("\n")).toBe("");
  });

  it("三种命名来源各自都要真有命中，不许全靠一条分支兜住", () => {
    expect(controls.filter((s) => s.viaAria).length).toBeGreaterThanOrEqual(18);
    expect(controls.filter((s) => s.viaAssociate && !s.viaAria).length).toBeGreaterThanOrEqual(4);
    expect(controls.filter((s) => s.viaLabel && !s.viaAria && !s.viaAssociate).length).toBeGreaterThanOrEqual(80);
    // label 包裹不能是全站唯一来源，否则 htmlFor 配对那条判定早就漂了
    expect(controls.filter((s) => s.viaLabel).length).toBeLessThan(controls.length);
  });

  it("共享组件本体必须留着 aria-label 兜底，只许改好不许删", () => {
    const missing = FALLBACK_FILES.filter((file) => !FALLBACK_RE.test(readScannedSource(file)));
    expect(missing.join("\n")).toBe("");
  });

  it("共享组件调用点必须命名：在 <label> 内或显式传 ariaLabel=", () => {
    const naked = components.filter((s) => !s.viaLabel && !s.viaProp && !s.viaAria);
    expect(naked.map(where).join("\n")).toBe("");
    const counts: Record<string, number> = {};
    for (const s of components) counts[s.name] = (counts[s.name] ?? 0) + 1;
    // 数量钉死：加调用点要先把名字写好，再回来把数字改上去
    expect(counts).toEqual({ Combobox: 2, NumberField: 4, CodeEditor: 3 });
  });
});
