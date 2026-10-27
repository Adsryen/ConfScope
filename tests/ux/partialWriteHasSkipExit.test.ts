/**
 * 半截写入在第 5 步必须有第二条出口（轮98 A6）。
 *
 * 在此之前失败屏只有一句话能落地：「可在操作历史用本次备份快照回退」。
 * 用户想留着已经写成的那几条、把剩下的补完，界面上无路可走——重试这条路又被
 * 新鲜度判据堵死（前几条的成功看起来像"目标被人改了"）。等于失败之后只能全撤。
 *
 * 这条链跨两层：执行器要能说出"失败的是哪一项"（`failedItemId`），界面才能精确摘掉它；
 * 摘掉之后必须走原来那个执行入口，确认勾选、受保护目标手敲文本、执行中禁用一条都不许绕过。
 * 任何一环断掉，用户手上就剩一颗"看起来能做点什么"的假按钮，所以整条钉住。
 */
import { describe, expect, it } from "vitest";
import { loadLocale, readScannedSource } from "./scanUtils";

const EXEC = "src/lib/applyPlanExecution.ts";
const PLAN = "src/components/ApplyPlanView.tsx";

const zh = loadLocale("zh-CN.json");
const en = loadLocale("en-US.json");

describe("半截写入的跳过出口", () => {
  it("执行器把失败项 id 带进进度，界面才有东西可摘", () => {
    const exec = readScannedSource(EXEC);
    expect(exec).toMatch(/failedItemId\?: string;/);
    expect(exec).toMatch(/failedItemId: attemptedItemId \|\| undefined/);
    // 逐条写入时才记 id，整轮跑完再算就认不出失败的是哪一条
    expect(exec).toMatch(/attemptedItemId = write\.item\.id;/);
  });

  it("失败屏给「跳过这一项，继续剩下的」，且与回退出口并存", () => {
    const plan = readScannedSource(PLAN);
    const at = plan.indexOf('className="apply-skip-exit"');
    expect(at, "第二条出口被删了？用户只能全撤").toBeGreaterThan(-1);
    // 出口挂在半截写入那段事实陈述之后：先说"写到哪儿了"，再给下一步能做什么
    expect(plan.lastIndexOf('className="apply-partial-write"', at), "出口跑到失败屏之前了").toBeGreaterThan(-1);
    // 条件式必须整条挂着：前面再垫一个短路（false && …）也是"永远不给出口"
    expect(plan).toMatch(/\{executeError && canSkipFailedItem && \(\s*<div className="apply-skip-exit"/);
    expect(plan).toMatch(/className="apply-rollback-entry"/);
    expect(plan.indexOf('className="apply-skip-exit"'), "回退那颗被跳过那颗顶掉了？撤回路只剩文案").toBeLessThan(
      plan.indexOf('className="apply-rollback-entry"')
    );
  });

  it("出口只认执行器给出的失败项 id，且必须仍在勾选里", () => {
    const plan = readScannedSource(PLAN);
    expect(plan).toMatch(/executeProgress\?\.failedItemId/);
    expect(plan).toMatch(/selectedIds\.has\(executeProgress\.failedItemId\)/);
    expect(plan).toMatch(/executeError && executeProgress\?\.failedItemId/);
  });

  it("摘掉失败项后没得写就不给出口，按下去不能是空跑", () => {
    const plan = readScannedSource(PLAN);
    expect(plan).toMatch(/remainingAfterSkip\.length > 0/);
    expect(plan).toMatch(/item\.id !== skipCandidateId && isSelectableApplyItem\(item\)/);
  });

  it("守卫沿用执行按钮那一份，不另开捷径", () => {
    const plan = readScannedSource(PLAN);
    const decl = plan.slice(plan.indexOf("const skipDisabled"), plan.indexOf("const skipDisabled") + 200);
    expect(decl).toContain("!ready");
    expect(decl).toContain("anyRunning");
    expect(decl).toContain("executionSucceeded");
    expect(plan).toMatch(/disabled=\{skipDisabled\}/);
    // 灰按钮自己得说清缺哪一步（R19）
    const block = plan.slice(plan.indexOf('className="apply-skip-exit"'), plan.indexOf("apply-skip-exit-hint"));
    expect(block).toMatch(/className="btn-guard" title=\{blockerTitle\(skipBlockers\)\}/);
    expect(plan).toMatch(/skipBlockers = blockers\.filter\(\(blocker\) => blocker\.id !== "noSelection"\)/);
  });

  it("按下走的是同一个 runPlan，而且靠参数把勾选换掉", () => {
    const plan = readScannedSource(PLAN);
    const handler = plan.slice(plan.indexOf("const skipFailedItemAndContinue"), plan.indexOf("const runPlan"));
    expect(handler).toMatch(/setSelectedIds\(new Set\(remaining\)\)/);
    // setState 之后这一趟 runPlan 读到的还是旧勾选，失败项会被再写一遍
    expect(handler).toMatch(/void runPlan\(false, remaining\)/);
    expect(plan).toMatch(/const runPlan = async \(dryRun: boolean, selectedOverride\?: string\[\]\)/);
    expect(plan).toMatch(/const selectedItemIds = \(selectedOverride \?\? Array\.from\(selectedIds\)\)/);
    expect(plan.match(/await executeApplyPlan\(/g) ?? [], "跳过出口不许自己再调一次执行器").toHaveLength(1);
  });

  it("已达成的结论屏不吃成功横幅，项清单摊开且可选中复制", () => {
    const plan = readScannedSource(PLAN);
    expect(plan).toMatch(/nothingToWrite && \(\s*<div className="apply-already-applied"/);
    expect(plan).toMatch(/!nothingToWrite && executeNotice/);
    const at = plan.indexOf("result.alreadyAppliedOnly)");
    expect(at, "全部已达成的分支被删了？").toBeGreaterThan(-1);
    const branch = plan.slice(at, plan.indexOf("} else {", at));
    expect(branch).toMatch(/setNothingToWrite\(true\)/);
    expect(branch, "什么都没写却点亮成功态，晋级面板与工作流都会跟着说谎").not.toMatch(/setExecutionSucceeded\(true\)/);

    const css = readScannedSource("src/styles.css");
    // 可选中名单是整条选择器列表，只有真列在里面才算数（它自己的规则块不等于可选中）
    const selectableRule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(
      ([, selectors, body]) => /user-select:\s*text/.test(body) && selectors.includes(".apply-partial-write")
    );
    expect(selectableRule, "整段可选中名单不见了？结论行抄不走只能逐字看").toBeTruthy();
    const selectableList = selectableRule![1]
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    expect(selectableList, "已达成的结论行没进可选中名单").toContain(".apply-already-applied");
    expect(/\.apply-skip-exit \.btn \{[^}]*min-height:\s*24px/.test(css), "按钮命中高度不到 24px").toBe(true);
  });

  it("成功横幅的「已应用 N 项」跟着执行器那份落笔清单，不许按勾选数重算", () => {
    const plan = readScannedSource(PLAN);
    const at = plan.indexOf("setExecutionSucceeded(true)");
    expect(at, "成功分支不见了？").toBeGreaterThan(-1);
    const branch = plan.slice(at, plan.indexOf("auditSessionEvent(session", at));
    // 回读结论的 total 就是这一轮真写了几条；勾了却没写（已是这一版）不能算进横幅
    expect(branch).toMatch(/const appliedCount = writeVerificationResult\?\.total \?\? selectedItemIds\.length/);
    expect(branch, "横幅又拿勾选数当已应用数：与同一轮操作的「本次写入 N 项」对不上").not.toMatch(/count: selectedItemIds\.length/);
    expect(branch.match(/count: appliedCount/g) ?? [], "两条成功文案少了一条按落笔数报数").toHaveLength(2);
    // 同源的根在执行器那侧：回读清单、落笔清单、累积写入项都出自同一个 if (!itemError)
    const exec = readScannedSource(EXEC);
    const block = exec.slice(exec.indexOf("if (!itemError) {"), exec.indexOf("if (itemError) throw new Error(itemError)"));
    expect(block).toMatch(/writtenWrites\.push/);
    expect(block).toMatch(/writtenLocations\.add/);
  });

  it("出口文案中英成对，占位符不偏科", () => {
    for (const [name, tree] of [
      ["zh", zh],
      ["en", en],
    ] as const) {
      expect(tree["apply.skipFailedItem"], `${name} 少了出口按钮文案`).toBeTruthy();
      expect(tree["apply.skipFailedItemHint"], `${name} 的提示没说跑几项`).toContain("{count}");
      expect(tree["apply.alreadyAppliedOnly"], `${name} 少了"没有写入"那句`).toBeTruthy();
      expect(tree["apply.skipFailedItem"], `${name} 的按钮文案太长了，会撑破一行`).not.toMatch(/[。.]$/);
    }
  });
});
