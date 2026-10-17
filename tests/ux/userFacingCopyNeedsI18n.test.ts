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
        // 失败分支必须复用共享文案：组件用 t()、lib 用 translate()（波41 的 externalLink 就是后者），
        // 所以这里认 key 本身，而不是认某一种调用写法——换成自建文案同样算没处理。
        return !/if\s*\(\s*await\s+copyText\(/.test(source) || !/["']common\.copyFailed["']/.test(source);
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

/**
 * lib 层抛给用户的错误文案（波24 R43）。
 *
 * lib 里的 `new Error("…")` 不是日志，它们会被 `InlineError`、错误中心、任务详情原样贴到界面上，
 * 所以「写死一种语言」和可见出口写死中文是同一个 bug：英文界面冒中文、中文界面冒英文。
 * lib 层没有组件的 `t()`，沿用 `appDataDoc.ts` 的先例用 `translate()`，
 * 分区名 / ref / 底层异常文本属于数据，按 `{占位}` 透传。
 */
/** Error 构造点（含自定义子类，如 `new RangeError(`）。 */
const ERROR_CTOR = /\bnew\s+\w*Error\s*\(/g;
/** 已成句的文案至少三个实词；键名（`appDataBackup.missingSection`）拆不出三个词，不会误报。 */
const MIN_WORDS = 3;

function wordsIn(text: string): number {
  return (text.match(/[A-Za-z]{3,}/g) ?? []).length;
}

/** 某个 src/lib 文件里「写死语言」的 Error 实参。 */
function hardcodedErrorCopy(file: string): string[] {
  const source = readScannedSource(file);
  const findings: string[] = [];
  for (const ctor of Array.from(source.matchAll(ERROR_CTOR))) {
    const at = ctor.index ?? 0;
    const open = at + ctor[0].length - 1;
    const args = argumentWindow(source, open).slice(1, -1);
    const where = `${file}:${source.slice(0, at).split("\n").length}`;
    if (CJK.test(args)) {
      findings.push(`${where} 写死中文 → ${JSON.stringify(args.trim().slice(0, 60))}`);
      continue;
    }
    if (args.includes("translate(")) continue;
    for (const literal of Array.from(args.matchAll(LITERALS))) {
      if (wordsIn(literal[2]) >= MIN_WORDS) {
        findings.push(`${where} 写死英文句子 → ${JSON.stringify(literal[2].trim().slice(0, 60))}`);
      }
    }
  }
  return findings;
}

const libFiles = sourceFiles().filter((file) => file.startsWith("src/lib/") && file.endsWith(".ts"));

describe("src/lib 抛出的错误文案必须走 i18n（波24 R43）", () => {
  it("扫描口径不是空转：src/lib 确实有 Error 构造点", () => {
    const total = libFiles.reduce((acc, file) => acc + Array.from(readScannedSource(file).matchAll(ERROR_CTOR)).length, 0);
    expect(total, "一条 Error 都没扫到，说明构造点正则失效了").toBeGreaterThanOrEqual(24);
  });

  it("已经本地化的站点数量不缩水（防止守卫把整段代码扫没了还亮绿灯）", () => {
    const localized = libFiles.reduce(
      (acc, file) =>
        acc +
        Array.from(readScannedSource(file).matchAll(ERROR_CTOR)).filter((ctor) =>
          argumentWindow(readScannedSource(file), (ctor.index ?? 0) + ctor[0].length - 1).includes("translate(")
        ).length,
      0
    );
    expect(localized).toBeGreaterThanOrEqual(21);
  });

  it("Error 实参里不许写死中文，也不许写死成句的英文", () => {
    const leaks = libFiles.flatMap(hardcodedErrorCopy);
    expect(leaks).toEqual([]);
  });
});
