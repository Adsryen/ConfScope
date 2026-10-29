/**
 * 编辑器接管 Ctrl/Cmd+S（波27 R47）。
 *
 * 扫出来的真 bug：CodeEditor 只劫持了 Ctrl+F / F3，全仓没有任何 "s" 键处理，
 * App 也没有全局 keydown → 用户在代码编辑区按 Ctrl+S，漏到 webview 原生层弹「保存网页」，
 * 存下来的是整页 HTML，跟正在编辑的配置毫无关系。
 *
 * 口径（PRD R1~R6）：
 * - 编辑区内由 CodeEditor 的 onSave 接管（保存的是这份内容），判据来自 lib/saveShortcut 单一事实源；
 * - 编辑区之外没有保存语义，由 App 挂的全局兜底把原生对话框吞掉，且必须先看 defaultPrevented，
 *   否则一次按键会存两遍；
 * - 没有保存动作的宿主不许装作接管；真有保存动作的宿主必须接管（r136 迁移：
 *   第四步「编辑目标内容」改成弹窗后确有「保存并重新校验」，不接管就是弹窗里按键毫无反馈）。
 */
import { describe, expect, it } from "vitest";
import { loadLocale, readScannedSource, sourceFiles } from "./scanUtils";

const LIB = "src/lib/saveShortcut.ts";
const EDITOR = "src/components/CodeEditor.tsx";
const APP = "src/App.tsx";

/** 编辑区里的接管：判据 + 拦默认行为 + 调宿主 onSave，三件缺一都算没接管成功。 */
const EDITOR_HANDOFF = /if \(onSave && isSaveShortcutKey\(e\)\) \{\s*e\.preventDefault\(\);\s*onSave\(\);/;
/** 宿主接线点。 */
const WIRING = /onSave=\{/g;
/** 自己手搓保存判据（绕过单一事实源）。 */
const HANDROLLED_KEY = /key\s*===\s*"s"/;

function countMatches(re: RegExp, source: string): number {
  return Array.from(source.matchAll(re)).length;
}

describe("保存快捷键只认一个出口（波27 R47）", () => {
  it("单一事实源存在，且判据与兜底都从它导出", () => {
    const lib = readScannedSource(LIB);
    expect(lib).toMatch(/export function isSaveShortcutKey\(/);
    expect(lib).toMatch(/export function useBlockNativeSaveShortcut\(/);
    // 兜底必须尊重「已经有人接管」，否则重复保存
    expect(lib).toMatch(/if \(e\.defaultPrevented\) return;/);
    // 兜底必须是冒泡阶段监听（React 合成事件在根容器派发，比 window 早，defaultPrevented 才可信）
    expect(lib).toMatch(/window\.addEventListener\("keydown", onKeyDown\)/);
  });

  it("编辑区真的接管了 Ctrl/Cmd+S：判据、preventDefault、onSave 一次到位", () => {
    const editor = readScannedSource(EDITOR);
    expect(editor).toMatch(/onSave\?: \(\) => void;/);
    expect(editor).toMatch(EDITOR_HANDOFF);
    expect(editor).toContain('from "../lib/saveShortcut"');
  });

  it("宿主接线点不少于 2 处（编辑抽屉 + 新建配置弹窗），防止守卫空转", () => {
    const wired = sourceFiles()
      .filter((file) => file !== EDITOR && file !== LIB)
      .map((file) => ({ file, hits: countMatches(WIRING, readScannedSource(file)) }))
      .filter((entry) => entry.hits > 0);
    // 轮60 第三步人工微调、r136 第四步「编辑目标内容」都真有保存动作，一起入清单
    expect(wired.map((entry) => entry.file).sort()).toEqual([
      "src/components/ApplyPlanView.tsx",
      "src/components/ConfigBrowser.tsx",
      "src/components/ConfigEditor.tsx",
      "src/components/DiffView.tsx",
      "src/components/TargetTunePanel.tsx",
    ]);
    expect(countMatches(WIRING, sourceFiles().map(readScannedSource).join("\n"))).toBeGreaterThanOrEqual(2);
  });

  it("变更计划的目标内容编辑器接管 Ctrl+S（r136 从「不许接管」迁移为「必须接管」）", () => {
    // 迁移前的断言是 not.toMatch(WIRING)，理由是「它没有保存动作」——这个前提已经不成立：
    // 同一个向导里第三步按 Ctrl+S 能存正文，第四步过去按了没反应，两边不对称就是缺陷。
    // 现在要求它出现，并且接的必须是提交这条路径（不是随便一个空函数）。
    const host = readScannedSource("src/components/ApplyPlanView.tsx");
    expect(host).toMatch(WIRING);
    expect(host).toMatch(/onSave=\{commitEdit\}/);
  });

  it("App 挂了全局兜底，浏览态/列表/设置页也不会漏出原生保存对话框", () => {
    const app = readScannedSource(APP);
    expect(app).toMatch(/useBlockNativeSaveShortcut\(\);/);
  });

  it("保存判据只有单一事实源一份，别处不许手搓", () => {
    const offenders = sourceFiles()
      .filter((file) => file !== LIB)
      .filter((file) => HANDROLLED_KEY.test(readScannedSource(file)));
    expect(offenders).toEqual([]);
  });

  it("保存按钮的快捷键提示走 i18n，zh/en 都写明 Ctrl+S", () => {
    for (const file of ["zh-CN.json", "en-US.json"]) {
      const locale = loadLocale(file);
      expect(locale["config.saveShortcutHint"]).toBeDefined();
      expect(locale["config.saveShortcutHint"]).toContain("Ctrl+S");
    }
    for (const file of ["src/components/ConfigBrowser.tsx", "src/components/ConfigEditor.tsx"]) {
      expect(readScannedSource(file)).toMatch(/title=\{t\("config\.saveShortcutHint"\)\}/);
    }
  });
});
