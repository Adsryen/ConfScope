/**
 * 晋级入口只准长在变更计划第5步（轮76）。
 *
 * 起因是用户一句话：「操作历史页面不应该有晋级的功能吧！」——成立。
 * 操作历史是审计面，晋级是写路径的起点。把它摆在历史页，等于给写入开第二个入口，
 * 而且那个入口离执行现场最远：用户真正需要它的时刻是刚在沙箱写完、正盯着回读结论的那一秒。
 * 迁移之后风险反过来：第5步的面板一旦能自己落笔，全站唯一的写出口（计划 + dry-run + 手敲确认）就漏了。
 * 所以这里守六件事：
 *   1. 历史页里晋级的四件套（生产目标选择器 / 晋级按钮 / 构造调用 / 行容器）一个都不许回来，
 *      但「标记沙箱验证」与只读的验证状态、本次改动面板必须还在；
 *   2. 第5步面板的挂载条件四项同时成立：执行成功 + 有本次记录 + 调用方给了 onStartApply（dry-run 走不到成功档）；
 *   3. 面板只产入口不写目标：不许碰 publish/delete，也不许引执行器；
 *   4. 未验证 / 回读有未确认项时按钮真灰，原因挂在 .btn-guard 上而不是只靠 title；
 *   5. 标记验证与查找验证各只有一份实现（lib/applyFollowup），两个页面都走 import；
 *   6. 中英 key 齐平、占位符不偏科，迁走的旧键不许留在 locale 里当孤儿；
 *   7. 晋级落进哪一套租户由用户点明（命名空间口径单点在 lib/applyFollowup），历史页不许长出这一栏；
 *   8. 步骤条的「回到某一步」只在返回落点真的是对比页时给出——晋级/回退/审计/备份的计划
 *      没有对比现场可回，可点按钮 + 「进度保留」的气泡就是一句假话（落点判据全站一份）。
 * 变异自检（改坏任一条，本文件必须变红）：① 历史页把晋级块加回来；② 第5步去掉 executionSucceeded 条件；
 * ③ 面板里直接调 publishConfigFromApplyPlan；④ 历史页本地重写一份 findVerification；⑤ 晋级按钮去掉 !verification 守卫；
 * ⑥ App 与计划页各算一份返回落点；⑦ 步骤条无条件收下 onStepClick；⑧ 面板不再把命名空间交给 lib（回到「沿用沙箱 id」这个洞）；
 * ⑨ 候选没过写资格线（只读连接重新挂回生产目标）。
 */
import { describe, expect, it } from "vitest";
import { loadLocale, readScannedSource } from "./scanUtils";

const HISTORY = "src/components/OperationHistoryView.tsx";
const PANEL = "src/components/PostApplyPromotionPanel.tsx";
const APPLY_VIEW = "src/components/ApplyPlanView.tsx";
const APP = "src/App.tsx";
const FOLLOWUP = "src/lib/applyFollowup.ts";
const CSS = "src/styles.css";
const APPLY_ENTRY = "src/lib/applyEntry.ts";

const zh = loadLocale("zh-CN.json");
const en = loadLocale("en-US.json");

describe("历史页不许再长出写操作入口", () => {
  it("晋级的四件套整块撤出历史页", () => {
    const history = readScannedSource(HISTORY);
    for (const banned of ["history-promote-row", "startPromotionDryRun", "buildPromotionEntryFromVerification", "productionTargetsFor", "selectedPromotionTargetId"]) {
      expect(history, `历史页又出现了 ${banned}：晋级只有一个正规入口，就是变更计划第5步`).not.toContain(banned);
    }
    // 生产目标选择器（原生 select + label）也不许回来：它是晋级的一半，留着就能被再拼一次。
    expect(history, "历史页又有了生产目标选择器").not.toMatch(/operationHistory\.productionTarget/);
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
      "promoteEntryLocation",
    ]) {
      expect(history, `历史页少了 ${kept}：撤晋级入口不该顺手删掉状态读数与只读标签`).toContain(kept);
    }
  });

  it("验证状态是一行只读读数，不是按钮的另一种写法", () => {
    const history = readScannedSource(HISTORY);
    const row = /followupRecord && followupSucceeded && \(\s*<div className="info-row">\s*<span className="info-label">\{t\("operationHistory\.verificationState"\)/;
    expect(row.test(history), "沙箱验证状态行必须挂在「有本次执行记录 + 执行成功」上，失败记录不配被标记").toBe(true);
    const css = readScannedSource(CSS);
    expect(css).toMatch(/\.history-verification-state\.verified/);
    expect(css).toMatch(/\.history-verification-state\.unverified/);
    expect(css, "旧的晋级行样式没跟着删掉，会留下无人认领的 CSS").not.toMatch(/\.history-promote-row/);
  });
});

