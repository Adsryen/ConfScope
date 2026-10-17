/**
 * 错误文本只认一个出口（轮12 R44）。
 *
 * 扫出来的真 bug 有两类，都是「界面看得见、测试也钉住了」的脏显示：
 * - 直接 `String(e)`：`new Error("403")` 在连接测试里显示成 `Error: 403`，About / HistoryView /
 *   ConfigBrowser / BackupView / ConnectionManager 全中招（旧断言里成片的 `"Error: xxx"` 就是证据）；
 * - 抛出非 Error：`String({ code: "ENOENT" })` 得到 `[object Object]`，用户看到等于没报错。
 * 另外 `e instanceof Error ? e.message : String(e)` 在仓库里被手抄了 11 份，第二坑谁都没躲过。
 *
 * 口径统一收进 `src/lib/errorText.ts`，这里静态钉住，防止再长出第四个副本或新的 `String(e)`。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource, sourceFiles } from "./scanUtils";

/** 单一事实源自身允许出现下面这些写法（剥前缀、兜底 String 都在那里）。 */
const IMPLEMENTATION = "src/lib/errorText.ts";
/** 裸的 `String(<错误变量>)`：错误对象被直接摊成文本，前缀和 [object Object] 都从这来。 */
const BARE_STRING = /\bString\(\s*(e|err|error|reason|ex|cause|exception)\s*\)/g;
/** 手抄的正解副本：`x instanceof Error ? x.message : String(x)`。 */
const HANDROLLED = /[\w$]+\s+instanceof\s+Error\s*\?[\s\S]{0,40}?\.message\s*:/g;
/** 委托调用点。 */
const DELEGATED = /\berrorText\(/g;

function occurrences(re: RegExp, source: string): number[] {
  const hits: number[] = [];
  for (const m of source.matchAll(re)) hits.push(m.index ?? 0);
  return hits;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

describe("错误文本单一出口（波25 R44）", () => {
  const files = sourceFiles().filter((f) => f !== IMPLEMENTATION);

  it("src/ 里不许再出现裸的 String(<错误变量>)", () => {
    const violations: string[] = [];
    for (const file of files) {
      const source = readScannedSource(file);
      for (const at of occurrences(BARE_STRING, source)) {
        const line = lineOf(source, at);
        violations.push(`${file}:${line}: ${source.split("\n")[line - 1].trim().slice(0, 100)}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("不许再手抄 instanceof Error ? .message : String(...) 副本", () => {
    const violations: string[] = [];
    for (const file of files) {
      const source = readScannedSource(file);
      for (const at of occurrences(HANDROLLED, source)) {
        const line = lineOf(source, at);
        violations.push(`${file}:${line}: ${source.split("\n")[line - 1].trim().slice(0, 100)}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("委托到 errorText() 的调用点不得少于 50 处（防空转）", () => {
    let total = 0;
    for (const file of files) total += occurrences(DELEGATED, readScannedSource(file)).length;
    expect(total).toBeGreaterThanOrEqual(50);
  });

  it("既有私有包装必须只剩转调，不许夹带自己的判断", () => {
    // 历史上这些文件各有一份私有实现：errorMessage / toErrorMessage / errorText。
    const wrappers: Record<string, RegExp> = {
      "src/lib/applyExecutionSafety.ts": /function\s+errorMessage\b/,
      "src/lib/applyPlanExecution.ts": /function\s+errorMessage\b/,
      "src/lib/applyPlanDraft.ts": /function\s+errorText\b/,
      "src/lib/applyFollowup.ts": /function\s+errorText\b/,
      "src/components/SettingsView.tsx": /function\s+toErrorMessage\b/,
      "src/components/AppDataBackupPanel.tsx": /function\s+toErrorMessage\b/,
      "src/components/SSHManagerView.tsx": /function\s+errorMessage\b/,
      "src/components/DiffView.tsx": /function\s+errorText\b/,
    };
    for (const [file, re] of Object.entries(wrappers)) {
      expect(readScannedSource(file), file).not.toMatch(re);
    }
  });

  it("单一事实源要保住两条边界：不截断、只摘 Error/Exception 结尾的前缀", () => {
    const source = readScannedSource(IMPLEMENTATION);
    expect(source).toContain("export function errorText");
    expect(source).not.toMatch(/slice\(0\s*,\s*\d+\)/);
    expect(source).toMatch(/Error\|Exception/);
  });
});
