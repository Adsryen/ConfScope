/**
 * 会显示给用户的文案必须走 i18n（轮6 R45 / R51 / R54）。
 *
 * 扫出来的真 bug 有三处同族：
 * - App.tsx 与 lib/appDataDoc.ts 给错误中心写死「本地数据」，英文界面里错误中心冒出中文；
 * - ApplyPlanView 执行成功的横幅用「t() 结果 + 写死的中文尾巴」拼，英文界面漏出「（另有 N 项已阻断，未执行）」；
 * - 复制失败一点反馈都没有（CopyButton / MessageCenter / About），WebView 拦剪贴板时用户以为没点到。
 * 这类漂移不会报错也不会飘红，只能静态钉住：投递给「用户看得见」的出口，参数里不许有中文字面量。
 */
import { describe, expect, it } from "vitest";
import { lineAt, loadLocale, readScannedSource, sourceFiles } from "./scanUtils";

const CJK = /[\u3400-\u9fff]/;
/** 用户可见出口：轻提示、错误中心、页面横幅、原生 alert。 */
const SINKS = /\b(?:toast|report\w*|setNotice|setExecuteNotice|setBanner|alert)\(/g;
/** 字符串/模板字面量（模板里的 `${}` 段落仍算字面量文本，正好能抓到拼接漏译）。 */
const LITERALS = /(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
/** 从 `(` 起做括号配平，取整段实参；带引号状态机，不会被 `"("` 这类字符骗过。 */
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

/** 某文件里「出现在可见出口实参中的中文字面量」。 */
function leaksInFile(file: string): string[] {
  const source = readScannedSource(file);
  const leaks: string[] = [];
  for (const sink of Array.from(source.matchAll(SINKS))) {
    const open = (sink.index ?? 0) + sink[0].length - 1;
    const window = argumentWindow(source, open);
    for (const literal of Array.from(window.matchAll(LITERALS))) {
      if (!CJK.test(literal[2])) continue;
      const absolute = open + (literal.index ?? 0);
      leaks.push(`${file}:${lineAt(file, absolute)} ${sink[0].replace("(", "")} → ${JSON.stringify(literal[2].slice(0, 40))}`);
    }
  }
  return leaks;
}

const files = sourceFiles();

describe("可见文案的 i18n 守卫", () => {
  it("扫描口径不是空转：确实抓到了可见出口", () => {
    const sinkCount = files.reduce((acc, file) => acc + Array.from(readScannedSource(file).matchAll(SINKS)).length, 0);
    expect(sinkCount).toBeGreaterThan(50);
  });

  it("可见出口的实参里不许有中文字面量（英文界面会直接漏出中文）", () => {
    const leaks = files.flatMap(leaksInFile);
    expect(leaks).toEqual([]);
  });

  it("JSX 文本节点里不许有写死的中文（可见文案一律 t()）", () => {
    const hits = files
      .filter((file) => file.endsWith(".tsx"))
      .flatMap((file) => {
        const source = readScannedSource(file);
        return Array.from(source.matchAll(/>((?:[^<>{}]|{[^{}]*}){1,200}?)</g))
          .filter((m) => CJK.test(m[1]) && m[1].trim())
          .map((m) => `${file}:${lineAt(file, m.index ?? 0)} → ${JSON.stringify(m[1].trim().slice(0, 40))}`);
      });
    expect(hits).toEqual([]);
  });
});

describe("复制失败的反馈守卫（R51）", () => {
  /** 真正调剪贴板的站点：CopyButton 是共享实现，lib/clipboard 是定义处，其余必须自己处理失败。 */
  const callSites = files.filter((file) => readScannedSource(file).includes("copyText("));

  it("调用 copyText 的文件不多于登记范围（新增复制点要一起加守卫）", () => {
    expect(callSites.sort()).toEqual(
      expect.arrayContaining(["src/components/CopyButton.tsx", "src/components/MessageCenter.tsx", "src/lib/clipboard.ts"])
    );
  });

  it("除共享实现外，直接调 copyText 的组件必须处理失败分支", () => {
    const unhandled = callSites
      .filter((file) => file !== "src/lib/clipboard.ts" && file !== "src/components/CopyButton.tsx")
      .filter((file) => {
        const source = readScannedSource(file);
        return !/if\s*\(\s*await\s+copyText\(/.test(source) || !source.includes('t("common.copyFailed")');
      });
    expect(unhandled).toEqual([]);
  });

  it("共享 CopyButton 成功/失败两条路都有反馈", () => {
    const button = readScannedSource("src/components/CopyButton.tsx");
    expect(button).toMatch(/if\s*\(\s*await\s+copyText\(/);
    expect(button).toContain('t("common.copyFailed")');
    expect(button).toContain("toast(");
  });

  it("复制失败这条文案真的存在于两份语言文件里（键存在性由 localeParity 兜，这里查引用）", () => {
    const zh = loadLocale("zh-CN.json");
    const en = loadLocale("en-US.json");
    expect(Object.keys(zh)).toContain("common.copyFailed");
    expect(en["common.copyFailed"].trim().length, "en 侧不能空着").toBeGreaterThan(0);
    // 引用的地方必须写的是同一个键名
    ["src/components/CopyButton.tsx", "src/components/MessageCenter.tsx"].forEach((file) => {
      expect(readScannedSource(file)).toContain('"common.copyFailed"');
    });
  });

  it("About 页不再手搓复制按钮（手搓的那版连成功反馈都没有）", () => {
    const about = readScannedSource("src/components/About.tsx");
    expect(about).not.toMatch(/onClick=\{[^}]*copyText\(/);
    expect(about).toContain("CopyButton");
  });
});
