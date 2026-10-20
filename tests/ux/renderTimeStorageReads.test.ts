/**
 * 渲染期不摸磁盘：读存储只许发生在三个位置（轮47 R47-05）。
 *
 * 扫出来的真 bug（探针 P47-B 实测，见 .trellis/tasks/10-20-ui-ux-47/prd.md §2.3）：
 * 删掉正在用的配置来源后，选中项跳到连接列表第 0 条，并且跨到了另一个环境（开发 → Development）。
 * 机理是回落时 `loadUI()` 读回来的是**持久化 effect 在同一帧刚写进去的空串回声**——
 * 三层判据全废。这与轮45/轮46 那两次对比页粘连是同一个根因的第三种表现。
 *
 * 为什么渲染期读存储比「慢」更严重（实测单次 5.8 µs，60 条连接 69.8 µs，慢不是重点）：
 * `load*()` 的返回值到底来自用户现场还是来自本应用上一帧自己写的回声，
 * **无法从代码判定**，只能靠时序推理——而时序推理正是这三轮全都推理错的东西。
 * 所以渲染/效应在概念上必须等价于纯函数：状态从参数与 state/props 进来，磁盘只在三个位置读：
 *   ① 挂载时（`useState(() => loadX())` 惰性初值）
 *   ② 事件发生时（写侧自己刷新、保存回调、effect 里的通知回调）
 *   ③ 写完立刻通知（store 的写侧广播，见 store/settings.subscribeSettings）
 *
 * 口径是刻意收窄的（宁可漏报也不误伤）：只钉「组件函数体第一层的语句」和「JSX 里的 IIFE」，
 * 目标是本轮清掉的四处长不回来；模块级 helper（如 initialDiffStateFromPreferences）
 * 与 effect / useCallback 内部的读不在此列。跨文件纪律只守一次，行为用例见 App.test.tsx。
 */
import { describe, expect, it } from "vitest";
import { lineAt, readScannedSource, sourceFiles } from "./scanUtils";

const APP = "src/App.tsx";
const DIFF_VIEW = "src/components/DiffView.tsx";
const SSH_MANAGER = "src/components/SSHManagerView.tsx";
const SETTINGS_VIEW = "src/components/SettingsView.tsx";
const BACKUP_PANEL = "src/components/AppDataBackupPanel.tsx";
const SETTINGS_STORE = "src/store/settings.ts";
const USE_SETTINGS = "src/lib/useSettings.ts";
const CACHE_CLEANUP = "src/lib/cacheCleanup.ts";

/** 读盘调用：store 的 load* 与直接 localStorage.getItem。 */
const READ_RE = /(?:\bload[A-Z][A-Za-z0-9_]*|localStorage\.getItem)\s*\(/;
/** 组件函数体第一层的裸读：`const x = loadX()` / `const x: T = loadX()`。 */
const RENDER_BODY_READ_RE = /^ {2}(?:const|let)\s+[\w$]+(?:\s*:\s*[^=]+)?\s*=\s*(?:\bload[A-Z][A-Za-z0-9_]*|localStorage\.getItem)\s*\(/;
/** 第一层读盘的外层候选行：模块级函数 / 组件定义（名字大小写区分 helper 与组件）。 */
const COMPONENT_DECL_RE = /^(?:export\s+)?(?:default\s+)?function\s+[A-Z]/;
const MODULE_HELPER_DECL_RE = /^(?:export\s+)?(?:default\s+)?function\s+[a-z$_]/;
const MODULE_CONST_RE = /^(?:export\s+)?const\s+[A-Z][\w$]*\s*[=:]/;

function read(rel: string): string {
  return readScannedSource(rel);
}

/** 这一行的第一层外层是什么：往上找最近的一条 0 缩进行。 */
function enclosingModuleLine(lines: string[], index: number): string {
  for (let i = index - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.trim() || /^[ \t]/.test(line)) continue;
    return line;
  }
  return "";
}

/** 从 `useState` 之后扫到参数列表的左括号（跳过泛型 <...>）。返回左括号下标，找不到返回 -1。 */
function stateCallParen(src: string, from: number): number {
  let i = from;
  while (i < src.length && /[\s]/.test(src[i])) i += 1;
  if (src[i] === "<") {
    let angle = 0;
    for (; i < src.length; i += 1) {
      if (src[i] === "<") angle += 1;
      else if (src[i] === ">") {
        angle -= 1;
        if (angle === 0) {
          i += 1;
          break;
        }
      }
    }
    while (i < src.length && /\s/.test(src[i])) i += 1;
  }
  return src[i] === "(" ? i : -1;
}

/** 取一对括号内的实参文本（不含最外层括号）。 */
function argumentText(src: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return src.slice(openIndex + 1, i);
    }
  }
  return src.slice(openIndex + 1);
}

