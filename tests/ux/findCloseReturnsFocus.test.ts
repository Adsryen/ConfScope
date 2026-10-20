/**
 * 守卫：收起查找栏时，焦点必须回到「被查找的那一层」（轮16 波38 / R62）。
 *
 * 缺陷长什么样：`CodeView.closeFind` 只 `setFindOpen(false)`，查找输入框随卸载一起消失，
 * activeElement 掉回 `document.body`。搜完按 Esc 或点 ✕，接着按方向键 / PageUp / PageDown
 * **代码一动不动**，必须先拿鼠标点一下正文。同族的 `CodeEditor.closeFind` 早就写了
 * `taRef.current?.focus()`——两条出口口径不一致，说明这是漏接而不是设计。
 *
 * 口径（一句话）：**查找结束，焦点回到被查找的那一层**。
 * 1. 每个查找宿主都要能识别「被查找的那一层」：挂着 ref 的只读正文（`.code-area` / `.diff-body` /
 *    `.udiff`）或编辑区（`textarea`）；
 * 2. 凡收起查找栏的出口（`setFindOpen(false)`，且不属于「换内容重置」），所属语句里必须把焦点还给那一层，
 *    按 **ref 名** 校验（含 `const ta = taRef.current` 这种别名）——换成 `tabIndex={-1}` 的根节点等于没还；
 * 3. 「换内容重置」（切文件 / 切草稿那条 useEffect）**不许**移焦：那是用户在左侧列表里点出来的，
 *    程序化把焦点拽进正文区会打断列表键盘导航，语义也与「我刚结束查找」不同；
 * 4. 只读正文层聚焦必须带 `preventScroll: true`（这一层常只露半截，不该带动整页滚动条）；
 *    编辑区反之——要靠默认滚动把光标位置带进视野；
 * 5. 归还目标必须仍然键盘可达（`tabIndex={0}` + `role="region"`），否则还过去也接不住按键；
 * 6. Esc 与 ✕ 两条出口必须共用同一个 `closeFind`，不许长出第二份内联写法绕开焦点口径；
 * 7. 行为用例是另一张网：`document.activeElement` 断言数量钉下限，防守卫将来被改空。
 *
 * 轮49 的形状变化：量 DOM 那一派（DiffPanel / UnifiedDiff）不再自己写 closeFind——
 * 「收栏 + 还焦点」这一段进了 src/lib/useFindLayer.ts，宿主侧只剩接线（`onClose={closeFind}`）。
 * 所以本守卫拆成两侧：焦点语句按**编排所在文件**校验（两个代码视图 + 共享层），
 * 键盘可达与接线按**渲染条子的宿主**校验（四个）。少任何一侧都会退回原缺陷。
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lineAt, PROJECT_ROOT, readScannedSource, sourceFiles } from "./scanUtils";

/** 四个渲染查找条的宿主：浏览态、编辑态、并排差异（轮48）、单列差异（轮49）。 */
const JSX_HOSTS = [
  "src/components/CodeView.tsx",
  "src/components/CodeEditor.tsx",
  "src/components/DiffPanel.tsx",
  "src/components/UnifiedDiff.tsx",
];
/** 还没迁进共享层、仍在宿主里自己写收栏语句 + 登记 Esc 的地方。 */
const CODE_VIEWS = ["src/components/CodeView.tsx", "src/components/CodeEditor.tsx"];
const LAYER = "src/lib/useFindLayer.ts";
/** 握着「收栏出口语句」的文件：两个代码视图 + 共享层那一份编排。 */
const CLOSE_FILES = [...CODE_VIEWS, LAYER];
/** 共享层里「被查找的那一层」就是入参 `bodyRef`：没有 JSX，按 ref 名校验。 */
const LAYER_REF = "bodyRef";
const ALL_FILES = [...new Set([...JSX_HOSTS, ...CLOSE_FILES])];
/** 被查找的那一层：只读正文层按 className 片段识别（三处），编辑区按标签识别。 */
const READONLY_LAYERS = ['className="code-area', 'className="diff-body', 'className="udiff'];
const EDITOR_LAYER = "<textarea";
/** 「换内容重置」出口的依赖键：出现这些才算内容切换，而非查找结束。 */
const CONTENT_SWITCH_KEYS = ["code", "contentKey", "doc", "format", "value", "leftText", "rightText"];
/** 焦点调用：允许 `x.current?.focus(` / `x.focus(` / `const ta = taRef.current; ta.focus()` 三种写法。 */
const FOCUS_RE = /([A-Za-z_$][\w$]*)((?:\s*\.\s*current)?)\s*(?:\?\.|\.|!\.)\s*focus\s*\(([^)]*)\)/g;

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function described(file: string, index: number, snippet: string): string {
  return `${file}:${lineAt(file, index)}: ${normalize(snippet).slice(0, 160)}`;
}

