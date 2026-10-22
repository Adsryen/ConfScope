/**
 * 中英文文案的静态对齐守卫（轮6 R48）。
 *
 * 以前的「门禁」是把两份 JSON 的字符总数比一下（1124 = 1124），键名漂移、漏译、
 * 占位符写错全都抓不到——英文界面漏出中文（R45）就是这类漂移的结果。这里改成真守卫：
 * 1. 两份语言文件的叶键集合必须完全一致；
 * 2. 同一个键里的 `{placeholder}` 集合必须一致（文案换了说法也不能把参数弄丢）；
 * 3. 不许有空值；
 * 4. 源码里写死的 `t("a.b")` 键必须在两份里都存在；
 * 5. 模板拼接的动态键（`t(\`logViewer.kind${Cap(x)}\`)` 这类）由「枚举闭包表」逐档核对，
 *    新增档位忘了补文案时这里会红，而不是像 R47 那样把原始键名印到按钮上。
 */
import { describe, expect, it } from "vitest";
import { capitalize, loadLocale, readScannedSource, sourceFiles, unionMembers } from "./scanUtils";

const zh = loadLocale("zh-CN.json");
const en = loadLocale("en-US.json");

/** `{name}` 占位符集合。 */
function placeholders(text: string): string[] {
  return Array.from(text.matchAll(/\{([^{}]+)\}/g), (m) => m[1]).sort();
}

