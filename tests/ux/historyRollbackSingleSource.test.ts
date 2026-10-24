/**
 * 「这条操作记录能不能回退」只许有一份判据（轮72A）。
 *
 * 缺陷本体是同一块详情面板里的两句互相打脸的话：
 * 上面写「回滚状态：不可回滚 / 配置变更计划记录需要生成回退 dry-run」，
 * 下面挂着能点的「生成回退计划」按钮。根因是判据有两套——
 * `store/operationHistory.isRollbackableOperation()` 在轮42 禁直写后被改成恒 `return false`
 * （死口径，`rollbackUnavailableReason()` 的分支永不可达），
 * 真正生效的是 `lib/applyFollowup.canBuildRollbackEntry()`（现场齐不齐）。
 * 数据源在写入侧：`applyExecutionSafety.buildApplyOperationHistoryInput()` 当年把
 * `rollbackable:false` + 原因键一起塞进每条记录，界面照着那句谎话渲染。
 *
 * 这条守卫钉四件事，防止复发：
 * 1. 死口径不许被粘回来（store 不再导出那两个函数，全仓不许引用）；
 * 2. 界面不许自己判定能力，也不许拿存档字段 `record.rollbackable` 当否决；
 * 3. 回退入口只能物化成变更计划载荷，且 apply 家族不许降级成「按记录正文回退」
 *    （批量记录的 beforeContent 只是第一条配置的写前正文，放出去会被读成整批都退回去了）；
 * 4. 存档原因键的文案不许被当死键删掉：老版本写进用户 localStorage 的记录仍然带着它们，
 *    删了就在屏幕上显示原始 key（口径同 default-sentinels-must-not-reach-render-untranslated）。
 *
 * 变异对照（逐条实测过判红）：把 `assessHistoryRollback` 换成 `record.rollbackable === true`、
 * 把 `buildDirectWriteExitEntry` 换成 `buildRollbackEntryFromApplyRecord`、
 * 在 `assessApplyBackup` 的收口后面补一句 `return assessRecordedContent(record, ctx)`、
 * 删掉 locales 里 `rollbackDisabled`、把 chip 的类名改掉、
 * 把 apply 家族的出口从 `withHistoryReturnMode(result.entry)` 退回去掉收口的 `return result`
 * （→「两条回退路径都要过这一处返回口收口」红）、
 * 把 `withHistoryReturnMode` 里的 "history" 改成 "browse"（→ 本守卫红 + 真机 S30 的「返回」断言红）。
 * 每种改法都必须让下面某条断言红。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, loadLocale, readScannedSource, sourceFiles } from "./scanUtils";

const STORE = "src/store/operationHistory.ts";
const LIB = "src/lib/historyRollback.ts";
const VIEW = "src/components/OperationHistoryView.tsx";
const SAFETY = "src/lib/applyExecutionSafety.ts";

const zh = loadLocale("zh-CN.json");
const en = loadLocale("en-US.json");

/** 轮72A 起界面用的能力判定与出口都收在这两个导出上。 */
const LIB_EXPORTS = ["assessHistoryRollback", "buildHistoryRollbackEntry"];

/** 存档在记录里的不可回退原因键：老版本写入的 localStorage 数据仍然带着，删文案=显示原始 key。 */
const ARCHIVED_REASON_KEYS = [
  "operationHistory.rollbackDisabled",
  "operationHistory.rollbackRequiresApplyPlan",
  "operationHistory.rollbackApplyRequiresPlan",
  // 本轮仍然在写的原因键：快照/导出两类记录落库时把原因存进记录里，
  // 界面读的是记录里那个 key——删文案等于在屏幕上显示原始 key。
  "operationHistory.rollbackSnapshotOnly",
  "operationHistory.rollbackExportOnly",
];

