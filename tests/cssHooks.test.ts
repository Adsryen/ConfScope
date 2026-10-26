/**
 * CSS 钩子与自定义属性一致性扫描（R6 / D7 防回归）。
 *
 * 为什么用 AST 而不是正则扫全文：正则会把 className 表达式里的比较字符串、JS 标识符、
 * 以及模板串 `${}` 拼接边界上的残段（`env-`、`toast-` 等）当成类名，实测 253 条告警里
 * 只有 26 条可信，当不了门禁。这里用 TypeScript 编译器 API 只取真正参与拼接的字面量，
 * 剩下的「用了但 styles.css 没定义」才是真死钩子。
 *
 * 为什么不与源码同目录放在 src/lib/：本用例要读磁盘上的 styles.css 与全部 tsx，需要 node 的
 * fs/path 类型；tsconfig 的 include 只有 src 与 wailsjs，且只挂 DOM lib（仓库没有 @types/node），
 * 放进 src 会让 tsc --noEmit 直接失败。用 ?raw / import.meta.glob 也走不通——vitest 会把 .css
 * 依赖替换成空模块，拿不到真实文本。
 * 只扫生产 JSX（排除 *.test.tsx）：测试夹具里的类名不代表线上观感。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC_DIR = join(PROJECT_ROOT, "src");
const STYLES_PATH = join(SRC_DIR, "styles.css");

/** 第三方/运行时钩子：styles.css 里没有对应规则，但不属于死钩子。 */
const EXTERNAL_CLASS_HOOKS = new Set([
  // highlight.js 基类；配色规则挂在 .hljs-* 上，基类本身不需要样式
  "hljs",
]);

/** 由 CodeView 内联 style 下发，不是 styles.css 的声明。 */
const INLINE_SET_VARS = new Set(["--code-pad-right", "--code-find-right"]);

/** 本波次整改过的钩子：一旦 CSS 侧被删掉，这里要立刻红。 */
const REMEDIATED_HOOKS = [
  "field-hint",
  "apply-draft-loading",
  "app-data-backup-local",
  "backup-item-time",
  "batch-diff-failures-count",
  "browser-replace-modal",
  "browser-target-modal",
  "browse-page",
  "settings-page",
  "settings-data-locations",
  "settings-data-file-row",
  "connection-page",
  "task-detail-error",
  "task-item-scope",
  "conn-provider-badge",
  "apollo",
  "consul",
];

/** 本波次修掉的「引用未定义变量」：这些变量名不应再出现在 styles.css 里。 */
const REMEDIATED_VARS = ["--bg1", "--success", "--text-mid", "--text-muted", "--text-secondary"];

/** 去掉 CSS 块注释，避免注释里提到的类名被当成选择器。 */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, " ");
}

function collectTsx(dir: string, out: string[] = []): string[] {
  readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectTsx(full, out);
    else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) out.push(full);
  });
  return out;
}

/** 把一段静态文本里的类名挑出来；left/right 标记该段是否紧邻 `${}`（拼接残段不可信）。 */
function addTokens(target: Set<string>, text: string, leftPartial: boolean, rightPartial: boolean): void {
  const tokens = text.split(/[\s,]+/).filter((tok) => /^[a-zA-Z_][\w-]*$/.test(tok));
  if (!tokens.length) return;
  const dropHead = leftPartial && !/^[\s,]/.test(text);
  const dropTail = rightPartial && !/[\s,]$/.test(text);
  const from = dropHead ? 1 : 0;
  const to = tokens.length - 1 - (dropTail ? 1 : 0);
  for (let i = from; i <= to; i += 1) target.add(tokens[i]);
}

/** 只走拼接位置上的字面量，避免把 t("some.key") 这类字符串当成类名。 */
const CLASS_COMBINERS = new Set(["clsx", "cn", "classNames", "cnd", "cx"]);

function collectClassNameTokens(node: ts.Node | undefined, target: Set<string>): void {
  if (!node) return;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    addTokens(target, node.text, false, false);
    return;
  }
  if (ts.isTemplateExpression(node)) {
    addTokens(target, node.head.text, false, true);
    node.templateSpans.forEach((span, index) => {
      addTokens(target, span.literal.text, true, index !== node.templateSpans.length - 1);
      collectClassNameTokens(span.expression, target);
    });
    return;
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
    collectClassNameTokens(node.expression, target);
    return;
  }
  if (ts.isConditionalExpression(node)) {
    // 条件里的比较字符串不是类名，只取两个分支
    collectClassNameTokens(node.whenTrue, target);
    collectClassNameTokens(node.whenFalse, target);
    return;
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      collectClassNameTokens(node.right, target);
    } else if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      collectClassNameTokens(node.left, target);
      collectClassNameTokens(node.right, target);
    }
    return;
  }
  if (ts.isArrayLiteralExpression(node)) {
    node.elements.forEach((el) => collectClassNameTokens(el, target));
    return;
  }
  if (ts.isObjectLiteralExpression(node)) {
    node.properties.forEach((prop) => {
      if (!ts.isPropertyAssignment(prop)) return;
      if (ts.isStringLiteral(prop.name)) addTokens(target, prop.name.text, false, false);
      collectClassNameTokens(prop.initializer, target);
    });
    return;
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
    if (CLASS_COMBINERS.has(name)) node.arguments.forEach((arg) => collectClassNameTokens(arg, target));
  }
}

function classNameTokensIn(file: string, text: string): Set<string> {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
  const tokens = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.name.getText() === "className") {
      collectClassNameTokens(node.initializer, tokens);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return tokens;
}

const css = stripCssComments(readFileSync(STYLES_PATH, "utf8"));
const definedClasses = new Set([...css.matchAll(/\.(-?[a-zA-Z_][\w-]*)/g)].map((m) => m[1]));
const definedVars = new Set([...css.matchAll(/(--[A-Za-z][\w-]*)\s*:/g)].map((m) => m[1]));
const usedVars = new Set([...css.matchAll(/var\(\s*(--[A-Za-z][\w-]*)/g)].map((m) => m[1]));

describe("styles.css 与 JSX className 的一致性", () => {
  it("JSX 里用到的类名都在 styles.css 有定义（外部钩子除外）", () => {
    const used = new Map<string, string[]>();
    collectTsx(SRC_DIR).forEach((file) => {
      const short = relative(PROJECT_ROOT, file);
      classNameTokensIn(file, readFileSync(file, "utf8")).forEach((token) => {
        const bucket = used.get(token);
        if (bucket) bucket.push(short);
        else used.set(token, [short]);
      });
    });
    // 扫描自身失效（漏读文件 / 选择器口径变化）时必须红，别让它默默通过
    expect(used.size).toBeGreaterThan(400);
    const dead = [...used.keys()]
      .filter((token) => !definedClasses.has(token) && !EXTERNAL_CLASS_HOOKS.has(token))
      .map((token) => `${token} ← ${used.get(token)?.join(", ")}`)
      .sort();
    expect(dead.join("\n")).toBe("");
  });

  it("不存在引用未定义 CSS 变量（声明会被整条丢弃）", () => {
    const undef = [...usedVars].filter((v) => !definedVars.has(v) && !INLINE_SET_VARS.has(v)).sort();
    expect(undef.join(", ")).toBe("");
  });

  it("本波次整改的类名保持有定义", () => {
    expect(REMEDIATED_HOOKS.filter((hook) => !definedClasses.has(hook)).join(", ")).toBe("");
  });

  it("本波次修掉的未定义变量不再被引用", () => {
    expect(REMEDIATED_VARS.filter((v) => usedVars.has(v)).join(", ")).toBe("");
  });
});
