/**
 * 「半截写入 → 去操作历史回退」这条链必须一路接通（轮66 WP-2）。
 *
 * 缺陷本体是一句没人兑现的承诺：计划页失败后告诉用户「此前写入的项已在目标生效，
 * 可在操作历史用本次备份快照回退」，但页面上没有任何入口，回退按钮埋在中立栏
 * 「操作历史」的第二层里，还得先在几十条记录里认出本次那条。
 *
 * 这条链跨三个文件（ApplyPlanView 出按钮 → App 传参并切模式 → OperationHistoryView 定位），
 * 组件测试各管一段，看不出中间断在哪一环，所以这里按「链路每环都在」钉死：
 *   1. 计划页只在「真落了内容 + 真拿到记录 id + 调用方真给了回调」同时成立时放出入口；
 *   2. App 把回调接到 openHistoryAtRecord，该函数必须切到 history 模式；
 *   3. 历史页真的读 focusRecordId，列表行真的带 data-record-id（定位靠它认领，缺了就永远找不到行）；
 *   4. 三份文案在中英文里都在，{id} 占位符不许在某一侧丢掉。
 * 少任何一环，用户点下去就是「跳过去了却什么都没看见」。
 */
import { describe, expect, it } from "vitest";
import { loadLocale, readScannedSource } from "./scanUtils";

const PLAN = "src/components/ApplyPlanView.tsx";
const APP = "src/App.tsx";
const HISTORY = "src/components/OperationHistoryView.tsx";

const zh = loadLocale("zh-CN.json");
const en = loadLocale("en-US.json");

describe("计划页失败态的回退入口接线", () => {
  it("入口要求「已写入 > 0」「有记录 id」「调用方给了回调」三者同时成立", () => {
    const plan = readScannedSource(PLAN);
    const start = plan.indexOf('apply-rollback-entry');
    expect(start, "计划页找不到回退入口").toBeGreaterThan(-1);
    const condition = plan.slice(Math.max(0, plan.lastIndexOf("&&", start) - 600), start);
    expect(condition).toContain("executeError");
    expect(condition).toContain("executeProgress.completedWrites > 0");
    expect(condition).toContain("executeHistoryId");
    expect(condition).toContain("onOpenHistory");
  });

  it("点击把本次记录 id 交给回调，而不是随便跳一页", () => {
    const plan = readScannedSource(PLAN);
    expect(plan).toMatch(/onOpenHistory\(\s*executeHistoryId\s*\)/);
    expect(plan).toMatch(/setExecuteHistoryId\(\s*resultHistoryId \?\? null\s*\)/);
    const resets = plan.match(/setExecuteHistoryId\(null\)/g) ?? [];
    expect(resets.length, "清理点少于 3 处，会在新执行前留旧记录 id").toBeGreaterThanOrEqual(3);
  });

  it("App 把回调接到 openHistoryAtRecord，并且真的切到操作历史模式", () => {
    const app = readScannedSource(APP);
    expect(app).toMatch(/onOpenHistory=\{openHistoryAtRecord\}/);
    const decl = app.indexOf("const openHistoryAtRecord");
    expect(decl).toBeGreaterThan(-1);
    const body = app.slice(decl, decl + 300);
    expect(body).toContain("setHistoryFocusRecordId(recordId)");
    expect(body).toContain('setMode("history")');
    expect(app).toMatch(/focusRecordId=\{historyFocusRecordId\}/);
    expect(app).toMatch(/onFocusConsumed=\{\(\) => setHistoryFocusRecordId\(null\)\}/);
  });

  it("历史页真的读 focusRecordId，列表行真的带 data-record-id", () => {
    const history = readScannedSource(HISTORY);
    expect(history).toContain("focusRecordId");
    expect(history).toMatch(/data-record-id=\{record\.id\}/);
    expect(history).toMatch(/dataset\.recordId === focusRecordId/);
    expect(history).toContain('setFilterConnection("")');
    expect(history).toContain('setFilterType("")');
    expect(history).toContain('setFilterDataId("")');
    expect(history).toMatch(/if \(!focusRecordId \|\| !localRecordsLoaded\) return/);
  });

  it("三份文案中英都在，占位符不偏科", () => {
    for (const key of ["apply.openHistoryToRollback", "apply.openHistoryToRollbackHint", "operationHistory.focusRecordMissing"]) {
      expect(zh[key], `zh 缺 ${key}`).toBeTruthy();
      expect(en[key], `en 缺 ${key}`).toBeTruthy();
    }
    for (const [name, tree] of [["zh", zh], ["en", en]] as const) {
      expect(tree["operationHistory.focusRecordMissing"], `${name} 的文案丢了 {id}`).toContain("{id}");
    }
  });

  it("样式里给入口留了规则，按钮命中高度不小于 24", () => {
    const css = readScannedSource("src/styles.css");
    const block = /\.apply-rollback-entry \{([^}]*)\}/.exec(css);
    expect(block, "缺少 .apply-rollback-entry 规则").not.toBeNull();
    const btnRule = /\.apply-rollback-entry \.btn \{([^}]*)\}/.exec(css);
    expect(btnRule, "缺少按钮命中高度规则").not.toBeNull();
    expect(/min-height:\s*24px/.test(btnRule![1]), "按钮命中高度没到 24px").toBe(true);
  });
});
