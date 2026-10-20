/**
 * 守卫：弹层内部的瞬时编辑/查找层必须自己登记 Esc（轮16 波37 / R61）。
 *
 * 缺陷长什么样：`useEscape` 的分派器挂在 window 的**捕获**阶段并 stopPropagation，React 根监听在冒泡阶段。
 * 于是「组件里写裸 onKeyDown 处理 Escape」在任意一层注册 active 时都是死代码：按键被外层吃掉。
 * 代码查找栏正是这么写的，用户在配置浏览的编辑态里想收起查找条，结果取消了整段编辑、
 * 手写一半的草稿撞上「放弃修改？」；在新建/编辑弹层里按一次 Esc，整个弹层连带草稿一起没了。
 * 既有的单组件用例（单独渲染代码视图、外层无注册）一直绿，所以缺陷藏了很久——这里用静态口径钉住。
 *
 * 口径：
 * 1. 档位表：`find` 必须存在且数值夹在 `overlay` 与 `dropdown` 之间，既有档位不许重排；
 * 2. 站点名单：三处瞬时层按「文件 + 门控 + 回调」钉死，不钉行号（上方插一行就漂）；
 * 3. 门控：`find` 档登记不许常开，门控必须引用本组件的瞬时层状态；同文件里若宿主已按 page/overlay
 *    登记，find 的门控必须包含宿主那段表达式（隐藏的宿主不许让内层抢走 Esc，波31 同类事故）；
 * 4. 反向钉：`src/` 下除分派器本身，不许再出现「裸 Escape 分支」；
 * 5. `find` 档只许用于名单内文件——宿主弹层借它会替外层吃掉按键；
 * 6. 防守卫永真：档位表、站点数、接线文件数、扫描覆盖面都钉了下限。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lineAt, PROJECT_ROOT, readScannedSource, sourceFiles } from "./scanUtils";

const LIB = "src/lib/useEscape.ts";
/** 档位表基线：数值越大越内层。波37 只新增 find，既有档位数值不许动。 */
const TIER_BASELINE: Array<[string, number]> = [
  ["page", 0],
  ["overlay", 10],
  ["find", 15],
  ["dropdown", 20],
  ["confirm", 30],
  ["global", 40],
];
/** 宿主层档位：内层登记必须与它们对齐门控。 */
const HOST_TIERS = ["page", "overlay"];

interface Site {
  file: string;
  /** 登记的第一参（可见性门控），规范化空白后的全文。 */
  gate: string;
  /** 登记的第二参（收起回调）。 */
  callback: string;
  why: string;
}

/** 接线的瞬时层名单（新增站点要一起说明为什么不是宿主弹层本身）。 */
const SITES: Site[] = [
  { file: "src/components/CodeView.tsx", gate: "active && findOpen", callback: "closeFind", why: "浏览态代码视图的查找栏" },
  { file: "src/components/CodeEditor.tsx", gate: "active && findOpen", callback: "closeFind", why: "新建/编辑弹层里的查找栏" },
  // 轮48：并排差异正文接入同一个查找条。它是页面内的瞬时层（栏一关就清词、不遮挡宿主弹层），
  // 门控与上面两处逐字同形：宿主页面被保活隐藏时（active=false）绝不登记 Esc。
  { file: "src/components/DiffPanel.tsx", gate: "active && findOpen", callback: "closeFind", why: "并排差异正文的查找栏（轮48）" },
  {
    file: "src/components/ConnectionManager.tsx",
    gate: "!embedded && !!renamingProject",
    callback: "() => setRenamingProject(null)",
    why: "连接面板内的行内重命名输入框",
  },
];

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function label(file: string, line: number, snippet: string): string {
  return `${file}:${line}: ${snippet.slice(0, 120)}`;
}

/** 从档位表字面量里取 `名字 -> 数值`，at 为字面量内位置（用于判声明顺序）。 */
function tierTable(): Array<{ name: string; value: number; at: number }> {
  const source = readScannedSource(LIB);
  const block = /export const EscapePriority\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(source);
  if (!block) return [];
  return Array.from(block[1].matchAll(/(\w+)\s*:\s*(\d+)/g), (m) => ({
    name: m[1],
    value: Number(m[2]),
    at: m.index ?? 0,
  }));
}

