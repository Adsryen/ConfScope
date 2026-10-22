/**
 * 三个内置默认名（默认项目 / 未分组 / 默认来源）不许以 raw 形式漏到英文界面。
 *
 * 为什么守卫长这个形状而不是「把常量改成英文」：这三个串既是**存档值**又是**匹配键**
 * （`filter(conn => connectionEnvironmentName(conn) === activeProject)` 这类），
 * 换值 = 用户一切语言就丢分组、丢选中、丢历史归属。所以口径是
 * **数据层永远 raw，展示层判哨兵再 t()**（见 src/lib/defaultNameCopy.ts 的注释）。
 *
 * 守卫只钉「展示位」：JSX 属性（title/label/placeholder/aria-label/alt）、
 * 组件自定义 prop、对象字面量里的展示字段、JSX 文本位。
 * 身份位（filter / find / === / sort 比较器 / environmentTone 入参）必须继续用 raw，
 * 不在射程内——把它们也翻掉才是真 bug。
 *
 * 白名单：`<EnvironmentBadge name={...}>` 传 raw 是有意的——徽章内部
 * 用 raw 定色调（envTone 认中文关键词），用本地化后的串出文字，一处收口两处都要。
 *
 * ## 规则二：默认名经过变量再进 Select 的 label
 * 同行正则看不见 `const projectNames = connections.map(c => connectionProjectName(c))`
 * → `options={projectNames.map((n) => ({ value: n, label: n }))}` 这种传递链，
 * 而它正是最容易写出来的形态（本轮就漏过 AuditView 与 DiffView 两处项目下拉）。
 * 口径：**value 与 label 写成同一个标识符 = label 没本地化**。
 * value 必须是 raw（它是切换时的匹配键），label 必须是 `localizeDefaultName(...)` 的结果，
 * 所以「两个键同值」在这个场景里永远错。只对项目/环境/来源这三类清单生效，
 * 命名空间、group 之类不含哨兵的清单不参与。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource, sourceFiles } from "./scanUtils";

const RAW_GETTER = /\b(?:connectionDisplayLabel|connectionProjectName|connectionEnvironmentName|connectionSourceName)\(/;
const LOCALIZER = /\b(?:localizeDefaultName|projectLabel|environmentLabel|sourceLabel|connectionLabel)\(/;
/** 组件内部自带本地化，允许把 raw 传进去。 */
const LOCALIZING_SINKS = ["EnvironmentBadge"];

