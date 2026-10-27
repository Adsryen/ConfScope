/**
 * CSS 自定义属性必须「先声明、后引用」（轮96 K2 事故后新增）。
 *
 * 缺陷形状：给草稿基线提示条写底色时用了 `color-mix(in srgb, var(--amber) 12%, var(--bg-panel))`，
 * 而 `--bg-panel` 全站从没声明过。浏览器不报错、tsc 不管、真机上看着也不「崩」——
 * 整条 background 在计算值阶段直接失效，等于这条提示条没有底色，只剩一圈边框。
 * 写的人以为自己混了个面板底，实际什么都没发生：这和 duplicateSelectors 抓的「改了不生效」
 * 是同一类静默故障，只是这次失的是变量名。
 *
 * 判据为什么能静态成立：var(--x) 的解析发生在计算值阶段，引用的令牌要么在样式表里声明过，
 * 要么由 JS 通过内联 style / setProperty 下发，两种来源都能静态收集齐（全站只有 src/styles.css
 * 一份样式表，几何令牌只有 CodeEditor 一个下发方）。所以「引用集合 ⊆ 声明集合」可以直接判。
 *
 * 动态引用怎么处理：模板串拼名 `var(--${...})` 的正则匹配不到（`$` 不在令牌字符集里），
 * 天然落在引用集合之外；真要用动态令牌时得改成显式列举，否则本守卫只会漏判不会误判——
 * 这一点写在这里，别把它当成已经覆盖。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, lineAt, readScannedSource, sourceFiles, stripComments } from "./scanUtils";

const CSS_REL = "src/styles.css";

/** `var(--x)` 或 `var(--x, fallback)`：令牌名后面必须紧跟 `,` 或 `)`，模板拼名匹配不到。 */
const REF_RE = /var\(\s*(--[A-Za-z0-9_-]+)\s*[,)]/g;
/** 样式表里的声明：`:root { --x: ... }` 与规则块里的局部声明都算。 */
const DECL_CSS_RE = /(--[A-Za-z0-9_-]+)\s*:/g;
/** JS 内联 style 对象里的下发：`"--code-row-h": \`${ROW_H}px\``。 */
const DECL_TS_RE = /["'`]--([A-Za-z0-9_-]+)["'`]\s*:/g;
/** `el.style.setProperty("--x", ...)` 也是合法来源。 */
const DECL_SET_RE = /\.setProperty\(\s*["']--([A-Za-z0-9_-]+)["']/g;
/** 读侧也算引用：JS 用 getPropertyValue("--x") 取几何分量，令牌没了会静默量到空串。 */
const READ_RE = /\.getPropertyValue\(\s*["'](--[A-Za-z0-9_-]+)["']/g;

interface Ref {
  token: string;
  rel: string;
  line: number;
}

/** 收集引用与声明：注释一律先剥掉，免得说明文字里的示例令牌被当成真引用。 */
function collect() {
  const refs: Ref[] = [];
  const declared = new Set<string>();
  const cssRaw = readFileSync(join(PROJECT_ROOT, CSS_REL), "utf8");
  const css = stripComments(cssRaw);
  Array.from(css.matchAll(DECL_CSS_RE), (m) => declared.add(m[1]!));
  Array.from(css.matchAll(REF_RE), (m) => refs.push({ token: m[1]!, rel: CSS_REL, line: lineAt(CSS_REL, m.index!) }));

  sourceFiles().forEach((rel) => {
    const scanned = readScannedSource(rel);
    Array.from(scanned.matchAll(DECL_TS_RE), (m) => declared.add(m[1]!));
    Array.from(scanned.matchAll(DECL_SET_RE), (m) => declared.add(m[1]!));
    Array.from(scanned.matchAll(REF_RE), (m) => refs.push({ token: m[1]!, rel, line: lineAt(rel, m.index!) }));
    Array.from(scanned.matchAll(READ_RE), (m) => refs.push({ token: m[1]!, rel, line: lineAt(rel, m.index!) }));
  });
  return { refs, declared };
}

describe("CSS 自定义属性引用必须有声明", () => {
  const { refs, declared } = collect();

  it("解析器在工作：引用与声明都扫到了量级", () => {
    expect(refs.length, "一个 var(--x) 都没扫到，多半是正则失效了").toBeGreaterThanOrEqual(20);
    expect(declared.size, "一个 --x: 声明都没扫到，多半是正则失效了").toBeGreaterThanOrEqual(30);
  });

  it("每个被引用的令牌都在样式表或 JS 里声明过", () => {
    const missing = refs.filter((ref) => !declared.has(ref.token));
    expect(
      missing.map((ref) => `${ref.rel}:${ref.line} 引用了未声明的 ${ref.token}`),
      "引用未声明的自定义属性时整条声明在计算值阶段静默失效（等于没写），先补令牌或改用已存在的底色"
    ).toEqual([]);
  });

  it("底色类引用只许用真实存在的面板令牌", () => {
    // 事故本身的最小复现：--bg-panel 听起来像「面板底色」，全站却没有它。
    // 这类凭语感造出来的名字要当场拦住，而不是等下一次肉眼找「为什么这块没底色」。
    const invented = refs.filter((ref) => !declared.has(ref.token) && /^--(bg|panel|surface|card|elevat)/.test(ref.token));
    expect(invented.map((ref) => `${ref.rel}:${ref.line} ${ref.token}`), "凭空造出来的底色令牌").toEqual([]);
    expect(declared.has("--bg"), "基础底色令牌被改名了？引用它的所有地方都要跟着复核").toBe(true);
  });
});
