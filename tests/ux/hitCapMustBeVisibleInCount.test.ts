/**
 * 查找命中上限必须「既生效，又看得见」（轮28 F-10）。
 *
 * 背景：20 万行 / 10MB 的配置里搜「e」实测 80 万处命中、47.7MB HTML、80 万个 <mark> 节点，
 * find 464ms / mark 1956ms。加上限只解决一半问题——另一半是**用户能不能知道被截断了**：
 * 「第 1/5000 处」这句话会被天然读成「这个文件里一共 5000 处」，
 * 于是用户往下翻、找不到「那个明明存在的命中」，最后报的是「搜索漏结果」这种更难查的 bug。
 * 轮26 已经为同类问题定过口径：限制本身必须落在可见文案上，title 只能做补充解释。
 *
 * 钉四件事：
 * 1) 截断必须发生在**扫描侧**（循环里 break），而不是扫完再 slice——后者一分钟都省不下；
 * 2) 上限常量只有一份定义，视图不许自己写数字；
 * 3) 两个视图的计数都要分「截断 / 未截断」两态，未截断时文案与历史逐字不变；
 * 4) 中英两份 locale 都要有「+」，且带 {max} 插值（漏一种语言就是漏一个用户群）。
 *
 * 末尾两条自检把「退回扫完再截断」「退回只显示 total」两种改法钉成判红。
 */
import { describe, expect, it } from "vitest";
import { loadLocale, readScannedSource } from "./scanUtils";

const LIB = "src/lib/codeLines.ts";
const VIEWS = ["src/components/CodeView.tsx", "src/components/CodeEditor.tsx"];

