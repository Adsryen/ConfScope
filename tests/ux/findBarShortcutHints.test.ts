/**
 * 查找栏的快捷键提示必须两态成对存在（轮17 波42 R65）。
 *
 * 背景：Ctrl+F / F3 / Shift+F3 / Enter / Shift+Enter / Esc 早就实现了，
 * 但界面上只有一句「在此文件查找（Ctrl+F）」，其余全靠用户猜——
 * 快捷键做了却没人知道，等于没做。这条守卫钉四件事：
 * 1) 浏览态与编辑态的提示口径一致（只补一个视图等于另一个视图继续盲）；
 * 2) 键名走 title + aria-keyshortcuts，aria-label 保持纯文案，读屏不会被键名串淹掉；
 * 3) 空态提示真的显示在栏内（复用 .code-find-count），不是挂在没人看的属性里；
 * 4) zh / en 两份文案都带同样的键名，不会只在中文里提示。
 */
import { describe, expect, it } from "vitest";
import { loadLocale, readScannedSource, sourceFiles } from "./scanUtils";

const VIEWS = ["src/components/CodeView.tsx", "src/components/CodeEditor.tsx"];
/** 键名走 title（悬停可见）+ aria-keyshortcuts（辅助技术可读），label 走不带键名的旧 key。 */
const HINTED: { labelKey: string; titleKey: string; keyShortcuts: string }[] = [
  { labelKey: "findPrev", titleKey: "findPrevKey", keyShortcuts: '"Shift+Enter"' },
  { labelKey: "findNext", titleKey: "findNextKey", keyShortcuts: '"Enter"' },
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

function count(re: RegExp, source: string): number {
  return Array.from(source.matchAll(re)).length;
}

describe("查找栏快捷键提示两态成对（波42 R65）", () => {
  it("两个视图都要有带键名的 title，且 aria-label 仍然是不带键名的那条文案", () => {
    for (const file of VIEWS) {
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
    for (const file of VIEWS) {
      const source = readScannedSource(file);
      expect(source, `${file} 的空态提示出口被删了`).toContain('t("config.findHint")');
      expect(source, `${file} 的提示不该搬出 .code-find-count`).toMatch(/className="code-find-count"[\s\S]{0,400}config\.findHint/);
    }
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

  it("aria-keyshortcuts 的站点不许空转：两个视图各至少 4 处", () => {
    for (const file of VIEWS) {
      expect(count(KEY_SHORTCUT_ATTR, readScannedSource(file)), file).toBeGreaterThanOrEqual(4);
    }
  });

  it("src/ 里出现 aria-keyshortcuts 的文件仍是这两个视图（新增处要一起审）", () => {
    const users = sourceFiles().filter((file) => readScannedSource(file).includes("aria-keyshortcuts="));
    expect(users.sort()).toEqual([...VIEWS].sort());
  });
});
