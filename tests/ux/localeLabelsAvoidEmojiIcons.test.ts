/**
 * 文案里的图标不许由彩色 emoji 承担（轮74 D2）。
 *
 * 真机修前的关于页：三个小标题挂着 🎯️📦，而 `.about-section h3::before` 早就画了一根自研装饰条
 * —— 同一行两套图标语言；五条特性列表各带一枚 emoji，配上 `li::before` 的 ▸ 就成了「▸ 🔗 多配置中心连接管理」。
 * 更要命的是 ⭐ GitHub 与 🐛 反馈问题：彩色 emoji 会进按钮的可访问名，读屏念出「星号 GitHub」，
 * Windows（Segoe UI Emoji）与 macOS（Apple Color Emoji）的字形还不是一套，同一颗按钮在两台机器上宽窄不同。
 * 本轮 C1 刚为 👁/🙈 付过一次账（换成线性 SVG），图标这一族必须只有一套。
 *
 * 口径（宁可漏报不误报，只打彩色 emoji）：
 * 1. 图形块 U+1F000–U+1FAFF / 区域指示符 / U+2B00 段（⭐ 在这儿）/ 变体选择符 U+FE0F
 *    —— FE0F 存在的唯一目的就是强制 emoji 呈现，见到它就是说好了「这颗要画成彩色」；
 * 2. 单色的排版符号 **不算** emoji：✓ ✕ ✎ ⚠（不带 FE0F）▸ 是字形不是图标，全站一直这么用；
 * 3. locale 的值里一颗都不许有；源码里除署名白名单外只许出现在下面的记账基线里（只减不增）；
 * 4. 防永真：修前的原文必须被探测器抓住，白名单里的每一项都必须仍然命中真实代码。
 */
import { describe, expect, it } from "vitest";
import { loadLocale, readScannedSource, sourceFiles } from "./scanUtils";

/** 彩色 emoji：图形块 + 区域指示符 + ⭐ 所在的杂项符号与箭头 + 强制 emoji 呈现的变体选择符。 */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;

/**
 * 记账基线：本轮只清了关于页与设置页那一族，这两处同缺陷但改动面在别的页面，留给下一轮。
 * 每一项都必须仍然命中真实代码 —— 修掉之后要把这条一起删掉，别留着当下一次漏网的口子。
 */
const SOURCE_BASELINE: { file: string; contains: string; why: string }[] = [
  { file: "src/components/ConnectionManager.tsx", contains: "\u{1F512}SSH", why: "连接项前的彩色锁：与全站线性图标不同族" },
  { file: "src/components/DeleteConfirm.tsx", contains: "\u{26A0}\u{FE0F}", why: "删除警告段的彩色三角：应改 CSS 装饰或线性图标" },
];

/** 署名白名单：页脚「Made with ❤️ by」是作者署名文案，不进任何控件的可访问名。 */
const SIGNATURE_ALLOWLIST: { file: string; mustContain: string }[] = [{ file: "src/components/About.tsx", mustContain: "Made with" }];

function emojiIn(text: string): string[] {
  return text.match(EMOJI) ?? [];
}

function offenderLines(relPath: string): { at: string; line: string }[] {
  return readScannedSource(relPath)
    .split("\n")
    .map((line, i) => ({ at: `${relPath}:${i + 1}`, line }))
    .filter(({ line }) => emojiIn(line).length > 0);
}

describe("文案不用彩色 emoji 当图标（轮74 D2）", () => {
  it("探测器不是摆设：修前的原文被抓到，单色字形不误伤", () => {
    expect(emojiIn("🎯 功能特性")).toEqual(["🎯"]);
    expect(emojiIn("⭐ GitHub")).toEqual(["⭐"]);
    expect(emojiIn("🛠️ 技术栈")).toEqual(["🛠", "️"]);
    expect(emojiIn("🐛 反馈问题")).toEqual(["🐛"]);
    // 这些是排版符号，全站一直这么用：误伤就会把 90 处正常写法一起报出来
    for (const text of ["✓ 已复制", "✕", "✎", "⚠", "▸ 多配置中心连接管理", "↑↓"]) {
      expect(emojiIn(text), `${text} 不该被算成彩色 emoji`).toEqual([]);
    }
  });

  it("两份 locale 的值里一颗彩色 emoji 都没有", () => {
    for (const file of ["zh-CN.json", "en-US.json"]) {
      const flat = loadLocale(file);
      const offenders = Object.entries(flat)
        .filter(([, text]) => emojiIn(text).length > 0)
        .map(([key, text]) => `${file} ${key} → ${text}`);
      expect(offenders, `${file} 里又用彩色 emoji 当图标了（图标走线性 SVG 或 CSS 装饰）`).toEqual([]);
    }
  });

  it("源码里的彩色 emoji 只剩署名与记账基线，且每一项都仍命中真实代码", () => {
    const files = new Set([...SIGNATURE_ALLOWLIST.map((e) => e.file), ...SOURCE_BASELINE.map((e) => e.file), "src/components/About.tsx"]);
    const offenders = sourceFiles()
      .filter((file) => !files.has(file))
      .flatMap((file) => offenderLines(file).map(({ at, line }) => `${at} → ${line.trim().slice(0, 60)}`));
    expect(offenders, "控件名/标题里又混进了彩色 emoji：与全站线性图标不同族，还会进可访问名").toEqual([]);

    for (const entry of SIGNATURE_ALLOWLIST) {
      expect(readScannedSource(entry.file), `署名白名单里的 ${entry.file} 已经不含 "${entry.mustContain}"，这条该删`).toContain(entry.mustContain);
    }
    for (const entry of SOURCE_BASELINE) {
      const hits = offenderLines(entry.file).filter(({ line }) => line.includes(entry.contains));
      expect(hits.length, `记账基线 ${entry.file} 的 ${entry.contains} 已不存在（${entry.why}）：修掉了就把这条删掉`).toBeGreaterThan(0);
    }
  });

  it("去掉 emoji 后标题不裸奔：自研装饰仍在 CSS 里", () => {
    const css = readScannedSource("src/styles.css");
    expect(css, ".about-section h3 的装饰条被删了：标题会只剩一行字").toMatch(/\.about-section h3::before \{[\s\S]*?background: var\(--accent\)/);
    expect(css, "特性列表的项目符号被删了：五条列表会糊成一团").toMatch(/\.about-section li::before \{/);
  });
});