/** 截断必须写在扫描循环里：`hits.length >= limit` 之后紧跟 break。 */
const EARLY_STOP = /if\s*\(\s*hits\.length\s*>=\s*limit\s*\)\s*break\s*;/;
/** 反模式：扫完再切一刀（看着有上限，实际把整篇扫干净了才丢尾巴）——只看函数体内部。 */
const LATE_TRUNCATION = /\.slice\(\s*0\s*,\s*limit\b/;

function scanFunctionBody(source: string): string {
  const start = source.indexOf("export function findCodeHits(");
  expect(start, "找不到 findCodeHits 的定义").toBeGreaterThanOrEqual(0);
  // 取到下一个顶层 export / 注释块之前，够覆盖整个函数体
  const rest = source.slice(start);
  const end = rest.search(/\nexport (function|const|interface|type)\b/);
  return end > 0 ? rest.slice(0, end) : rest;
}

describe("查找命中上限要可见（轮28 F-10）", () => {
  it("上限常量只定义一次，且扫描在循环里提前停", () => {
    const source = readScannedSource(LIB);
    const consts = Array.from(source.matchAll(/export const MAX_CODE_HITS\s*=\s*(\d+)/g), (m) => Number(m[1]));
    expect(consts, "MAX_CODE_HITS 必须且只能定义一次").toHaveLength(1);
    expect(consts[0]).toBeGreaterThan(0);
    expect(Number.isFinite(consts[0])).toBe(true);

    const body = scanFunctionBody(source);
    expect(body, "命中没在扫描循环里提前停：扫到底再截断省不下任何时间").toMatch(EARLY_STOP);
    expect(body, "出现「扫完再 slice」的假上限").not.toMatch(LATE_TRUNCATION);
    expect(body.match(/\.slice\(/g) || [], "函数体里出现 slice 就该问一句是不是假上限").toHaveLength(0);
    expect(source).toMatch(/export function findCodeHits\([^)]*options: MatchOptions = \{\},\s*limit = MAX_CODE_HITS\)/);
    expect(source, "默认上限没走常量").not.toMatch(/export function findCodeHits\([^)]*limit = \d+\)/);
  });

  it("「是否被动停的」判定收在 lib，视图不许自己比数字", () => {
    const source = readScannedSource(LIB);
    expect(source, "isHitScanCapped 没跟同一个 limit 口径").toMatch(
      /export function isHitScanCapped\(\s*hits: CodeHit\[\]\s*,\s*limit = MAX_CODE_HITS\s*\)/
    );
    expect(source).toMatch(/return hits\.length >= limit/);
    for (const file of VIEWS) {
      const view = readScannedSource(file);
      expect(view, `${file} 没走 isHitScanCapped`).toMatch(/const hitsCapped = isHitScanCapped\(hits\);/);
      expect(view, `${file} 自己写了命中数字`).not.toMatch(/hits\.length\s*>=\s*\d{3,}/);
    }
  });

  it("两个视图的计数分两态，未截断时文案逐字不变", () => {
    for (const file of VIEWS) {
      const view = readScannedSource(file);
      expect(view, `${file} 的计数没查上限位`).toMatch(/hitsCapped\s*\?\s*t\("config\.findCountCapped"/);
      expect(view, `${file} 截断后还在报精确总数`).toMatch(/t\("config\.findCount",\s*\{\s*current:[^}]*total: hits\.length\s*\}\)/);
      expect(view, `${file} 上限值没走常量`).toMatch(/max: MAX_CODE_HITS/);
      expect(view, `${file} 缺截断解释的 title`).toMatch(
        /title=\{hitsCapped \? t\("config\.findCountCappedHint",\s*\{ max: MAX_CODE_HITS \}\) : undefined\}/
      );
      // 上限值只能来自 lib：视图里出现裸数字就是第二套口径
      expect(view, `${file} 把上限数字写死在视图里`).not.toMatch(/findCountCapped[\s\S]{0,120}?\d{4}/);
    }
  });

  it("中英都把「还有更多」写进可见文案，解释句带上下限数字", () => {
    for (const file of ["zh-CN.json", "en-US.json"]) {
      const locale = loadLocale(file);
      const count = locale["config.findCountCapped"];
      const hint = locale["config.findCountCappedHint"];
      expect(count, `${file} 缺 config.findCountCapped`).toBeTruthy();
      expect(count, `${file} 的截断计数没有「+」，会被读成精确总数`).toContain("+");
      expect(count, `${file} 的截断计数丢了当前序号`).toContain("{current}");
      expect(count, `${file} 的截断计数没带上限值`).toContain("{max}");
      expect(count, `${file} 的截断计数不许再用 {total}`).not.toContain("{total}");
      expect(hint, `${file} 缺 config.findCountCappedHint`).toBeTruthy();
      expect(hint, `${file} 的解释句没告诉用户上限是多少`).toContain("{max}");
      expect(hint, `${file} 的解释句该给一条出路`).toMatch(/更长|longer/);
      expect(locale["config.findCount"], "未截断的文案被动过").toMatch(/处|\{total\}/);
    }
  });

  // ---- 自检：两种「退回」都必须判红，否则上面的守卫只是装饰 ----
  it("自检一：改成「扫完再 slice」的假上限必须判红", () => {
    const body = scanFunctionBody(readScannedSource(LIB));
    const mutant = body.replace(EARLY_STOP, "").replace("return hits;", "return hits.slice(0, limit);");
    expect(mutant, "去掉提前 break 之后必须不再满足 EARLY_STOP").not.toMatch(EARLY_STOP);
    expect(mutant, "换成尾部 slice 必须被反模式规则抓到").toMatch(LATE_TRUNCATION);
    expect(mutant.includes("return hits.slice(0, limit);"), "变异没落到函数体里，这条自检是空转").toBe(true);
  });

  it("自检二：视图退回只显示精确 total 必须判红", () => {
    const honest = readScannedSource(VIEWS[0]);
    const regressed = honest.replace(/hitsCapped\s*\?\s*t\("config\.findCountCapped",\s*\{[^}]*\}\)\s*:\s*/, "");
    expect(regressed, "截断态退回只显示 total 必须判红").not.toMatch(/hitsCapped\s*\?\s*t\("config\.findCountCapped"/);
  });
});