/** useState 的实参是否惰性初值（`() => ...` / `(x) => ...`）。 */
function isLazyInitializer(arg: string): boolean {
  return /^\s*(?:\([^)]*\)|[a-z_$][\w$]*)\s*=>/.test(arg);
}

/** 收集某文件的「非惰性初值 + 直接读盘」命中。 */
function nonLazyStateReads(rel: string): string[] {
  const src = read(rel);
  const hits: string[] = [];
  const re = /\buseState\b/g;
  for (const match of Array.from(src.matchAll(re))) {
    const open = stateCallParen(src, (match.index ?? 0) + match[0].length);
    if (open < 0) continue;
    const arg = argumentText(src, open);
    if (!READ_RE.test(arg)) continue;
    if (isLazyInitializer(arg)) continue;
    hits.push(`${rel}:${lineAt(rel, open)} → useState(${arg.trim().slice(0, 60)})`);
  }
  return hits;
}

/** 收集某文件的「渲染层裸读盘」命中（第一层语句 + JSX 里的 IIFE）。 */
function renderBodyReads(rel: string): string[] {
  const src = read(rel);
  const lines = src.split("\n");
  const hits: string[] = [];
  lines.forEach((line, index) => {
    if (!RENDER_BODY_READ_RE.test(line)) return;
    const outer = enclosingModuleLine(lines, index);
    // helper / 模块常量里的读盘是合法的（它们由惰性初值或事件路径调用）
    if (MODULE_HELPER_DECL_RE.test(outer) || MODULE_CONST_RE.test(outer)) return;
    if (!COMPONENT_DECL_RE.test(outer) && !MODULE_CONST_RE.test(outer)) return;
    hits.push(`${rel}:${index + 1} → ${line.trim().slice(0, 80)}`);
  });
  // JSX 内联 IIFE 里读盘：`{(() => { const x = load...` —— 设置页的「最后备份」原来就长这样
  const iifeRe = /\{\s*\(\s*\(\s*\)\s*=>\s*\{[\s\S]{0,600}?\}\s*\)\s*\(\s*\)\s*\}/g;
  for (const match of Array.from(src.matchAll(iifeRe))) {
    if (!READ_RE.test(match[0])) continue;
    hits.push(`${rel}:${lineAt(rel, match.index ?? 0)} → JSX 内联 IIFE 里读盘`);
  }
  return hits;
}

