/**
 * 操作历史「本次改动」面板的四条红线（轮75）。
 *
 * 这一节存在的理由是：批量写入的执行记录里没有正文，用户想知道「这次到底改了什么」
 * 唯一的出路是先生成一份计划跳去变更计划页看——那是把审计需求绕到写操作入口上解决。
 * 补了只读面板之后，风险反过来：审计视图一旦能碰到写路径，历史页就成了第二个执行入口。
 * 所以这里守四件事：
 *   1. 只给成功的执行记录挂（失败记录的 appliedLocations 记的是全部勾选项而非真正落笔的那几条）；
 *   2. 面板与它的取数层都不许引 api 下的写接口，也不许带任何「开始执行」类回调；
 *   3. 范围与标签口径必须复用（executableItemsForRecord / applyPlanItemLabel），
 *      标签不再手拼第三份、正文未知时不许比出假 diff；
 *   4. 文案中英齐、占位符不偏科，命中区与焦点样式按全站口径来。
 * 变异自检（改坏任一条，本文件必须变红）：把 before 取成 afterValue / 范围换成整份计划 /
 * 删掉 followupSucceeded 条件 / 手拼 ns/group/dataId / 去掉 contentKnown 闸门。
 */
import { describe, expect, it } from "vitest";
import { loadLocale, readScannedSource } from "./scanUtils";

const PANEL = "src/components/HistoryChangeDetailPanel.tsx";
const LIB = "src/lib/historyChangeDetail.ts";
const HISTORY = "src/components/OperationHistoryView.tsx";
const FOLLOWUP = "src/lib/applyFollowup.ts";
const EXECUTION = "src/lib/applyPlanExecution.ts";

const zh = loadLocale("zh-CN.json");
const en = loadLocale("en-US.json");

describe("历史页「本次改动」面板的挂载条件", () => {
  it("只给成功的执行记录挂面板", () => {
    const history = readScannedSource(HISTORY);
    expect(history, "面板要引 HistoryChangeDetailPanel").toMatch(/import HistoryChangeDetailPanel from "\.\/HistoryChangeDetailPanel"/);
    expect(
      /followupRecord && followupSucceeded && \(\s*<HistoryChangeDetailPanel record=\{selectedVisibleRecord\} getPlan=\{getApplyPlan\}/.test(
        history
      ),
      "面板的挂载条件必须是「apply 家族记录 + 执行成功」同时成立"
    ).toBe(true);
  });

  it("面板在详情里排在「配置内容」之前，用户先看到改动清单再看单份正文", () => {
    const history = readScannedSource(HISTORY);
    const panel = history.indexOf("<HistoryChangeDetailPanel");
    const content = history.indexOf("{selectedVisibleRecord.content && (");
    expect(panel).toBeGreaterThan(-1);
    expect(content, "详情里的正文块找不到，先确认渲染层有没有改名").toBeGreaterThan(-1);
    expect(panel, "「本次改动」被挪到正文块之后了").toBeLessThan(content);
  });

  it("计划读取器由调用方注入，面板不自己决定计划存哪儿", () => {
    const panel = readScannedSource(PANEL);
    expect(panel).toMatch(/getPlan: \(id: string\) => ApplyPlan \| null/);
    expect(panel, "面板不许直接读 store/applyPlans，否则测试与真机各走一份数据").not.toMatch(/store\/applyPlans/);
  });
});

describe("「本次改动」是只读审计视图", () => {
  it("面板与取数层都不碰 api 下的写接口", () => {
    for (const rel of [PANEL, LIB]) {
      const src = readScannedSource(rel);
      expect(src, `${rel} 不该引 api/ 下的任何东西（publish/delete 会无条件抛错，写路径只归变更计划）`).not.toMatch(/from "\.\.\/(src\/)?api\//);
      expect(src, `${rel} 不该引执行器`).not.toMatch(/applyPlanExecution/);
      expect(src, `${rel} 不该引计划写入 store`).not.toMatch(/saveApplyPlan|deleteApplyPlan/);
    }
  });

  it("面板不接受任何写入口回调", () => {
    const panel = readScannedSource(PANEL);
    for (const forbidden of ["onStartApply", "onExecute", "publishConfig", "deleteConfig"]) {
      expect(panel, `面板里出现了 ${forbidden}，历史页就变成第二个执行入口了`).not.toContain(forbidden);
    }
  });

  it("取数层的写前/写后各读各的字段，不许两边都用 afterValue", () => {
    const lib = readScannedSource(LIB);
    const before = /const before = textOf\(item\.(\w+)\)/.exec(lib);
    expect(before, "写前正文取数点找不到").not.toBeNull();
    expect(before![1], "写前正文应取 targetValue").toBe("targetValue");
    const afterLine = /const after = [^\n]*/.exec(lib);
    expect(afterLine, "写后正文取数点找不到").not.toBeNull();
    expect(afterLine![0], "写后正文应取 afterValue").toContain("textOf(item.afterValue)");
    expect(afterLine![0], "写后正文不许退回 targetValue").not.toContain("textOf(item.targetValue)");
  });

  it("删除项的写后读作「目标上不再保留」，不是「正文是空串」", () => {
    const lib = readScannedSource(LIB);
    expect(lib).toMatch(/item\.action === "delete" \? \{ text: "", known: true \} : textOf\(item\.afterValue\)/);
  });

  it("正文未知时只给提示，不放 diff", () => {
    const panel = readScannedSource(PANEL);
    const hint = panel.indexOf("{!item.contentKnown && (");
    const gate = panel.indexOf("{item.contentKnown && (");
    expect(hint, "缺少正文未知的提示分支").toBeGreaterThan(-1);
    expect(gate, "diff 渲染必须带 contentKnown 闸门，拿空串比出来的结论是假的").toBeGreaterThan(-1);
    const diff = panel.indexOf("<UnifiedDiff", gate);
    expect(diff, "闸门分支里没有渲染 diff").toBeGreaterThan(-1);
    const between = panel.slice(gate, diff);
    expect(between, "闸门与 diff 之间出现了闭合，说明 diff 其实落在闸门外面").not.toContain("</>");
    expect(between, "正文已知的分支要先给写前/写后摘要再给 diff").toContain("history-change-sides");
    expect(hint, "提示分支要出现在 diff 之前").toBeLessThan(diff);
  });
});

describe("口径只有一份实现", () => {
  it("执行范围走 executableItemsForRecord，不是整份计划", () => {
    const lib = readScannedSource(LIB);
    expect(lib).toMatch(/import \{[^}]*executableItemsForRecord[^}]*\} from "\.\/applyFollowup"/);
    expect(lib, "范围必须按记录勾选的项收口，没勾选项既没被写也不该出现在审计清单里").toContain("executableItemsForRecord(plan, record)");
    expect(lib).not.toMatch(/executableItems\(plan\)/);
  });

  it("人读标签只有 applyPlanItemLabel 一份，其余都是转发", () => {
    const lib = readScannedSource(LIB);
    expect(lib).toMatch(/applyPlanItemLabel\(item\.targetRef \?\? item\.ref\)/);
    for (const rel of [PANEL, LIB]) {
      expect(readScannedSource(rel), `${rel} 又在手拼 ns/group/dataId`).not.toMatch(/`\$\{[^}]*namespace\}\/\$\{[^}]*group\}\/\$\{[^}]*dataId\}`/);
    }
    expect(readScannedSource(FOLLOWUP), "applyFollowup 的 itemLabel 应转发到唯一实现").toContain("return applyPlanItemLabel(ref)");
    expect(readScannedSource(EXECUTION), "执行器的 itemRefLabel 应转发到唯一实现").toContain("return applyPlanItemLabel(ref)");
  });

  it("差异渲染复用 UnifiedDiff，不另造一份带行号/搜索的 diff", () => {
    const panel = readScannedSource(PANEL);
    expect(panel).toMatch(/import UnifiedDiff from "\.\/UnifiedDiff"/);
    expect(panel).toMatch(/oldText=\{item\.beforeText\} newText=\{item\.afterText\}/);
  });

  it("切换记录时归零展开态与筛选，条件写在 record.id 上", () => {
    const panel = readScannedSource(PANEL);
    expect(
      panel,
      "展开态/筛选没有跟着记录切换归零，会停在上一条的现场"
    ).toMatch(/useEffect\(\(\) => \{\s*setExpandedItemId\(null\);\s*setOnlyChanged\(false\);\s*\}, \[record\.id\]\)/);
  });
});

