/**
 * 原生绑定只能有一种失败形态：Promise rejection（轮95 R1+R2）。
 *
 * 缺陷长什么样（真机取证见 `.trellis/tasks/10-27-r95-native-boundary-failsafe/prd.md`）：
 * `wailsjs/go/app/App.ts` 原先是 `const app = () => window.go.app.App;` 加
 * `export const X = (a) => app().X(a)`。`app().X` 在**取方法**的那一刻同步求值，
 * 名字不在桥/Go 的方法表里就当场 TypeError：
 *   · 调用点在 useEffect 里（About 挂载取反馈事实）⇒ 抛穿 render/effect ⇒ React 卸载 #root ⇒ 整页白屏；
 *   · 调用点在 async 函数体内 ⇒ 退化成 rejection ⇒ 被上层 catch 吞掉 ⇒ 页面正常、功能静默空转。
 * 第二种比第一种更难发现，因为没有任何一盏灯会亮。
 *
 * 修法不是在每个调用点补 try/catch（那会把 85 颗包装变成 85 处方言），而是把这层收成**一个出口**：
 * 出口把求值与调用都挪进 `Promise.resolve().then(invoke)`，同步抛错从此只能是 rejection，
 * 并且报错里必须带**方法名**。本守卫钉五条不变式，每条都自带正控（同一份判据喂进违反它的样本必须判红）：
 *   K1 除 `call()` 体内那一处外，本文件不得再出现直接取用 `window.go` / `app().` 的**代码**
 *      （字符串里提到 `window.go.app.App` 是给人读的报错文案，不算取用，所以扫描前先抹平字面量）；
 *   K2 每颗导出包装都必须是 `=> call("同名", ...)`，字面量与方法名逐字相等（防复制粘贴错位）；
 *   K3 `GoApp` 里每个方法都声明成 `Promise<...>`，且出口真的过 `Promise.resolve().then(`（不变式①的两个半边）；
 *   K4 取不到方法时抛的是带方法名的 `MissingNativeBindingError`（不变式②）；
 *   K5 产品代码（src/ 非测试）除 `src/lib/wailsAppBindings.ts` 这个出口外不得直接摸 `window.go`。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource, sourceFiles } from "./scanUtils";

const BINDINGS = "wailsjs/go/app/App.ts";
/** src 侧唯一被允许直接读 window.go 的出口（数据层降级取绑定，轮50 立的口径）。 */
const ALLOWED_WINDOW_GO_OUTLETS = new Set(["src/lib/wailsAppBindings.ts"]);
const GUARD = "tests/ux/nativeBindingsUseSingleAsyncExit.test.ts";
const CALL_ANCHOR = "function call<K extends keyof GoApp>";
/** 直接取用原生对象的句式。 */
const DIRECT_ACCESS_PATTERNS: RegExp[] = [/\bwindow\s*(\?\.|\.)\s*go\b/g, /\bapp\(\)\s*\./g];

/**
 * 抹平字符串/模板字面量的内容（保留长度与行数），让「句式扫描」只看代码。
 *
 * 为什么必须抹：报错文案里就写着 `window.go.app.App.<方法名>`，不抹平的话 K1 会在
 * 解释自己的那条消息上自红；而 `// 注释里的旧句式` 已由 stripComments 处理，两者互补。
 */
function blankStringLiterals(text: string): string {
  const out: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      if (ch === "\\") {
        out.push("  ");
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
        out.push(ch);
        continue;
      }
      out.push(ch === "\n" ? "\n" : " ");
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out.push(ch);
      continue;
    }
    out.push(ch);
    void next;
  }
  return out.join("");
}

/** call() 的函数体区间（K1 的唯一豁免段）。 */
function callBodyRange(code: string): { start: number; end: number } | null {
  const at = code.indexOf(CALL_ANCHOR);
  if (at < 0) return null;
  const stop = code.indexOf("\n}", at);
  if (stop < 0) return null;
  return { start: at, end: stop + 2 };
}

/** K1：除 call() 体内那一处外，还剩几处直接取用（带行号，便于定位）。 */
function directAccessHits(code: string): string[] {
  const exempt = callBodyRange(code);
  const hits: string[] = [];
  for (const pattern of DIRECT_ACCESS_PATTERNS) {
    for (const m of code.matchAll(pattern)) {
      const at = m.index ?? 0;
      if (exempt && at >= exempt.start && at < exempt.end) continue;
      hits.push(`第 ${code.slice(0, at).split("\n").length} 行: ${m[0]}`);
    }
  }
  return hits;
}

