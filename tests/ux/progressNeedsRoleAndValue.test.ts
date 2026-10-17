/**
 * 进度条必须带 progressbar 语义与当前值（轮11 R42 的第二半）。
 *
 * 扫出来的真 bug：5 处进度（任务中心列表/详情、变更执行确认页、关于页更新下载、配置内容搜索）
 * 全靠一根 `width: N%` 的色条表达。读屏走到这里只念得出「分组」，进度是多少、还在不在动，
 * 一句都听不到。而内容搜索那处更绕：它同时是「文本进度」，如果按 live region 处理，
 * 每读一条配置就念一遍「已读取 n/N 项」，几百条刷下来会把用户当前朗读全部打断——
 * 所以它走 `role="progressbar"` + `aria-valuetext`，读屏按需查询而不是主动插播。
 *
 * 口径：
 * 1. className 含 `progress-bar` / `content-search-progress` 的元素，必须
 *    `role="progressbar"` + `aria-valuemin` + `aria-valuemax` + (`aria-valuenow` 或 `aria-valuetext`)，
 *    并且有名字（`aria-label` / `aria-labelledby`）——progressbar 没名字时读屏只念「进度条 62%」；
 * 2. 反向也查：手写了 `role="progressbar"` 的，不许少值少名字（防新增进度条裸奔）；
 * 3. progressbar 不许同时是 live region（`aria-live` / `role="status"` / `role="alert"`）；
 * 4. 内容搜索进度那处必须是 progressbar，防它被改回 live region 刷屏；
 * 5. 防永真：命中量下限（按 class 命中、按 role 命中）。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource, sourceFiles } from "./scanUtils";

/** 视觉进度条的 class 特征（token 级匹配，避开 progress-fill / progress-text 这类装饰节点） */
const PROGRESS_CLASS_TOKENS = ["progress-bar", "update-progress-bar"];
/** 必填的数值属性：区间两端 + 当前值（当前值允许用 aria-valuetext 的口语化写法替代） */
const REQUIRED_VALUE = ["aria-valuemin", "aria-valuemax"];
/** 必须有名字的来源，二者有一即可 */
const NAME_ATTRS = ["aria-label", "aria-labelledby"];
/** 会被主动插播的活区写法——progressbar 上不许出现 */
const LIVE_ATTRS = ["aria-live"];
const LIVE_ROLES = ["status", "alert", "log"];
/** 命中量下限（2026-10-17 实测 class 命中 4、role 命中 5） */
const MIN_CLASS_SITES = 4;
const MIN_ROLE_SITES = 5;
/** 内容搜索进度的文案 key：它必须是 progressbar */
const CONTENT_SEARCH_PROGRESS_KEY = "config.contentSearchProgress";

interface Tag {
  file: string;
  line: number;
  name: string;
  attrs: string;
}

/** 取开标签的属性文本：花括号/引号里的 `>` 不算结束（`onChange={(e) => x}` 里全是 `>`）。 */
function tagHead(source: string, start: number): { attrs: string; selfClosing: boolean } {
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
    else if (ch === ">" && depth === 0) {
      const body = source.slice(start, i);
      return { attrs: body.replace(/\/$/, ""), selfClosing: /\/$/.test(body) };
    }
  }
  return { attrs: source.slice(start), selfClosing: false };
}

function hasAttr(attrs: string, name: string): boolean {
  return new RegExp(`(?:^|\\s)${name}\\s*=`).test(attrs);
}

