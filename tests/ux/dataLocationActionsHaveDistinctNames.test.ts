/**
 * 数据位置每行的动作按钮必须各自点得出名（轮67 R67-WP5）。
 *
 * 真机修前读数：7 行 14 颗按钮的 `aria-label` 全为 null，Tab 走查 #34-#40 连续念出
 * 「复制」「打开」——同名动作跨 7 行重复就是 WCAG 2.4.6 的缺陷，读屏用户按下前无从判断是哪一行。
 *
 * 口径（可见文字一个字不许动，只加 aria-label）：
 * 1. SettingsView 里每处 `<CopyButton` 都得带 `ariaLabel`；
 * 2. 渲染 `t("settings.openFolder")` 的那颗 button，起始标签上必须有 `aria-label`；
 * 3. 两个 locale 都得有 `copyPathAria` / `openFolderAria`，且模板里含住可见标签
 *    （WCAG 2.5.3：可访问名不含可见文字时，用户按屏幕上看到的词去搜语音命令会搜不到）；
 * 4. CopyButton 只把 ariaLabel 落到 aria-label 上，不许拿它当可见文字。
 * 5. 防永真：修前的原样必须被探测器抓住。
 */
import { describe, expect, it } from "vitest";
import { loadLocale, readScannedSource } from "./scanUtils";

/** 起始到第一个 `/>` 之间的一段 `<CopyButton ... />`（JSX 属性折行是常态，必须允许换行）。 */
const COPY_BUTTON_ELEMENT = /<CopyButton[\s\S]*?\/>/g;

/** 抓「没有 ariaLabel 的 CopyButton」。 */
function copyButtonsWithoutAriaLabel(relPath: string): string[] {
  const source = readScannedSource(relPath);
  return Array.from(source.matchAll(COPY_BUTTON_ELEMENT))
    .filter((chunk) => !/\bariaLabel=/.test(chunk[0]))
    .map((chunk) => `${relPath}:${source.slice(0, chunk.index ?? 0).split("\n").length}`);
}

/**
 * 找到渲染某段可见文字的 button，检查从 `<button` 到那段文字之间有没有 `aria-label`。
 * 不能拿第一个 `>` 当标签收尾——属性里的箭头函数 `() =>` 就带 `>`，会把窗口截断在标签中间；
 * 所以直接用「<button 到可见文字之间」这段，里面出现 aria-label 才算达标。
 */
function buttonsRenderingWithoutAriaLabel(relPath: string, textExpression: string): string[] {
  const source = readScannedSource(relPath);
  const offenders: string[] = [];
  let cursor = 0;
  for (;;) {
    const at = source.indexOf(textExpression, cursor);
    if (at < 0) return offenders;
    cursor = at + textExpression.length;
    const open = source.lastIndexOf("<button", at);
    expect(open, `${relPath}:${source.slice(0, at).split("\n").length} 那段文字不在任何 button 里`).toBeGreaterThan(-1);
    if (!/aria-label=/.test(source.slice(open, at))) {
      offenders.push(`${relPath}:${source.slice(0, open).split("\n").length}`);
    }
  }
}

const PRE_FIX_SAMPLES = [
  "<CopyButton text={entry.path} />",
  '<button type="button" className="btn btn-ghost btn-sm" disabled={openFolderBusy}>{t("settings.openFolder")}</button>',
];
const POST_FIX_SAMPLES = [
  '<CopyButton text={entry.path} ariaLabel={t("settings.copyPathAria", { name: rowName })} />',
  '<button type="button" aria-label={t("settings.openFolderAria", { name: rowName })}>{t("settings.openFolder")}</button>',
];

describe("数据位置动作按钮的可访问名守卫", () => {
  it("探测器本身有效：修前的原样要被抓、修后的写法不抓", () => {
    for (const sample of PRE_FIX_SAMPLES) {
      const bare = /<CopyButton[\s\S]*?\/>/g.test(sample) && !/\bariaLabel=/.test(Array.from(sample.matchAll(COPY_BUTTON_ELEMENT))[0]?.[0] ?? "");
      const noLabelTag = (() => {
        const open = sample.indexOf("<button");
        const tagEnd = sample.indexOf(">", open);
        return open >= 0 && tagEnd > open && !/aria-label=/.test(sample.slice(open, tagEnd));
      })();
      expect(bare || noLabelTag, `${sample} 是修前的违规原样，探测器抓不到就说明口径漂了`).toBe(true);
    }
    for (const sample of POST_FIX_SAMPLES) {
      const chunks = Array.from(sample.matchAll(COPY_BUTTON_ELEMENT));
      if (chunks.length > 0) {
        expect(chunks.every((chunk) => /\bariaLabel=/.test(chunk[0])), sample).toBe(true);
      }
      const open = sample.indexOf("<button");
      if (open >= 0) {
        expect(sample.slice(open, sample.indexOf('{t("settings')), sample).toMatch(/aria-label=/);
      }
    }
  });

  it("SettingsView 里没有不带 ariaLabel 的 CopyButton", () => {
    expect(copyButtonsWithoutAriaLabel("src/components/SettingsView.tsx")).toEqual([]);
  });

  it("渲染「打开」的那颗按钮带 aria-label", () => {
    expect(buttonsRenderingWithoutAriaLabel("src/components/SettingsView.tsx", '{t("settings.openFolder")}')).toEqual([]);
  });

  it("两个 locale 的分辨名都存在且含住可见标签", () => {
    for (const file of ["zh-CN.json", "en-US.json"]) {
      const locale = loadLocale(file);
      const pairs: Array<[string, string]> = [
        ["settings.copyPathAria", locale["common.copy"] as string],
        ["settings.openFolderAria", locale["settings.openFolder"] as string],
      ];
      for (const [key, visible] of pairs) {
        expect(locale[key], `${file} 缺 ${key}`).toBeTruthy();
        expect(locale[key], `${file} 的 ${key} 没含住可见标签「${visible}」（WCAG 2.5.3）`).toContain(visible as string);
        expect(locale[key] as string).toContain("{name}");
      }
    }
  });

  it("CopyButton 把 ariaLabel 只落到 aria-label 上", () => {
    const source = readScannedSource("src/components/CopyButton.tsx");
    expect(source).toMatch(/<button[^>]*aria-label=\{ariaLabel\}[^>]*>/s);
    // 可见文字仍然来自 label / common.copy
    expect(source).toMatch(/\{\s*done \? t\("common\.copied"\) : \(label \?\? t\("common\.copy"\)\)\s*\}/);
  });
});
