/**
 * 异步换内容的区域必须告诉读屏「我正在忙」（轮15 波36 / R55）。
 *
 * 缺陷长什么样：波23 只让「加载中」这三个字能被念出来，波33 只补齐了轻量提示的 role，
 * 但**被换掉的那一整块**始终没标 busy。实测全站 aria-busy 0 处：焦点停在历史列表某一行上的
 * 用户听见一句「加载中」，接着整块内容凭空被替换 —— 既不知道换完没有，也不知道该不该继续等。
 * 这类缺失不报错、不影响渲染、读屏手册里也不会有一条规则拦着你，只能静态钉。
 *
 * 口径：
 * 1. 站点名单钉死（按「文件 + className token」定位，不钉行号 —— 接线后行号会漂）；
 * 2. "aria-busy" 字面量只许写在 src/lib/busyRegion.ts，别处再搓一份即红；
 * 3. 展开了 busyProps 的文件必须 import 到，且不许写死 busyProps(true)/busyProps(false)
 *    （写死 = 永久 busy 或永久静默，比不接更糟）；
 * 4. 反向钉「静态占位 / 常驻说明 / 警告块 / 字段级 loading 后缀」：这些容器不许挂 busy，
 *    过度标注会让读屏把稳定内容当持续变动区反复盯；
 * 5. 每个接线文件的 busyProps 调用数必须等于名单条目数（长出未登记容器 = 红），
 *    且波23 的 role="status" 加载占位一个都不许被顺手删掉；
 * 6. 防守卫永真：站点数、展开数、接线文件数都钉了下限。
 */
import { describe, expect, it } from "vitest";
import { lineAt, readScannedSource, sourceFiles } from "./scanUtils";

const MAPPING = "src/lib/busyRegion.ts";

interface Site {
  file: string;
  /** 定位容器开标签的 className 片段（带尾随引号，避免 `pad-msg big` 误配 `pad-msg big err`）。 */
  marker: string;
  /** 该文件里这个片段应出现的次数：多了说明长出同类容器漏接，少了说明站点被删或改写。 */
  count: number;
  /** 开标签里必须出现的 busy 展开。 */
  spread: string;
}

/**
 * 本波接线的容器：列表主体与详情主体，宿主都是「占位符与内容块的共同父容器」。
 * 轮67 WP-15 起新增宿主「本机版本历史」，同形三处一起登记 —— 新组件必须整族进名单，
 * 否则「busyProps 调用数 == 名单条目数」那条会在下一处长出未登记容器时静默放过。
 */
const SITES: Site[] = [
  {
    file: "src/components/ConfigBrowser.tsx",
    marker: 'className="browser-items"',
    count: 1,
    spread: "{...busyProps(listLoading || contentSearching)}",
  },
  {
    file: "src/components/ConfigBrowser.tsx",
    marker: 'className="content-box"',
    count: 1,
    spread: "{...busyProps(contentLoading)}",
  },
  {
    file: "src/components/HistoryView.tsx",
    marker: 'className="history-items"',
    count: 1,
    spread: "{...busyProps(loading)}",
  },
  {
    file: "src/components/HistoryView.tsx",
    marker: 'className="history-detail"',
    count: 1,
    spread: "{...busyProps(comparePending)}",
  },
  {
    file: "src/components/HistoryView.tsx",
    marker: 'className="content-box"',
    count: 1,
    spread: "{...busyProps(!ready)}",
  },
  // 轮67 WP-15：本机版本历史面板与历史视图同形，三块异步替换区各钉一处。
  // busy 的表达式按各自宿主真实状态取名（detailBusy / switching 是本地派生态），
  // 不硬套 HistoryView 的 comparePending——写死 true/false 会被另一条守卫拦住。
  {
    file: "src/components/LocalRevisionPanel.tsx",
    marker: 'className="history-items"',
    count: 1,
    spread: "{...busyProps(loading)}",
  },
  {
    file: "src/components/LocalRevisionPanel.tsx",
    marker: 'className="history-detail"',
    count: 1,
    spread: "{...busyProps(detailBusy)}",
  },
  {
    file: "src/components/LocalRevisionPanel.tsx",
    marker: 'className="content-box"',
    count: 1,
    spread: "{...busyProps(switching)}",
  },
  {
    file: "src/components/BackupView.tsx",
    marker: 'className="page-surface data-page backup-view"',
    count: 1,
    spread: "{...busyProps(loading)}",
  },
  {
    file: "src/components/OperationHistoryView.tsx",
    marker: 'className="page-surface data-page history-page"',
    count: 1,
    spread: "{...busyProps(loading)}",
  },
  {
    file: "src/components/ApplyPlanView.tsx",
    marker: 'className="page-surface data-page apply-view"',
    count: 1,
    spread: '{...busyProps(draftState.status === "loading")}',
  },
];