/** 轮72A 新增的键：能力名 / 每条不可回退的具体原因（含 lib 内部三条）/ 遗留记录出口 / 筛选开关。 */
const NEW_KEYS = [
  "operationHistory.rollbackable",
  "operationHistory.notRollbackable",
  "operationHistory.rollbackableOnly",
  "operationHistory.rollbackState",
  "operationHistory.rollbackReason",
  "operationHistory.rollbackNoPlanOnRecord",
  "operationHistory.rollbackMissingBackupSnapshot",
  "operationHistory.rollbackPlanExpired",
  "operationHistory.rollbackTargetConnectionMissing",
  "operationHistory.rollbackTargetNotWritable",
  "operationHistory.rollbackFromRecordedContent",
  // lib/historyRollback 自己的三条不可回退原因：它们是「不可回退」那一行的正文，
  // 不钉进清单就会被当成死键清掉，界面剩下一个原始 key。
  "operationHistory.rollbackOnlySuccess",
  "operationHistory.rollbackMissingContent",
  "operationHistory.rollbackUnsupportedType",
];

describe("回退判据只有一份", () => {
  it("死口径从 store 消失，全仓没有引用", () => {
    const store = readScannedSource(STORE);
    expect(store).not.toMatch(/export function isRollbackableOperation/);
    expect(store).not.toMatch(/export function rollbackUnavailableReason/);
    for (const file of sourceFiles()) {
      const name = file.replace(/\\/g, "/");
      if (name.endsWith("lib/historyRollback.ts")) continue;
      const source = readScannedSource(name);
      expect(source, `${name} 又引用了被删掉的死口径`).not.toMatch(/\bisRollbackableOperation\b|\brollbackUnavailableReason\b/);
    }
  });

  it("store 里那两个字段被写成存档元数据，不是能力判定", () => {
    // 注释会被 readScannedSource 剥掉，这里读原文：字段名本身骗过人两次，注释才是防线。
    const raw = readFileSync(join(PROJECT_ROOT, STORE), "utf8");
    const rollbackableAt = raw.indexOf("rollbackable?: boolean;");
    expect(rollbackableAt).toBeGreaterThan(-1);
    const head = raw.slice(Math.max(0, rollbackableAt - 500), rollbackableAt);
    expect(head, "rollbackable 字段没说清它是存档元数据").toContain("存档元数据");
    expect(head, "注释没把判定指向唯一事实源").toContain("lib/historyRollback");
  });

  it("界面不许自己算能力，也不许拿存档字段当否决", () => {
    const view = readScannedSource(VIEW);
    for (const name of LIB_EXPORTS) {
      expect(view, `OperationHistoryView 没有用 lib/historyRollback 的 ${name}`).toContain(name);
    }
    // 判据入口只此一个：chip / 徽章 / 按钮 / 筛选都读 rollbackByRecord（或同一份 assessment）。
    expect(view).toMatch(/rollbackByRecord\.get\(/);
    expect(view).not.toMatch(/record\.rollbackable\s*===?/);
    expect(view).not.toMatch(/selectedVisibleRecord\.rollbackable\s*===?/);
    // 构造出口也不许绕过 lib 直接调用旧 builder（那样 lib 的原因分派就成了摆设）。
    expect(view, "回退入口必须经 buildHistoryRollbackEntry 分派").not.toMatch(/buildRollbackEntryFromApplyRecord\(/);
  });

  it("写入侧不再往记录里塞误导的 rollbackable:false + 原因键", () => {
    const safety = readScannedSource(SAFETY);
    const builder = safety.slice(safety.indexOf("export function buildApplyOperationHistoryInput"));
    const body = builder.slice(0, builder.indexOf("\n}"));
    expect(body, "执行记录又被写死了 rollbackable:false，徽章会重新开始说谎").not.toMatch(/\brollbackable:/);
    expect(body).not.toContain("rollbackApplyRequiresPlan");
  });
});

describe("两条回退路径的边界", () => {
  it("遗留单条记录走 directWriteExit，apply 家族不降级", () => {
    const lib = readScannedSource(LIB);
    const assessSlice = lib.slice(lib.indexOf("function assessRecordedContent"), lib.indexOf("export function assessHistoryRollback"));
    expect(assessSlice, "可写判定要复用 isWritableConfigTarget，别在这里再写一套").toContain("isWritableConfigTarget(");
    const buildSlice = lib.slice(lib.indexOf("export async function buildHistoryRollbackEntry"));
    expect(buildSlice, "遗留记录的出口没有复用 buildDirectWriteExitEntry").toContain("buildDirectWriteExitEntry(");
    expect(buildSlice, "apply 家族的构造没有复用备份快照那条链").toContain("buildRollbackEntryFromApplyRecord(");
    // 从历史进来的回退，计划页「返回」要落回操作历史。directWriteExit 恒给 browse（浏览页内 tab 的口径）、
    // applyFollowup 恰好给 history——两条路径都必须过 lib 里这一处收口，不许再各写各的，
    // 也不许指望两个上游模块刚好一致（轮72A 复跑探针：只改一处时真机用例照样绿）。
    expect(lib).toMatch(/function withHistoryReturnMode\(entry: ApplyEntryPayload\)[\s\S]{0,200}returnMode:\s*"history"/);
    expect(buildSlice.match(/withHistoryReturnMode\(/g)?.length ?? 0, "两条回退路径都要过这一处返回口收口").toBeGreaterThanOrEqual(2);
    expect(buildSlice, "出口里不许再各写各的 returnMode，改收口那一个函数").not.toMatch(/returnMode:/);

    const applyAssess = lib.slice(lib.indexOf("function assessApplyBackup"), lib.indexOf("function assessRecordedContent"));
    expect(applyAssess, "apply 家族按备份快照放行").toContain("canBuildRollbackEntry(");
    expect(applyAssess, "apply 记录不许降级成按 beforeContent 回退").not.toContain("assessRecordedContent(");
    expect(applyAssess).not.toMatch(/\brecord\.rollbackable\b/);
  });

  it("不可回退时给具体原因，且原因键中英文成对", () => {
    for (const key of NEW_KEYS) {
      expect(zh[key], `zh 缺 ${key}`).toBeTruthy();
      expect(en[key], `en 缺 ${key}`).toBeTruthy();
    }
    // 直写红线没放宽：CTA 必须把用户带去「计划」，文案里出现计划/plan 才算数。
    expect(zh["operationHistory.rollbackFromRecordedContent"]).toContain("计划");
    expect(en["operationHistory.rollbackFromRecordedContent"].toLowerCase()).toContain("plan");
    expect(zh["operationHistory.rollbackPlanExpired"]).toContain("计划");
  });

  it("存档原因的文案不许当死键删掉", () => {
    for (const key of ARCHIVED_REASON_KEYS) {
      expect(zh[key], `${key} 被删了：老记录里的原因会显示成原始 key`).toBeTruthy();
      expect(en[key], `${key} 被删了：老记录里的原因会显示成原始 key`).toBeTruthy();
    }
  });
});

describe("列表 chip 与「只看可回退」筛选接线", () => {
  it("chip 是行内的非交互元素，筛选开关是真的 checkbox", () => {
    const view = readScannedSource(VIEW);
    expect(view).toMatch(/className="history-rollback-chip"/);
    // 行本身是 <button>，chip 不能再嵌交互元素。
    expect(view).not.toMatch(/<button[^>]*className="history-rollback-chip"/);
    expect(view).toMatch(/<label className="history-filter-toggle">/);
    expect(view).toMatch(/type="checkbox"[^}]*checked=\{filterRollbackableOnly\}/s);
    expect(view).toContain('useRememberedState<boolean>("history.filterRollbackable"');
  });

  it("样式给了 chip 与开关命中的位置，不靠内联", () => {
    const css = readScannedSource("src/styles.css");
    expect(/\.history-rollback-chip \{[^}]*\}/.test(css), "缺少 .history-rollback-chip 规则").toBe(true);
    const toggle = /\.history-filter-toggle \{([^}]*)\}/.exec(css);
    expect(toggle, "缺少 .history-filter-toggle 规则").not.toBeNull();
    expect(/min-height:\s*2[4-9]px|min-height:\s*[3-9]\dpx/.test(toggle![1]), "开关命中高度不足 24px").toBe(true);
  });

  it("knownPlanIds 挂载时一次读全量，不在渲染期逐行解析 localStorage", () => {
    const view = readScannedSource(VIEW);
    expect(view).toMatch(/useState<ReadonlySet<string>>\(\(\) => new Set\(listApplyPlanIds\(\)\)\)/);
    expect(view, "逐行 getApplyPlan() 会在渲染期反复解析同一份 localStorage").not.toMatch(/allRecords\.(map|forEach)\([^)]*getApplyPlan/s);
  });
});