const files = sourceFiles();
/** 字面量键：`t("a.b")` / `t('a.b')` / `translate("a.b")` / `getTranslation(locale, "a.b")`。 */
const literalKeys = files.flatMap((file) => {
  const source = readScannedSource(file);
  return Array.from(source.matchAll(/\b(?:t|translate|getTranslation)\(\s*(?:locale,\s*)?["']([^"']+)["']/g), (m) => ({
    file,
    key: m[1],
  }));
});

/**
 * 动态拼接键的枚举闭包表：来源是 TS 联合类型 / Go 常量 / 接口字段，
 * 全部是「编译期可枚举」的档位，所以守卫能自己算出该有哪些键。
 */
const dynamicTables: { label: string; keys: string[] }[] = [
  {
    // LogViewer 的会话类型标签：`logViewer.kind${Cap(kind)}`
    label: "logViewer.kind* ← AuditSession.kind",
    keys: unionMembers("src/lib/auditSessionLog.ts", /export interface AuditSession \{[\s\S]*?kind:\s*([^;\n]+);/).map(
      (v) => `logViewer.kind${capitalize(v)}`
    ),
  },
  {
    // 会话状态标签：statusLabel 也是按档位拼的
    label: "logViewer.status* ← AuditSession.status",
    keys: unionMembers("src/lib/auditSessionLog.ts", /export interface AuditSession \{[\s\S]*?status:\s*([^;\n]+);/).map(
      (v) => `logViewer.status${capitalize(v)}`
    ),
  },
  {
    // 设置页数据位置标题：`settings.dataLoc${Cap(entry.key)}`，key 由 Go 侧白名单给出
    label: "settings.dataLoc* ← Go dataLocKey*",
    keys: (
      Array.from(readScannedSource("internal/app/app_data_locations.go").matchAll(/dataLocKey\w+\s*=\s*"([^"]+)"/g), (m) => m[1]) ?? []
    ).map((v) => `settings.dataLoc${capitalize(v)}`),
  },
  {
    // 更新交接面板的出路说明：`about.handoff.${handoffKey}`，档位来自 TS 联合类型
    label: "about.handoff.* ← UpdateHandoff",
    keys: unionMembers("src/api/app.ts", /export type UpdateHandoff\s*=\s*([^;]+);/).map((v) => `about.handoff.${v}`),
  },
  {
    // 变更计划的动作标签与摘要
    label: "apply.actions.* / apply.summary.* ← ApplyPlanAction",
    keys: unionMembers("src/lib/applyPlan.ts", /export type ApplyPlanAction\s*=\s*([^;]+);/).flatMap((v) => [
      `apply.actions.${v}`,
      `apply.summary.${v}`,
    ]),
  },
  {
    label: "apply.scopes.* ← ApplyPlanScope",
    keys: unionMembers("src/lib/applyPlan.ts", /export type ApplyPlanScope\s*=\s*([^;]+);/).map((v) => `apply.scopes.${v}`),
  },
  {
    // 摘要条还额外有 total / blocked 两格
    label: "apply.summary.* ← ApplyPlanSummary 其余字段",
    keys: ["total", "blocked"].map((v) => `apply.summary.${v}`),
  },
  {
    label: "tasks.status* ← TaskStatus",
    keys: unionMembers("src/lib/taskmanager.ts", /export type TaskStatus\s*=\s*([^;]+);/).map((v) => `tasks.status${capitalize(v)}`),
  },
  {
    // 工作流五步：`diff.workflowStep${index+1}` 与 `${index+1}Detail`
    label: "diff.workflowStep* ← WORKFLOW_STEP_IDS",
    keys: Array.from(
      {
        length: (
          readScannedSource("src/components/DiffWorkflowCard.tsx")
            .match(/WORKFLOW_STEP_IDS: WorkflowStepId\[\] = \[[^\]]*\]/)?.[0]
            .match(/"[^"]+"/g) ?? []
        ).length,
      },
      (_, i) => i + 1
    ).flatMap((n) => [`diff.workflowStep${n}`, `diff.workflowStep${n}Detail`]),
  },
];

describe("locale 静态守卫", () => {
  it("zh / en 叶键集合完全一致（漏一侧就会在另一种语言里露出原文或空串）", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });

  it("每个键都有非空文案", () => {
    const blanks = [...Object.entries(zh), ...Object.entries(en)].filter(([, v]) => !String(v).trim());
    expect(blanks.map(([k]) => k)).toEqual([]);
  });

  it("同键的 {placeholder} 集合一致", () => {
    const drift = Object.keys(zh)
      .filter((key) => key in en)
      .map((key) => ({ key, zh: placeholders(zh[key]).join(","), en: placeholders(en[key]).join(",") }))
      .filter(({ zh: z, en: e }) => z !== e);
    expect(drift).toEqual([]);
  });

  it("源码里的字面量 t() 键在两份语言文件里都存在", () => {
    expect(literalKeys.length, "一条 t() 字面量键都没扫到，说明扫描正则失效了").toBeGreaterThan(500);
    const missing = literalKeys.filter(({ key }) => !(key in zh) || !(key in en));
    expect(missing).toEqual([]);
  });

  it("动态拼接键的每一档都有文案（R47 那类「原始键名印到界面上」不会再发生）", () => {
    // 先确认扫描口径本身没有空转：每条表都必须真的算出档位
    dynamicTables.forEach(({ label, keys }) => {
      expect(keys.length, `${label} 算出 0 个键，枚举正则需要跟着源码改`).toBeGreaterThan(0);
    });
    const missing = dynamicTables.flatMap(({ label, keys }) =>
      keys.filter((key) => !(key in zh) || !(key in en)).map((key) => `${label} → ${key}`)
    );
    expect(missing).toEqual([]);
  });

  it("en 文案里没有残留中文（错误中心/轻提示这类运行期文本最容易漏）", () => {
    // 白名单：确实要展示中文原文的场景（例如教用户输入「测试」来命中灰度档）在此登记键名，
    // 空着也要留着——这样「新增一条带中文的英文文案」必须显式表态，而不是把整条守卫放宽。
    const ZH_IN_EN_ALLOWLIST: string[] = [];
    const leaked = Object.entries(en).filter(([key, value]) => /[\u3400-\u9fff]/.test(value) && !ZH_IN_EN_ALLOWLIST.includes(key));
    expect(leaked.map(([key]) => key)).toEqual([]);
  });
});
