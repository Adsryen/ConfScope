/**
 * 备份面板的时间与体积必须走事实源（轮67 R67-WP4）。
 *
 * 真机量到的原样：活动 `<time>` 直出 `2026-10-23T01:23:45.678Z`（同机本地时刻是 09:23，
 * 差 8 小时、带 Z 带毫秒，`datetime` 属性为 null）；远端备份行是
 * `2097152 bytes · Thu, 22 Oct 2026 09:42:16 GMT`（2MB 显示成七位数，时间是跟着英文月份
 * 缩写的服务器原始串）。这类数字用户是拿来判断「这份件新不新、要不要覆盖」的，
 * 直出机器格式等于没给信息。
 *
 * 口径：
 * 1. `<time>` 元素的内容不许是裸字段插值——必须过 formatDateTime，原始值留在 `datetime` 上；
 * 2. `t("...", { createdAt|modifiedAt: x.createdAt })` 这类展示插值不许直出裸字段（要包 format*）；
 *    只扫 `t(` 调用的参数，避免把 store 里 `{ createdAt: input.createdAt }` 这种取值搬运输动算成违规；
 * 3. locale 里不许再出现 `{size} 字节` / `{size} bytes` 这种「字节数没有量级」的模板；
 * 4. 防永真：先拿修前的三段原样喂给探测器，量不到就说明扫描口径漂了。
 */
import { describe, expect, it } from "vitest";
import { loadLocale, readScannedSource, sourceFiles } from "./scanUtils";

/** 规则 1：`<time ...>{裸字段}</time>`。 */
const RAW_TIME_ELEMENT = /<time(?:\s[^>]*)?>\s*\{\s*[\w.]+\s*\}\s*<\/time>/g;
/**
 * 规则 2：文案插值参数里直出时间字段。
 * `(?!format)` 放行 `createdAt: formatDateTime(...)` 这类合规写法；
 * 只扫 `t(` 的第二个参数，避开 store 里 `{ createdAt: input.createdAt }` 那种取数搬运输动。
 */
const RAW_TIME_IN_COPY = /\bt\(\s*"[^"]+"\s*,\s*\{[^{}]*\b(?:createdAt|modifiedAt|updatedAt|timestamp)\s*:\s*(?!format)[\w.]+/g;
/** 规则 2b：JSX 文本位直出时间字段（`<span>{plan.createdAt}</span>` 这种）。 */
const RAW_TIME_IN_MARKUP = />\s*\{\s*[\w.]+\.(?:createdAt|modifiedAt|updatedAt|timestamp)\s*\}/g;
/** 规则 3：字节数量级缺失的模板。 */
const RAW_BYTE_UNIT = /\{\s*size\s*\}\s*(?:字节|bytes)/;

/** 修前的三段原样（本文件所在的提交里就是它们），用来证明探测器不是空转。 */
const PRE_FIX_SAMPLES = [
  ['<time>{activity.createdAt}</time>', RAW_TIME_ELEMENT],
  ['{t("appDataBackup.summaryCreatedAt", { createdAt: summary.createdAt })}', RAW_TIME_IN_COPY],
  ['{t("appDataBackup.remoteMeta", { size: remote.size, modifiedAt: remote.modifiedAt || "-" })}', RAW_TIME_IN_COPY],
  ['<span className="info-value">{plan.createdAt}</span>', RAW_TIME_IN_MARKUP],
  ['{t("backup.remoteSnapshotMeta", { size: remote.size, modifiedAt: remote.modifiedAt || "-" })}', RAW_TIME_IN_COPY],
];
/** 修后的合规写法，必须一条都不抓住，否则规则会把正常代码当噪声吞进来。 */
const POST_FIX_SAMPLES = [
  '<time dateTime={activity.createdAt}>{formatDateTime(activity.createdAt)}</time>',
  '{t("appDataBackup.remoteMeta", { size: formatBytes(remote.size), modifiedAt: formatDateTime(remote.modifiedAt) })}',
  '<span className="info-value">{formatDateTime(plan.createdAt)}</span>',
];

function hits(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const file of sourceFiles()) {
    const source = readScannedSource(file);
    for (const match of Array.from(source.matchAll(pattern))) {
      const line = source.slice(0, match.index ?? 0).split("\n").length;
      found.push(`${file}:${line}`);
    }
  }
  return found;
}

describe("备份面板时间与体积的口径守卫", () => {
  it("探测器本身有效：修前的每一段原样都要被抓住，修后的写法一段都不抓", () => {
    for (const [sample, pattern] of PRE_FIX_SAMPLES) {
      expect(sample, `${sample} 是修前的违规原样，探测器抓不到就说明口径漂了`).toMatch(pattern);
    }
    for (const sample of POST_FIX_SAMPLES) {
      expect(sample).not.toMatch(RAW_TIME_ELEMENT);
      expect(sample).not.toMatch(RAW_TIME_IN_COPY);
      expect(sample).not.toMatch(RAW_TIME_IN_MARKUP);
    }
  });

  it("src 内没有裸 <time> 直出时间字段", () => {
    expect(hits(RAW_TIME_ELEMENT)).toEqual([]);
  });

  it("src 内没有把时间字段原样塞进文案插值", () => {
    expect(hits(RAW_TIME_IN_COPY)).toEqual([]);
  });

  it("src 内没有把时间字段原样写在 JSX 文本位", () => {
    expect(hits(RAW_TIME_IN_MARKUP)).toEqual([]);
  });

  it("两个 locale 都没有「N bytes / N 字节」这种体积模板", () => {
    for (const file of ["zh-CN.json", "en-US.json"]) {
      const locale = loadLocale(file);
      const offenders = Object.entries(locale)
        .filter(([, text]) => RAW_BYTE_UNIT.test(text))
        .map(([key]) => key);
      expect(offenders, `${file} 里这些 key 还在直出字节数`).toEqual([]);
    }
  });

  it("面板确实用上了两个事实源（下限防规则空转）", () => {
    const source = readScannedSource("src/components/AppDataBackupPanel.tsx");
    expect(Array.from(source.matchAll(/\bformatDateTime\(/g)).length).toBeGreaterThanOrEqual(3);
    expect(source).toMatch(/\bformatBytes\(/);
  });
});
