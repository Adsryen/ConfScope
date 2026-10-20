/**
 * 查找栏的快捷键提示必须两态成对存在（轮17 波42 R65）。
 *
 * 背景：Ctrl+F / F3 / Shift+F3 / Enter / Shift+Enter / Esc 早就实现了，
 * 但界面上只有一句「在此文件查找（Ctrl+F）」，其余全靠用户猜——
 * 快捷键做了却没人知道，等于没做。这条守卫钉四件事：
 * 1) 提示口径全站只有一份：轮48 起条子是 src/components/FindBar.tsx 这一份实现，
 *    浏览态 / 编辑态 / 并排差异三个宿主共用（轮22 R75 那套「只补一个视图等于另一个继续盲」
 *    的成因已经被抽掉，宿主接线由 tests/ux/findBarSingleImplementation.test.ts 钉）；
 * 2) 键名走 title + aria-keyshortcuts，aria-label 保持纯文案，读屏不会被键名串淹掉；
 * 3) 空态提示真的显示在栏内（复用 .code-find-count），不是挂在没人看的属性里；
 * 4) zh / en 两份文案都带同样的键名，不会只在中文里提示。
 */
import { describe, expect, it } from "vitest";
import { loadLocale, readScannedSource, sourceFiles } from "./scanUtils";

const BAR_FILES = ["src/components/FindBar.tsx"];
/** 键名走 title（悬停可见）+ aria-keyshortcuts（辅助技术可读），label 走不带键名的旧 key。 */
const HINTED: { labelKey: string; titleKey: string; keyShortcuts: string }[] = [
  { labelKey: "findPrev", titleKey: "findPrevKey", keyShortcuts: '"Shift+Enter Shift+F3"' },
  { labelKey: "findNext", titleKey: "findNextKey", keyShortcuts: '"Enter F3"' },
  { labelKey: "findClose", titleKey: "findCloseKey", keyShortcuts: '"Escape"' },
];
/** 键名到文案的最低要求：中文英文都必须出现这些字面 token。 */
const LOCALE_TOKENS: Record<string, string[]> = {
  "config.findPrevKey": ["Shift+Enter", "F3"],
  "config.findNextKey": ["Enter", "F3"],
  "config.findCloseKey": ["Esc"],
  "config.findHint": ["Enter", "Esc"],
  "config.openFind": ["Ctrl+F"],
};
const KEY_SHORTCUT_ATTR = /aria-keyshortcuts=/g;

/** 空态提示的落点：`.code-find-count` 那个 live region 的开标签 + children 表达式。 */
const COUNT_CLASS = 'className="code-find-count"';

function countRegion(source: string): { tag: string; children: string } {
  const start = source.indexOf(COUNT_CLASS);
  expect(start, `缺少 ${COUNT_CLASS} 容器`).toBeGreaterThanOrEqual(0);
  const tagEnd = source.indexOf(">", start);
  expect(tagEnd, `${COUNT_CLASS} 的开标签没闭合`).toBeGreaterThan(start);
  const childrenEnd = source.indexOf("</span>", tagEnd);
  expect(childrenEnd, `${COUNT_CLASS} 的 children 收不到尾`).toBeGreaterThan(tagEnd);
  return { tag: source.slice(start, tagEnd + 1), children: source.slice(tagEnd + 1, childrenEnd) };
}

function count(re: RegExp, source: string): number {
  return Array.from(source.matchAll(re)).length;
}

describe("查找栏快捷键提示两态成对（波42 R65）", () => {
  it("查找栏里每颗按钮都同时给到 title、可访问名与 aria-keyshortcuts", () => {
    for (const file of BAR_FILES) {
      const source = readScannedSource(file);
      for (const { labelKey, titleKey, keyShortcuts } of HINTED) {
        expect(source, `${file} 的 ${titleKey} 提示被摘掉了`).toContain(`t("config.${titleKey}")`);
        expect(source, `${file} 的可访问名不该被键名污染`).toContain(`aria-label={t("config.${labelKey}")}`);
        expect(source, `${file} 缺少 ${keyShortcuts} 的 aria-keyshortcuts`).toContain(`aria-keyshortcuts=${keyShortcuts}`);
      }
      expect(source, `${file} 的开栏按钮要把 Ctrl+F 告诉辅助技术`).toContain('aria-keyshortcuts="Control+F"');
    }
  });

  it("空态提示仍然长在栏内那个 live region 里，不是藏进属性", () => {
    for (const file of BAR_FILES) {
      const source = readScannedSource(file);
      expect(source, `${file} 的空态提示出口被删了`).toContain('t("config.findHint")');
      // 按 span 边界量，不按「距离 className 多少个字符」量：开标签里再加几个属性
      // （aria-live / 截断态的 title）就会把距离口径撑爆，而那根本不是回归。
      const { tag, children } = countRegion(source);
      expect(children, `${file} 的提示不该搬出 .code-find-count 的文本`).toContain('t("config.findHint")');
      expect(tag, `${file} 的提示被塞进了属性——读屏念不到`).not.toContain("config.findHint");
      expect(tag, `${file} 的 .code-find-count 不再是 live region`).toContain('aria-live="polite"');
    }
  });

  // ---- 自检：口径退回「按字符距离量」会被属性撑爆，按边界量则能抓到真回归 ----
  it("自检：把提示从 children 搬进 title 必须判红", () => {
    const source = readScannedSource(BAR_FILES[0]);
    const moved = source
      .replace(COUNT_CLASS, 'className="code-find-count" title={t("config.findHint")}')
      .replace(': t("config.findHint")}', ': ""}');
    expect(moved, "变异没落到 span 里，这条自检是空转").not.toBe(source);
    const { tag, children } = countRegion(moved);
    expect(tag, "变异后提示还是没进属性，这条自检是空转").toContain("config.findHint");
    expect(children, "提示搬进属性必须判红").not.toContain("config.findHint");
  });

  it("zh / en 两份文案带同样的键名 token", () => {
    for (const file of ["zh-CN.json", "en-US.json"]) {
      const flat = loadLocale(file);
      for (const [key, tokens] of Object.entries(LOCALE_TOKENS)) {
        const value = flat[key];
        expect(value, `${file} 缺少 ${key}`).toBeTruthy();
        for (const token of tokens) {
          expect(value, `${file} 的 ${key} 没提 ${token}`).toContain(token);
        }
      }
      // 键名提示不许混进读屏念的可访问名
      for (const plainKey of ["config.findPrev", "config.findNext", "config.findClose"]) {
        expect(flat[plainKey], `${file} 的 ${plainKey} 被塞进了键名`).not.toMatch(/Enter|Esc|F3|\+/);
      }
    }
  });

  it("aria-keyshortcuts 的站点不许空转：条子里至少 4 处", () => {
    for (const file of BAR_FILES) {
      expect(count(KEY_SHORTCUT_ATTR, readScannedSource(file)), file).toBeGreaterThanOrEqual(4);
    }
  });

  it("src/ 里出现 aria-keyshortcuts 的文件仍是这一份条子（新增处要一起审）", () => {
    const users = sourceFiles().filter((file) => readScannedSource(file).includes("aria-keyshortcuts="));
    expect(users.sort()).toEqual([...BAR_FILES].sort());
  });
});
