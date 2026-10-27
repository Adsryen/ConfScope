/**
 * 复测桥的方法表必须覆盖产品真会调的 wailsjs 绑定面（轮94 建立，轮94b 收成精确口径）。
 *
 * 这条守卫的起因是一次真机取证，不是假想的洁癖：轮94 落位探针跑到第 11 档「关于」页时
 * toast 等 5s 没出现，读 DOM 读到的是 `document.getElementById("root").children.length === 0`
 * —— 整棵应用树被卸载成白屏。根因链很短：
 *   · About 挂载时取反馈事实：src/api/app.ts 的 getFeedbackDiagnostics() 直接调 wailsjs 包装；
 *   · wailsjs 的包装是 `() => app().GetFeedbackDiagnostics()`，**同步**取方法；
 *   · 复测桥 window.go.app.App 的方法表里没有这个名字 ⇒ 同步抛 TypeError；
 *   · 同步抛错绕过了调用点的 `.catch()`，在 render 阶段炸穿，React 卸载整个 root。
 * 也就是说「产品新增一条绑定、桥的方法表没跟着补」这件事，代价不是某条用例红，
 * 而是复测环境下这一页根本进不去 —— 所有覆盖这一页的断言都在读一张白屏，绿灯全是假的。
 *
 * 同一个缺口还有第二种、更难发现的形态（本轮按精确口径扫出 9 个名字）：调用点位于 async
 * 函数体内时，同步抛错被包成 rejection 被上层 catch 吞掉 ⇒ 页面不炸、用例不红，
 * 「存密码进系统凭据库」「打包应用数据备份」「导出配置源文件」在复测里只是静默空转。
 *
 * 判据取两个事实源的交集，不是「App.ts 里写了就得补」：
 *   A = wailsjs/go/app/App.ts 里 `app().X(` 形态的运行时绑定全集；
 *   B = src/（非测试文件）里以**值**形态 import 自 wailsjs/go/app/App 的名字（`type X` 只是类型，
 *       不构成运行时依赖）；
 *   要求 B ∩ A ⊆ WAILS_METHODS。Go 侧有、前端还不调用的方法不要求补替身
 *   （例：RunCredentialStorePoC —— src/ 查无调用，造出来只会多一个没人走的假替身）。
 */
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, readScannedSource, sourceFiles } from "./scanUtils";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const BRIDGE_TABLE_TS = "tests/retest/bridge/installRetestBridge.ts";
const BRIDGE_IMPL_TS = "tests/retest/bridge/retestBinding.ts";
const APP_IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*["'][^"']*wailsjs\/go\/app\/App["']/g;

/** 事实源 A：wailsjs 里以 `app().Name(` 形态暴露的运行时绑定名（注释已剥掉）。 */
function runtimeBindingNames(): Set<string> {
  const src = readScannedSource("wailsjs/go/app/App.ts");
  const names = new Set<string>();
  for (const m of src.matchAll(/app\(\)\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) names.add(m[1]);
  return names;
}

/** 事实源 B：产品代码以值形态导入的绑定名（`type X` 排除 —— 类型不产生运行时调用）。 */
function productImportedNames(): Set<string> {
  const names = new Set<string>();
  for (const rel of sourceFiles()) {
    const src = readScannedSource(rel);
    for (const m of src.matchAll(APP_IMPORT_RE)) {
      for (const raw of m[1].split(",")) {
        const spec = raw.trim();
        if (spec === "" || spec.startsWith("type ") || spec.startsWith("//")) continue;
        const name = spec.split(/\s+as\s+/)[0].trim();
        if (/^[A-Z][A-Za-z0-9_]*$/.test(name)) names.add(name);
      }
    }
  }
  return names;
}

/** 桥的方法表 WAILS_METHODS 里的名字。 */
function bridgeMethods(): string[] {
  const src = readScannedSource(BRIDGE_TABLE_TS);
  const block = /const WAILS_METHODS = \[([\s\S]*?)\] as const;/.exec(src);
  expect(block, "读不到 WAILS_METHODS 数组：桥的方法表写法变了，请同步改这条守卫").not.toBeNull();
  return Array.from((block as RegExpExecArray)[1].matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)).map((m) => m[1]);
}

