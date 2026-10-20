/**
 * 查找条只许有一份实现（轮48）。
 *
 * 缺陷长什么样：浏览态（CodeView）与编辑态（CodeEditor）各抄了一份 DOM 一模一样的条子，
 * 两份的差别只有「onChange 里顺手把序号归零」和「style 带不带右侧留白」。轮48 要接第三处
 * （并排差异 DiffPanel）时，第三份拷贝就等于把「只补一边」这个事故形状再复制一遍 ——
 * 轮22 R75 记的就是它：两套条子里改了一套，另一套的键名提示 / 焦点行为从此各说各话。
 *
 * 轮49 把「状态与副作用编排」也收成了唯一一份（src/lib/useFindLayer.ts）：第四个宿主
 * UnifiedDiff 接进来时不再抄第四份散装 state，量 DOM 那一派（DiffPanel / UnifiedDiff）共用它。
 *
 * 现在条子在 src/components/FindBar.tsx 里只有一份，宿主只传状态与几何。守卫钉四件事：
 * 1. 条子的类名字面量（code-find*）只许出现在这一份 JSX 里 —— 第二份就等于第二套几何；
 * 2. 宿主只许 <FindBar / <FindOpenButton 两个入口，宿主名单在这里登记，新增宿主必须显式加；
 * 3. 条子里的文案键与 ⌕ 的键名提示（aria-keyshortcuts="Control+F"）只许出现在这一份实现里；
 * 4. FindBar 反过来也不许碰宿主的命中表与滚动 DOM —— 「视图无关」是它唯一的存在理由。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource, sourceFiles } from "./scanUtils";

const BAR = "src/components/FindBar.tsx";
/** 已登记的宿主。新增一处查找条就要在这里加一行，并同步 findKeyOwnership 那份所有权名单。 */
const HOSTS = [
  "src/components/CodeView.tsx",
  "src/components/CodeEditor.tsx",
  "src/components/DiffPanel.tsx",
  // 轮49：历史「高亮变更」那一屏（默认视图）也是查找栏宿主
  "src/components/UnifiedDiff.tsx",
] as const;

/** 条子这一层的全部类名（styles.css 里 .code-find* 那组规则的唯一使用者）。 */
const BAR_CLASSES = [
  "code-find",
  "code-find-input",
  "code-find-toggle",
  "code-find-count",
  "code-find-btn",
  "code-find-open",
];

/** 条子里用到的文案键：第二份实现必然要重新抄一遍这几个键，所以它们也是「唯一实现」的证据。 */
const BAR_LOCALE_KEYS = [
  "config.findPlaceholder",
  "config.findCaseSensitive",
  "config.findWholeWord",
  "config.findCount",
  "config.findCountCapped",
  "config.findCountCappedHint",
  "config.findNone",
  "config.findHint",
  "config.findPrev",
  "config.findNext",
  "config.findPrevKey",
  "config.findNextKey",
  "config.findClose",
  "config.findCloseKey",
  "config.openFind",
];

/**
 * 取一个文件里所有 `className=` 的字面类名词元。
 *
 * 与 scrollableReadOnlyRegionsNeedKeyboardAccess 同一口径：模板串里 `${}` 的片段先抹平成空白再切，
 * 所以 `code-find-toggle${caseSensitive ? " is-on" : ""}` 交出的是 code-find-toggle 与 is-on。
 */
