/**
 * 缩略图必须分两阶段算，标尺不许退回全文 maxLen（轮28 F-11 + F-12 + F-13）。
 *
 * 三条缺陷各自都有「一改就退回去」的形状，所以钉形状不钉性能数字：
 * 1) F-12：`minimapRows` 原先挂在含 currentLine 的 memo 上，桶内行长 / 行类型 / 条宽只跟正文有关，
 *    却每按一次 Enter 把 20 万行重新 `line.replace(/\t/g, "  ")` 一遍（实测单次 21-46ms）。
 *    ⇒ 贵的那一阶段（prepareMinimapBuckets）不许看命中，视图侧的 buckets memo 依赖只许 [lines, rowLimit]。
 * 2) F-11：条宽用全文最长行归一时，「800 行正常配置 + 1 行 60000 字符证书」让 266/267 个桶
 *    塌到 3px 下限（实测条宽 p50 = 3.0px），缩略图唯一的用处（哪里内容密集）没了。
 *    ⇒ 标尺走桶最长行的 p95 常量，ratio 必须 `min(1, …)` 触顶，函数里不许再出现 maxLen。
 * 3) F-13：`hasMinimap` 原先只看「设置开了且有行」，内容不满一屏时缩略图照样画——
 *    点了不动的死控件。加可滚判断的同时，右侧留白**必须继续用旧条件**，
 *    否则「隐藏缩略图 ⇒ 正文宽 8px ⇒ 可能不再需要横向滚动条 ⇒ clientHeight 变 ⇒ 又该显示」自激振荡。
 *
 * 末尾三条自检把三种退回钉成判红。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource } from "./scanUtils";

const LIB = "src/lib/codeLines.ts";
const VIEW = "src/components/CodeView.tsx";

/** 取 `export function name(...)` 到下一个顶层 export 之前（够覆盖整个函数体）。 */
function exportedBody(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`);
  expect(start, `找不到 ${name} 的定义`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start);
  const end = rest.search(/\nexport (async )?(function|const|interface|type)\b/);
  return end > 0 ? rest.slice(0, end) : rest;
}

/** 取 `export function name(...)` 的形参表原文。 */
function exportedParams(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`);
  expect(start, `找不到 ${name} 的定义`).toBeGreaterThanOrEqual(0);
  const open = start + `export function ${name}(`.length;
  const close = source.indexOf("): ", open) >= 0 ? source.indexOf("): ", open) : source.indexOf(") {", open);
  expect(close, `${name} 的形参表读不到`).toBeGreaterThan(open);
  return source.slice(open, close).replace(/\s+/g, " ");
}

/** 取某条 `const x = useMemo(...)` 的依赖数组内容（空白压成单空格）。 */
function memoDeps(source: string, decl: string): string {
  const start = source.indexOf(decl);
  expect(start, `缺少 ${decl}`).toBeGreaterThanOrEqual(0);
  const found = /,\s*\[([^\]]*)\]\)/.exec(source.slice(start));
  expect(found, `${decl} 的依赖数组读不到`).not.toBeNull();
  return (found?.[1] ?? "").replace(/\s+/g, " ").trim();
}

