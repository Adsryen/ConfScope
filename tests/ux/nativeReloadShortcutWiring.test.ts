/**
 * 刷新快捷键只认一个出口（轮45 R01）。
 *
 * 扫出来的真 bug：全仓没有任何一层拦 F5 / Ctrl+R，桌面 webview 里按一下就是整页重载，
 * 只活在内存里的现场（浏览页搜索词与结果、打开的详情、对比结果）一次清零。
 * 真机探针实测：搜 `svc-pay` 得到 2 条并打开一条详情后刷新 → 搜索框空、列表回到 13 条、
 * `.code-area` 归 0，而 `cs.ui` 里从来没存过这些值，刷新后无从恢复。
 *
 * 分工（别在这里重复 src/lib/reloadShortcut.test.ts 已经钉死的东西）：
 *  那条单测管判据对不对；这条静态守卫管「只有一个出口 + 真的接在 App 上 + 让位顺序不能被倒着改」。
 *  让位顺序是这里唯一有技术含量的断言：`preventDefault` 一旦挪到 `defaultPrevented` / IME 判断之前，
 *  就变成「全局兜底跟每个组件抢按键」，而这种倒装在单测里照样绿。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource, sourceFiles } from "./scanUtils";

const LIB = "src/lib/reloadShortcut.ts";
const SIGNAL = "src/lib/shortcutKey.ts";
const APP = "src/App.tsx";
/** App 顶层的接线点。 */
const WIRING = /useBlockNativeReloadShortcut\(\);/;
/** 别处手搓刷新判据：自己比 "F5" 或自己比 r。 */
const HANDROLLED_F5 = /===\s*"F5"/;
const HANDROLLED_R = /key\s*===\s*"r"/;

function indexOfRequired(re: RegExp, source: string, file: string, what: string): number {
  const at = source.search(re);
  expect(at, `${file} 缺少${what}`).toBeGreaterThanOrEqual(0);
  return at;
}

describe("刷新快捷键只认一个出口（轮45 R01）", () => {
  it("单一事实源存在，判据与兜底都从它导出", () => {
    const lib = readScannedSource(LIB);
    expect(lib).toMatch(/export function isReloadShortcutKey\(/);
    expect(lib).toMatch(/export function useBlockNativeReloadShortcut\(/);
    expect(lib).toContain('from "./shortcutKey"');
  });

  it("兜底必须先看两道让位再拦，且是冒泡阶段监听", () => {
    const lib = readScannedSource(LIB);
    const ime = indexOfRequired(/isImeComposing\(e\)/, lib, LIB, "输入法让位");
    const prevented = indexOfRequired(/e\.defaultPrevented/, lib, LIB, "已接管让位");
    const block = indexOfRequired(/e\.preventDefault\(\);/, lib, LIB, "拦默认行为");
    expect(ime).toBeLessThan(block);
    expect(prevented).toBeLessThan(block);
    // 必须冒泡阶段：React 合成事件在根容器派发，比 window 早，defaultPrevented 才可信
    expect(lib).toMatch(/window\.addEventListener\("keydown", onKeyDown\)/);
  });

  it("裸 r 不可能被当成刷新：r 分支必须在修饰键闸门之后", () => {
    const lib = readScannedSource(LIB);
    const gate = indexOfRequired(/if \(!event\.ctrlKey && !event\.metaKey\) return false;/, lib, LIB, "修饰键闸门");
    const r = indexOfRequired(/event\.key === "r"/, lib, LIB, "r 判定");
    expect(r).toBeGreaterThan(gate);
    // Alt 逃生门必须在判据最前面，否则开发者连手敲重载的路径都没有
    const alt = indexOfRequired(/if \(hasAltModifier\(event\)\) return false;/, lib, LIB, "Alt 放行");
    expect(alt).toBeLessThan(gate);
    expect(readScannedSource(SIGNAL)).toMatch(/export function hasAltModifier\(/);
  });

  it("App 真的挂了兜底，而且只挂一处", () => {
    const app = readScannedSource(APP);
    expect(app).toMatch(WIRING);
    expect(sourceFiles().filter((file) => file !== LIB && WIRING.test(readScannedSource(file))).length).toBe(1);
  });

  it("刷新判据只有单一事实源一份，别处不许手搓", () => {
    const offenders = sourceFiles()
      .filter((file) => file !== LIB)
      .filter((file) => HANDROLLED_F5.test(readScannedSource(file)) || HANDROLLED_R.test(readScannedSource(file)));
    expect(offenders).toEqual([]);
  });
});