/**
 * 不许挂 busy 的容器：
 * - `.pad-msg big` / `.pad-msg browser-empty` / `.data-empty-state page-empty` 是「请选择一条配置」
 *   这类静态占位，内容不随异步请求替换；
 * - `.diff-warnings` 是校验警告块，出现即稳定，busy 只会让读屏继续盯一段早就写完的文本；
 * - DiffView 那两处 `<span role="status">` 是字段名后面的 (加载中) 后缀，宿主是控件旁的说明，
 *   整块区域并没有被换掉，波23 定过的口径不许被 busy 覆盖。
 */
const MUST_STAY_NOT_BUSY: Array<{ file: string; marker: string; count: number }> = [
  { file: "src/App.tsx", marker: 'className="pad-msg big"', count: 2 },
  { file: "src/components/AuditView.tsx", marker: 'className="pad-msg big"', count: 2 },
  { file: "src/components/DiffView.tsx", marker: 'className="pad-msg big"', count: 3 },
  { file: "src/components/ConfigBrowser.tsx", marker: 'className="pad-msg big"', count: 1 },
  { file: "src/components/ConfigBrowser.tsx", marker: 'className="pad-msg browser-empty"', count: 1 },
  { file: "src/components/BackupView.tsx", marker: 'className="data-empty-state page-empty"', count: 1 },
  { file: "src/components/ApplyPlanView.tsx", marker: 'className="data-empty-state page-empty"', count: 1 },
  { file: "src/components/AuditView.tsx", marker: 'className="diff-warnings" role="status"', count: 1 },
  { file: "src/components/DiffPanel.tsx", marker: 'className="diff-warnings" role="status"', count: 1 },
  { file: "src/components/DiffView.tsx", marker: 'className="diff-warnings" role="status"', count: 1 },
  { file: "src/components/DiffView.tsx", marker: '<span role="status"', count: 2 },
];

/** 接线文件里波23 的加载占位不许被顺手删（busy 是补充，不是替代播报）。 */
const LOADING_PLACEHOLDER_MIN = 1;

function normalize(tag: string): string {
  return tag.replace(/\s+/g, " ");
}

/** 取包含 marker 的开标签全文：引号与花括号里的 `>` 不算结束。 */
function tagHeadAt(source: string, markerIndex: number): string {
  const start = source.lastIndexOf("<", markerIndex);
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i += 1) {
    const ch = source.charAt(i);
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
    else if (ch === ">" && depth === 0) return normalize(source.slice(start, i + 1));
  }
  return normalize(source.slice(start));
}

function heads(file: string, marker: string): Array<{ line: number; head: string }> {
  const source = readScannedSource(file);
  const found: Array<{ line: number; head: string }> = [];
  let at = source.indexOf(marker);
  while (at !== -1) {
    found.push({ line: lineAt(file, at), head: tagHeadAt(source, at) });
    at = source.indexOf(marker, at + marker.length);
  }
  return found;
}

function describeHead(entry: { file: string; marker: string }, line: number, head: string): string {
  return entry.file + ":" + line + ": " + head.slice(0, 150);
}

