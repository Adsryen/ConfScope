/**
 * 「返回值当错误」的出口也必须跟着界面语言走（轮13 R50）。
 *
 * 波24 R43 管的是 `new Error(...)`，波28 管的是内联错误块，但 `{ ok:false, error, detail }`
 * 这条管道没人盯：apply 的回滚/晋升/dry-run 生成把英文技术句直接塞进 `detail`，
 * 中文界面点「生成回退计划」就冒出 `Apply record history-1 is missing planId.`。
 * 这类漂移不报错、不飘红，只能静态钉住：
 * 1. 登记文件里进错误出口的写死句子必须为 0；
 * 2. 已经换掉的英文句式不许退回（全 src 扫描，防别处再抄一份）；
 * 3. 键必须在两份语言文件里都存在、非空、占位符一致；
 * 4. 键必须真的被引用（防死钩子）；
 * 5. 审计/日志用的内部标识不许被顺手翻译（防误伤判据）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadLocale, readScannedSource, sourceFiles } from "./scanUtils";
import { translate } from "../../src/locales";

const CJK = /[\u3400-\u9fff]/;
/** 字符串/模板字面量；模板里的 `${}` 段落仍算字面量文本。 */
const LITERALS = /(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
/** locale 键名长得像 `apply.followupMissingPlanId`：有点号、没空格。 */
const KEY_LIKE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
/** 码值/枚举（`apply_followup_failed`、`missing_before_snapshot`）属于数据，不属于文案。 */
const CODE_LIKE = /^[A-Za-z0-9_\s:/-]*$/;
/** 已成句至少三个实词，与波24 的口径一致。 */
const MIN_WORDS = 3;

/** 错误出口的落点：函数实参型 + 对象字段型 + 直接 return 型。 */
const ARG_SINKS = /\b(?:fail|setRecordFollowupError)\s*\(/g;
const FIELD_SINKS = /\b(?:error|detail)\s*:\s*/g;
const RETURN_SINKS = /\breturn\s+/g;
const ASSIGN_SINKS = /\b(?:const|let)\s+error\s*=\s*/g;

/** 波30 登记的写死英文句出处，新增同族站点必须一起登记。 */
const REGISTERED = [
  "src/lib/applyFollowup.ts",
  "src/lib/applyPlanDraft.ts",
  "src/lib/applyPlanExecution.ts",
  "src/lib/applyExecutionSafety.ts",
  "src/components/OperationHistoryView.tsx",
];

/** 波30 新建的 22 个键 + 2 处复用既有键。 */
const NEW_KEYS = [
  "apply.followupMissingPlanId",
  "apply.followupPlanMissing",
  "apply.followupMissingBackupSnapshot",
  "apply.followupLoadSnapshotFailed",
  "apply.followupSnapshotMissingPath",
  "apply.followupTargetConnectionMissing",
  "apply.followupVerificationDrift",
  "apply.followupNoVerification",
  "apply.followupVerificationMismatch",
  "apply.followupSameConnection",
  "apply.followupSandboxConnectionMissing",
  "apply.followupVerifySandboxFailed",
  "apply.draftLoadSnapshotFailed",
  "apply.draftSnapshotMissingPath",
  "apply.draftSnapshotMissingSourceConnection",
  "apply.missingConnection",
  "apply.blockedItem",
  "apply.keyLevelWriteUnsupported",
  "apply.planStale",
  "apply.planTaskName",
  "apply.safetyBlockedItems",
  "apply.safetyMissingBeforeSnapshot",
];
const REUSED_KEYS = ["apply.noSelectedItems"];

/** 换掉的英文句式：不许在任何 src 源码里再出现（locales 不参与扫描）。 */
const RETIRED_TEMPLATES = [
  "is missing planId",
  "is missing backupSnapshotId",
  "Configuration change plan",
  "has no sandbox verification",
  "does not match apply record",
  "cannot be the same connection",
  "drift detected for item(s)",
  "Failed to load backup snapshot",
  "is missing path",
  "Target connection",
  "Sandbox connection",
  "Failed to verify sandbox current state",
  "Failed to load snapshot",
  "references missing source connection",
  "Missing connection",
  "Cannot execute blocked item",
  "Cannot materialize key-level apply",
  "No change plan items selected",
  "Change plan is stale",
  "blocked item(s)",
  "Missing before snapshot for item(s)",
];

function wordsIn(text: string): number {
  return (text.match(/[A-Za-z]{3,}/g) ?? []).length;
}

/** 从 `(` 起做括号配平取整段实参（带引号状态机，不被 `"("` 骗过）。 */
function argumentWindow(source: string, openParen: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openParen; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openParen, i + 1);
    }
  }
  return source.slice(openParen);
}

