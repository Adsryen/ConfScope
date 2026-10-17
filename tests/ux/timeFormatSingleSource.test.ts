/**
 * 显示型时间只许有一个事实源（轮11 R41）。
 *
 * 扫出来的真 bug：全站 13 处显示时间分三套写法——11 处 `toLocale*`、2 处手写
 * `YYYY-MM-DD HH:mm` 拼接。11 处里只有消息中心 1 处传了 locale，其余跟着**操作系统**
 * 区域走：英文 Windows 上任务详情会显示 `10/17/2026 9:40:07 PM`，而同页列表还是
 * `2026-10-17 21:40`，两种长相既排不了序也分不清新旧。非法值更乱：`NaN-NaN-NaN`、
 * 原串、空串、iso 各来一份。
 *
 * 口径：
 * 1. `src/` 内不许再出现 `toLocaleString|toLocaleTimeString|toLocaleDateString(` 或
 *    `Intl.*DateTimeFormat`（`toLocaleLowerCase` 是搜索归一化，不在名单里，`configContentSearch.ts` 合法）；
 * 2. 日期字段取值（`getFullYear()` 等）和补零 `padStart(2, "0")` 只允许出现在
 *    `src/lib/formatDateTime.ts`——手写格式只此一处；
 * 3. 老的 `formatTime` 包装（快照、Nacos 接口层）必须委托事实源，不许自己再拼；
 * 4. 防永真：命中量下限。将来扫描口径漂掉时先在数量上红，而不是让规则空转把违规吞了。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource, sourceFiles } from "./scanUtils";

/** 事实源本体：规则 1/2 的唯一豁免对象。 */
const SINGLE_SOURCE = "src/lib/formatDateTime.ts";
/** 规则 1：跟着系统区域变的 Intl 显示写法（含直接上 Intl 的绕道）。 */
const INTL_DISPLAY = /toLocale(?:String|TimeString|DateString)\(|Intl\.\w*DateTimeFormat/g;
/** 规则 2：手写日期时间必然用到的字段取值与补零。 */
const DATE_FIELDS = /\.(getFullYear|getMonth|getDate|getDay|getHours|getMinutes|getSeconds)\(\)/g;
const ZERO_PAD = /padStart\(\s*2\s*,\s*"0"\s*\)/g;
/** 规则 4：事实源对外两个口径的调用点下限（实测 10 与 5，留出重构余量）。 */
const MIN_DATE_TIME_CALLS = 8;
const MIN_CLOCK_CALLS = 4;

/** 某规则在事实源之外的命中位置，用于报错时直接指出文件行号。 */
function hitsOutside(files: string[], pattern: RegExp): string[] {
  const found: string[] = [];
  for (const file of files) {
    const source = readScannedSource(file);
    for (const match of Array.from(source.matchAll(pattern))) {
      const line = source.slice(0, match.index ?? 0).split("\n").length;
      found.push(`${file}:${line} ${match[0].trim()}`);
    }
  }
  return found;
}

const files = sourceFiles().filter((file) => file !== SINGLE_SOURCE);
const callCount = (pattern: RegExp) => files.reduce((acc, file) => acc + Array.from(readScannedSource(file).matchAll(pattern)).length, 0);

describe("显示型时间的单一事实源守卫", () => {
  it("扫描口径不是空转：事实源确实导出了两个显示口径", () => {
    const source = readScannedSource(SINGLE_SOURCE);
    expect(source).toContain("export function formatDateTime(");
    expect(source).toContain("export function formatClock(");
    // 事实源自己必须不用 Intl，否则口径又跟着系统区域跑了
    expect(Array.from(source.matchAll(INTL_DISPLAY))).toEqual([]);
  });

  it("调用点数量下限：防止规则永真把违规吞掉", () => {
    expect(callCount(/\bformatDateTime\(/g)).toBeGreaterThanOrEqual(MIN_DATE_TIME_CALLS);
    expect(callCount(/\bformatClock\(/g)).toBeGreaterThanOrEqual(MIN_CLOCK_CALLS);
  });

  it("src 内不许再用 toLocale* 显示时间", () => {
    expect(hitsOutside(files, INTL_DISPLAY)).toEqual([]);
  });

  it("日期字段拼接只许出现在事实源里", () => {
    expect(hitsOutside(files, DATE_FIELDS)).toEqual([]);
  });

  it("补零写法只许出现在事实源里", () => {
    expect(hitsOutside(files, ZERO_PAD)).toEqual([]);
  });

  it("老的 formatTime 包装必须委托事实源（不许就地再拼一遍）", () => {
    for (const file of ["src/lib/snapshot.ts", "src/api/nacos.ts"]) {
      const source = readScannedSource(file);
      expect(source, `${file} 的 formatTime 应当委托 lib/formatDateTime`).toMatch(
        /export function formatTime\([\s\S]{0,200}?formatDateTime\(/
      );
      expect(Array.from(source.matchAll(DATE_FIELDS))).toEqual([]);
    }
  });
});
