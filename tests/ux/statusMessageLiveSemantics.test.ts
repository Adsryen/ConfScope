/**
 * 状态提示必须被读屏播报（轮14 波33 / R54）。
 *
 * 缺陷长什么样：`.test-msg` / `.pad-msg` / `.field-error-box` 这些轻量提示是波28 定过的边界（R48-a）——
 * 形态本就不同，不合并组件。代价是 `role` 全靠写的人记得加：实测 21 处「保存成功」「测试连接失败」
 * 「命名空间加载失败」一个都没挂上，读屏用户点完按钮只听到沉默，分不清是成功了还是卡住了。
 * 这类缺失不报错、不影响渲染、fireEvent 也永远点得到，只能静态钉。
 *
 * 口径：
 * 1. 站点名单钉死（按「文件 + className token」定位，不钉行号——接线后行号会漂）；
 * 2. `tone → role/aria-live` 的判定只许写在 src/lib/statusSemantics.ts，别处再搓一份对象字面量即红；
 * 3. 语义挂在容器上，内层文本节点不许重复挂（重复挂 = 同一句念两遍）；
 * 4. 反向钉「常驻说明/静态占位」：那些容器不许出现 role 或 live，否则引导文案会被反复播报；
 * 5. 波33 之前已带 role 的 10 处不许退回静默；
 * 6. 防守卫永真：站点总数、名单条目数、接线文件数都钉了下限。
 */
import { describe, expect, it } from "vitest";
import { lineAt, readScannedSource, sourceFiles } from "./scanUtils";

const MAPPING = "src/lib/statusSemantics.ts";
const ERROR = '{...statusMessageProps("error")}';
const SUCCESS = '{...statusMessageProps("success")}';
const INFO = '{...statusMessageProps("info")}';

interface Site {
  file: string;
  /** 定位容器开标签的 className 片段（带引号，避免 `pad-msg` 误配 `pad-msg err`）。 */
  marker: string;
  /** 该文件里这个片段应出现的次数：多了说明长出同类容器漏接，少了说明站点被删或改写。 */
  count: number;
  /** 开标签里必须出现的语义展开。 */
  spread: string;
}

/** 本波接线的 21 处站点。 */
const SITES: Site[] = [
  { file: "src/components/About.tsx", marker: 'className="test-msg ok"', count: 3, spread: SUCCESS },
  { file: "src/components/About.tsx", marker: 'className="test-msg err"', count: 1, spread: ERROR },
  { file: "src/components/AuditView.tsx", marker: 'className="test-msg err"', count: 1, spread: ERROR },
  { file: "src/components/ConfigEditor.tsx", marker: 'className="test-msg err"', count: 1, spread: ERROR },
  { file: "src/components/DeleteConfirm.tsx", marker: 'className="test-msg err"', count: 1, spread: ERROR },
  { file: "src/components/HistoryView.tsx", marker: 'className="pad-msg err"', count: 1, spread: ERROR },
  { file: "src/App.tsx", marker: 'className="pad-msg big err"', count: 1, spread: ERROR },
  { file: "src/components/ConnectionManager.tsx", marker: 'className="field-error-box"', count: 1, spread: ERROR },
  { file: "src/components/ConnectionManager.tsx", marker: 'className="field-warning"', count: 1, spread: INFO },
  {
    file: "src/components/ConnectionManager.tsx",
    marker: 'className={`test-msg ${visibleTestMsg.ok ? "ok" : "err"}`}',
    count: 1,
    spread: '{...statusMessageProps(visibleTestMsg.ok ? "success" : "error")}',
  },
  { file: "src/components/DiffView.tsx", marker: 'className="field-error-box"', count: 2, spread: ERROR },
  // 尾随 `{`：同族还有一份手写 role="status" 的既有站点（MUST_STAY_ANNOUNCED 钉它），
  // 不带 `{` 的片段会把那份也捞进来，站点数就对不上了。
  { file: "src/components/DiffView.tsx", marker: 'className="diff-warnings" {', count: 1, spread: INFO },
  { file: "src/components/ApplyPlanView.tsx", marker: 'className="apply-edit-errors"', count: 1, spread: ERROR },
  { file: "src/components/SettingsView.tsx", marker: 'className="test-msg ok"', count: 3, spread: SUCCESS },
  {
    file: "src/components/AppDataBackupPanel.tsx",
    marker: 'className={`test-msg ${status.ok ? "ok" : "err"}`}',
    count: 1,
    spread: '{...statusMessageProps(status.ok ? "success" : "error")}',
  },
  {
    file: "src/components/SSHManagerView.tsx",
    marker: 'className={`test-msg ${message.ok ? "ok" : "err"}`}',
    count: 1,
    spread: '{...statusMessageProps(message.ok ? "success" : "error")}',
  },
];