/** 取表达式起点后第一段实参/字面量（`return` / `error:` / `const error =` 这类不是函数调用，没法配平）。 */
function expressionWindow(source: string, at: number): string {
  const rest = source.slice(at);
  const stop = rest.search(/[\n;]/);
  const len = stop === -1 ? rest.length : stop + 1;
  return rest.slice(0, len);
}

/** 字面量是不是「写死语言的成句文案」。 */
function isSentence(text: string): boolean {
  if (!text.trim()) return false;
  if (CJK.test(text)) return false;
  if (KEY_LIKE.test(text.trim())) return false;
  if (!text.includes(" ") && CODE_LIKE.test(text.trim())) return false;
  if (text.includes("${") && !/[A-Za-z]{3,}\s+[A-Za-z]{3,}/.test(text.replace(/\$\{[^{}]*\}/g, " "))) return false;
  return wordsIn(text) >= MIN_WORDS;
}

function sentenceHits(file: string): string[] {
  const source = readScannedSource(file);
  const findings: string[] = [];
  const scan = (pattern: RegExp, window: (index: number, match: string) => string) => {
    for (const hit of Array.from(source.matchAll(pattern))) {
      const at = hit.index ?? 0;
      const slice = window(at, hit[0]);
      if (slice.includes("translate(") || slice.includes("t(")) continue;
      for (const literal of Array.from(slice.matchAll(LITERALS))) {
        if (!isSentence(literal[2])) continue;
        findings.push(`${file}:${source.slice(0, at).split("\n").length} → ${JSON.stringify(literal[2].trim().slice(0, 60))}`);
      }
    }
  };
  scan(ARG_SINKS, (at, match) => argumentWindow(source, at + match.length - 1));
  scan(FIELD_SINKS, (at, match) => expressionWindow(source, at + match.length));
  scan(RETURN_SINKS, (at, match) => expressionWindow(source, at + match.length));
  scan(ASSIGN_SINKS, (at, match) => expressionWindow(source, at + match.length));
  return Array.from(new Set(findings));
}