/** `const ta = taRef.current` / `const el = areaRef.current` 这类局部别名。 */
function aliasMap(source: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of Array.from(source.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\.current\b/g))) {
    map.set(m[1], m[2]);
  }
  return map;
}

function canonicalName(name: string, aliases: Map<string, string>): string {
  return aliases.get(name) ?? name;
}

interface FocusCall {
  ref: string;
  options: string;
  at: number;
}

function focusCallsIn(text: string, aliases: Map<string, string>): FocusCall[] {
  return Array.from(text.matchAll(FOCUS_RE), (m) => ({
    ref: canonicalName(m[1], aliases),
    options: normalize(m[3] ?? ""),
    at: m.index ?? 0,
  }));
}

/** 取包含 marker 的开标签全文：引号与花括号里的 `>` 不算结束。 */
function tagHeadAt(source: string, markerIndex: number): string {
  const start = source.lastIndexOf("<", markerIndex);
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
    else if (ch === ">" && depth === 0) return normalize(source.slice(start, i + 1));
  }
  return normalize(source.slice(start));
}

interface Layer {
  ref: string;
  tag: string;
  head: string;
  at: number;
}

/** 被查找的那一层：开标签里必须挂着 ref。 */
function searchedLayers(file: string): Layer[] {
  const source = readScannedSource(file);
  const found: Layer[] = [];
  for (const marker of [...READONLY_LAYERS, EDITOR_LAYER]) {
    let at = source.indexOf(marker);
    while (at !== -1) {
      const head = tagHeadAt(source, at);
      const ref = /ref=\{([A-Za-z_$][\w$]*)\}/.exec(head);
      const tag = /^<([a-zA-Z][\w-]*)/.exec(head)?.[1] ?? "";
      if (ref) found.push({ ref: ref[1], tag, head, at });
      at = source.indexOf(marker, at + marker.length);
    }
  }
  return found;
}

/** 从 `{` 起做花括号配对（注释已剥掉，只需防字符串里的花括号）。 */
function matchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIndex; i < source.length; i += 1) {
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
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface Site {
  file: string;
  at: number;
  statement: string;
  name: string;
  deps: string[];
  isResetEffect: boolean;
}

/** 取 `setFindOpen(false)` 所属的顶层语句：组件体里缩进 2 空格的那一层。 */
function ownerStatement(file: string, source: string, at: number): Site {
  const starts = Array.from(source.matchAll(/\n {2}(?:const|let|function|useEffect|useImperativeHandle)\b/g), (m) => (m.index ?? 0) + 1);
  const begin = starts.filter((s) => s < at).pop() ?? 0;
  const braceOpen = source.indexOf("{", begin);
  const braceClose = braceOpen === -1 ? -1 : matchingBrace(source, braceOpen);
  let end = braceClose === -1 ? source.length : braceClose + 1;
  while (end < source.length && source[end] !== ";" && source[end] !== "\n") end += 1;
  const statement = source.slice(begin, Math.min(end + 1, source.length));
  const tail = source.slice(braceClose === -1 ? begin : braceClose, Math.min(end + 1, source.length));
  const named = /(?:const|let|function)\s+([A-Za-z_$][\w$]*)/.exec(statement);
  const isEffect = /^\s*useEffect\s*\(/.test(statement);
  const depsMatch = /\}\s*,\s*\[([^\]]*)\]/.exec(tail);
  const deps = depsMatch ? depsMatch[1].split(",").map((d) => normalize(d)) : [];
  const name = named ? named[1] : isEffect ? "useEffect" : "(匿名)";
  // 「换内容重置」的两种形状：带正文依赖键的 useEffect（未迁宿主），
  // 以及共享层里那条按名字说清语义的 useCallback（层拿不到宿主的正文依赖）。
  const isResetByName = /ForNewContent$/.test(name);
  return {
    file,
    at,
    statement,
    name,
    deps,
    isResetEffect: (isEffect && deps.some((d) => CONTENT_SWITCH_KEYS.includes(d))) || isResetByName,
  };
}