/** K3a：GoApp 方法表里返回的不是 Promise 的成员。 */
function nonPromiseGoAppMethods(text: string): string[] {
  const block = /type GoApp = \{([\s\S]*?)\n\};/.exec(text);
  if (!block) throw new Error(`${BINDINGS} 里读不到 type GoApp：写法变了请同步改 ${GUARD}`);
  const found: string[] = [];
  for (const m of block[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*\))\s*:\s*([^\n;]+)/g)) {
    const returnType = m[3].trim();
    if (!/^Promise</.test(returnType)) found.push(`${m[1]}: ${returnType}`);
  }
  return found;
}

function declaredMethodNames(text: string): string[] {
  const block = /type GoApp = \{([\s\S]*?)\n\};/.exec(text);
  if (!block) return [];
  return Array.from(block[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)).map((m) => m[1]);
}

interface Wrapper {
  name: string;
  /** 该包装箭头体里第一个被调用者的名字。 */
  callee: string | null;
  /** `call("字面量")` 的字面量。 */
  literal: string | null;
}

/**
 * K2：摊出所有 `export const Name = (...) => ...;` 包装及其调用对象。
 *
 * 按行切而不是用一个整体正则：参数表跨行的包装（`NacosListConfigs` 那一族）在
 * `\([^)]*\)` 上会被截断，整体正则于是只认单行参数的那一半包装，守卫自己先漏coverage。
 */