/** 取 `(` 对应的 `)`：忽略引号内的括号，注释已由 readScannedSource 剥掉。 */
function matchingParen(source: string, openIndex: number): number {
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
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 按顶层逗号切参数：箭头函数、对象字面量里的逗号不算分隔。 */
function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "}" || ch === "]") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts.map(normalize);
}

interface EscapeCall {
  file: string;
  line: number;
  gate: string;
  callback: string;
  tier: string;
}

/** 文件里所有 useEscape 登记；缺省第三参按 page 计（与 useEscape 的默认值一致）。 */
function escapeCalls(rel: string): EscapeCall[] {
  const source = readScannedSource(rel);
  const found: EscapeCall[] = [];
  for (const m of Array.from(source.matchAll(/\buseEscape\s*\(/g))) {
    const at = (m.index ?? 0) + m[0].length - 1;
    const close = matchingParen(source, at);
    if (close === -1) continue;
    const args = splitTopLevel(source.slice(at + 1, close));
    if (args.length < 2) continue;
    const raw = args[2] ?? "";
    const named = /EscapePriority\.([\w$]+)/.exec(raw);
    found.push({
      file: rel,
      line: lineAt(rel, m.index ?? 0),
      gate: args[0],
      callback: args[1],
      tier: named ? named[1] : raw === "" ? "page（缺省）" : normalize(raw),
    });
  }
  return found;
}

/** 本文件 useState 解构出的状态名：门控必须真的引用其中一个，否则就是常开。 */
function stateNames(rel: string): string[] {
  const source = readScannedSource(rel);
  return Array.from(source.matchAll(/const\s*\[\s*([A-Za-z_$][\w$]*)\s*,/g), (m) => m[1]);
}

function allCalls(): EscapeCall[] {
  const acc: EscapeCall[] = [];
  for (const rel of sourceFiles()) {
    if (rel === LIB) continue;
    acc.push(...escapeCalls(rel));
  }
  return acc;
}

const CALLS = allCalls();
const FIND_CALLS = CALLS.filter((c) => c.tier === "find");
const SCANNED_FILE_COUNT = sourceFiles().filter((rel) => rel !== LIB).length;

describe("Esc 分层：瞬时编辑层自己登记", () => {
  it("档位表含 find，数值夹在 overlay 与 dropdown 之间，既有档位不许重排", () => {
    const table = tierTable();
    expect(table.length, "档位表解析失败（口径漂了先在这里红）").toBeGreaterThanOrEqual(TIER_BASELINE.length);
    const byName = new Map(table.map((t) => [t.name, t.value]));
    const mismatched = TIER_BASELINE.filter(([name, value]) => byName.get(name) !== value).map(
      ([name, value]) => `${name} 期望 ${value}，实际 ${String(byName.get(name))}`
    );
    expect(mismatched, "档位数值被改动：\n" + mismatched.join("\n")).toEqual([]);

    const find = byName.get("find");
    const overlay = byName.get("overlay");
    const dropdown = byName.get("dropdown");
    expect(find, "find 档被删掉了：瞬时层就无处登记，Esc 会继续穿透到宿主").toBeDefined();
    expect(find!, "find 必须比宿主弹层更内层").toBeGreaterThan(overlay!);
    expect(find!, "find 必须比弹层内的下拉更外层").toBeLessThan(dropdown!);

    // 声明顺序与数值同向：读代码时从上到下就是由外到内，顺手挡掉「数值对但顺序打乱」的改法。
    const ascending = table.filter((t, i) => i === 0 || t.value >= table[i - 1].value);
    expect(ascending.length, "档位声明顺序与数值不一致（读表时会看错层级）").toBe(table.length);
  });

  it("find 档必须有注释交代适用面、穿透根因与门控要求", () => {
    // 注释在扫描时会被剥掉，判注释内容必须读原文。
    const text = readFileSync(join(PROJECT_ROOT, LIB), "utf8");
    const atFind = /\n\s*find:/.exec(text);
    expect(atFind, "find 档不存在").not.toBeNull();
    const before = text.slice(0, atFind!.index);
    const doc = before.slice(before.lastIndexOf("/*"));
    for (const term of ["瞬时", "捕获", "门控"]) {
      expect(doc, `find 档的注释缺了「${term}」：这三处是后来人复用档位时必须知道的边界`).toContain(term);
    }
  });

  it("三处瞬时层站点按「文件 + 门控 + 回调」钉死", () => {
    const missing = SITES.filter(
      (site) => !FIND_CALLS.some((c) => c.file === site.file && c.gate === site.gate && c.callback === site.callback)
    ).map((site) => `${site.file}（${site.why}）找不到 useEscape(门控=${site.gate}, ${site.callback}, EscapePriority.find)`);
    expect(missing, "登记被改写或退回裸分支：\n" + missing.join("\n")).toEqual([]);
  });

  it("find 档登记必须带可见性门控，不许常开、也不许脱离宿主门控", () => {
    const offenders: string[] = [];
    for (const call of FIND_CALLS) {
      if (call.gate === "true" || call.gate === "!1" || call.gate === "") {
        offenders.push(label(call.file, call.line, `常开登记 useEscape(${call.gate}, ${call.callback})`));
        continue;
      }
      const names = stateNames(call.file);
      const usesOwnState = names.some((name) => new RegExp(`\\b${name}\\b`).test(call.gate));
      if (!usesOwnState) {
        offenders.push(label(call.file, call.line, `门控没有引用本组件的瞬时层状态（useState）：${call.gate}`));
        continue;
      }
      // 同文件宿主登记（page/overlay）存在时，内层门控必须包含宿主那段表达式。
      for (const host of escapeCalls(call.file).filter((c) => HOST_TIERS.includes(c.tier))) {
        if (!call.gate.includes(host.gate)) {
          offenders.push(label(call.file, call.line, `find 门控「${call.gate}」没带上门控宿主层的「${host.gate}」`));
        }
      }
    }
    expect(offenders, "隐藏的视图登记 Esc 等于凭空多一层拦截：\n" + offenders.join("\n")).toEqual([]);
    expect(FIND_CALLS.length, "find 档站点下限 3（波37 接线的三处都不许被删）").toBeGreaterThanOrEqual(3);
    const files = new Set(FIND_CALLS.map((c) => c.file));
    expect(files.size, "接线文件下限 3").toBeGreaterThanOrEqual(3);
  });

  it("src 下不许再出现瞬时层裸 Escape 分支", () => {
    const bare: string[] = [];
    for (const rel of sourceFiles()) {
      if (rel === LIB) continue; // 分派器自己是唯一合法判 key 的地方
      const source = readScannedSource(rel);
      for (const m of Array.from(source.matchAll(/key\s*[=!]==?\s*["']Escape["']|keyCode\s*[=!]==?\s*27/g))) {
        bare.push(label(rel, lineAt(rel, m.index ?? 0), m[0]));
      }
    }
    expect(bare, "裸 Escape 分支在捕获阶段就被吃掉，是死代码且误导后来人：\n" + bare.join("\n")).toEqual([]);
  });

  it("find 档只许名单内文件使用（宿主弹层借它会替外层吃掉按键）", () => {
    const allowed = new Set(SITES.map((s) => s.file));
    const extra = FIND_CALLS.filter((c) => !allowed.has(c.file)).map((c) =>
      label(c.file, c.line, `useEscape(${c.gate}, ${c.callback}, find)`)
    );
    expect(extra, "新增 find 站点必须先说明它为什么是「瞬时层」而不是宿主弹层本身：\n" + extra.join("\n")).toEqual([]);
  });

  it("扫描口径不为空：文件数、登记数都钉下限", () => {
    expect(SCANNED_FILE_COUNT, "sourceFiles() 覆盖面异常").toBeGreaterThan(40);
    expect(CALLS.length, "useEscape 登记总数下限 15（口径漂成空扫时先在这里红）").toBeGreaterThanOrEqual(15);
  });
});
