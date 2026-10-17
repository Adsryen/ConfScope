/**
 * 详情区滚动复位只认一个出口（轮13 波29 / R49）。
 *
 * 缺陷长什么样：详情面板、日志原文、错误详情这类 `overflow: auto` 的只读 `<pre>` 复用同一个 DOM 节点，
 * 切换选中项时 React 只换文本、不重建元素，`scrollTop` 于是留着上一份内容的偏移——
 * 用户看到「新详情莫名停在中间」，还会以为差异就只有滚到的那几行。
 * CodeView 早就为这个问题写过一条 R9，但只有它自己归零，其余 6 类详情块一直带着偏移复用。
 *
 * 口径：
 * 1. `scrollTop = 0` / `scrollLeft = 0` 这类归零字面量只允许出现在 lib 模块里，站点退回手抄直接红；
 * 2. 详情块登记表 == 实码：新增、改名、删掉都要显式改这张表，别想悄悄漏掉一处（登记表本身即数量下限，防守卫永真）；
 * 3. 每条登记项的开标签必须挂 `ref={`，所在文件必须调用 hook——漏一样，归零就无从下手；
 * 4. lib 模块必须还是绘制前归零（`useLayoutEffect`），列表版仍按 `isConnected` 收尾节点。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource, sourceFiles } from "./scanUtils";

const LIB = "src/lib/useScrollResetOnContentChange.ts";
const CODE_VIEW = "src/components/CodeView.tsx";

/** 详情块登记表：`文件|class`。新增只读详情区要在这里报到，否则守卫红。 */
const EXPECTED_SITES = [
  "src/components/AuditView.tsx|audit-detail-value",
  "src/components/ErrorDialog.tsx|error-detail",
  "src/components/LogViewer.tsx|log-event-payload",
  "src/components/LogViewer.tsx|log-jsonl",
  "src/components/OperationHistoryView.tsx|history-detail-content",
  "src/components/OperationHistoryView.tsx|history-detail-error",
  "src/components/TaskCenter.tsx|history-detail-error",
];

/** 归零字面量：只认「赋 0」，跳行 / 跟手用的 `scrollTop = clamp(...)` 不算。 */
const RESET_LITERAL = /\.scroll(?:Top|Left)\s*=\s*0\s*(?:;|,)/;
const HOOK_CALL = /useScrollReset(?:OnContentChange|Ref)\(/;
const PRE_TAG = /<pre\b([\s\S]*?)>/g;

type PreSite = { file: string; line: number; key: string; attrs: string };

/** 列出源码里所有 class 命中登记表的 `<pre …>` 开标签。 */
function preSites(file: string, stripped: string): PreSite[] {
  const sites: PreSite[] = [];
  for (const match of stripped.matchAll(PRE_TAG)) {
    const attrs = match[1] ?? "";
    const classes = [...attrs.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].flatMap((m) => (m[1] ?? m[2] ?? "").split(/[\s${}]+/));
    const hit = classes.filter((cls) => EXPECTED_SITES.some((entry) => entry.endsWith(`|${cls}`)));
    if (!hit.length) continue;
    sites.push({ file, line: stripped.slice(0, match.index ?? 0).split("\n").length, key: `${file}|${hit[0]}`, attrs });
  }
  return sites;
}

describe("详情区滚动复位单一出口（波29 R49）", () => {
  const files = sourceFiles();
  const sources = new Map(files.map((file) => [file, readScannedSource(file)]));
  const read = (file: string) => sources.get(file) ?? "";
  const sites = files.flatMap((file) => preSites(file, read(file)));
  const found = sites.map((site) => site.key).sort();

  it("归零字面量只许写在 lib 模块里", () => {
    const violations = files
      .filter((file) => file !== LIB && RESET_LITERAL.test(read(file)))
      .map((file) => `${file}: 自己写了一份 scrollTop/scrollLeft 归零`);
    expect(violations, "出现了第二份滚动归零实现").toEqual([]);
  });

  it("详情块登记表与实码一致，且每块都挂 ref、所在文件都调用 hook", () => {
    expect(found, "详情块登记表与实码不一致：新增 / 改名 / 删掉都要先改这张表").toEqual([...EXPECTED_SITES].sort());
    const missingRef = sites.filter((site) => !/ref=\{/.test(site.attrs)).map((site) => `${site.file}:${site.line} ${site.key}`);
    expect(missingRef, "详情块开标签没挂 ref，切选中项时滚动不会归零").toEqual([]);
    const unhooked = sites.filter((site) => !HOOK_CALL.test(read(site.file))).map((site) => `${site.file}:${site.line}`);
    expect(unhooked, "详情块所在文件没调用 useScrollResetOnContentChange / useScrollResetRef").toEqual([]);
  });

  it("CodeView 也走同一份 hook，R9 不再是特例", () => {
    const codeView = read(CODE_VIEW);
    expect(codeView, "CodeView 没有调用滚动复位 hook").toMatch(/useScrollResetOnContentChange\(/);
    expect(codeView, "CodeView 还在自己用 useLayoutEffect 归零").not.toMatch(/useLayoutEffect\s*\(/);
  });

  it("lib 模块保住绘制前归零与列表版节点收尾", () => {
    const lib = read(LIB);
    expect(lib, "滚动复位退回 useEffect，用户会看到跳变的一帧").toContain("useLayoutEffect");
    expect(lib, "列表版不再按 isConnected 摘除离开文档的节点，Set 只增不减").toContain("isConnected");
    expect(lib, "单元素版少了 scrollLeft 归零，横向偏移留着会看不到行首").toContain("scrollLeft");
  });
});
