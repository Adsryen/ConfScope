/**
 * 「目标已经是这一版」这条判据只许有一处实现（轮98 A1/A2/A3/A5）。
 *
 * 起因是半截写入后重试必然再失败一次：前面写成功的那几项，目标现值当然和「写入前」不等，
 * 于是被新鲜度判据当成过期，整份计划连同没写过的剩下几项一起堵死。解法不是放宽判据，
 * 而是让写前豁免和写后回读确认问同一个问题。
 *
 * 这里守的正是那条共享关系。它一旦散成两份实现，就会出现没人能解释的矛盾：
 * 回读说「这一条没写成」、写前说「这一条不用写」，用户既不能前进也不能回退。
 * 豁免的边界（只豁免 target 侧、豁免项全程按 effective 计划走、全豁免时不记历史）
 * 也一起钉住——它们都是执行链路上的口径，不是可以随时改回去的实现细节。
 */
import { describe, expect, it } from "vitest";
import { loadLocale, readScannedSource, sourceFiles } from "./scanUtils";

const SHARED = "src/lib/applyWriteEquivalence.ts";
const EXEC = "src/lib/applyPlanExecution.ts";

const zh = loadLocale("zh-CN.json");
const en = loadLocale("en-US.json");

describe("已达成判据只有一份实现", () => {
  it("共享谓词文件导出两条函数，且包装那条不改口", () => {
    const shared = readScannedSource(SHARED);
    expect(shared).toMatch(/export function writeMatchesReadBack\(/);
    expect(shared).toMatch(/export function isTargetAlreadyApplied\(/);
    // isTargetAlreadyApplied 必须转发，另算一遍就等于第二份实现
    const wrapper = shared.slice(shared.indexOf("export function isTargetAlreadyApplied"));
    expect(wrapper).toMatch(/return writeMatchesReadBack\(/);
    expect(wrapper, "包装处自己加比较规则，两份口径就分叉了").not.toMatch(/===\s*(current|write)\./);
  });

  it("执行器不再有本地副本，两处判定都从共享谓词进来", () => {
    const exec = readScannedSource(EXEC);
    expect(exec).not.toMatch(/function writeMatchesReadBack\(/);
    expect(exec).toMatch(/import \{ isTargetAlreadyApplied, writeMatchesReadBack, type ApplyWriteKind \} from "\.\/applyWriteEquivalence"/);
    // 写后回读确认与写前豁免
    expect(exec).toMatch(/verdict: writeMatchesReadBack\(write, current\) \? "confirmed" : "drifted"/);
    expect(exec).toMatch(/isTargetAlreadyApplied\(write, current\)/);
  });

  it("全仓只许有一份 writeMatchesReadBack 定义", () => {
    const definers = sourceFiles().filter((rel) => /function writeMatchesReadBack\(/.test(readScannedSource(rel)));
    expect(definers, `比较逻辑散成了多份：${definers.join(", ")}`).toEqual([SHARED]);
  });

  it("只豁免 target 侧：source 侧的变化一律留在过期清单里", () => {
    const exec = readScannedSource(EXEC);
    const split = exec.slice(exec.indexOf("function splitStaleVsApplied("), exec.indexOf("export const WRITE_VERIFY_DELAYS_MS"));
    expect(split.length, "拆分函数没在回读延迟之前？顺序变了这条守卫要跟着看").toBeGreaterThan(100);
    expect(split).toMatch(/if \(issue\.side === "source"\) \{\s*stale\.push\(issue\);\s*continue;/);
    expect(split, "target 侧不能无条件豁免").toMatch(/isTargetAlreadyApplied\(write, current\)/);
  });

  it("豁免项整条链路都不参与：写入、写前快照、备份、失败记账都用同一份计划", () => {
    const exec = readScannedSource(EXEC);
    for (const call of [
      "planWrites(executionPlan)",
      "beforeSnapshots(executionPlan",
      "prepareApplyExecutionSafety(executionPlan",
      "recordFailure(executionPlan",
    ]) {
      expect(exec, `这条还吃工作原计划，已达成项会被重新写一遍：${call}`).toContain(call);
    }
    for (const leak of ["planWrites(workingPlan)", "beforeSnapshots(workingPlan", "prepareApplyExecutionSafety(workingPlan"]) {
      expect(exec, `漏回原计划：${leak}`).not.toContain(leak);
    }
  });

  it("一项都没落笔时不记操作历史，也不点亮成功态", () => {
    const exec = readScannedSource(EXEC);
    const at = exec.indexOf("writes.length === 0 && alreadyAppliedLabels.length > 0");
    expect(at, "全部已达成的出口被删了？没有写入却记一条成功是假账").toBeGreaterThan(-1);
    const branch = exec.slice(at, at + 700);
    expect(branch.slice(0, branch.indexOf("return"))).not.toContain("recordOperation");
    expect(branch).toMatch(/alreadyAppliedOnly: true/);
    expect(branch).toMatch(/completeTask\(taskId, true\)/);
  });

  it("已达成条数在成功与半截失败两条出口里都要如实报出来", () => {
    const exec = readScannedSource(EXEC);
    const reports = exec.match(/alreadyApplied: alreadyAppliedLabels\.length \? alreadyAppliedLabels : undefined/g) ?? [];
    expect(reports.length, "少一处出口，失败屏就说不清哪几项没写").toBeGreaterThanOrEqual(3);
  });

  it("新文案中英成对，占位符不偏科，也不把内部字段名吐给用户", () => {
    const keys = [
      "apply.alreadyAppliedNote",
      "apply.alreadyAppliedOnly",
      "apply.alreadyAppliedItems",
      "apply.skipFailedItem",
      "apply.skipFailedItemHint",
    ];
    for (const key of keys) {
      expect(zh[key], `zh 缺 ${key}`).toBeTruthy();
      expect(en[key], `en 缺 ${key}`).toBeTruthy();
    }
    for (const [name, tree] of [
      ["zh", zh],
      ["en", en],
    ] as const) {
      expect(tree["apply.alreadyAppliedNote"], `${name} 的结论行没带条数`).toContain("{count}");
      expect(tree["apply.skipFailedItemHint"], `${name} 的出口提示没说跑几项`).toContain("{count}");
      expect(tree["apply.alreadyAppliedItems"], `${name} 的项清单没带项`).toContain("{refs}");
      for (const key of keys) {
        expect(tree[key], `${name} 的 ${key} 漏出内部字段名`).not.toMatch(/itemId|failedItemId|alreadyApplied|stale|ApplyPlan|executor/i);
      }
    }
  });
});