describe("文案与样式", () => {
  it("面板用到的 changeDetail* 文案中英都在，占位符不偏科", () => {
    const keys = new Set<string>();
    for (const rel of [PANEL, LIB]) {
      for (const match of readScannedSource(rel).matchAll(/"operationHistory\.(changeDetail[A-Za-z]*)"/g)) {
        keys.add(`operationHistory.${match[1]}`);
      }
    }
    // 取数层给的是 reasonKey 字符串，渲染层直接 t(detail.reasonKey)，扫描器抓不到字面量，这里显式补上。
    keys.add("operationHistory.changeDetailNoPlan");
    keys.add("operationHistory.changeDetailPlanExpired");
    expect(keys.size, "一个文案都没扫到，先确认键名有没有改名").toBeGreaterThan(10);
    for (const key of keys) {
      expect(zh[key], `zh 缺 ${key}`).toBeTruthy();
      expect(en[key], `en 缺 ${key}`).toBeTruthy();
    }
    expect(zh["operationHistory.changeDetailSummary"]).toContain("{total}");
    expect(en["operationHistory.changeDetailSummary"]).toContain("{total}");
    expect(zh["operationHistory.changeDetailSummary"]).toContain("{changed}");
    expect(en["operationHistory.changeDetailSummary"]).toContain("{changed}");
  });

  it("动作胶囊复用变更计划页的动作词，不再发一套同义词", () => {
    const panel = readScannedSource(PANEL);
    for (const key of ["create", "overwrite", "delete", "skip", "parse_error"]) {
      expect(panel, `动作 ${key} 没有映射到 apply.actions.${key}`).toContain(`"apply.actions.${key}"`);
      expect(zh[`apply.actions.${key}`], `zh 缺 apply.actions.${key}`).toBeTruthy();
      expect(en[`apply.actions.${key}`], `en 缺 apply.actions.${key}`).toBeTruthy();
    }
  });

  it("行是按钮：命中高度与焦点样式按全站口径，筛选行不被标题样式大写", () => {
    const css = readScannedSource("src/styles.css");
    const itemRule = /\.history-change-item \{([^}]*)\}/.exec(css);
    expect(itemRule, "缺少 .history-change-item 规则").not.toBeNull();
    expect(/min-height:\s*(2[4-9]|[3-9]\d)px/.test(itemRule![1]), "行命中高度没到 24px").toBe(true);
    const focusRule = /\.history-change-item:focus-visible \{([^}]*)\}/.exec(css);
    expect(focusRule, "按钮行缺 :focus-visible 样式，键盘用户看不到落点").not.toBeNull();
    expect(focusRule![1]).toContain("var(--focus-outline)");
    const filterRule = /\.history-change-filter \{([^}]*)\}/.exec(css);
    expect(filterRule, "缺少筛选行规则").not.toBeNull();
    expect(filterRule![1], "筛选行会被 label 的大写小标题样式带跑").toContain("text-transform: none");
  });
});
