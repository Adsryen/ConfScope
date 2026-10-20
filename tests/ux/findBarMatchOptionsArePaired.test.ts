/**
 * 查找栏的匹配口径开关必须两态成对（轮22 波52 R75）。
 *
 * 背景：浏览态（CodeView）与编辑态（CodeEditor）原本是两套独立实现的查找栏，
 * 命中计算 / 计数 / 导航全都有两份。这类「两份实现」最容易出的事故是
 * 只补一边：浏览态能区分大小写了，编辑态里同一个词却仍然全量命中，
 * 用户切个 Tab 就发现「刚刚明明搜到了」——没人会怀疑是口径没成对。
 * 轮48 把条子抽成 src/components/FindBar.tsx 一份实现（第三个宿主：并排差异 DiffPanel），
 * 于是这条守卫分成两半：**markup 只许有一份**（在 FindBar），**状态与口径只许成对**。
 * 轮49 把「状态与编排」也抽成 src/lib/useFindLayer.ts 一份：量 DOM 那一派的两个宿主
 * 不再自己握着 Aa / ab| 的 state，只把共享层给的 `toggle*` 接进条子。
 * 与 tests/ux/findBarShortcutHints.test.ts 同一口径：跨文件的成对关系只守一次。
 *
 * 钉六件事：
 * 1) 条子里有且只有两个开关，都带 aria-pressed（否则读屏不知道开没开）；
 * 2) 状态出处（两个未迁宿主 + 共享层）都走同一对记忆键，翻转口径一致；
 * 3) 渲染条子的四个宿主都要把两颗状态与两颗翻转接进条子，缺一颗就是装饰品；
 * 4) 选项一律被门在 findOpen 之后——外部内容搜索词必须继续「大小写不敏感子串」，
 *    这条同时被 src/lib/configContentSearch.test.ts 的跨模块不变式钉着；
 * 5) 记忆键同名且只有状态出处那三处在用（不落 localStorage，见 viewStateSingleStore）；
 * 6) 开关文案里不许出现键名，title 也不能和 aria-keyshortcuts 打架（findBarShortcutHints）。
 */
import { describe, expect, it } from "vitest";
import { loadLocale, readScannedSource, sourceFiles } from "./scanUtils";