function closeSites(): Site[] {
  const acc: Site[] = [];
  for (const file of CLOSE_FILES) {
    const source = readScannedSource(file);
    for (const m of Array.from(source.matchAll(/\bsetFindOpen\(false\)/g))) {
      acc.push(ownerStatement(file, source, m.index ?? 0));
    }
  }
  return acc;
}

const SITES = closeSites();
function layersFor(file: string): Layer[] {
  if (file === LAYER) return [{ ref: LAYER_REF, tag: "div", head: "", at: readScannedSource(file).indexOf(".focus(") }];
  return searchedLayers(file);
}
const LAYERS = new Map(ALL_FILES.map((file) => [file, layersFor(file)]));
const ALIASES = new Map(ALL_FILES.map((file) => [file, aliasMap(readScannedSource(file))]));

/** `src/components/*.test.tsx`：sourceFiles() 有意排掉测试，这里单独捞。 */
function componentTestFiles(): string[] {
  return readdirSync(join(PROJECT_ROOT, "src/components"))
    .filter((name) => /\.test\.tsx$/.test(name))
    .map((name) => `src/components/${name}`);
}

describe("收起查找栏把焦点还给被查找的那一层", () => {
  it("四个查找宿主都能识别「被查找的那一层」，且那一层挂着 ref", () => {
    for (const file of JSX_HOSTS) {
      expect((LAYERS.get(file) ?? []).length, `${file} 找不到带 ref 的正文层/编辑层：口径漂了先在这里红`).toBeGreaterThan(0);
    }
    // 共享层的归还目标必须是入参那颗，不许在层里 querySelector 猜一个
    const layerSrc = readScannedSource(LAYER);
    expect(layerSrc, `${LAYER} 的归还目标不再是入参 bodyRef`).toMatch(new RegExp(String.raw`bodyRef: RefObject<HTMLElement \| null>;`));
  });

  it(`只读正文层仍然键盘可达：tabIndex={0} + role="region"`, () => {
    const offenders: string[] = [];
    for (const file of JSX_HOSTS) {
      for (const layer of LAYERS.get(file) ?? []) {
        if (layer.tag === "textarea") continue; // 编辑区天然可聚焦
        if (!/tabIndex=\{0\}/.test(layer.head) || !/role="region"/.test(layer.head)) {
          offenders.push(described(file, layer.at, `归还目标丢了键盘可达性：${layer.head}`));
        }
      }
    }
    expect(offenders, "还过去接不住按键等于没还：\n" + offenders.join("\n")).toEqual([]);
  });

  it("非重置出口一律把焦点还给那一层（按 ref 名校验，含别名）", () => {
    const offenders: string[] = [];
    const closers = SITES.filter((s) => !s.isResetEffect);
    for (const site of closers) {
      const refs = new Set((LAYERS.get(site.file) ?? []).map((l) => l.ref));
      const targets = focusCallsIn(site.statement, ALIASES.get(site.file) ?? new Map()).filter((c) => refs.has(c.ref));
      if (!targets.length) {
        offenders.push(
          described(
            site.file,
            site.at,
            `${site.name} 收了查找栏却没把焦点还给 ${[...refs].join(" / ")}：${normalize(site.statement).slice(0, 110)}`
          )
        );
      }
    }
    expect(offenders, "焦点掉回 body 后方向键 / PageDown 失效：\n" + offenders.join("\n")).toEqual([]);
    expect(
      closers.length,
      "「收起查找栏」出口下限 4 处：两个代码视图的 closeFind + CodeEditor 的 revealLine + 共享层的 closeFind"
    ).toBeGreaterThanOrEqual(4);
    // 编排只许有一份：量 DOM 那一派的宿主里不该再出现收栏语句本身
    for (const file of ["src/components/DiffPanel.tsx", "src/components/UnifiedDiff.tsx"]) {
      expect(readScannedSource(file), `${file} 自己写了一份 setFindOpen(false)（第二套关栏出口）`).not.toMatch(/setFindOpen\(/);
    }
  });

  it("「换内容重置」出口不许移焦：换文件不是查找结束", () => {
    const resets = SITES.filter((s) => s.isResetEffect);
    expect(resets.length, "换内容重置出口至少一条（两宿主各有一份）").toBeGreaterThanOrEqual(1);
    const offenders = resets
      .filter((s) => focusCallsIn(s.statement, ALIASES.get(s.file) ?? new Map()).length > 0)
      .map((s) => described(s.file, s.at, `${s.name}（依赖 ${s.deps.join(", ")}）在换内容时程序化抢焦点，会打断左侧列表的键盘导航`));
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("只读正文层聚焦带 preventScroll，编辑区不带", () => {
    const offenders: string[] = [];
    for (const file of ALL_FILES) {
      const layers = LAYERS.get(file) ?? [];
      const readonlyRefs = new Set(layers.filter((l) => l.tag !== "textarea").map((l) => l.ref));
      const editorRefs = new Set(layers.filter((l) => l.tag === "textarea").map((l) => l.ref));
      for (const call of focusCallsIn(readScannedSource(file), ALIASES.get(file) ?? new Map())) {
        if (readonlyRefs.has(call.ref) && !/preventScroll:\s*true/.test(call.options)) {
          offenders.push(described(file, call.at, `只读正文层 ${call.ref}.focus() 没带 preventScroll：聚焦会把整页滚动条拽走`));
        }
        if (editorRefs.has(call.ref) && /preventScroll/.test(call.options)) {
          offenders.push(described(file, call.at, `编辑区 ${call.ref}.focus() 不许带 preventScroll：光标位置得滚进视野`));
        }
      }
    }
    expect(offenders, "滚动语义按层区分：\n" + offenders.join("\n")).toEqual([]);
  });

  it("Esc 与 ✕ 共用同一个 closeFind，不许长出第二份内联出口", () => {
    const offenders: string[] = [];
    // Esc 的登记点只有「编排在哪」那一处：代码视图在宿主里，量 DOM 那一派在共享层里
    for (const file of CLOSE_FILES) {
      const flat = normalize(readScannedSource(file));
      if (!new RegExp(`useEscape\\([^;]*?closeFind[^;]*?EscapePriority\\.find`).test(flat)) {
        offenders.push(`${file} 的 Esc 不再指向 closeFind（波37 的登记口径被改动）`);
      }
    }
    // 渲染条子的四个宿主都只认 onClose={closeFind} 这一颗出口
    for (const file of JSX_HOSTS) {
      const source = readScannedSource(file);
      const flat = normalize(source);
      const min = CODE_VIEWS.includes(file) ? 3 : 2; // 未迁：定义 / 登记 / 接线；已迁：解构 / 接线
      expect(flat.split("closeFind").length - 1, `${file} 里 closeFind 至少要出现 ${min} 次`).toBeGreaterThanOrEqual(min);
      if (!/onClose=\{closeFind\}/.test(source)) {
        offenders.push(`${file} 没把 closeFind 接给条子的 onClose：✕ 会绕开焦点口径`);
      }
    }
    // 迁进共享层的宿主不许再自己挂一份 Esc 登记：两份登记 = 一次按键两次关栏
    for (const file of ["src/components/DiffPanel.tsx", "src/components/UnifiedDiff.tsx"]) {
      if (/useEscape\(/.test(readScannedSource(file))) {
        offenders.push(`${file} 又自己登记了一遍 Esc：与共享层的 closeFind 抢同一个按键`);
      }
    }
    expect(offenders, "两条出口必须同函数：\n" + offenders.join("\n")).toEqual([]);
  });

  it("行为用例钉住两张网：断言焦点归属的用例不少于 5 处", () => {
    const files = componentTestFiles();
    const hit = files.filter((rel) => /document\.activeElement/.test(readScannedSource(rel)));
    const total = hit.reduce((sum, rel) => sum + (readScannedSource(rel).match(/document\.activeElement/g) ?? []).length, 0);
    expect(files.length, "src/components 下的用例文件数量异常（扫描口径漂）").toBeGreaterThan(10);
    expect(hit.length, "至少两个用例文件断言焦点归属").toBeGreaterThanOrEqual(2);
    expect(total, "焦点断言总数下限 5").toBeGreaterThanOrEqual(5);
  });
});
