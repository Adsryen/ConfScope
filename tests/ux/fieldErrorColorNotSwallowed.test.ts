/**
 * 字段级报错的颜色守卫（轮72B）。
 *
 * 为什么单独守一件事：`.field > span` 这类**按位置**给字段标题上灰阶的规则，特异度 (0,1,1)
 * 高于 `.field-error` 的 (0,1,0)。于是任何人把报错直接挂成 .field 的子 span，
 * 颜色就被标题规则吃掉——tsc 不报、eslint 不报、jsdom 也不算样式，
 * 只有真机截图能看出「报错和说明文字一个颜色」。设置页代理校验的报错就是这么哑掉的。
 *
 * 口径：CSS 里每出现一条「<前缀> .field > span」的标题规则，就必须有一条同前缀的
 * 「<前缀> .field > .field-error」把颜色拿回来。以后新增表单族（.foo .field > span）
 * 时这条会直接红，而不是等下一轮截图再抓。
 *
 * 只看顶层规则：@media 里的覆盖本来就该晚于基础规则，混进来只会把「谁赢」判错。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CSS = readFileSync(join(PROJECT_ROOT, "src/styles.css"), "utf8");

interface Rule {
  /** 逗号拆开后的单个选择器（已压掉多余空白） */
  sels: string[];
  decls: Array<[string, string]>;
}

/** 注释换成等长空白：注释里也写着 .field > span，混进解析就会虚报。 */
function blankComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

/**
 * 扫顶层规则。花括号配对靠 cursor 单向前进，绝不回头——
 * 这类手写解析器最容易死循环，所以步数上限按文件长度的倍数算，超限直接抛，
 * 让守卫以「解析失败」红，而不是把测试跑到超时。
 */
function topLevelRules(css: string): Rule[] {
  const text = blankComments(css);
  const rules: Rule[] = [];
  let cursor = 0;
  let steps = 0;
  const budget = text.length * 4 + 1000;
  while (cursor < text.length) {
    const open = text.indexOf("{", cursor);
    if (open === -1) break;
    const selector = text.slice(cursor, open).replace(/\s+/g, " ").trim();
    let depth = 1;
    let end = open + 1;
    while (end < text.length && depth > 0) {
      steps += 1;
      if (steps > budget) throw new Error("CSS 花括号配对异常：存在未闭合的 {，请检查 styles.css");
      if (text[end] === "{") depth += 1;
      else if (text[end] === "}") depth -= 1;
      end += 1;
    }
    if (!selector.startsWith("@") && !selector.includes("{")) {
      const decls = text
        .slice(open + 1, end - 1)
        .split(";")
        .map((part) => {
          const at = part.indexOf(":");
          if (at === -1) return null;
          return [part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim().toLowerCase()] as [string, string];
        })
        .filter((entry): entry is [string, string] => entry !== null);
      rules.push({
        sels: selector
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean),
        decls,
      });
    }
    cursor = end;
  }
  return rules;
}

/** 取 .field > span 之前的祖先前缀：基础规则的前缀是空串。 */
function prefixOf(sel: string, tail: RegExp): string {
  const at = sel.search(tail);
  return at <= 0 ? "" : sel.slice(0, at).trim();
}

const CAPTION_TAIL = /\.field\s*>\s*span\b/;
const ERROR_TAIL = /\.field\s*>\s*\.field-error\b/;

const RULES = topLevelRules(CSS);
const captionPrefixes = RULES.flatMap((rule) => rule.sels.filter((sel) => CAPTION_TAIL.test(sel)).map((sel) => prefixOf(sel, CAPTION_TAIL)));
const recoveredPrefixes = RULES.filter((rule) => rule.decls.some(([prop, value]) => prop === "color" && value.includes("var(--red-h)")))
  .flatMap((rule) => rule.sels.filter((sel) => ERROR_TAIL.test(sel)).map((sel) => prefixOf(sel, ERROR_TAIL)));

describe("字段级报错不许被按位置的字段标题规则吃掉颜色", () => {
  it("确实扫到了标题规则，守卫不是空转", () => {
    expect(captionPrefixes.length, "没扫到 .field > span，说明选择器写法变了，守卫要跟着改").toBeGreaterThanOrEqual(3);
  });

  it("每一条 .field > span 都有同前缀的 .field > .field-error 兜住", () => {
    const missing = [...new Set(captionPrefixes)].filter((prefix) => !recoveredPrefixes.includes(prefix));
    expect(missing, `这些表单族里直挂 .field 的报错会是灰的: ${missing.map((p) => `${p || "(基础)"} .field > span`)}`).toEqual([]);
  });
});
