/**
 * 晋级入口必须是零：变更计划第5步不再有晋级入口（r113）。
 *
 * 轮76 把晋级入口从操作历史搬进第5步之后，用户真机反馈：第5步多出「晋级到生产」区块且整列滚不动。
 * r113 的结论是把入口整个撤掉——变更计划页只留「执行 + 写后回读 + 到操作历史回退 + 跳过」，
 * 晋级不再有任何页面入口（「以本次范围新建变更计划」未排期，接口按预留保留）。
 * 这个文件守「零」本身，而不是「入口搬到别处」：
 *   1. 面板文件本身已删，组件层任何文件不许再引用它；apply-promote-panel 容器不许留在计划页；
 *   2. 历史页不许再长出晋级的四件套与指路句——历史页是记录级读数面，不是写路径起点；
 *   3. 记录级面一个不少：标记沙箱验证、验证状态行、本次改动面板、旧 promote 记录的筛选与回退；
 *   4. 27 个 apply.promote* 文案键与 operationHistory.promoteEntryLocation 中英全删，
 *      第5步标题改「执行与验证」，写后回读提示改指操作历史、不再说「在本步验证」；
 *   5. isSandboxTarget 保留（r114 环境角色显式化接手，别提前删）；
 *   6. 预留接线不动：成功分支仍一次性读回本次记录、dry-run 不抹记录引用、App 仍传 startApply；
 *   7. 步骤条「回到某一步」只在返回落点真的是对比页时给出（落点判据全站一份）；
 *   8. lib 机制层保留在树里（晋级构造 / 写资格线 / 生产目标候选）：
 *      旧 promote 记录的回退计划仍会经这条路进来，数据形状与 lib 单点不许跟着删。
 * 变异自检（改坏任一条，本文件必须变红）：① 把 PostApplyPromotionPanel 文件复活或在组件层引用回来；
 * ② ApplyPlanView 里加回 apply-promote-panel 容器或挂载条件；③ 历史页长出晋级四件套或指路句；
 * ④ 删掉验证状态行或记录级读数键；⑤ 第5步标题加回「晋级」；⑥ 写后回读提示加回「在本步标记验证」；
 * ⑦ locale 里留一个 apply.promote* 孤儿键；⑧ 删掉 isSandboxTarget；⑨ App 不再传 onStartApply；
 * ⑩ lib 候选丢写资格线（只读连接重新挂回生产目标）。
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT, loadLocale, readScannedSource, sourceFiles } from "./scanUtils";

const HISTORY = "src/components/OperationHistoryView.tsx";
const APPLY_VIEW = "src/components/ApplyPlanView.tsx";
const APP = "src/App.tsx";
const FOLLOWUP = "src/lib/applyFollowup.ts";
const CSS = "src/styles.css";
const APPLY_ENTRY = "src/lib/applyEntry.ts";
const PANEL = "src/components/PostApplyPromotionPanel.tsx";

const zh = loadLocale("zh-CN.json");
const en = loadLocale("en-US.json");

const componentFiles = sourceFiles().filter((rel) => rel.startsWith("src/components/"));

describe("晋级入口是零（r113）", () => {
  it("面板文件已删，组件层没有文件再引用它", () => {
    expect(existsSync(join(PROJECT_ROOT, PANEL)), "PostApplyPromotionPanel 文件必须删掉").toBe(false);
    for (const rel of componentFiles) {
      const src = readScannedSource(rel);
      expect(src, `${rel} 还在引用已删的面板组件`).not.toContain("PostApplyPromotionPanel");
      expect(src, `${rel} 还在直接调晋级构造（树里只剩 lib 的定义）`).not.toContain("buildPromotionEntryFromVerification");
    }
    expect(readScannedSource(APPLY_VIEW), "计划页还留着面板容器类名").not.toContain("apply-promote-panel");
  });

  it("预留接线原样保留：成功分支读回本次记录、dry-run 不抹、App 仍传 startApply", () => {
    const applyView = readScannedSource(APPLY_VIEW);
    expect(applyView, "executeRecord 必须在执行结果回来时赋值一次（成功屏也要认得自己的现场）").toMatch(
      /setExecuteRecord\(resultHistoryId \? \(loadOperationHistory\(\)\.find\(\(item\) => item\.id === resultHistoryId\) \?\? null\) : null\);/
    );
    expect(applyView, "写完再干跑一次核对现状是自然动作，把记录引用抹掉等于把回退入口藏起来").toMatch(
      /if \(!dryRun\) \{\s*setExecuteHistoryId\(null\);\s*setExecuteRecord\(null\);\s*\}/
    );
    const renderBody = applyView.slice(
      applyView.indexOf("function ConfirmationPanel"),
      applyView.indexOf("export default function ApplyPlanView")
    );
    expect(renderBody, "渲染期读 store 会让每次重渲染都重新解析历史记录").not.toMatch(/loadOperationHistory\(\)/);
    expect(applyView).toMatch(
      /import \{ loadOperationHistory, recordOperation, type OperationRecord \} from "\.\.\/store\/operationHistory"/
    );
    expect(readScannedSource(APP), "App 保留把 startApply 传给计划页（预留接口，替代方案未排期）").toMatch(/onStartApply=\{startApply\}/);
    expect(applyView, "预留的 onStartApply 接口不许顺手删").toMatch(/onStartApply\?: \(payload: ApplyEntryPayload\) => void/);
  });

  it("isSandboxTarget 保留：环境角色判定由下一批显式化接手，别提前删", () => {
    expect(readScannedSource(APPLY_VIEW), "isSandboxTarget 被删了：执行「全部完成」的判定还在用它").toMatch(/function isSandboxTarget\(/);
  });
});

describe("历史页不许再长出写操作入口", () => {
  it("晋级的四件套与指路句不许回历史页", () => {
    const history = readScannedSource(HISTORY);
    for (const banned of [
      "history-promote-row",
      "startPromotionDryRun",
      "buildPromotionEntryFromVerification",
      "productionTargetsFor",
      "selectedPromotionTargetId",
      "promoteEntryLocation",
    ]) {
      expect(history, `历史页又出现了 ${banned}：晋级没有入口了，历史页只是记录级读数面`).not.toContain(banned);
    }
    // 生产目标选择器（原生 select + label）也不许回来：它是晋级的一半，留着就能被再拼一次。
    expect(history, "历史页又有了生产目标选择器").not.toMatch(/operationHistory\.productionTarget/);
    for (const banned of ["listNamespaces", "targetNamespace", "promoteNamespace"]) {
      expect(history, `历史页又出现了 ${banned}：晋级现场不在历史页`).not.toContain(banned);
    }
  });

  it("记录级事实与只读出口一个不少", () => {
    const history = readScannedSource(HISTORY);
    for (const kept of [
      "markSandboxVerified",
      "recordSandboxVerification",
      "findVerificationForRecord",
      "HistoryChangeDetailPanel",
      "opPromote",
      "verificationState",
    ]) {
      expect(history, `历史页少了 ${kept}：撤晋级入口不该顺手删掉状态读数与只读标签`).toContain(kept);
    }
    expect(history, "历史页不许留第二份查找实现：key 语义一改另一份就悄悄失真").not.toMatch(
      /const findVerification = |function findVerification\(/
    );
  });

  it("验证状态是一行只读读数，不是按钮的另一种写法", () => {
    const history = readScannedSource(HISTORY);
    const row =
      /followupRecord && followupSucceeded && \(\s*<div className="info-row">\s*<span className="info-label">\{t\("operationHistory\.verificationState"\)/;
    expect(row.test(history), "沙箱验证状态行必须挂在「有本次执行记录 + 执行成功」上，失败记录不配被标记").toBe(true);
    const css = readScannedSource(CSS);
    expect(css).toMatch(/\.history-verification-state\.verified/);
    expect(css).toMatch(/\.history-verification-state\.unverified/);
    expect(css, "旧的晋级行样式没跟着删掉，会留下无人认领的 CSS").not.toMatch(/\.history-promote-row/);
    expect(css, ".apply-promote-* 样式必须随面板一起删").not.toMatch(/\.apply-promote-/);
  });
});

describe("文案随撤除走干净", () => {
  const panelKeys = [
    "promotePanelTitle",
    "promotePanelIntro",
    "promoteStepReadback",
    "promoteStepVerification",
    "promoteReadbackConfirmed",
    "promoteReadbackUnconfirmed",
    "promoteVerificationVerified",
    "promoteVerificationUnverified",
    "promoteMarkVerified",
    "promoteRemarkVerified",
    "promoteMarking",
    "promoteMarked",
    "promoteBlockedByUnconfirmed",
    "promoteTargetLabel",
    "promoteTargetNoProductionMarker",
    "promoteNamespaceLabel",
    "promoteNamespaceInherit",
    "promoteNamespaceLoading",
    "promoteNamespaceLoadFailed",
    "promoteNamespaceMissing",
    "promoteNoTarget",
    "promoteAction",
    "promoteBuilding",
    "promoteBusyGuard",
    "promoteRequiresVerification",
    "promoteDryRunPromise",
    "promoteFailed",
  ];

  it("apply.promote* 整块与指路键中英全删", () => {
    for (const key of panelKeys) {
      expect(zh[`apply.${key}`], `apply.${key} 没从 zh 删掉：没有人再引用它`).toBeUndefined();
      expect(en[`apply.${key}`], `apply.${key} 没从 en 删掉：没有人再引用它`).toBeUndefined();
    }
    expect(zh["operationHistory.promoteEntryLocation"], "zh 还留着指路句").toBeUndefined();
    expect(en["operationHistory.promoteEntryLocation"], "en 还留着指路句").toBeUndefined();
  });

  it("早先迁走的旧键不许在 locale 里当孤儿", () => {
    for (const orphan of [
      "operationHistory.productionTarget",
      "operationHistory.promoteToTarget",
      "operationHistory.promoteRequiresVerification",
      "operationHistory.noProductionTarget",
    ]) {
      expect(zh[orphan], `${orphan} 已经没人引用了，别留在 zh 里`).toBeUndefined();
      expect(en[orphan], `${orphan} 已经没人引用了，别留在 en 里`).toBeUndefined();
    }
  });

  it("记录级读数键中英都在，占位符不偏科", () => {
    for (const key of [
      "operationHistory.markSandboxVerified",
      "operationHistory.remarkSandboxVerified",
      "operationHistory.verificationState",
      "operationHistory.verificationVerified",
      "operationHistory.verificationUnverified",
    ]) {
      expect(zh[key], `zh 缺 ${key}`).toBeTruthy();
      expect(en[key], `en 缺 ${key}`).toBeTruthy();
    }
    expect(zh["operationHistory.verificationVerified"]).toContain("{target}");
    expect(en["operationHistory.verificationVerified"]).toContain("{target}");
  });

  it("第5步标题是「执行与验证」，中英都不留晋级", () => {
    expect(zh["diff.workflowStep5"], "zh 标题加回了晋级").toBe("执行与验证");
    expect(en["diff.workflowStep5"], "en 标题还带着晋级").not.toMatch(/promot/i);
    expect(en["diff.workflowStep5"]).toBeTruthy();
  });

  it("写后回读提示改指操作历史，不再说「在本步标记验证」", () => {
    expect(zh["diff.workflowStep5Detail"], "步骤说明加回了晋级").not.toContain("晋级");
    expect(en["diff.workflowStep5Detail"], "步骤说明加回了晋级").not.toMatch(/promot/i);
    // 旧版断言「说明不许提操作历史」已倒过来：新文案指去操作历史是真实去处，必须指得到。
    expect(zh["apply.postWriteVerificationHintConfirmed"], "还在叫用户在本步标记验证").not.toContain("在这一步");
    expect(zh["apply.postWriteVerificationHintConfirmed"], "没指去操作历史").toContain("操作历史");
    expect(en["apply.postWriteVerificationHintConfirmed"], "还在说 verified here").not.toMatch(/verified here/i);
    expect(en["apply.postWriteVerificationHintConfirmed"], "没指去操作历史").toMatch(/operation history/i);
  });
});

describe("步骤条的回退点击跟着返回落点走（轮76）", () => {
  it("非对比流程的计划不接收回退点击，退回纯指示", () => {
    const applyView = readScannedSource(APPLY_VIEW);
    // 必须是同一个判据、同一个三元：写成 if/else 各渲一张卡片，迟早有一张漏掉。
    expect(
      applyView,
      "步骤条又无条件收下回退点击了：回退/晋级/审计/备份进来的计划点它只会落到别的页面，气泡那句「进度保留」是假话"
    ).toMatch(/onStepClick=\{applyEntryStepsAreNavigable\(entry\) \? onWorkflowStepClick : undefined\}/);
    // 卡片侧的既有约定：没有 onStepClick 就不画按钮、不给「回到「X」（进度保留）」这种承诺。
    const card = readScannedSource("src/components/DiffWorkflowCard.tsx");
    expect(card).toMatch(/const clickable = Boolean\(onStepClick\) && status === "completed"/);
    expect(card).toMatch(/if \(status === "completed" && onStepClick\) return t\("diff\.workflowBackTo"/);
  });

  it("返回落点全站只算一次", () => {
    const entry = readScannedSource(APPLY_ENTRY);
    expect(entry).toMatch(/export function applyEntryReturnMode\(payload: Pick<ApplyEntryPayload, "origin">\): string \{/);
    expect(entry).toMatch(/return payload\.origin\.returnMode \?\? payload\.origin\.mode;/);
    expect(entry).toMatch(/export function applyEntryStepsAreNavigable[\s\S]*return applyEntryReturnMode\(payload\) === "diff";/);
    const app = readScannedSource(APP);
    expect(app, "App 别再自己写一遍 returnMode ?? mode：两处判据迟早分家").toContain("applyEntryReturnMode(payload)");
    expect(app).not.toMatch(/const mode = payload\.origin\.returnMode \?\? payload\.origin\.mode;/);
    expect(readScannedSource(APPLY_VIEW), "计划页必须从 lib 引判据，不许复制一份比较").toContain(
      'import { applyEntryStepsAreNavigable, type ApplyEntryPayload } from "../lib/applyEntry";'
    );
  });
});

/**
 * 晋级落进哪一套租户，只在 lib 收口（轮76 S31 真机量出来的洞）。
 *
 * r113 之后这条机制暂时没有页面调用方，但保留在树里：旧 promote 记录的回退计划仍会经
 * 「回退→变更计划」这条路进来，lib 的命名空间口径与写资格线是数据形状的一部分，不许跟着面板删。
 */