describe("渲染期不摸磁盘（轮47 R47-05）", () => {
  const componentSources = sourceFiles().filter((rel) => rel.endsWith(".tsx"));

  it("组件函数体第一层不出现裸 load*/localStorage.getItem，JSX 里也不许内联读盘", () => {
    const offenders = componentSources.flatMap(renderBodyReads);
    expect(offenders, `这些地方在渲染时读盘，读到的是用户现场还是自己上一帧的回声无法判定:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("useState 的初值一律惰性：非惰性写法每次渲染都解析一遍再丢弃", () => {
    const offenders = sourceFiles().flatMap((rel) => (rel.endsWith(".tsx") || rel.endsWith(".ts") ? nonLazyStateReads(rel) : []));
    expect(offenders, `React 只消费首帧返回值，其余是白读:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("App 的 cs.ui 只在挂载读一次，回落只认内存里的上一个有效作用域", () => {
    const app = read(APP);
    expect(app, "ui0 必须是挂载快照，否则每次渲染重解析 cs.ui").toMatch(/const \[ui0\] = useState\(\(\) => loadUI\(\)\)/);
    // loadUI 只许有两个文本位置：自己的定义 + 挂载快照。回落那条线一旦再读存储就是回声（轮47 R47-01）
    expect(app.match(/loadUI\(\)/g) ?? [], "loadUI() 只许在定义处与挂载快照各出现一次").toHaveLength(2);
    expect(app, "回落不许再从存储里取判据").not.toMatch(/preferredConnection\([^)]*loadUI/);
    expect(app).toMatch(/useRef<ScopeHint>\(scopeHintFromUI\(ui0\)\)/);
    expect(app, "回落必须用 lastValidScopeRef，而不是任何存储读取").toMatch(/preferredConnection\(connections, lastValidScopeRef\.current\)/);
    expect(app, "挂载初值用 ui0 快照，不读盘").toMatch(/preferredConnection\(connections, scopeHintFromUI\(ui0\)\)/);
    expect(app, "记住有效作用域的 effect 必须声明在回落 effect 之前").satisfies((source) =>
      source.indexOf("lastValidScopeRef.current = {") < source.indexOf("preferredConnection(connections, lastValidScopeRef.current)")
    );
    // 回落时 ref 不许被空值覆盖：activeConn 为空必须直接返回
    expect(app).toMatch(/if \(!activeConn\) return;\s*\n\s*lastValidScopeRef\.current = \{/);
  });

  it("设置走「写完即通知」：写侧只有一个通知点，读侧用 useSettings", () => {
    const store = read(SETTINGS_STORE);
    expect(store).toMatch(/export function subscribeSettings/);
    expect(store).toMatch(/export function notifySettingsChanged/);
    expect(store, "所有写入方都汇聚到 saveSettings，通知点也只该有这一个").toMatch(
      /export function saveSettings\(settings: AppSettings\) \{\s*\n\s*localStorage\.setItem\([\s\S]{0,120}?\n\s*notifySettingsChanged\(\);/
    );
    const hook = read(USE_SETTINGS);
    expect(hook, "读方初值必须惰性").toMatch(/useState<AppSettings>\(\(\) => loadSettings\(\)\)/);
    expect(hook).toMatch(/subscribeSettings\(\(\) => setSettings\(loadSettings\(\)\)\)/);

    const diffView = read(DIFF_VIEW);
    expect(diffView, "对比页不许在渲染体里读设置").not.toMatch(/loadSettings\(\)/);
    expect(diffView).toMatch(/const settings = useSettings\(\)/);
    expect(diffView).toContain('from "../lib/useSettings"');

    const cleanup = read(CACHE_CLEANUP);
    expect(cleanup, "水合绕过 saveSettings，必须补一次通知，否则订阅方拿着清理前的旧值").toMatch(/await rehydrateFromAppDataDoc\(\);[\s\S]{0,200}?notifySettingsChanged\(\);/);

    // SSH 页的连接列表由 App 下发（真值本来就在 App 的 state 里）
    const ssh = read(SSH_MANAGER);
    expect(ssh, "SSH 页不许绕过 App 读盘拿连接").not.toMatch(/loadConnections\(\)/);
    expect(ssh).toMatch(/connections: Connection\[\];/);
    expect(read(APP)).toMatch(/<SSHManagerView connections=\{connections\} \/>/);
  });

  it("「最后备份」由面板上报驱动，不在设置页的渲染体里读备份活动", () => {
    const panel = read(BACKUP_PANEL);
    expect(panel).toMatch(/onActivitiesChange\?: \(activities: AppDataBackupActivity\[\]\) => void;/);
    expect(panel, "面板内所有落地必须走同一个漏斗，才保证上报不漏").toMatch(
      /const applyBackupState = \(next: AppDataBackupState\) => \{\s*\n\s*setBackupState\(next\);\s*\n\s*onActivitiesChange\?\.\(next\.activities\);/
    );
    expect((panel.match(/setBackupState\(/g) ?? []).length, "setBackupState 只许在 useState 声明与漏斗里出现").toBeLessThanOrEqual(2);

    const settingsView = read(SETTINGS_VIEW);
    expect(settingsView, "设置页只在挂载时读一次活动列表").toMatch(/useState\(\(\) => loadAppDataBackupState\(\)\.activities\)/);
    expect(settingsView).toMatch(/<AppDataBackupPanel onActivitiesChange=\{setBackupActivities\} \/>/);
    expect(settingsView.match(/loadAppDataBackupState\(\)/g) ?? [], "loadAppDataBackupState 只许出现在 import 与惰性初值").toHaveLength(1);
  });
});