/** 常驻说明与静态占位：出现 role 或 live 就是过度播报（读屏会把引导文案一遍遍重念）。 */
const MUST_STAY_SILENT: Array<{ file: string; marker: string; count: number }> = [
  { file: "src/App.tsx", marker: 'className="pad-msg big"', count: 2 },
  { file: "src/components/AuditView.tsx", marker: 'className="pad-msg big"', count: 2 },
  { file: "src/components/DiffView.tsx", marker: 'className="pad-msg big"', count: 3 },
  { file: "src/components/ConfigBrowser.tsx", marker: 'className="pad-msg big"', count: 1 },
  { file: "src/components/ConfigBrowser.tsx", marker: 'className="pad-msg browser-empty"', count: 1 },
  { file: "src/components/HistoryView.tsx", marker: 'className="pad-msg">{t(', count: 2 },
];

/** 波33 之前已经带播报的 10 处，本波不动，但也不许被人顺手退回静默。 */
const MUST_STAY_ANNOUNCED: Array<{ file: string; marker: string; count: number }> = [
  { file: "src/components/BackupView.tsx", marker: 'className="pad-msg" role="status"', count: 1 },
  { file: "src/components/ConfigBrowser.tsx", marker: 'className="pad-msg" role="status"', count: 2 },
  { file: "src/components/HistoryView.tsx", marker: 'className="pad-msg" role="status"', count: 3 },
  { file: "src/components/ApplyPlanView.tsx", marker: 'className="pad-msg big apply-draft-loading" role="status"', count: 1 },
  { file: "src/components/AuditView.tsx", marker: 'className="diff-warnings" role="status"', count: 1 },
  { file: "src/components/DiffView.tsx", marker: 'className="diff-warnings" role="status"', count: 1 },
  { file: "src/components/DiffPanel.tsx", marker: 'className="diff-warnings" role="status"', count: 1 },
];

/** 容器内层的文本节点：播报归容器，内层重复挂 = 同一句念两遍。 */
const INNER_TEXT_NODES = ['className="test-msg-text"', 'className="diff-warning"'];
/** 有外层 `.field-error-box` 的文件里，内层 `.field-error` span 不许再挂 role；NumberField 那份是独立宿主，豁免。 */
const INNER_ERROR_HOSTS = ["src/components/ConnectionManager.tsx", "src/components/DiffView.tsx"];
const INNER_ERROR = 'className="field-error"';

function normalize(tag: string): string {
  return tag.replace(/\s+/g, " ");
}

/** 取包含 marker 的开标签全文：引号与花括号里的 `>` 不算结束。 */
function tagHeadAt(source: string, markerIndex: number): string {
  const start = source.lastIndexOf("<", markerIndex);
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i += 1) {
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
  return `${entry.file}:${line}: ${head.slice(0, 140)}`;
}