/** 属性字面量（`x="a"` / `x='a'` / `x={"a"}` 三种写法） */
function attrLiteral(attrs: string, name: string): string {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{\\s*["']([^"']*)["']\\s*\\})`).exec(attrs);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
}

function classNameOf(attrs: string): string {
  const m = /(?:^|\s)className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/.exec(attrs);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
}

function isProgressBarClass(className: string): boolean {
  const tokens = className.split(/[^A-Za-z0-9_-]+/).filter(Boolean);
  return PROGRESS_CLASS_TOKENS.some((token) => tokens.includes(token));
}

/** 摊平 src 下所有开标签 */
function scanTags(): Tag[] {
  const tags: Tag[] = [];
  const tagRe = /<(\/?)([A-Za-z][\w.:-]*)/g;
  for (const file of sourceFiles()) {
    if (!file.endsWith(".tsx")) continue;
    const source = readScannedSource(file);
    for (const hit of Array.from(source.matchAll(tagRe))) {
      if (hit[1]) continue;
      const at = hit.index ?? 0;
      const head = tagHead(source, at + hit[0].length);
      tags.push({ file, line: source.slice(0, at).split("\n").length, name: hit[2], attrs: head.attrs });
    }
  }
  return tags;
}

/** 找「渲染某 key 作为元素文本」时最近的外层元素：走一遍标签栈 */
function enclosingOfTextRender(key: string): { file: string; line: number; tag?: Tag } | undefined {
  const tagRe = /<(\/?)([A-Za-z][\w.:-]*)/g;
  const keyRe = new RegExp(`t\\(\\s*["']${key}["']\\s*[,)]`, "g");
  const VOID_TAGS = new Set(["input", "textarea", "select", "img", "br", "hr"]);
  for (const file of sourceFiles()) {
    if (!file.endsWith(".tsx")) continue;
    const source = readScannedSource(file);
    const events: Array<{ at: number; kind: "tag" | "text"; hit: RegExpExecArray }> = [];
    for (const hit of Array.from(source.matchAll(tagRe))) events.push({ at: hit.index ?? 0, kind: "tag", hit });
    for (const hit of Array.from(source.matchAll(keyRe))) events.push({ at: hit.index ?? 0, kind: "text", hit });
    events.sort((a, b) => a.at - b.at);
    const stack: Tag[] = [];
    for (const ev of events) {
      if (ev.kind === "tag") {
        const name = ev.hit[2];
        if (ev.hit[1]) {
          for (let i = stack.length - 1; i >= 0; i -= 1) {
            if (stack[i].name === name) {
              stack.length = i;
              break;
            }
          }
          continue;
        }
        const at = ev.at;
        const head = tagHead(source, at + ev.hit[0].length);
        if (!head.selfClosing && !VOID_TAGS.has(name)) {
          stack.push({ file, line: source.slice(0, at).split("\n").length, name, attrs: head.attrs });
        }
        continue;
      }
      return { file, line: source.slice(0, ev.at).split("\n").length, tag: stack[stack.length - 1] };
    }
  }
  return undefined;
}

function where(tag: Tag): string {
  return `${tag.file}:${tag.line} <${tag.name} className="${classNameOf(tag.attrs)}">`;
}

function missingAttrs(tag: Tag): string[] {
  const missing: string[] = [];
  if (attrLiteral(tag.attrs, "role") !== "progressbar") missing.push('role="progressbar"');
  for (const name of REQUIRED_VALUE) if (!hasAttr(tag.attrs, name)) missing.push(name);
  if (!hasAttr(tag.attrs, "aria-valuenow") && !hasAttr(tag.attrs, "aria-valuetext")) missing.push("aria-valuenow|aria-valuetext");
  if (!NAME_ATTRS.some((name) => hasAttr(tag.attrs, name))) missing.push("aria-label|aria-labelledby");
  return missing;
}

function liveOnProgressbar(tag: Tag): string | undefined {
  if (LIVE_ATTRS.some((name) => hasAttr(tag.attrs, name))) return "aria-live";
  const role = attrLiteral(tag.attrs, "role");
  return LIVE_ROLES.includes(role) ? `role="${role}"` : undefined;
}

describe("进度条必须能被读屏读出百分比", () => {
  const tags = scanTags();
  const byClass = tags.filter((tag) => isProgressBarClass(classNameOf(tag.attrs)));
  const byRole = tags.filter((tag) => attrLiteral(tag.attrs, "role") === "progressbar");
  /** 两个口径的并集：漏一边就没人守了 */
  const all = Array.from(new Set([...byClass, ...byRole]));

  it("扫描口径不是空转：视觉进度条与 progressbar 各自都要有命中", () => {
    expect(byClass.length).toBeGreaterThanOrEqual(MIN_CLASS_SITES);
    expect(byRole.length).toBeGreaterThanOrEqual(MIN_ROLE_SITES);
    // class 命中的进度条必须都写上 role，否则说明有人只补了半边（新增色条裸奔）
    const classOnly = byClass.filter((tag) => attrLiteral(tag.attrs, "role") !== "progressbar");
    expect(classOnly.map(where).join("\n")).toBe("");
  });

  it("进度条必须带 progressbar 语义、区间、当前值与名字", () => {
    const problems = all.filter((tag) => missingAttrs(tag).length > 0).map((tag) => `${where(tag)} 缺 ${missingAttrs(tag).join(", ")}`);
    expect(problems.join("\n")).toBe("");
  });

  it("进度条不许同时是活区（高频刷新会刷屏打断朗读）", () => {
    const noisy = all
      .map((tag) => ({ tag, live: liveOnProgressbar(tag) }))
      .filter((row) => row.live)
      .map((row) => `${where(row.tag)} 挂了 ${row.live}`);
    expect(noisy.join("\n")).toBe("");
  });

  it("内容搜索进度必须是 progressbar（波23 决定，不许改回 live region）", () => {
    const site = enclosingOfTextRender(CONTENT_SEARCH_PROGRESS_KEY);
    expect(site?.tag, "内容搜索进度文案找不到宿主元素").toBeDefined();
    expect(attrLiteral(site?.tag?.attrs ?? "", "role")).toBe("progressbar");
    expect(liveOnProgressbar(site?.tag as Tag)).toBeUndefined();
  });
});