function callCount(file: string): number {
  return (readScannedSource(file).match(/busyProps\(/g) ?? []).length;
}

describe("异步区域的 aria-busy（波36 R55）", () => {
  const files = sourceFiles();

  it("站点名单钉死 11 处，且每条开标签都展开 busyProps", () => {
    const violations: string[] = [];
    for (const site of SITES) {
      const found = heads(site.file, site.marker);
      if (found.length !== site.count) {
        violations.push(site.file + " 的 " + site.marker + " 应有 " + site.count + " 处，实为 " + found.length + " 处");
        continue;
      }
      for (const item of found) {
        if (!item.head.includes(site.spread)) violations.push(describeHead(site, item.line, item.head));
      }
    }
    expect(violations, "这些容器正在被异步换内容却没标 busy，读屏不知道要不要等：\n" + violations.join("\n")).toEqual([]);
  });

  it("站点数与名单条目数不许悄悄缩水", () => {
    expect(SITES).toHaveLength(11);
    expect(SITES.reduce((sum, site) => sum + site.count, 0)).toBe(11);
  });

  it("aria-busy 字面量只许写在 busyRegion.ts", () => {
    const copies = files
      .filter((file) => file !== MAPPING)
      .flatMap((file) => {
        const source = readScannedSource(file);
        const hits: string[] = [];
        for (const pattern of [/["']aria-busy["']\s*[=:]/, /setAttribute\(\s*["']aria-busy/]) {
          const at = source.search(pattern);
          if (at !== -1) hits.push(file + ":" + lineAt(file, at) + ": " + source.split("\n")[lineAt(file, at) - 1].trim().slice(0, 130));
        }
        return hits;
      });
    expect(copies, "又自己搓了一份 aria-busy，请调用 busyProps()：\n" + copies.join("\n")).toEqual([]);
  });

  it("展开 busyProps 的文件必须 import 到", () => {
    const missing = files
      .filter((file) => file !== MAPPING && readScannedSource(file).includes("busyProps("))
      .filter((file) => !/from "\.\.?\/lib\/busyRegion"/.test(readScannedSource(file)));
    expect(missing, "展开了却没 import：\n" + missing.join("\n")).toEqual([]);
  });

  it("不许写死 busyProps(true) 或 busyProps(false)", () => {
    const violations: string[] = [];
    for (const file of files) {
      if (file === MAPPING) continue;
      const source = readScannedSource(file);
      for (const match of source.matchAll(/busyProps\(\s*(true|false)\s*\)/g)) {
        violations.push(file + ":" + lineAt(file, match.index ?? 0) + ": " + match[0]);
      }
    }
    expect(violations, "写死常量等于永久 busy 或永久静默，必须传真实的加载态：\n" + violations.join("\n")).toEqual([]);
  });

  it("静态占位、警告块与字段级后缀不挂 busy，读屏不会把它们当常驻变动区", () => {
    const violations: string[] = [];
    for (const entry of MUST_STAY_NOT_BUSY) {
      const found = heads(entry.file, entry.marker);
      if (found.length !== entry.count) {
        violations.push(entry.file + " 的 " + entry.marker + " 应有 " + entry.count + " 处，实为 " + found.length + " 处");
        continue;
      }
      for (const item of found) {
        if (/busyProps\(|aria-busy/.test(item.head)) violations.push(describeHead(entry, item.line, item.head));
      }
    }
    expect(violations, "这些容器不该标 busy：\n" + violations.join("\n")).toEqual([]);
  });

  it("接线文件的 busyProps 数量与名单成对，且波23 的加载占位仍在", () => {
    const violations: string[] = [];
    const wired = new Map<string, number>();
    for (const site of SITES) wired.set(site.file, (wired.get(site.file) ?? 0) + site.count);
    for (const [file, expected] of wired) {
      const actual = callCount(file);
      if (actual !== expected) {
        violations.push(file + ": busyProps 调用应为 " + expected + " 处，实为 " + actual + " 处（长出了未登记的异步容器，或站点被删）");
      }
      const placeholders = (readScannedSource(file).match(/role="status"/g) ?? []).length;
      if (placeholders < LOADING_PLACEHOLDER_MIN) {
        violations.push(file + ": 加载占位的 role=status 没了，busy 是补充不是替代");
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("全站接线规模不低于现状", () => {
    const wired = files.filter((file) => file !== MAPPING && readScannedSource(file).includes("busyProps("));
    expect(wired.length).toBeGreaterThanOrEqual(6);
    let calls = 0;
    for (const file of wired) calls += callCount(file);
    expect(calls).toBeGreaterThanOrEqual(SITES.length);
  });
});
