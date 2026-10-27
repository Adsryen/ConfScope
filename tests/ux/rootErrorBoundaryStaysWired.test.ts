/**
 * 根错误边界的接线守卫（轮95 R3 / R4）。
 *
 * 缺陷长什么样：兜底界面写好了，但接线被人在重构时挪走 ——
 * `src/main.tsx` 把 `<AppErrorBoundary>` 从 `I18nProvider` **里面**搬到外面（它渲染时要 `t()`、
 * 要用 `CopyButton`，那些都吃 provider，搬出去的后果是「最该说话的时候一起抛错」）；
 * 或者干脆删掉包裹，退回轮94 那张白屏：`#root` 的子节点被 React 全删，没有提示、没有按钮。
 * 这两种退化都不改变任何功能路径，组件自己的用例照样绿，只能静态钉住接线本身。
 *
 * 口径：
 * 1. 边界必须包在 provider 内，且 `<App />` 仍是它的 children（不是兄弟节点）；
 * 2. 兜底界面必须自带「抄得走」出口（CopyButton）与「当场可见」的地标（role="alert"）；
 * 3. 诊断文本不许截断——组件栈的尾部正是「崩在哪个页面」；
 * 4. 界面引用的 `crash.*` 文案键必须在两份语言里都存在（兜底屏上印出 `crash.title` 这种原始键名，
 *    等于出事时给用户看一串代码）；
 * 5. 兜底面不许再依赖任何会跟着一起抛的东西：不碰 wailsjs 绑定、不碰 src/api、不读主数据文件、
 *    不读 localStorage ——它是别的代码正在抛错时唯一还要渲染的东西。
 */
import { describe, expect, it } from "vitest";
import { loadLocale, readScannedSource } from "./scanUtils";

const MAIN = "src/main.tsx";
const BOUNDARY = "src/components/AppErrorBoundary.tsx";

/** provider 包住边界的接线形状。 */
function isWiredInsideProvider(source: string): boolean {
  const provider = source.indexOf("<I18nProvider>");
  const boundary = source.indexOf("<AppErrorBoundary>");
  const app = source.indexOf("<App />");
  return provider !== -1 && boundary > provider && app > boundary;
}

/** 兜底界面引用到的 `crash.*` 字面量键（`t("…")` 与 `translate("…")` 两种写法）。 */
function crashKeys(source: string): string[] {
  return Array.from(source.matchAll(/\b(?:t|translate)\(\s*["'](crash\.[A-Za-z]\w*)["']/g), (m) => m[1]).sort();
}

describe("根错误边界仍然包住界面", () => {
  it("main.tsx 里边界包在 I18nProvider 内，App 是它的 children", () => {
    const source = readScannedSource(MAIN);
    expect(source, "main.tsx 里找不到 <AppErrorBoundary>：根边界被摘掉了，退回白屏形态").toContain("<AppErrorBoundary>");
    expect(isWiredInsideProvider(source), "边界必须包在 I18nProvider 里面，且 <App /> 在它内部").toBe(true);
    // 正控：形状反过来的写法必须被判定为「没接好」，否则上面那条是永真断言
    expect(isWiredInsideProvider("<I18nProvider><App /></I18nProvider><AppErrorBoundary>x</AppErrorBoundary>")).toBe(false);
    expect(isWiredInsideProvider("<AppErrorBoundary><I18nProvider><App /></I18nProvider></AppErrorBoundary>")).toBe(false);
    expect(isWiredInsideProvider("<div></div>")).toBe(false);
  });

  it("兜底界面自带可见地标与复制出口", () => {
    const source = readScannedSource(BOUNDARY);
    expect(source).toContain('role="alert"');
    expect(source).toContain("<CopyButton");
    // 两条出口之一：重新载入是 remount，不许写成重启进程（那会连带丢掉正在跑的任务）
    expect(source, "重新载入必须走 setState 重建子树，不许调 quitApplication / location.reload").not.toMatch(/location\.reload|quitApplication|window\.location\s*=/);
    expect(source).toMatch(/this\.setState\(\{\s*error:\s*null/);
  });

  it("诊断文本不截断：组件栈与错误栈都整段留全", () => {
    const source = readScannedSource(BOUNDARY);
    const builder = source.slice(source.indexOf("export function buildCrashDiagnostics"), source.indexOf("export function buildCrashDiagnostics") + 900);
    expect(builder).toContain("componentStack");
    expect(builder).toContain("error.stack");
    // 正控：`slice(0, 500)` 这种截断写法要能被抓到
    expect(/\.slice\(\s*0\s*,\s*\d+\s*\)/.test(builder), "buildCrashDiagnostics 里出现定长截断，栈尾会被剪掉").toBe(false);
    expect(/\.slice\(\s*0\s*,\s*\d+\s*\)/.test("text.slice(0, 500)")).toBe(true);
  });

  it("界面引用的 crash.* 文案在两份语言里都存在", () => {
    const keys = crashKeys(readScannedSource(BOUNDARY));
    expect(keys.length, "兜底界面一个文案键都没引用，多半是整块被改成写死中文了").toBeGreaterThanOrEqual(8);
    const zh = loadLocale("zh-CN.json");
    const en = loadLocale("en-US.json");
    const missingZh = keys.filter((key) => !(key in zh));
    const missingEn = keys.filter((key) => !(key in en));
    expect(missingZh, `这些键中文里没有，兜底屏上会直接印原始键名：\n${missingZh.join("\n")}`).toEqual([]);
    expect(missingEn, `这些键英文里没有，英文界面崩溃时等于没说话：\n${missingEn.join("\n")}`).toEqual([]);
    // 正控：漏一个键的写法必须被判红
    expect("crash.notARealKey" in zh).toBe(false);
    expect(crashKeys('t("crash.title") translate("crash.lead")')).toEqual(["crash.lead", "crash.title"]);
  });

  it("兜底面不再依赖任何会跟着一起抛的东西", () => {
    const source = readScannedSource(BOUNDARY);
    for (const forbidden of ["window.go", "@wailsjs", 'from "../api/', "appDataDoc", "localStorage"]) {
      expect(source, `兜底界面里出现了 ${forbidden}：它在别的代码抛错时唯一要能渲染，别加会跟着一起塌的依赖`).not.toContain(forbidden);
    }
  });
});
