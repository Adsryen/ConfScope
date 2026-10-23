/**
 * 直写被禁用后，四个写入口的唯一出路必须是变更计划（轮42 / 方案 D）。
 *
 * 缺陷长什么样（真机取证见 `.trellis/tasks/10-19-10-19-ui-ux-42/prd.md`）：
 * `fd074a8` 在 API 层无条件砍掉直写（`publishConfig` / `deleteConfig` 直接 throw），
 * 但就地编辑「保存发布」、删除、新建「发布」、历史「回滚」四个入口照旧可点——
 * 点下去必然失败，还在操作历史里留一条 `result:"failure"` 的假审计，
 * 失败呈现里挂的「重试」永远不可能成功，按钮标题写着「将此版本内容重新发布为最新版」这种
 * 根本不成立的话。四处 `planRouteButtons` 实测全空：既没有预告，也没有出路。
 *
 * 本轮把四个入口本身改造成计划入口（`buildDirectWriteExitEntry` → `onStartApply`）。
 * 守卫钉的是**结构**，不是文案，防止三件事复发：
 * 1. 有人为了「把按钮救活」去放宽 API 层的禁用 throw（安全模型，绝对禁区）；
 * 2. 有人把某个入口改回「先试直写、失败再提示」——假 failure 审计与必然失败的重试就是这么来的；
 * 3. 有人把本轮删掉的死文案/说谎文案从 git 历史里粘回来（locales 里有的是整段遗留键）。
 */
import { describe, expect, it } from "vitest";
import { loadLocale, readScannedSource } from "./scanUtils";

const ENTRY_FILES = [
  "src/components/ConfigBrowser.tsx",
  "src/components/ConfigEditor.tsx",
  "src/components/HistoryView.tsx",
  // 轮67 WP-15：本机版本历史也能「按这一版生成回滚计划」，是第五处写入出口。
  "src/components/LocalRevisionPanel.tsx",
  "src/components/DeleteConfirm.tsx",
];
/** 会自己构造计划载荷的入口（DeleteConfirm 走的是删除确认，不在此列）。 */
const PLAN_BUILDING_FILES = [
  "src/components/ConfigBrowser.tsx",
  "src/components/ConfigEditor.tsx",
  "src/components/HistoryView.tsx",
  "src/components/LocalRevisionPanel.tsx",
];

/** 直写禁用错误只许出现在 API 层的 throw 上；UI 里出现 = 回到「点了才报错」。 */
const DIRECT_WRITE_ERROR_KEY = "api.directWriteRequiresApplyPlan";

/** 这四个 type 的 failure 记录在入口侧就是假的：它反映的是「我们根本没打算写」。 */
const WRITE_OP_TYPES = new Set(["publish", "delete", "rollback"]);

/**
 * 按括号配对截出组件里每一个 `recordOperation({...})` 的实参对象。
 *
 * 不用 `recordOperation\(\{[^}]*?\}` 那种正则：实参里带嵌套对象时收口会停在第一个 `}`，
 * 拿到的半块既能漏判 type/result 的组合，也能让断言假绿。
 */