describe("状态提示的播报语义（波33 R54）", () => {
  const files = sourceFiles();

  it("站点名单钉死 21 处，且每条都展开 statusMessageProps", () => {
    const violations: string[] = [];
    for (const site of SITES) {
      const found = heads(site.file, site.marker);
      if (found.length !== site.count) {
        violations.push(`${site.file} 的 ${site.marker} 应有 ${site.count} 处，实为 ${found.length} 处`);
        continue;
      }
      for (const item of found) {
        if (!item.head.includes(site.spread)) violations.push(describeHead(site, item.line, item.head));
      }
    }
    expect(violations, `这些提示容器缺播报语义，读屏完全静默：\n${violations.join("\n")}`).toEqual([]);
  });

  it("站点总数与名单条目数不许悄悄缩水", () => {
    expect(SITES).toHaveLength(16);
    expect(SITES.reduce((sum, site) => sum + site.count, 0)).toBe(21);
  });

  it("tone → role/aria-live 的判定只许写在 statusSemantics.ts", () => {
    const pattern = /\brole\s*:\s*["'](alert|status)["']|"aria-live"\s*:\s*["'](polite|assertive|off)["']/;
    const copies = files
      .filter((file) => file !== MAPPING)
      .flatMap((file) => {
        const source = readScannedSource(file);
        const at = source.search(pattern);
        return at === -1 ? [] : [`${file}:${lineAt(file, at)}: ${(source.split("\n")[lineAt(file, at) - 1] ?? "").trim().slice(0, 120)}`];
      });
    expect(copies, `又搓了一份 tone→role 映射，请调用 statusMessageProps()：\n${copies.join("\n")}`).toEqual([]);
  });

  it("每个接线文件都必须从 lib/statusSemantics 引入", () => {
    const missing = files
      .filter((file) => file !== MAPPING && readScannedSource(file).includes("statusMessageProps("))
      .filter((file) => !/from "\.\.?\/lib\/statusSemantics"/.test(readScannedSource(file)));
    expect(missing, `展开了却没 import：\n${missing.join("\n")}`).toEqual([]);
  });

  it("展开站点数量与文件数量不低于现状", () => {
    const wired = files.filter((file) => readScannedSource(file).includes("statusMessageProps("));
    expect(wired.length).toBeGreaterThanOrEqual(12);
    let calls = 0;
    for (const file of wired) calls += (readScannedSource(file).match(/statusMessageProps\(/g) ?? []).length;
    expect(calls).toBeGreaterThanOrEqual(22);
  });

  it("内层文本节点不重复挂播报，同一句只念一遍", () => {
    const violations: string[] = [];
    for (const file of files) {
      const boxHost = INNER_ERROR_HOSTS.includes(file);
      for (const marker of INNER_TEXT_NODES) {
        for (const item of heads(file, marker)) {
          if (/role=|aria-live=/.test(item.head)) violations.push(`${file}:${item.line}: ${item.head.slice(0, 140)}`);
        }
      }
      if (boxHost) {
        for (const item of heads(file, INNER_ERROR)) {
          if (/role=|aria-live=/.test(item.head)) violations.push(`${file}:${item.line}: ${item.head.slice(0, 140)}`);
        }
      }
    }
    expect(violations, `容器已经有语义了，内层再挂一遍会重复播报：\n${violations.join("\n")}`).toEqual([]);
  });

  it("常驻说明与静态占位保持沉默，不抢 live region", () => {
    const violations: string[] = [];
    for (const entry of MUST_STAY_SILENT) {
      const found = heads(entry.file, entry.marker);
      if (found.length !== entry.count) {
        violations.push(`${entry.file} 的 ${entry.marker} 应有 ${entry.count} 处，实为 ${found.length} 处`);
        continue;
      }
      for (const item of found) {
        if (/role=|aria-live=|statusMessageProps\(/.test(item.head)) violations.push(describeHead(entry, item.line, item.head));
      }
    }
    expect(violations, `这些是常驻说明，加了播报会被反复念：\n${violations.join("\n")}`).toEqual([]);
  });

  it("既有 10 处播报站点不许退回静默", () => {
    const violations: string[] = [];
    let total = 0;
    for (const entry of MUST_STAY_ANNOUNCED) {
      const found = heads(entry.file, entry.marker);
      total += found.length;
      if (found.length !== entry.count) {
        violations.push(`${entry.file} 的 ${entry.marker} 应有 ${entry.count} 处，实为 ${found.length} 处`);
      }
    }
    expect(total, "播报站点总数少于 10").toBeGreaterThanOrEqual(10);
    expect(violations, `波33 之前就在播报的站点被动过了：\n${violations.join("\n")}`).toEqual([]);
  });

  it("映射源自己必须同时提供 alert 与 polite 两种形态", () => {
    const mapping = readScannedSource(MAPPING);
    expect(mapping).toMatch(/role:\s*"alert"/);
    expect(mapping).toMatch(/role:\s*"status"/);
    expect(mapping).toMatch(/"aria-live":\s*"polite"/);
    expect(mapping, "错误块靠 role=alert 隐含 assertive，显式再写一遍会双声播报").not.toMatch(/"aria-live":\s*"assertive"/);
  });
});