const DISPLAY_CONTEXTS: Array<{ name: string; re: RegExp }> = [
  { name: "JSX 展示属性", re: /^\s*(?:title|label|placeholder|aria-label|alt)=\{/ },
  { name: "展示字段（对象字面量）", re: /^\s*(?:source|name|label|left|right|text|title):\s*[`$"']/ },
  { name: "JSX 文本位", re: /^\s*\{[^}]*\bconnection(?:Display|Project|Environment|Source)Name\(/ },
  { name: "组件展示 prop", re: /(?:title|label|source|left|right|placeholder)\s*=\s*\{/ },
];

interface Site {
  file: string;
  line: number;
  text: string;
  context: string;
}

/** 某段源码里「展示位上直接调 raw getter 且没被本地化函数包住」的行。 */
function findUntranslatedSentinelSites(source: string, file: string): Site[] {
  const sites: Site[] = [];
  source.split("\n").forEach((line, index) => {
    if (!RAW_GETTER.test(line)) return;
    if (LOCALIZER.test(line)) return;
    if (LOCALIZING_SINKS.some((sink) => new RegExp(`<${sink}\\b`).test(line))) return;
    const hit = DISPLAY_CONTEXTS.find((entry) => entry.re.test(line));
    if (!hit) return;
    sites.push({ file, line: index + 1, text: line.trim().slice(0, 140), context: hit.name });
  });
  return sites;
}

function productionSites(): Site[] {
  return sourceFiles()
    .filter((file) => file.endsWith(".tsx"))
    .flatMap((file) => findUntranslatedSentinelSites(readScannedSource(file), file));
}

describe("内置默认名只能在展示层翻译", () => {
  it("生产代码的展示位没有裸 raw 默认名", () => {
    const found = productionSites().map((site) => `${site.file}:L${site.line} [${site.context}] ${site.text}`);
    expect(
      found,
      `这些位置会把「默认项目 / 未分组 / 默认来源」原样显示出来，英文界面里就是中文漏译。
改法：换成 src/lib/defaultNameCopy 里的 connectionLabel / environmentLabel / sourceLabel / localizeDefaultName；
Select 的 options 保持 value=raw（匹配键）、label=本地化。\n${found.join("\n")}`
    ).toEqual([]);
  });

  it("守卫自己能抓到真违规，也不会误伤身份位（否则它就是空转）", () => {
    const sample = [
      // 1) 展示位 + 裸 getter ⇒ 必须抓到
      '          title={connectionEnvironmentName(c)}',
      '                    {connectionSourceName(c)}',
      '                  source: `${connectionDisplayLabel(conn)} / ${title}` : title,',
      // 2) 展示位 + 本地化 ⇒ 放行
      '                  title={localizeDefaultName(connectionEnvironmentName(c), t)}',
      '                  source: `${connectionLabel(conn, t)} / ${title}` : title,',
      // 3) 内部自带本地化的组件 ⇒ 放行（tone 需要 raw）
      '                  <EnvironmentBadge name={connectionEnvironmentName(leftConn)} />',
      // 4) 身份位 / 色调位 ⇒ 放行，翻掉才是 bug
      '  const browseProjectConnections = connections.filter((conn) => connectionProjectName(conn) === activeProject);',
      '  const firstProject = connections[0] ? connectionProjectName(connections[0]) : "";',
      '          className={`env-badge env-${environmentTone(connectionEnvironmentName(env.conn))}`}',
      '            connectionDisplayLabel(left).localeCompare(connectionDisplayLabel(right))',
    ].join("\n");
    const hit = findUntranslatedSentinelSites(sample, "sample.tsx");
    expect(hit.map((site) => site.line)).toEqual([1, 2, 3]);
    expect(productionSites, "扫描口径在生产代码上不能空转（0 命中时要靠上面的自证用例兜住）").not.toThrow();
  });

  it("三个默认名常量与 i18n 键一一对应（改了常量必须一起改守卫）", () => {
    const lib = readScannedSource("src/lib/defaultNameCopy.ts");
    for (const key of ["connection.defaultProjectName", "connection.defaultEnvironmentName", "connection.defaultSourceName"]) {
      expect(lib, `defaultNameCopy 里缺 ${key}`).toContain(`"${key}"`);
    }
    // 展示层判哨兵的前提：常量还是中文。真改成英文时，这条会提醒一起收口。
    const store = readScannedSource("src/store/connections.ts");
    expect(store).toMatch(/DEFAULT_PROJECT_NAME = "默认项目"/);
    expect(store).toMatch(/DEFAULT_ENVIRONMENT_NAME = "未分组"/);
    expect(store).toMatch(/DEFAULT_SOURCE_NAME = "默认来源"/);
  });
});

/* ------------------------------------------------------------------ *
 * 规则二：raw 默认名清单 → Select option 的 label
 * ------------------------------------------------------------------ */

/** 从 `=` 起做括号配平取整段初始化表达式（`useMemo(() => …, [deps])` 是多行的，按行截会漏掉）。 */
function initializerAt(source: string, equalIndex: number): string {
  let i = equalIndex + 1;
  let depth = 0;
  let quote: string | null = null;
  const start = i;
  for (; i < source.length; i += 1) {
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
    if ("([{".includes(ch)) depth += 1;
    else if (")]}".includes(ch)) depth -= 1;
    else if (ch === ";" && depth <= 0) break;
    if (depth < 0) break;
  }
  return source.slice(start, i);
}

/** 清单变量名：初始化表达式里直接调 raw getter，或从已认定的清单派生。 */
function rawListNames(source: string): Set<string> {
  const names = new Set<string>();
  const decl = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/g;
  const decls: Array<{ name: string; init: string }> = [];
  for (const m of source.matchAll(decl)) decls.push({ name: m[1], init: initializerAt(source, (m.index ?? 0) + m[0].length - 1) });
  for (const d of decls) if (RAW_GETTER.test(d.init)) names.add(d.name);
  // 派生链（`const environmentOptions = environmentNames.map(...)` 之类）迭代两轮收口
  for (let round = 0; round < 2; round += 1) {
    for (const d of decls) {
      if (names.has(d.name)) continue;
      for (const known of names) {
        if (new RegExp(`\\b${known}\\b`).test(d.init)) {
          names.add(d.name);
          break;
        }
      }
    }
  }
  return names;
}

/** 取 `NAME.map(...)` 里回调的返回对象字面量文本（靠花括号配平，不看行）。 */
function mappedObjectLiteral(source: string, mapOpen: number): string | null {
  let i = mapOpen;
  let quote: string | null = null;
  let depth = 0;
  let objectStart = -1;
  for (; i < source.length; i += 1) {
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
    if (ch === "{") {
      depth += 1;
      if (depth === 1) objectStart = i;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0 && objectStart >= 0) return source.slice(objectStart + 1, i);
    }
  }
  return null;
}

interface OptionSite {
  file: string;
  line: number;
  text: string;
  list: string;
}

/** 清单.map 出来的 option 里，label 与 value 写成同一个标识符 ⇒ label 一定没翻译。 */
function findRawOptionLabels(source: string, file: string): OptionSite[] {
  const sites: OptionSite[] = [];
  for (const list of rawListNames(source)) {
    const call = new RegExp(`\\b${list}\\.map\\(\\s*\\(?([A-Za-z_$][\\w$]*)\\)?\\s*=>`, "g");
    for (const m of source.matchAll(call)) {
      const param = m[1];
      const open = (m.index ?? 0) + m[0].length - 1;
      const body = mappedObjectLiteral(source, open);
      if (body === null) continue;
      const labelMatch = /\blabel:\s*([^,}\n]*)/.exec(body);
      if (!labelMatch) continue;
      const labelExpr = labelMatch[1].trim();
      if (labelExpr === param && !LOCALIZER.test(body)) {
        sites.push({
          file,
          line: source.slice(0, m.index ?? 0).split("\n").length,
          text: (source.split("\n")[(source.slice(0, m.index ?? 0).split("\n").length - 1)] ?? "").trim().slice(0, 140),
          list,
        });
      }
    }
  }
  return sites;
}

function productionOptionSites(): OptionSite[] {
  return sourceFiles()
    .filter((file) => file.endsWith(".tsx"))
    .flatMap((file) => findRawOptionLabels(readScannedSource(file), file));
}

describe("默认名清单转 option 时 label 必须另写", () => {
  it("生产代码没有 value/label 同名的默认名清单", () => {
    const found = productionOptionSites().map((site) => `${site.file}:L${site.line} [${site.list}] ${site.text}`);
    expect(found, `这些下拉把 raw 默认名直接当 label 显示：\n${found.join("\n")}`).toEqual([]);
  });

  it("两种写法都抓得到，翻译过的放行", () => {
    const sample = [
      "  const projectNames = connections.map((c) => connectionProjectName(c));",
      "  const browseEnvironments = uniqueSorted(conns.map((conn) => connectionEnvironmentName(conn)));",
      "              options={projectNames.map((n) => ({ value: n, label: n }))}",
      "  const projectOptions = projectNames.map((value) => ({ value, label: value }));",
      "  const environmentOptions = browseEnvironments.map((value) => ({ value, label: localizeDefaultName(value, t) }));",
      "  const names = configs.map((item) => item.group);",
      "  const groupOptions = names.map((value) => ({ value, label: value }));",
    ].join("\n");
    const hit = findRawOptionLabels(sample, "sample.tsx");
    expect(hit.map((site) => site.line)).toEqual([3, 4]);
    expect(hit.map((site) => site.list)).toEqual(["projectNames", "projectNames"]);
  });
});

describe("规则二的扫描口径在生产代码上真的认得出默认名清单", () => {
  // 这条专门防「提取器坏掉导致守卫空转」：上一版按行截初始化表达式时，
  // DiffView / AuditView 的 `const projectNames = useMemo(` 全都被当普通常量放过。
  it("多行 useMemo 声明的清单也收得进来", () => {
    expect([...rawListNames(readScannedSource("src/components/DiffView.tsx"))]).toEqual(
      expect.arrayContaining(["projectNames", "environmentNames", "sourceOptions", "environmentOptions"])
    );
    expect([...rawListNames(readScannedSource("src/components/AuditView.tsx"))]).toContain("projectNames");
    expect([...rawListNames(readScannedSource("src/App.tsx"))]).toEqual(
      expect.arrayContaining(["browseProjects", "browseEnvironments", "browseSourceOptions"])
    );
  });
});