function recordedOperations(source: string): Array<{ type: string; failure: boolean }> {
  const blocks: string[] = [];
  const re = /\brecordOperation\(\s*\{/g;
  let m = re.exec(source);
  while (m) {
    const open = source.indexOf("{", m.index);
    let depth = 0;
    let i = open;
    for (; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push(source.slice(open + 1, i));
    re.lastIndex = i + 1;
    m = re.exec(source);
  }
  return blocks.map((b) => ({
    type: b.match(/\btype:\s*"([^"]+)"/)?.[1] ?? "",
    failure: /\bresult:\s*"failure"/.test(b),
  }));
}

/** 入口侧新增的假写入审计：type 是写入动作且 result 是 failure。 */
function fakeWriteFailures(source: string): string[] {
  return recordedOperations(source)
    .filter((r) => WRITE_OP_TYPES.has(r.type) && r.failure)
    .map((r) => r.type);
}

/** 本轮从 locales 摘掉的死键/说谎键（改前逐一实测过引用数为 0）。 */
const RETIRED_KEYS = [
  "config.publishing",
  "config.savePublish",
  "config.published",
  "config.publishConfigFailed",
  "config.publish",
  "config.createConfigFailed",
  "config.retryPublish",
  "history.rollback",
  "history.rollbackConfigFailed",
  "history.retryRollback",
  "history.rollbackHint",
  "history.rollingBack",
  "history.confirmRollback",
];

/** 计划出路必须说清「这是计划」，不许再冒充实直写动作。 */
const PLAN_COPY_KEYS = [
  "config.saveAsPlan",
  "config.deleteAsPlan",
  "config.generatingPlan",
  "history.rollbackAsPlan",
  "history.confirmRollbackAsPlan",
];

describe("API 层的直写禁用不许被放宽", () => {
  for (const file of ["src/api/nacos.ts", "src/api/configCenter.ts"]) {
    it(`${file} 仍在 publishConfig / deleteConfig 上无条件抛「必须走变更计划」`, () => {
      const source = readScannedSource(file);
      const throws = source.match(new RegExp(`throw new Error\\(translate\\("${DIRECT_WRITE_ERROR_KEY}"\\)\\)`, "g")) ?? [];
      // publishConfig + deleteConfig 两个入口，一个都不能少：少一个就是直写复活。
      expect(throws.length, `${file} 里的直写 throw 数量变了`).toBeGreaterThanOrEqual(2);
    });
  }
});

describe("五处入口不再自己呈现直写失败", () => {
  for (const file of ENTRY_FILES) {
    it(`${file} 不引用「直接配置写入已禁用」这条 API 错误文案`, () => {
      const source = readScannedSource(file);
      expect(source.includes(DIRECT_WRITE_ERROR_KEY), `${file} 又把禁用直写的错误搬到 UI 里就地展示了`).toBe(false);
    });

    it(`${file} 不为发布/删除/回滚写必然失败的审计`, () => {
      const source = readScannedSource(file);
      expect(fakeWriteFailures(source), `${file} 又用 recordOperation 记了一条注定失败的写入记录`).toEqual([]);
    });
  }

  it("就地编辑的失败提示不再挂必然失败的「重试」", () => {
    const source = readScannedSource("src/components/ConfigBrowser.tsx");
    expect(/onRetry=\{save(AsPlan|Edit)\}/.test(source), "saveError 的 InlineError 又挂了永远点不通的重试").toBe(false);
  });

  it("正文没改动时不生成空计划，改完正文明确说明出路在哪", () => {
    const browser = readScannedSource("src/components/ConfigBrowser.tsx");
    expect(browser.includes("config.noChangeToPlan"), "编辑保存不再区分「正文与线上一致」，会生成只有 skip 的空计划").toBe(true);
    // 说明必须是可见文字，不能只挂在 title 上（口径见 disabledControlsDoNotRelyOnTitle）
    expect(
      /<span className="fmt-write-hint"[^>]*>\s*\{t\("config\.directWriteDisabledHint"\)\}/.test(browser),
      "编辑工具栏的直写禁用说明不再是可见文案"
    ).toBe(true);
  });
});

describe("四处入口共用同一套计划机制", () => {
  for (const file of PLAN_BUILDING_FILES) {
    it(`${file} 经 buildDirectWriteExitEntry 交给 onStartApply`, () => {
      const source = readScannedSource(file);
      expect(source.includes("buildDirectWriteExitEntry("), `${file} 绕过统一构造器自己拼计划载荷`).toBe(true);
      expect(source.includes("onStartApply"), `${file} 不再把计划交给计划流程`).toBe(true);
      expect(source.includes("import { buildDirectWriteExitEntry"), `${file} 自己复制了一份构造逻辑`).toBe(true);
    });
  }

  it("构造计划载荷的逻辑只存在于 src/lib/directWriteExit.ts", () => {
    const builders = PLAN_BUILDING_FILES.map((f) => f.replace(/^src\/components\//, "")).filter((f) =>
      readScannedSource(`src/components/${f}`).includes("function buildDirectWriteExitEntry")
    );
    expect(builders, "组件里又出现了一份计划载荷构造实现").toEqual([]);
  });

  it("可写目标判定只有一个出处，五处入口共用", () => {
    for (const file of ENTRY_FILES) {
      const source = readScannedSource(file);
      expect(/function isWritableTarget\b/.test(source), `${file} 又本地复制了一份 isWritableTarget`).toBe(false);
    }
    const lib = readScannedSource("src/lib/directWriteExit.ts");
    expect(lib.includes("export function isWritableConfigTarget")).toBe(true);
  });

  it("HistoryView 不再挂着从没被调用过的 onRolledBack", () => {
    expect(readScannedSource("src/components/HistoryView.tsx").includes("onRolledBack")).toBe(false);
    expect(readScannedSource("src/components/ConfigBrowser.tsx").includes("onRolledBack")).toBe(false);
  });
});

describe("locales 里本轮清掉的文案不许复活", () => {
  for (const file of ["zh-CN.json", "en-US.json"]) {
    const flat = loadLocale(file);
    it(`${file} 不再包含已废弃的直写文案键`, () => {
      const alive = RETIRED_KEYS.filter((key) => key in flat);
      expect(alive, `${file} 又出现了这些键：${alive.join(", ")}`).toEqual([]);
    });

    it(`${file} 不再包含「将此版本内容重新发布为最新版」这类说谎提示`, () => {
      const lying = Object.entries(flat).filter(([, text]) =>
        /将此版本内容重新发布为最新版|重新发布为最新版|Republish this version as latest/i.test(text)
      );
      expect(
        lying.map(([key]) => key),
        `${file} 里还有冒充直写成功的说明文案`
      ).toEqual([]);
    });

    it(`${file} 的计划出路文案确实说了「计划」`, () => {
      const wrong = PLAN_COPY_KEYS.filter((key) => {
        const text = flat[key];
        if (!text) return true;
        return file.startsWith("zh") ? !text.includes("计划") : !/plan/i.test(text);
      });
      expect(wrong, `${file} 缺少计划文案或文案没说明这是计划：${wrong.join(", ")}`).toEqual([]);
    });
  }

  it("两套语言都保留了 DeleteConfirm 兜底用的删除失败文案", () => {
    // config.deleteConfigFailed / config.retryDelete 仍被 DeleteConfirm 当默认值引用，删掉会让弹层显示原始键名。
    for (const file of ["zh-CN.json", "en-US.json"]) {
      const flat = loadLocale(file);
      expect("config.deleteConfigFailed" in flat).toBe(true);
      expect("config.retryDelete" in flat).toBe(true);
      expect("config.deleteAsPlan" in flat).toBe(true);
    }
  });
});