function classNameTokens(source: string): string[] {
  const tokens: string[] = [];
  for (const match of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/g)) {
    const raw = `${match[1] ?? ""} ${match[2] ?? ""} ${match[3] ?? ""}`;
    tokens.push(...raw.replace(/[`'"]/g, " ").split(/[\s${}]+/).filter(Boolean));
  }
  return tokens;
}

function usedLocaleKeys(source: string): string[] {
  return BAR_LOCALE_KEYS.filter((key) => source.includes(`"${key}"`));
}

function barUsers(): string[] {
  return sourceFiles().filter((rel) => /<(FindBar|FindOpenButton)\b/.test(readScannedSource(rel)));
}

describe("查找条只有一份实现（轮48）", () => {
  it("宿主文件不许再写第二份条子的类名", () => {
    const copies: string[] = [];
    sourceFiles().forEach((rel) => {
      if (rel === BAR) return;
      const hits = classNameTokens(readScannedSource(rel)).filter((token) => BAR_CLASSES.includes(token));
      hits.forEach((token) => copies.push(`${rel} -> .${token}`));
    });
    expect(copies, `查找条的类名出现在第二处实现里（改一边漏一边的老路）：\n${copies.join("\n")}`).toEqual([]);
  });

  it("唯一的实现里确实有这一组类名，守卫不是空转", () => {
    const bar = readScannedSource(BAR);
    const tokens = classNameTokens(bar);
    BAR_CLASSES.forEach((cls) => {
      expect(tokens, `.${cls} 在 FindBar.tsx 里找不到了：扫描口径变了，或被改名漏了`).toContain(cls);
    });
    BAR_LOCALE_KEYS.forEach((key) => {
      expect(bar, `${key} 不再被 FindBar.tsx 使用，请连这条守卫一起改`).toContain(`"${key}"`);
    });
  });

  it("宿主名单固定四处，只经 <FindBar / <FindOpenButton 两个入口", () => {
    expect(barUsers().sort(), "出现第二处查找条实现或宿主名单漏登记").toEqual([...HOSTS].sort());
    HOSTS.forEach((file) => {
      const src = readScannedSource(file);
      expect(src, `${file} 必须从 ./FindBar 拿条子`).toMatch(/from "\.\/FindBar"/);
      expect(src, `${file} 没有条子的开栏入口（<FindOpenButton）`).toContain("<FindOpenButton");
      // 三个宿主都由 enableFind 决定接不接查找（ApplyPlanView 关掉它，避免与本页 CodeEditor 抢 Ctrl+F）
      expect(src, `${file} 的开栏条件不再由 enableFind 把关`).toMatch(/enableFind/);
    });
  });

  it("⌕ 的 Ctrl+F 键名提示只挂在唯一实现上", () => {
    const hint = /aria-keyshortcuts="Control\+F"/;
    expect(readScannedSource(BAR), "唯一实现里没有那颗 ⌕ 的键名提示").toMatch(hint);
    const copies = sourceFiles().filter((rel) => rel !== BAR && hint.test(readScannedSource(rel)));
    expect(copies, `又在宿主里手写了一遍 Ctrl+F 提示：\n${copies.join("\n")}`).toEqual([]);
  });

  it("FindBar 自己不知道命中表、滚动与状态——那些是宿主的", () => {
    const bar = readScannedSource(BAR);
    const leaks: Array<[string, RegExp]> = [
      ["自己算命中（编号与步进单位只有宿主知道）", /findCodeHits|findDiffHits|MAX_CODE_HITS/],
      ["碰宿主正文的 DOM（焦点归还与定位都在宿主）", /querySelector|scrollTop|scrollLeft|dangerouslySetInnerHTML/],
      ["自己记状态（开栏与否、查找词、序号都得在宿主）", /useState\(|useLayoutEffect\(|useEffect\(/],
      ["读存储（记忆键归宿主，见 findBarMatchOptionsArePaired）", /useRememberedState|localStorage/],
      ["抢按键所有权（Ctrl+F / Esc 的分派在宿主）", /addEventListener|takeGlobalShortcut|EscapePriority/],
    ];
    leaks.forEach(([label, re]) => {
      expect(bar, `FindBar.tsx 里出现「${label}」，条子就不再是视图无关的了`).not.toMatch(re);
    });
    // 反过来：几何与状态必须由 props 下发，缺一份就又得回到「各写一份」
    ["term", "hitCount", "currentHit", "capped", "cappedMax", "caseSensitive", "wholeWord", "barRef", "inputRef", "style"].forEach(
      (prop) => {
        expect(bar, `FindBarProps 少了 ${prop}，宿主就只能自己补一份几何`).toContain(`${prop}`);
      }
    );
  });

  it("自检：把条子抄回宿主就一定判红", () => {
    const host = readScannedSource("src/components/DiffPanel.tsx");
    expect(host).not.toMatch(/code-find/);
    const mutant = host.replace(
      "<FindBar",
      `<div className="code-find">\n              <input className="code-find-input mono" />\n              <FindBar`
    );
    expect(mutant.includes("code-find-input"), "变异没落到宿主源码里，这条守卫是空转").toBe(true);
    expect(classNameTokens(mutant).filter((token) => BAR_CLASSES.includes(token))).not.toEqual([]);
    // 同样的变异走「删掉唯一实现」那条路也必须被第 2 条拦住
    const stripped = host.replace("<FindBar", "<Nothing");
    expect(barUsers().length).toBe(HOSTS.length);
    expect(stripped).not.toContain("<FindBar");
  });

  it("条子的文案键在 src 里只被唯一实现引用", () => {
    const strays: string[] = [];
    sourceFiles().forEach((rel) => {
      if (rel === BAR) return;
      usedLocaleKeys(readScannedSource(rel)).forEach((key) => strays.push(`${rel} -> ${key}`));
    });
    expect(strays, `查找条文案键被第二处引用（多半是抄了条子）：\n${strays.join("\n")}`).toEqual([]);
  });
});
