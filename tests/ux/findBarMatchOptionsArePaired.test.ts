/**
 * 查找栏的匹配口径开关必须两态成对（轮22 波52 R75）。
 *
 * 背景：浏览态（CodeView）与编辑态（CodeEditor）原本是两套独立实现的查找栏，
 * 命中计算 / 计数 / 导航全都有两份。这类「两份实现」最容易出的事故是
 * 只补一边：浏览态能区分大小写了，编辑态里同一个词却仍然全量命中，
 * 用户切个 Tab 就发现「刚刚明明搜到了」——没人会怀疑是口径没成对。
 * 轮48 把条子抽成 src/components/FindBar.tsx 一份实现（第三个宿主：并排差异 DiffPanel），
 * 于是这条守卫分成两半：**markup 只许有一份**（在 FindBar），**状态与口径只许成对**（在每个宿主里）。
 * 与 tests/ux/findBarShortcutHints.test.ts 同一口径：跨文件的成对关系只守一次。
 *
 * 钉五件事：
 * 1) 条子里有且只有两个开关，都带 aria-pressed（否则读屏不知道开没开）；
 * 2) 三个宿主用同一对记忆键、同一个 locale key 出口，中英都有文案；
 * 3) 选项一律被门在 findOpen 之后——外部内容搜索词必须继续「大小写不敏感子串」，
 *    这条同时被 src/lib/configContentSearch.test.ts 的跨模块不变式钉着；
 * 4) 记忆键同名且只有这两个文件在用（不落 localStorage，见 viewStateSingleStore）；
 * 5) 开关文案里不许出现键名，title 也不能和 aria-keyshortcuts 打架（findBarShortcutHints）。
 */
import { describe, expect, it } from "vitest";
import { loadLocale, readScannedSource, sourceFiles } from "./scanUtils";

const BAR = "src/components/FindBar.tsx";
const DIFF_PANEL = "src/components/DiffPanel.tsx";
const CODE_VIEWS = ["src/components/CodeView.tsx", "src/components/CodeEditor.tsx"];
const HOSTS = [...CODE_VIEWS, DIFF_PANEL];
const OPTIONS: Array<{ key: string; localeKey: string; state: string; setter: string; toggleProp: string }> = [
  {
    key: "codeFind.caseSensitive",
    localeKey: "config.findCaseSensitive",
    state: "caseSensitive",
    setter: "setCaseSensitive",
    toggleProp: "CaseSensitive",
  },
  { key: "codeFind.wholeWord", localeKey: "config.findWholeWord", state: "wholeWord", setter: "setWholeWord", toggleProp: "WholeWord" },
];