/** 桥内实现了 case 的名字。 */
function bridgeCaseNames(): Set<string> {
  const src = readScannedSource(BRIDGE_IMPL_TS);
  const names = new Set<string>();
  for (const m of src.matchAll(/case "([A-Za-z_][A-Za-z0-9_]*)":/g)) names.add(m[1]);
  return names;
}

describe("retestBridgeCoversWailsBindings", () => {
  it("产品真调用的每个绑定名都在桥的方法表里", () => {
    const runtime = runtimeBindingNames();
    const called = productImportedNames();
    // 守卫自身失效的哨兵：任一侧扫空（提取正则/文件布局变了），不许悄悄变成永真
    expect(runtime.size, "wailsjs 一个绑定名都没扫到 ⇒ 提取正则失效").toBeGreaterThan(20);
    expect(called.size, "src/ 一个绑定导入都没扫到 ⇒ 导入提取失效").toBeGreaterThan(40);
    const required = Array.from(called)
      .filter((n) => runtime.has(n))
      .sort();
    expect(required.length, "交集为空 ⇒ 两个事实源对不上，守卫失效").toBeGreaterThan(40);
    const covered = new Set(bridgeMethods());
    const missing = required.filter((n) => !covered.has(n));
    expect(
      missing,
      `复测桥缺这些绑定名的替身：调用点在 render/effect 里会白屏炸穿，在 async 链里会被 catch 静默吞掉` +
        `（关于页白屏 = 前一种）。补进 ${BRIDGE_TABLE_TS} 的 WAILS_METHODS 并在 ${BRIDGE_IMPL_TS} 实现 case：\n${missing.join(", ")}`
    ).toEqual([]);
  });

  it("桥里实现了 case 的方法名必须同时出现在方法表（反向漂移）", () => {
    const implemented = bridgeCaseNames();
    expect(implemented.size, "一个 case 都没扫到 ⇒ 提取正则失效").toBeGreaterThan(20);
    const table = new Set(bridgeMethods());
    // 不留豁免名单：桥自有入口（Retest*Snapshot）也在表里才有意义，case 不在表里就是死代码。
    // 「表里有、桥里没 case」由 invokeInner 的 default 抛错兜住，另有 bridgeContract 守 Go 侧真名。
    const orphan = Array.from(implemented)
      .filter((n) => !table.has(n))
      .sort();
    expect(orphan, `桥实现了这些 case 却没登记进 WAILS_METHODS，浏览器侧调不到（等于死代码）：${orphan.join(", ")}`).toEqual([]);
  });

  it("正控：本轮补齐的名字既在表里也有 case", () => {
    // 钉住两次事故的同一批缺口，防止有人为了让上一例变绿，把名字从表里摘掉而不是补替身。
    const table = new Set(bridgeMethods());
    const cases = bridgeCaseNames();
    const pinned = [
      "GetFeedbackDiagnostics", // 关于页反馈事实（轮94 白屏）
      "AppendAuditEvent", // 审计写入（有 case 未入表 → 写审计静默降级）
      "ReadAuditLogLines", // 日志页读持久化行（同上 → 永远读不到）
      "WriteSecureSecret",
      "ReadSecureSecret",
      "DeleteSecureSecret", // 系统凭据库
      "ListAppDataSnapshotFiles",
      "RestoreAppDataSnapshotFiles", // 应用数据备份打包/还原
      "SelectConfigSourceExportDirectory",
      "ExportConfigSourceFiles", // 配置浏览导出源文件
    ];
    for (const name of pinned) {
      expect(table, `${name} 必须在 WAILS_METHODS 里`).toContain(name);
      expect(cases.has(name), `${name} 必须在桥里有 case，否则调用会撞 invokeInner 的 default 抛错`).toBe(true);
    }
    // 前端不调用的绑定不许被顺手补进表里当假替身（RunCredentialStorePoC 的 src 调用数恒为 0）
    expect(sourceFiles().some((rel) => readScannedSource(rel).includes("RunCredentialStorePoC"))).toBe(false);
    expect(readFileSync(join(PROJECT_ROOT, "src/api/app.ts"), "utf8")).toContain("GetFeedbackDiagnostics()");
  });
});
