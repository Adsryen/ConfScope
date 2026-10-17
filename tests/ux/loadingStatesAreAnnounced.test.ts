/**
 * 「加载中」必须能被读屏播报（轮11 R42）。
 *
 * 扫出来的真 bug：9 处 loading 提示写成裸 `<div className="pad-msg">{t("common.loading")}</div>`，
 * 它在数据回来后异步出现又消失，读屏完全不播报——视障用户点开备份页或历史页，只听到一片
 * 沉默，分不清「在读」还是「坏了」。另有 2 处内联后缀 `(加载中)` 挂在 `<label>` 的 span 上，
 * 直接给整个 label 加 aria-live 会把字段名也反复念一遍，所以只给会变化的那个 span 加。
 *
 * 口径：
 * 1. 渲染 `common.loading` / `config.loading` 作为元素文本的站点，最近的外层元素必须带
 *    `role="status"` 或 `aria-live`；
 * 2. 按钮/链接里的 loading 豁免——焦点停在上头时名字本来就跟着变，不需要 live region；
 * 3. 只许 polite 不许 assertive：assertive 会打断用户当前的朗读，进度类提示不该这么吵；
 * 4. 防永真：命中量下限（总站点、可播报站点、豁免站点、各文件站点）+ 波23 修好的文件清单。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource, sourceFiles } from "./scanUtils";

/** 需要在读屏里「出声」的加载文案 key */
const LOADING_KEYS = ["common.loading", "config.loading"];
/** 焦点控件的名字变化本身会被播报，这些标签内的 loading 豁免 */
const CONTROL_TAGS = new Set(["button", "a"]);
/** JSX 里没有子元素的标签，不进栈 */
const VOID_TAGS = new Set(["input", "textarea", "select", "img", "br", "hr"]);
/** 命中量下限（2026-10-17 实测 11 / 9 / 2） */
const MIN_SITES = 10;
const MIN_ANNOUNCED = 8;
const MIN_CONTROL_EXEMPT = 2;
/** 波23 已修站点所在文件：一个都不许退回 */
const FIXED_FILES = [
  "src/components/BackupView.tsx",
  "src/components/HistoryView.tsx",
  "src/components/OperationHistoryView.tsx",
  "src/components/ConfigBrowser.tsx",
  "src/components/DiffView.tsx",
];

interface OpenTag {
  name: string;
  attrs: string;
}

interface Site {
  file: string;
  line: number;
  key: string;
  /** 最近的外层元素（文本的宿主） */
  enclosing?: OpenTag;
  /** 从外到内的祖先链，用于判断是否落在按钮里 */
  chain: string[];
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

/** 属性是否写了（不看值，`aria-live` 与 `aria-live={mode}` 都算）。 */
function hasAttr(attrs: string, name: string): boolean {
  return new RegExp(`(?:^|\\s)${name}\\s*=`).test(attrs);
}

function attrLiteral(attrs: string, name: string): string {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{\\s*["']([^"']*)["'])`).exec(attrs);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
}

function isLiveRegion(tag?: OpenTag): boolean {
  if (!tag) return false;
  return hasAttr(tag.attrs, "aria-live") || attrLiteral(tag.attrs, "role") === "status";
}

/** 按源码顺序走标签栈，把每处 loading 文案与它的外层元素配起来。 */
function scanLoadingSites(): Site[] {
  const sites: Site[] = [];
  const tagRe = /<(\/?)([A-Za-z][\w.:-]*)/g;
  const keyRe = new RegExp(`t\\(\\s*["'](?:${LOADING_KEYS.join("|")})["']\\s*\\)`, "g");
  for (const file of sourceFiles()) {
    if (!file.endsWith(".tsx")) continue;
    const source = readScannedSource(file);
    const events: Array<{ at: number; kind: "tag" | "text"; hit: RegExpExecArray }> = [];
    for (const hit of Array.from(source.matchAll(tagRe))) events.push({ at: hit.index ?? 0, kind: "tag", hit });
    for (const hit of Array.from(source.matchAll(keyRe))) events.push({ at: hit.index ?? 0, kind: "text", hit });
    events.sort((a, b) => a.at - b.at);
    const stack: OpenTag[] = [];
    for (const ev of events) {
      if (ev.kind === "tag") {
        const name = ev.hit[2];
        if (ev.hit[1]) {
          // 闭合标签：回退到同名开标签，中间的元素一并出栈
          for (let i = stack.length - 1; i >= 0; i -= 1) {
            if (stack[i].name === name) {
              stack.length = i;
              break;
            }
          }
          continue;
        }
        const head = tagHead(source, (ev.hit.index ?? 0) + ev.hit[0].length);
        if (!head.selfClosing && !VOID_TAGS.has(name)) stack.push({ name, attrs: head.attrs });
        continue;
      }
      sites.push({
        file,
        line: source.slice(0, ev.at).split("\n").length,
        key: /["']([^"']+)["']/.exec(ev.hit[0])?.[1] ?? ev.hit[0],
        enclosing: stack[stack.length - 1],
        chain: stack.map((tag) => tag.name),
      });
    }
  }
  return sites;
}

function where(site: Site): string {
  const host = site.enclosing ? ` <${site.enclosing.name}>` : "";
  return `${site.file}:${site.line} ${site.key}${host}`;
}

describe("加载中提示必须能被读屏播报", () => {
  const sites = scanLoadingSites();
  const announced = sites.filter((site) => isLiveRegion(site.enclosing));
  const controlExempt = sites.filter((site) => site.chain.some((name) => CONTROL_TAGS.has(name)));
  const naked = sites.filter((site) => !isLiveRegion(site.enclosing) && !controlExempt.includes(site));

  it("扫描口径不是空转：站点数、可播报数、豁免数都要够", () => {
    expect(sites.length).toBeGreaterThanOrEqual(MIN_SITES);
    expect(announced.length).toBeGreaterThanOrEqual(MIN_ANNOUNCED);
    expect(controlExempt.length).toBeGreaterThanOrEqual(MIN_CONTROL_EXEMPT);
    // 两种 key 都得真有命中，否则其中一条口径会空转
    for (const key of LOADING_KEYS) expect(sites.some((site) => site.key === key)).toBe(true);
  });

  it("独立块与内联后缀的 loading 必须落在 live region 内", () => {
    expect(naked.map(where).join("\n")).toBe("");
  });

  it("波23 修好的文件一处不许退回", () => {
    const silent = FIXED_FILES.filter((file) => !announced.some((site) => site.file === file));
    expect(silent.join("\n")).toBe("");
  });

  it("只许 polite，不许 assertive 打断当前朗读", () => {
    const shouting = announced.filter((site) =>
      /(?:^|\s)aria-live\s*=\s*(?:"assertive"|'assertive'|\{\s*["']assertive["'])/.test(site.enclosing?.attrs ?? "")
    );
    expect(shouting.map(where).join("\n")).toBe("");
  });

  it("live region 不许挂在 label 上（字段名会被反复念）", () => {
    const loudLabels = announced.filter(
      (site) => site.chain.includes("label") && !site.chain.includes("button") && site.enclosing?.name !== "span"
    );
    expect(loudLabels.map(where).join("\n")).toBe("");
  });
});