function exportedWrappers(text: string): Wrapper[] {
  const out: Wrapper[] = [];
  for (const part of text.split(/\n(?=export const )/)) {
    const head = /^export const ([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/.exec(part);
    if (!head) continue;
    const rest = part.slice(head[0].length);
    const arrowAt = rest.indexOf("=>");
    if (arrowAt < 0) continue;
    const body = rest.slice(arrowAt + 2);
    const endAt = body.indexOf(";");
    const stmt = endAt >= 0 ? body.slice(0, endAt) : body;
    const calleeMatch = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(stmt);
    const literalMatch = /\bcall\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/.exec(stmt);
    out.push({ name: head[1], callee: calleeMatch ? calleeMatch[1] : null, literal: literalMatch ? literalMatch[1] : null });
  }
  return out;
}

/** K4：错误类必须把方法名写进消息，call() 必须在拿不到方法时抛它。 */
function namesTheBinding(text: string): boolean {
  const classBlock = /class MissingNativeBindingError extends Error \{[\s\S]*?\n\}/.exec(text);
  if (!classBlock) return false;
  const keepsNameOnInstance = /\bthis\.binding\s*=\s*binding\b/.test(classBlock[0]);
  const messageCarriesName = /\$\{\s*(?:String\(\s*)?binding\s*\)?\s*\}/.test(classBlock[0]);
  const callThrowsIt = /throw new MissingNativeBindingError\(\s*String\(\s*name\s*\)\s*\)/.test(text);
  return keepsNameOnInstance && messageCarriesName && callThrowsIt;
}

/** 正控样本：每条不变式各造一份「被改坏」的文件，判据必须抓到它。 */
const MUTANTS: { key: string; sample: string; rule: "K1" | "K2" | "K3" | "K4" }[] = [
  {
    key: "K1 又搓了一个 app() 助手",
    sample: [
      "function call<K extends keyof GoApp>(name: K): ReturnType<GoApp[K]> {",
      '  return Promise.resolve().then(() => window.go.app.App[name]());',
      "}",
      "const app = () => window.go.app.App;",
      "export const GetAppInfo = () => app().GetAppInfo();",
    ].join("\n"),
    rule: "K1",
  },
  {
    key: "K2 字面量与方法名错位",
    sample: [
      "function call<K extends keyof GoApp>(name: K): ReturnType<GoApp[K]> {",
      '  return Promise.resolve().then(() => window.go?.app?.App[name]());',
      "}",
      'export const GetAppInfo = () => call("CheckForUpdates");',
    ].join("\n"),
    rule: "K2",
  },
  {
    key: "K2 参数表跨行的包装也必须被扫到",
    sample: [
      "function call<K extends keyof GoApp>(name: K): ReturnType<GoApp[K]> {",
      '  return Promise.resolve().then(() => window.go?.app?.App[name]());',
      "}",
      "export const NacosListConfigs = (",
      "  baseUrl: string,",
      ") =>",
      '  app().NacosListConfigs(baseUrl);',
    ].join("\n"),
    rule: "K2",
  },
  {
    key: "K3 方法表里混进同步签名",
    sample: [
      "type GoApp = {",
      "  GetAppInfo(): AppInfo;",
      "  CheckForUpdates(request: any): Promise<any>;",
      "};",
      "function call<K extends keyof GoApp>(name: K): ReturnType<GoApp[K]> {",
      '  return Promise.resolve().then(() => window.go?.app?.App[name]());',
      "}",
      'export const GetAppInfo = () => call("GetAppInfo");',
    ].join("\n"),
    rule: "K3",
  },
  {
    key: "K4 报错不带方法名",
    sample: [
      "class MissingNativeBindingError extends Error {}",
      "function call<K extends keyof GoApp>(name: K): ReturnType<GoApp[K]> {",
      '  return Promise.resolve().then(() => window.go?.app?.App[name]());',
      "}",
      'export const GetAppInfo = () => call("GetAppInfo");',
    ].join("\n"),
    rule: "K4",
  },
];

describe("nativeBindingsUseSingleAsyncExit", () => {
  const src = readScannedSource(BINDINGS);
  const code = blankStringLiterals(src);

  it("K1 直接取用原生对象的句式只允许出现在 call() 内部", () => {
    expect(callBodyRange(code), `读不到 call() 的函数体：锚点 "${CALL_ANCHOR}" 变了，请同步改 ${GUARD}`).not.toBeNull();
    expect(directAccessHits(code), `${BINDINGS} 里除 call() 外又出现直接取用 window.go / app(). 的代码`).toEqual([]);
  });

  it("K2 每颗导出包装都走 call()，且字面量与导出名逐字相等", () => {
    const wrappers = exportedWrappers(src);
    expect(wrappers.length, "一颗包装都没扫到 ⇒ 提取失效").toBeGreaterThan(40);
    const notCall = wrappers.filter((w) => w.callee !== "call").map((w) => w.name);
    expect(notCall, `这些包装没走唯一出口 call()：${notCall.join(", ")}`).toEqual([]);
    const mismatched = wrappers.filter((w) => w.literal !== w.name).map((w) => `${w.name} => call("${w.literal ?? ""}")`);
    expect(mismatched, `这些包装的字面量与方法名不一致（复制粘贴错位）：${mismatched.join(", ")}`).toEqual([]);
    const declared = new Set(declaredMethodNames(src));
    const undeclared = wrappers.filter((w) => !declared.has(w.name)).map((w) => w.name);
    expect(undeclared, `这些包装在 GoApp 方法表里没有对应方法：${undeclared.join(", ")}`).toEqual([]);
  });

  it("K3 方法表全是 Promise 签名，出口真的过 Promise.resolve().then（失败形态只剩 rejection）", () => {
    expect(nonPromiseGoAppMethods(src), "GoApp 里出现非 Promise 返回类型 ⇒ call() 的返回值不再永远是 Promise").toEqual([]);
    const body = src.slice(callBodyRange(code)!.start, callBodyRange(code)!.end);
    expect(body).toContain("Promise.resolve().then(");
  });

  it("K4 拿不到方法时抛的是带方法名的 MissingNativeBindingError", () => {
    expect(namesTheBinding(src), "报错里必须带方法名，否则白屏事故的根因永远读不出来").toBe(true);
  });

  it("K5 产品代码除出口外不直接摸 window.go", () => {
    const offenders: string[] = [];
    for (const rel of sourceFiles()) {
      if (ALLOWED_WINDOW_GO_OUTLETS.has(rel)) continue;
      if (/\bwindow\s*(\?\.|\.)\s*go\b/.test(blankStringLiterals(readScannedSource(rel)))) offenders.push(rel);
    }
    expect(offenders, `这些产品文件绕开 wailsjs 出口自己拼原生对象（下次 Go 侧改名只有这里不会跟着变）：${offenders.join(", ")}`).toEqual([]);
  });

  it("正控：四条判据各自能抓到被改坏的样本", () => {
    const caught: string[] = [];
    for (const mutant of MUTANTS) {
      const sampleCode = blankStringLiterals(mutant.sample);
      if (mutant.rule === "K1") {
        if (directAccessHits(sampleCode).length > 0) caught.push(mutant.key);
        continue;
      }
      if (mutant.rule === "K2") {
        const wrappers = exportedWrappers(mutant.sample);
        const hit = wrappers.length > 0 && wrappers.some((w) => w.callee !== "call" || w.literal !== w.name);
        if (hit) caught.push(mutant.key);
        continue;
      }
      if (mutant.rule === "K3") {
        if (nonPromiseGoAppMethods(mutant.sample).length > 0) caught.push(mutant.key);
        continue;
      }
      if (!namesTheBinding(mutant.sample)) caught.push(mutant.key);
    }
    expect(caught.sort(), "正控没有全部被抓到 ⇒ 判据是假的").toEqual(MUTANTS.map((m) => m.key).sort());
  });

  it("报错文案里的 window.go 不算直接取用（K1 不能因为给人读的句子自红）", () => {
    const sample = [
      "function call<K extends keyof GoApp>(name: K): ReturnType<GoApp[K]> {",
      '  throw new MissingNativeBindingError(`原生绑定 window.go.app.App.${name} 不可用`);',
      "}",
    ].join("\n");
    expect(directAccessHits(blankStringLiterals(sample))).toEqual([]);
  });
});