describe("晋级机制的租户口径只在 lib 收口", () => {
  it("命名空间只有一份变量，计划项与入口端点共用", () => {
    const followup = readScannedSource(FOLLOWUP);
    const builder = followup.slice(followup.indexOf("export async function buildPromotionEntryFromVerification"));
    expect(builder).toMatch(/options\?: \{ targetNamespace\?: string \}/);
    expect(builder, "只有 undefined（调用方没点）才允许退回计划的目标命名空间").toMatch(
      /options\?\.targetNamespace === undefined \? plan\.target\.namespace/
    );
    // 传进来的空串是 Nacos 的公共空间本身（接口里 public 写作空 tenant），不是「没选」。
    expect(builder, "空串被当假值退回沙箱那个 id：用户点了 public，写的却是别的租户").toMatch(/: options\.targetNamespace\.trim\(\);/);
    expect(builder, "计划项的目标命名空间没跟着换：dry-run 报的位置和真正落笔的位置会各说一套").toMatch(
      /namespace: targetNamespace,\s*\};/
    );
    expect(builder, "入口端点还是沙箱那个 namespace id：新计划第4步看到的「目标」就是假的").toMatch(
      /target: endpointFromConnection\(productionTarget, targetNamespace\)/
    );
    expect(builder, "沙箱侧的位置不能被生产命名空间带跑：漂移复检与 source 读的都是 targetRef 之前那份现场").toMatch(
      /const sourceRef = toEntryRef\(item\.targetRef \?\? item\.ref\);/
    );
  });

  it("沙箱自己不在候选里，且默认指向带生产标记的那条", () => {
    const followup = readScannedSource(FOLLOWUP);
    const candidates = followup.slice(followup.indexOf("export function promotionTargetCandidates"));
    expect(candidates).toMatch(/conn\.id !== sandboxConnectionId/);
    expect(candidates, "候选顺序被改回连接表原序：下拉默认就可能停在 Dev 上").toMatch(/isProductionMarkedConnection\(conn, namespace\)/);
    expect(followup, "生产标记的判据另起了一套，必须复用执行层那组要求手敲确认的标记词").toMatch(/isProtectedApplyTarget\(connection, \{/);
  });

  it("写不进去的连接不进生产目标，apollo/consul 留在候选里", () => {
    const followup = readScannedSource(FOLLOWUP);
    const eligibility = followup.slice(followup.indexOf("export function isPromotionTargetConnection"));
    expect(eligibility, "资格线漏了一条：这一类连接照样挂在生产目标里，用户要到执行那步才收到错误").toMatch(
      /connection\.sourceType !== "local-snapshot" && !connection\.readonly && !connection\.forceLocalSnapshot/
    );
    const candidates = followup.slice(followup.indexOf("export function promotionTargetCandidates"));
    expect(candidates, "候选没有过资格线").toMatch(/conn\.id !== sandboxConnectionId && isPromotionTargetConnection\(conn\)/);
    expect(candidates, "apollo/consul 被顺手剔掉了：计划那条写链路在 Go 侧同样有 PublishConfig").not.toMatch(/provider === "nacos"/);
    expect(followup, "别复用浏览页那颗直接写出判据（isWritableConfigTarget 只认 nacos），两件事口径不同").not.toContain(
      "isWritableConfigTarget"
    );
  });
});