describe("缩略图分两阶段（轮28 F-12）", () => {
  it("贵的那一阶段完全不碰命中：参数与函数体里都不许出现 hits / currentLine", () => {
    const source = readScannedSource(LIB);
    const params = exportedParams(source, "prepareMinimapBuckets");
    expect(params, "prepareMinimapBuckets 不该接收命中").not.toMatch(/hits|currentLine|Set<number>/);
    expect(params).toBe("lines: string[], rowLimit: number");
    const body = exportedBody(source, "prepareMinimapBuckets");
    expect(body, "第一阶段算出了命中语义，第二阶段就没活干了").not.toMatch(/hasHit|isCurrent|currentLine/);
  });

  it("便宜的那一阶段不许重算正文：不读 lines、不做 Tab 归一、不判行类型", () => {
    const source = readScannedSource(LIB);
    const params = exportedParams(source, "decorateMinimapRows");
    expect(params).toBe("buckets: MinimapBuckets, sortedHitLines: number[], currentLine: number | null");
    const body = exportedBody(source, "decorateMinimapRows");
    expect(body, "第二阶段又去遍历全文了（每按一次 Enter 再付 21-46ms）").not.toMatch(/\.replace\(\/\\t\/g/);
    expect(body, "第二阶段重算了行长类型").not.toMatch(/isBlankLine|isCommentLine/);
    expect(body, "第二阶段重算了条宽").not.toMatch(/widthRatio\s*[:=]\s*[^,}]*\//);
  });

  it("buildMinimapRows 只是薄封装（口径只有一份，画布侧不改）", () => {
    const source = readScannedSource(LIB);
    const body = exportedBody(source, "buildMinimapRows");
    expect(body, "薄封装里不许再自己算行长").not.toMatch(/\.replace\(\/\\t\/g/);
    expect(body).toMatch(/decorateMinimapRows\(prepareMinimapBuckets\(lines,\s*rowLimit\),\s*Array\.from\(hits\),\s*currentLine\)/);
    expect(exportedParams(source, "buildMinimapRows")).toBe(
      "lines: string[], hits: Set<number>, currentLine: number | null, rowLimit: number"
    );
  });

  it("视图侧拆成两条 memo，且都不许走薄封装", () => {
    const view = readScannedSource(VIEW);
    expect(view, "视图不许一次算完（那正是每次 Enter 重付全文的钱）").not.toMatch(/buildMinimapRows\(/);
    expect(memoDeps(view, "const buckets = useMemo(")).toBe("lines, rowLimit");
    const rowsDeps = memoDeps(view, "const minimapRows = useMemo(");
    expect(rowsDeps, "minimapRows 又依赖整篇正文了").not.toMatch(/\blines\b/);
    expect(rowsDeps).toContain("buckets");
    expect(rowsDeps).toContain("currentLine");
  });
});

describe("缩略图条宽标尺（轮28 F-11）", () => {
  it("标尺是 p95 常量，不是全文 maxLen", () => {
    const source = readScannedSource(LIB);
    expect(source, "p95 常量没定义").toMatch(/export const MINIMAP_WIDTH_RULER_PERCENTILE\s*=\s*0\.95;/);
    const body = exportedBody(source, "prepareMinimapBuckets");
    expect(body, "标尺退回全文最长行：一行脏数据就能把整张图压扁").not.toMatch(/\bmaxLen\b/);
    expect(body, "标尺没用分位数").toMatch(/percentileAscending\(/);
    expect(body, "ratio 没触顶，超长行会画出画布外").toMatch(/Math\.min\(1,\s*longestInBucket\s*\/\s*ruler\)/);
  });

  it("分桶最长行只算一趟（旧实现每行 replace 两次）", () => {
    const body = exportedBody(readScannedSource(LIB), "prepareMinimapBuckets");
    expect(body.match(/\.replace\(\/\\t\/g/g) || [], "同一行被量了两次长度").toHaveLength(1);
  });
});

describe("缩略图显隐与右侧留白（轮28 F-13）", () => {
  it("显隐要判「真能滚」，留白要用旧条件", () => {
    const view = readScannedSource(VIEW);
    expect(view, "缩略图又在内容不满一屏时画了个点了不动的死控件").toMatch(
      /const canScrollContent = metrics\.scrollHeight <= 0 \|\| metrics\.scrollHeight > metrics\.clientHeight \+ 1;/
    );
    expect(view, "hasMinimap 没接可滚判断").toMatch(/const hasMinimap = minimapReserved && canScrollContent;/);
    expect(view, "留白跟着缩略图显隐变 ⇒ 自激振荡").toMatch(/const padRight = minimapReserved \? GUTTER_W \+ 24 : GUTTER_W \+ 16;/);
    expect(view, "--code-find-right 也要用留白条件，不是显隐条件").toMatch(
      /--code-find-right": `\$\{minimapReserved \? GUTTER_W \+ 24 : 16\}px`/
    );
  });

  it("缩略图尺寸的 ResizeObserver 依赖跟着显隐位（重新挂载后要有人再量它）", () => {
    const view = readScannedSource(VIEW);
    const block = /const measure = \(\) => setMinimapSize\([\s\S]*?\}, \[([^\]]*)\]\);/.exec(view);
    expect(block, "读不到 minimapSize 的 ResizeObserver 块").not.toBeNull();
    expect(block?.[1], "元素会因不满一屏自己消失，只盯 showMinimap 就再也没人量它").toContain("hasMinimap");
  });
});

describe("自检：三种退回都必须判红", () => {
  it("自检一：把 currentLine 圈回 buckets 依赖必须判红", () => {
    const view = readScannedSource(VIEW);
    const regressed = view.replace(
      "const buckets = useMemo(() => prepareMinimapBuckets(lines, rowLimit), [lines, rowLimit]);",
      "const buckets = useMemo(() => prepareMinimapBuckets(lines, rowLimit), [lines, rowLimit, currentLine]);"
    );
    expect(regressed, "变异没落到源码里，这条自检是空转").not.toBe(view);
    expect(memoDeps(regressed, "const buckets = useMemo("), "依赖里多一个 currentLine 就必须整篇重算").not.toBe("lines, rowLimit");
  });

  it("自检二：留白退回 hasMinimap 条件必须判红", () => {
    const view = readScannedSource(VIEW);
    const regressed = view.replace("const padRight = minimapReserved ?", "const padRight = hasMinimap ?");
    expect(regressed, "变异没落到源码里，这条自检是空转").not.toBe(view);
    expect(regressed, "留白跟着显隐变必须判红").not.toMatch(/const padRight = minimapReserved \? GUTTER_W \+ 24 : GUTTER_W \+ 16;/);
  });

  it("自检三：标尺退回全文 maxLen 必须判红", () => {
    const source = readScannedSource(LIB);
    const regressed = source
      .replace("const ruler = Math.max(", "const maxLen = Math.max(")
      .replace("longestInBucket / ruler", "longestInBucket / maxLen");
    expect(regressed, "变异没落到源码里，这条自检是空转").not.toBe(source);
    expect(regressed.includes("longestInBucket / ruler"), "第二处变异没落地").toBe(false);
    // 上面那条 `not.toMatch(/\bmaxLen\b/)` 必须能抓到这个形状
    expect(exportedBody(regressed, "prepareMinimapBuckets"), "退回 maxLen 必须判红").toMatch(/\bmaxLen\b/);
    expect(exportedBody(regressed, "prepareMinimapBuckets"), "ratio 丢掉触顶也必须判红").not.toMatch(
      /Math\.min\(1,\s*longestInBucket\s*\/\s*ruler\)/
    );
  });
});