const BAR = "src/components/FindBar.tsx";
const LAYER = "src/lib/useFindLayer.ts";
const CODE_VIEW = "src/components/CodeView.tsx";
const CODE_EDITOR = "src/components/CodeEditor.tsx";
const DIFF_PANEL = "src/components/DiffPanel.tsx";
const UNIFIED_DIFF = "src/components/UnifiedDiff.tsx";
/** 握着两颗开关 state 的地方：未迁的两个代码视图 + 共享层，只此三处。 */
const STATE_SITES = [CODE_VIEW, CODE_EDITOR, LAYER];
/** 渲染条子的四个宿主。 */
const JSX_HOSTS = [CODE_VIEW, CODE_EDITOR, DIFF_PANEL, UNIFIED_DIFF];
/** 量 DOM 那一派：状态在共享层，宿主只做接线。 */
const LAYER_HOSTS = [DIFF_PANEL, UNIFIED_DIFF];
const OPTIONS: Array<{ key: string; localeKey: string; state: string; setter: string; toggle: string; toggleProp: string }> = [
  {
    key: "codeFind.caseSensitive",
    localeKey: "config.findCaseSensitive",
    state: "caseSensitive",
    setter: "setCaseSensitive",
    toggle: "toggleCaseSensitive",
    toggleProp: "CaseSensitive",
  },
  {
    key: "codeFind.wholeWord",
    localeKey: "config.findWholeWord",
    state: "wholeWord",
    setter: "setWholeWord",
    toggle: "toggleWholeWord",
    toggleProp: "WholeWord",
  },
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

  it("开关的 state 只有三处出处，且都是布尔翻转", () => {
    for (const file of STATE_SITES) {
      const source = readScannedSource(file);
      for (const { state, setter } of OPTIONS) {
        expect(source, `${file} 的 ${state} 开关没走记忆层`).toContain(`const [${state}, ${setter}] = useRememberedState<boolean>`);
      }
      expect(source, `${file} 里出现第四份自己存的口径`).not.toMatch(/localStorage\.\w+\(\s*"codeFind/);
    }
    for (const file of [CODE_VIEW, CODE_EDITOR]) {
      const source = readScannedSource(file);
      for (const { setter, toggleProp } of OPTIONS) {
        expect(source, `${file} 的 ${setter} 不是布尔翻转`).toContain(`onToggle${toggleProp}={() => ${setter}((v) => !v)}`);
      }
    }
    // 共享层的翻转必须留在层里：宿主里出现 setCaseSensitive 就是抄了一份 state
    const layer = readScannedSource(LAYER);
    for (const { toggle } of OPTIONS) {
      expect(layer, `${LAYER} 没暴露 ${toggle}`).toMatch(new RegExp(String.raw`\b${toggle}: \(\) => set\w+\(\(v\) => !v\),`));
    }
    for (const file of LAYER_HOSTS) {
      const source = readScannedSource(file);
      for (const { setter } of OPTIONS) {
        expect(source, `${file} 自己写了一份 ${setter}（第二套口径的开头）`).not.toContain(setter);
      }
    }
  });

  it("四个宿主都把两颗状态与两颗翻转成对接进条子", () => {
    for (const file of JSX_HOSTS) {
      const source = readScannedSource(file);
      for (const { state, toggle, toggleProp, setter } of OPTIONS) {
        expect(source, `${file} 没把 ${state} 递进条子`).toContain(`${state}={${state}}`);
        const wired = new RegExp(String.raw`onToggle${toggleProp}=\{(?:\(\) => ${setter}\(\(v\) => !v\)|${toggle})\}`);
        expect(source, `${file} 的 ${state} 开关没接到条子的 onToggle${toggleProp}`).toMatch(wired);
      }
    }
  });

  it("选项一律被门在 findOpen 之后：外部搜索词继续大小写不敏感子串", () => {
    const gated = /\(\s*\)\s*=>\s*\(findOpen \? \{ caseSensitive, wholeWord \} : NEUTRAL_MATCH_OPTIONS\)/;
    for (const file of STATE_SITES) {
      const source = readScannedSource(file);
      expect(source, `${file} 的查找选项没被 findOpen 门住（会污染外部内容搜索词）`).toMatch(gated);
      // 记忆层常量必须是同一份引用：写成对象字面量会让命中表每渲染重算一次
      expect(source, `${file} 缺 NEUTRAL_MATCH_OPTIONS 常量`).toMatch(/(?:export )?const NEUTRAL_MATCH_OPTIONS: MatchOptions = \{\};/);
    }
    // 关栏时那个常量必须是**同一个引用**，否则每次渲染都重算命中表
    expect(readScannedSource(LAYER), "共享层的中性口径不再是模块级同一份引用").toMatch(
      /^export const NEUTRAL_MATCH_OPTIONS: MatchOptions = \{\};$/m
    );
    for (const file of [CODE_VIEW, CODE_EDITOR]) {
      expect(readScannedSource(file), `${file} 的命中计算没把选项传下去`).toMatch(
        /findCodeHits\(\s*\w+,\s*effectiveTerm\.trim\(\),\s*matchOptions\s*\)/
      );
    }
    // 差异两派走共享层的命中枚举（一行两格），但同一把尺子：options 原样透传
    expect(readScannedSource(LAYER), "共享层的命中计算没把选项传下去").toMatch(
      /findDiffHits\(\s*rows,\s*effectiveTerm\.trim\(\),\s*matchOptions\s*\)/
    );
  });

  it("记忆键同名、只有状态出处那三处在用，且没绕开 viewState 唯一实现", () => {
    const keys = OPTIONS.map((option) => option.key);
    for (const file of STATE_SITES) {
      const source = readScannedSource(file);
      for (const key of keys) {
        expect(source, `${file} 少了记忆键 ${key}`).toContain(`${key}"`);
      }
    }
    const users = sourceFiles().filter((rel) => {
      const source = readScannedSource(rel);
      return keys.some((key) => source.includes(`"${key}"`));
    });
    expect(users.sort(), "查找口径的记忆键被名单外的文件用了").toEqual([...STATE_SITES].sort());
    // 走 viewState 而不是 localStorage：状态出处共用一份、且不落盘
    for (const file of STATE_SITES) {
      expect(readScannedSource(file), `${file} 自己存了 localStorage`).not.toMatch(/localStorage\.\w+\(\s*"codeFind/);
    }
    // 接线侧不许凭空多出第三份 state：宿主没引 viewState 也算合规，引了就必须成对
    for (const file of LAYER_HOSTS) {
      expect(readScannedSource(file), `${file} 绕过共享层自己读记忆键`).not.toMatch(/useRememberedState/);
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
    // 三处状态出处的命中计算都真的接了第三个参数（只有一份在用 = 另一份的开关是装饰品）
    for (const file of STATE_SITES) {
      expect(readScannedSource(file), `${file} 的查找选项没进命中计算`).toMatch(/(findCodeHits|findDiffHits)\([\s\S]{0,80}matchOptions\)/);
    }
  });

  it("自检：宿主退回「把 state 抄回本地」必须判红（轮49）", () => {
    const panel = readScannedSource(DIFF_PANEL);
    expect(panel, "取样点漂了：DiffPanel 现在确实不自己握 state").not.toMatch(/useRememberedState/);
    const regressed = panel.replace(
      "const find = useFindLayer({",
      'const [caseSensitive, setCaseSensitive] = useRememberedState<boolean>("codeFind.caseSensitive", false);\n  const find = useFindLayer({'
    );
    expect(regressed !== panel, "变异没落进被测文本").toBe(true);
    expect(regressed, "宿主自己握 state 这一步没有被挡住").toMatch(/useRememberedState/);
  });
});