describe("第5步的晋级面板挂载条件", () => {
  it("执行成功 + 有本次记录 + 有 onStartApply 三者同时成立才渲染", () => {
    const applyView = readScannedSource(APPLY_VIEW);
    const mounted = /executionSucceeded && executeRecord && onStartApply && \(\s*<PostApplyPromotionPanel/.test(applyView);
    expect(mounted, "面板条件被削弱：dry-run 与失败/半截写入都拿不到 executionSucceeded && executeRecord").toBe(true);
    expect(applyView).toMatch(/import PostApplyPromotionPanel from "\.\/PostApplyPromotionPanel"/);
    // 回读结论直接决定能不能盖章：必须是它，而不是「看起来执行完了」。
    expect(applyView).toMatch(/readbackConfirmed=\{Boolean\(writeVerification\) && \(writeVerification\?\.unconfirmedCount \?\? 0\) === 0\}/);
  });

  it("成功后当场读回本次记录，不在渲染期读 localStorage", () => {
    const applyView = readScannedSource(APPLY_VIEW);
    expect(applyView, "executeRecord 必须在执行结果回来时赋值一次（F4：成功屏也要认得自己的现场）").toMatch(
      /setExecuteRecord\(resultHistoryId \? loadOperationHistory\(\)\.find\(\(item\) => item\.id === resultHistoryId\) \?\? null : null\)/
    );
    const renderBody = applyView.slice(applyView.indexOf("function ConfirmationPanel"), applyView.indexOf("export default function ApplyPlanView"));
    expect(renderBody, "渲染期读 store 会让每次重渲染都重新解析历史记录").not.toMatch(/loadOperationHistory\(\)/);
    expect(applyView).toMatch(/import \{ loadOperationHistory, recordOperation, type OperationRecord \} from "\.\.\/store\/operationHistory"/);
  });

  it("入口由调用方注入，App 负责换 entry 重跑完整五步", () => {
    expect(readScannedSource(APP), "App 没把 startApply 传给计划页，面板点了也没地方去").toMatch(/onStartApply=\{startApply\}/);
    const applyView = readScannedSource(APPLY_VIEW);
    expect(applyView).toMatch(/onStartApply\?: \(payload: ApplyEntryPayload\) => void/);
  });

  it("真实执行后 dry-run 不再抹掉本次记录引用", () => {
    const applyView = readScannedSource(APPLY_VIEW);
    expect(applyView, "写完再干跑一次核对现状是自然动作，把 executeRecord 抹掉等于把面板藏起来").toMatch(
      /if \(!dryRun\) \{\s*setExecuteHistoryId\(null\);\s*setExecuteRecord\(null\);\s*\}/
    );
  });
});

describe("晋级面板只产入口不写目标", () => {
  it("面板不碰任何写接口与执行器", () => {
    const panel = readScannedSource(PANEL);
    for (const banned of ["publishConfig", "deleteConfig", "executeApplyPlan", "applyPlanExecution"]) {
      expect(panel, `面板里出现了 ${banned}：写路径的唯一出口仍然是计划页第5步那条 dry-run 链路`).not.toContain(banned);
    }
    // 只允许读现值与命名空间清单这两件只读的事（算指纹 + 漂移复检 + 生产租户候选）。
    expect(panel).toMatch(/import \{ getConfigDocument, listNamespaces, type Namespace \} from "\.\.\/api\/nacos"/);
  });

  it("晋级的构造、查找与标记都走 lib 里那份唯一实现", () => {
    const panel = readScannedSource(PANEL);
    for (const shared of ["buildPromotionEntryFromVerification", "findVerificationForRecord", "promotionTargetCandidates", "recordSandboxVerification"]) {
      expect(panel, `面板没有 import lib/applyFollowup 的 ${shared}，八成是就地又抄了一份`).toContain(shared);
    }
    expect(panel, "面板不许自己算指纹：范围与指纹口径只有一份（executableItemsForRecord）").not.toMatch(/fingerprintApplyPlanValue|verifiedTargetFingerprints/);
    const history = readScannedSource(HISTORY);
    expect(history, "历史页不许留第二份查找实现：key 语义一改另一份就悄悄失真").not.toMatch(/const findVerification = |function findVerification\(/);
    expect(history).toMatch(/findVerificationForRecord/);
    expect(readScannedSource(FOLLOWUP)).toMatch(/export function promotionTargetCandidates/);
  });

  it("沙箱自己不在候选里，且默认指向带生产标记的那条", () => {
    const followup = readScannedSource(FOLLOWUP);
    const candidates = followup.slice(followup.indexOf("export function promotionTargetCandidates"));
    expect(candidates).toMatch(/conn\.id !== sandboxConnectionId/);
    expect(candidates, "候选顺序被改回连接表原序：下拉默认就可能停在 Dev 上").toMatch(/isProductionMarkedConnection\(conn, namespace\)/);
    expect(followup, "生产标记的判据另起了一套，必须复用执行层那组要求手敲确认的标记词").toMatch(/isProtectedApplyTarget\(connection, \{/);
  });
});

describe("灰态与原因必须是真的", () => {
  it("未验证与回读未确认都进 promoteReasons，按钮按长度灰", () => {
    const panel = readScannedSource(PANEL);
    expect(panel).toMatch(/const canVerify = readbackConfirmed && busy === null/);
    expect(panel, "去掉 !verification 这一条就是允许对没核对过的沙箱晋级").toMatch(/if \(!verification\) promoteReasons\.push\(t\("apply\.promoteRequiresVerification"\)\)/);
    expect(panel).toMatch(/if \(!selectedTarget\) promoteReasons\.push\(t\("apply\.promoteNoTarget"\)\)/);
    expect(panel).toMatch(/disabled=\{promoteReasons\.length > 0\}\s*aria-disabled=\{promoteReasons\.length > 0\}/);
    expect(panel, "标记按钮不能只灰不解释：原因写在 .btn-guard 的 title 上").toMatch(/<span className="btn-guard" title=\{canVerify \? undefined : blockedReason \|\| promoteReasons\.join\("\\n"\)\}>/);
  });

  it("选中目标没有生产标记时要说出来，而不是让栏目替它背书", () => {
    const panel = readScannedSource(PANEL);
    expect(panel).toMatch(/const sandboxNamespace = promotionTargetNamespace\(record, verification\)/);
    expect(panel, "沿用还是点明只能有一份值：两处各算一份就会指错租户").toMatch(/const effectiveNamespace =\s*namespaceChoice === INHERIT_SANDBOX_NAMESPACE \? sandboxNamespace : namespaceChoice/);
    expect(panel).toMatch(/isProductionMarkedConnection\(selectedTarget, effectiveNamespace\)/);
    expect(panel).toMatch(/apply-promote-target-note/);
    expect(zh["apply.promoteTargetNoProductionMarker"]).toContain("{target}");
    expect(en["apply.promoteTargetNoProductionMarker"]).toContain("{target}");
  });

  it("样式收在自己的容器里，警告色不被字段标题的灰阶吃掉", () => {
    const css = readScannedSource(CSS);
    for (const selector of [".apply-promote-panel", ".apply-promote-steps", ".apply-promote-actions", ".apply-promote-target", ".btn-guard"]) {
      expect(css, `缺少 ${selector} 规则`).toContain(selector);
    }
    const noteRule = /\.apply-promote-target > \.apply-promote-target-note,\s*\.apply-promote-namespace > \.apply-promote-namespace-note \{([^}]*)\}/.exec(css);
    expect(noteRule, "缺少生产目标/命名空间纠偏提示的样式（两块必须共用一份规则，别复制两遍）").not.toBeNull();
    expect(noteRule![1], "提示是警告级，不是灰字说明").toContain("var(--amber)");
    const panel = readScannedSource(PANEL);
    expect(panel, ".field > span 按位置给标题上灰阶（0,1,1），单类写 color 会被吃掉——别把警告挂上 .field-hint").not.toMatch(/className="field-hint apply-promote-target-note"/);
  });
});

describe("文案随迁移走干净", () => {
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

  it("apply.promote* 中英齐、占位符不偏科", () => {
    for (const key of panelKeys) {
      expect(zh[`apply.${key}`], `zh 缺 apply.${key}`).toBeTruthy();
      expect(en[`apply.${key}`], `en 缺 apply.${key}`).toBeTruthy();
    }
    for (const key of ["promoteReadbackUnconfirmed", "promoteBlockedByUnconfirmed"]) {
      expect(zh[`apply.${key}`], `${key} 的 zh 少了 {count}`).toContain("{count}");
      expect(en[`apply.${key}`], `${key} 的 en 少了 {count}`).toContain("{count}");
    }
    for (const key of ["promoteVerificationVerified"]) {
      for (const placeholder of ["{target}", "{namespace}", "{time}"]) {
        expect(zh[`apply.${key}`], `${key} 的 zh 少了 ${placeholder}`).toContain(placeholder);
        expect(en[`apply.${key}`], `${key} 的 en 少了 ${placeholder}`).toContain(placeholder);
      }
    }
    for (const [key, placeholders] of [
      ["promoteNamespaceInherit", ["{namespace}"]],
      ["promoteNamespaceLoadFailed", ["{target}"]],
      ["promoteNamespaceMissing", ["{namespace}", "{target}"]],
    ] as [string, string[]][]) {
      for (const placeholder of placeholders) {
        expect(zh[`apply.${key}`], `${key} 的 zh 少了 ${placeholder}`).toContain(placeholder);
        expect(en[`apply.${key}`], `${key} 的 en 少了 ${placeholder}`).toContain(placeholder);
      }
    }
  });

  it("生产目标为空时要把「为什么没有」说出来，而不是留一个空下拉", () => {
    // 本地快照与只读连接被剔出候选之后，这一栏完全可能真的为空：用户得知道是连接不给力，不是没配连接。
    expect(zh["apply.promoteNoTarget"], "没说清「本地快照与只读连接不能当目标」").toContain("只读");
    expect(en["apply.promoteNoTarget"], "same as zh").toMatch(/read-only/i);
  });

  it("面板引用的键都真存在，历史页新加的读数键也是", () => {
    for (const match of readScannedSource(PANEL).matchAll(/t\("(apply\.[A-Za-z]+)"/g)) {
      const key = match[1];
      expect(zh[key], `zh 缺 ${key}`).toBeTruthy();
      expect(en[key], `en 缺 ${key}`).toBeTruthy();
    }
    for (const key of [
      "operationHistory.markSandboxVerified",
      "operationHistory.remarkSandboxVerified",
      "operationHistory.verificationState",
      "operationHistory.verificationVerified",
      "operationHistory.verificationUnverified",
      "operationHistory.promoteEntryLocation",
    ]) {
      expect(zh[key], `zh 缺 ${key}`).toBeTruthy();
      expect(en[key], `en 缺 ${key}`).toBeTruthy();
    }
    expect(zh["operationHistory.verificationVerified"]).toContain("{target}");
    expect(en["operationHistory.verificationVerified"]).toContain("{target}");
  });

  it("晋级搬走后，指路的句子跟着改口径，不留旧路线", () => {
    expect(en["apply.postWriteVerificationHintConfirmed"]).toMatch(/mark the sandbox verified here/);
    expect(zh["apply.postWriteVerificationHintConfirmed"]).toContain("在这一步");
    // 工作流说明里那句「去操作历史标记验证并晋级」现在是假话：第5步就地标记，历史页没有晋级。
    expect(en["diff.workflowStep5Detail"], "还在把用户支去操作历史找晋级按钮").not.toMatch(/Operation History/);
    expect(zh["diff.workflowStep5Detail"], "还在把用户支去操作历史找晋级按钮").not.toContain("操作历史");
    // 迁走的旧键不许在 locale 里当孤儿（历史页只剩读数与提示，没有目标选择器与晋级按钮）。
    for (const orphan of ["operationHistory.productionTarget", "operationHistory.promoteToTarget", "operationHistory.promoteRequiresVerification", "operationHistory.noProductionTarget"]) {
      expect(zh[orphan], `${orphan} 已经没人引用了，别留在 zh 里`).toBeUndefined();
      expect(en[orphan], `${orphan} 已经没人引用了，别留在 en 里`).toBeUndefined();
    }
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
      "import { applyEntryStepsAreNavigable, type ApplyEntryPayload } from \"../lib/applyEntry\";"
    );
  });

  it("晋级的 dry-run 承诺不把用户支到不存在的第5步", () => {
    // 点完晋级落在新计划的第4步（生成并审核变更计划）：勾选与 dry-run 都在那儿做。
    expect(zh["apply.promoteDryRunPromise"], "还在叫用户回第5步勾选，页面上第5步是执行完之后才到的").not.toContain("第5步");
    expect(en["apply.promoteDryRunPromise"], "same as zh: that step number was wrong").not.toMatch(/step 5/i);
    expect(zh["apply.promoteDryRunPromise"]).toContain("新计划");
    expect(en["apply.promoteDryRunPromise"]).toMatch(/new change plan/i);
  });

});
/**
 * 晋级落进哪一套租户，只在 lib 收口（轮76 S31 真机量出来的洞）。
 *
 * Nacos/MSE 的 namespace id 每套集群各发各的（MSE 是 36 位 UUID）。第5步的面板以前没有这一栏，
 * 晋级把沙箱的 id 原样盖到生产集群上，计划把「这里没有这个租户」报成新建，
 * 用户以为在覆盖生产配置，其实写进没人读的租户。所以这里守四件事：
 * 命名空间只有一份变量、面板只交给 lib 不自己算、历史页不许长出这一栏、
 * 以及当不了目标的连接根本不进候选（本地快照/只读）。
 */
describe("晋级落进哪一套租户只在 lib 收口", () => {
  it("命名空间只有一份变量，计划项与入口端点共用", () => {
    const followup = readScannedSource(FOLLOWUP);
    const builder = followup.slice(followup.indexOf("export async function buildPromotionEntryFromVerification"));
    expect(builder).toMatch(/options\?: \{ targetNamespace\?: string \}/);
    expect(
      builder,
      "只有 undefined（面板没点）才允许退回计划的目标命名空间"
    ).toMatch(/options\?\.targetNamespace === undefined \? plan\.target\.namespace/);
    // 传进来的空串是 Nacos 的公共空间本身（接口里 public 写作空 tenant），不是「没选」。
    expect(
      builder,
      "空串被当假值退回沙箱那个 id：用户点了 public，写的却是别的租户"
    ).toMatch(/: options\.targetNamespace\.trim\(\);/);
    expect(builder, "计划项的目标命名空间没跟着换：dry-run 报的位置和真正落笔的位置会各说一套").toMatch(
      /namespace: targetNamespace,\s*\};/
    );
    expect(builder, "入口端点还是沙箱那个 namespace id：用户在第4步看到的「目标」就是假的").toMatch(
      /target: endpointFromConnection\(productionTarget, targetNamespace\)/
    );
    expect(
      builder,
      "沙箱侧的位置不能被生产命名空间带跑：漂移复检与 source 读的都是 targetRef 之前那份现场"
    ).toMatch(/const sourceRef = toEntryRef\(item\.targetRef \?\? item\.ref\);/);
  });

  it("面板把用户点出来的命名空间交给 lib，自己不算 id", () => {
    const panel = readScannedSource(PANEL);
    expect(panel, "面板不再传命名空间就等于回到「顺手沿用沙箱那个 id」这个洞").toMatch(
      /\{ targetNamespace: effectiveNamespace \}/
    );
    expect(panel, "public 既写作空串也写作 public，比对口径必须用全站那一份").toMatch(
      /import \{ normalizeNamespace \} from "\.\.\/lib\/configChangeBus";/
    );
    expect(panel).toMatch(/normalizeNamespace\(item\.namespace\) === normalizeNamespace\(effectiveNamespace\)/);
    expect(panel, "换目标连接不清空所选命名空间：上一套集群的 id 在这一套里毫无意义").toMatch(
      /setNamespaceChoice\(INHERIT_SANDBOX_NAMESPACE\);/
    );
    // 「沿用」必须有属于自己的哨兵值：拿空串当哨兵，public 这一档就永远选不中。
    expect(panel, "沿用沙箱的哨兵值不能是空串：那是 Nacos 公共空间的真实 id").toMatch(
      /const INHERIT_SANDBOX_NAMESPACE = "__inherit-sandbox-namespace__";/
    );
    expect(panel, "命名空间的有效值只许有一份").toMatch(
      /namespaceChoice === INHERIT_SANDBOX_NAMESPACE \? sandboxNamespace : namespaceChoice/
    );
    expect(panel, "公共空间的 id 是空串，括注出来就是「public ()」这种脏读数").toMatch(
      /label: item\.namespace && item\.namespaceShowName && item\.namespaceShowName !== item\.namespace/
    );
    expect(panel, "这一栏只读命名空间清单，不许多碰别的集群接口").not.toMatch(/configCenter[A-Z]/);
  });

  it("历史页不许长出命名空间这一栏", () => {
    const history = readScannedSource(HISTORY);
    for (const banned of ["listNamespaces", "targetNamespace", "promoteNamespace"]) {
      expect(history, `历史页又出现了 ${banned}：晋级的现场在第5步，历史页只是审计面`).not.toContain(banned);
    }
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