function toggleSites(source: string): string[] {
  return Array.from(source.matchAll(/className=\{`code-find-toggle/g), (m) => m[0]);
}

describe("查找栏匹配口径开关两态成对（R75）", () => {
  it("条子里只有 Aa 与 ab| 两颗开关，播报状态且不抢输入框焦点", () => {
    const source = readScannedSource(BAR);
    expect(toggleSites(source), `${BAR} 的开关数量变了（应当是 Aa 与 ab| 两个）`).toHaveLength(2);
    for (const { localeKey, state } of OPTIONS) {
      expect(source, `${BAR} 缺 ${state} 开关`).toContain(`aria-pressed={${state}}`);
      expect(source, `${BAR} 缺 ${localeKey} 文案`).toContain(`t("${localeKey}")`);
    }
    // 点开关不许把焦点从查找输入框 / textarea 上抢走
    expect(source, `${BAR} 的开关没有挡住 mousedown 默认行为`).toMatch(
      /className=\{`code-find-toggle[\s\S]{0,400}onMouseDown=\{\(e\) => e\.preventDefault\(\)\}/
    );
  });

  it("每个宿主都把记忆层的状态成对递进条子，翻转写在宿主自己这边", () => {
    for (const file of HOSTS) {
      const source = readScannedSource(file);
      for (const { state, setter, toggleProp } of OPTIONS) {
        expect(source, `${file} 的 ${state} 开关没走记忆层`).toContain(`const [${state}, ${setter}] = useRememberedState<boolean>`);
        expect(source, `${file} 没把 ${state} 递进条子`).toContain(`${state}={${state}}`);
        expect(source, `${file} 的 ${setter} 不是布尔翻转`).toContain(`onToggle${toggleProp}={() => ${setter}((v) => !v)}`);
      }
    }
  });

  it("选项一律被门在 findOpen 之后：外部搜索词继续大小写不敏感子串", () => {
    const gated = /\(\s*\)\s*=>\s*\(findOpen \? \{ caseSensitive, wholeWord \} : NEUTRAL_MATCH_OPTIONS\)/;
    for (const file of HOSTS) {
      const source = readScannedSource(file);
      expect(source, `${file} 的查找选项没被 findOpen 门住（会污染外部内容搜索词）`).toMatch(gated);
      // 记忆层常量必须是同一份引用：写成对象字面量会让命中表每渲染重算一次
      expect(source, `${file} 缺 NEUTRAL_MATCH_OPTIONS 常量`).toMatch(/const NEUTRAL_MATCH_OPTIONS: MatchOptions = \{\};/);
    }
    for (const file of CODE_VIEWS) {
      expect(readScannedSource(file), `${file} 的命中计算没把选项传下去`).toMatch(
        /findCodeHits\(\s*\w+,\s*effectiveTerm\.trim\(\),\s*matchOptions\s*\)/
      );
    }
    // 并排差异走自己那份命中枚举（一行两格），但同一把尺子：options 原样透传
    expect(readScannedSource(DIFF_PANEL), "DiffPanel 的命中计算没把选项传下去").toMatch(
      /findDiffHits\(\s*findRows,\s*effectiveTerm\.trim\(\),\s*matchOptions\s*\)/
    );
  });

  it("记忆键同名、只有这三个宿主在用，且没绕开 viewState 唯一实现", () => {
    const keys = OPTIONS.map((option) => option.key);
    for (const file of HOSTS) {
      const source = readScannedSource(file);
      for (const key of keys) {
        expect(source, `${file} 少了记忆键 ${key}`).toContain(`${key}"`);
      }
    }
    const users = sourceFiles().filter((rel) => {
      const source = readScannedSource(rel);
      return keys.some((key) => source.includes(`"${key}"`));
    });
    expect(users.sort(), "查找口径的记忆键被名单外的文件用了").toEqual([...HOSTS].sort());
    // 走 viewState 而不是 localStorage：三态共用一份、且不落盘
    for (const file of HOSTS) {
      expect(readScannedSource(file), `${file} 自己存了 localStorage`).not.toMatch(/localStorage\.\w+\(\s*"codeFind/);
    }
  });

  it("中英两份文案都有开关名，且不含任何键名 token", () => {
    for (const file of ["zh-CN.json", "en-US.json"]) {
      const flat = loadLocale(file);
      for (const { localeKey } of OPTIONS) {
        const value = flat[localeKey];
        expect(value, `${file} 缺 ${localeKey}`).toBeTruthy();
        expect(value, `${file} 的 ${localeKey} 被塞进了键名`).not.toMatch(/Enter|Esc|F3|Ctrl|Shift|\+/);
      }
    }
  });

  it("守卫自身不空转：口径类型与选项参数在生产代码里真的存在", () => {
    const textMatch = readScannedSource("src/lib/textMatch.ts");
    expect(textMatch).toContain("export interface MatchOptions");
    expect(textMatch).toMatch(/export function matchLiteral\([^)]*options: MatchOptions = \{\}/);
    // 全词边界不许退回正则 \b：JS 的 \b 只认 ASCII，中文搜索词会恒为 0 命中
    expect(textMatch, "又用回正则 \\b 了：中文词开全词会变成死条件").not.toMatch(/\\bb/);
    expect(readScannedSource("src/lib/codeLines.ts")).toMatch(/export function findCodeHits\([^)]*options: MatchOptions = \{\}/);
    expect(readScannedSource("src/lib/diffFind.ts")).toMatch(/export function findDiffHits\([\s\S]*?options: MatchOptions/);
    // 三个宿主的命中计算都真的接了第三个参数（只有一份在用 = 另一份的开关是装饰品）
    for (const file of HOSTS) {
      expect(readScannedSource(file), `${file} 的查找选项没进命中计算`).toMatch(/(findCodeHits|findDiffHits)\([\s\S]{0,80}matchOptions\)/);
    }
  });
});