function useLocale(locale: string): void {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => (key === "locale" ? locale : null),
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("非异常出口的报错必须走 i18n（波30 R50）", () => {
  it("登记表与实码一致：登记文件都还在被扫描", () => {
    const files = sourceFiles();
    REGISTERED.forEach((file) => expect(files, `登记文件没被扫到：${file}`).toContain(file));
  });

  it("扫描口径不是空转：错误出口确实扫得到", () => {
    const source = readScannedSource("src/lib/applyFollowup.ts");
    expect(Array.from(source.matchAll(ARG_SINKS)).length, "fail() 一个都没扫到，说明出口正则失效").toBeGreaterThanOrEqual(10);
  });

  it("进错误出口的写死成句文案为 0", () => {
    expect(REGISTERED.flatMap(sentenceHits)).toEqual([]);
  });

  it("已换掉的英文句式不许退回源码", () => {
    const files = sourceFiles();
    const hits = RETIRED_TEMPLATES.flatMap((template) =>
      files.filter((file) => readScannedSource(file).includes(template)).map((file) => `${template} ← ${file}`)
    );
    expect(hits).toEqual([]);
  });

  it("新键在两份语言文件里都存在、非空、占位符一致", () => {
    const zh = loadLocale("zh-CN.json");
    const en = loadLocale("en-US.json");
    const placeholders = (text: string) => Array.from(text.matchAll(/\{([^{}]+)\}/g), (m) => m[1]).sort();
    NEW_KEYS.concat(REUSED_KEYS).forEach((key) => {
      expect(zh[key] ?? "", `zh 缺键 ${key}`).not.toBe("");
      expect(en[key] ?? "", `en 缺键 ${key}`).not.toBe("");
      expect(placeholders(en[key]), `${key} 占位符与 zh 不一致`).toEqual(placeholders(zh[key]));
    });
    // zh 侧不许留英文成句（句式换掉了，正文也得是中文）
    NEW_KEYS.forEach((key) => {
      if (CJK.test(zh[key])) return;
      expect(wordsIn(zh[key]), `${key} 的中文正文一个汉字都没有：${zh[key]}`).toBeLessThan(MIN_WORDS);
    });
  });

  it("键真的被引用，不是死钩子", () => {
    const byFile = REGISTERED.map((file) => ({ file, source: readScannedSource(file) }));
    NEW_KEYS.forEach((key) => {
      const users = byFile.filter((entry) => entry.source.includes(`"${key}"`)).map((entry) => entry.file);
      expect(users.length, `${key} 没有任何登记文件在用`).toBeGreaterThan(0);
    });
    // 轮76：晋级入口从历史页搬回变更计划第5步后，这批文案只有一个产出者——lib。
    // 旧口径要求历史页组件也翻译这四个键（因为那时判定分支长在组件里）；现在 UI 只透传
    // result.detail，谁再在组件里自己判一遍并翻译，就是 R4 说的第二份文本，判红。
    const SHARED_KEYS = [
      "apply.followupMissingPlanId",
      "apply.followupPlanMissing",
      "apply.followupSandboxConnectionMissing",
      "apply.followupNoVerification",
    ];
    const producer = readScannedSource("src/lib/applyFollowup.ts");
    SHARED_KEYS.forEach((key) => expect(producer, `lib 没复用 ${key}`).toContain(`"${key}"`));
    [
      "src/components/OperationHistoryView.tsx",
      "src/components/PostApplyPromotionPanel.tsx",
    ].forEach((file) => {
      const ui = readScannedSource(file);
      SHARED_KEYS.forEach((key) => expect(ui, `${file} 不该自己再翻译 ${key}`).not.toContain(`"${key}"`));
    });
    expect(readScannedSource("src/lib/applyPlanExecution.ts")).toContain('"apply.noSelectedItems"');
    expect(readScannedSource("src/lib/applyPlanExecution.ts")).toContain('"apply.planTaskName"');
  });

  it("内部标识不算文案：审计/日志标题保持原样（R3）", () => {
    expect(readScannedSource("src/lib/applyPlanExecution.ts")).toContain("APPLY ${plan.id}");
    expect(readScannedSource("src/lib/applyFollowup.ts")).toContain('error: "apply_followup_failed"');
  });

  it("中文界面拿中文、英文界面拿英文，参数照常注入", () => {
    useLocale("zh-CN");
    expect(translate("apply.followupMissingPlanId", { id: "history-1" })).toContain("history-1");
    expect(CJK.test(translate("apply.followupSameConnection"))).toBe(true);
    useLocale("en-US");
    expect(translate("apply.followupSameConnection")).toBe("Promotion source and target cannot be the same connection.");
    expect(CJK.test(translate("apply.safetyBlockedItems", { count: 2 }))).toBe(false);
    expect(translate("apply.safetyBlockedItems", { count: 2 })).toContain("2");
  });

  it("detail 里带 $ 的底层原文不被占位替换吞掉", () => {
    useLocale("zh-CN");
    const detail = "boom $& $' tail";
    expect(translate("apply.followupLoadSnapshotFailed", { id: "snap-1", detail })).toContain(detail);
  });
});
