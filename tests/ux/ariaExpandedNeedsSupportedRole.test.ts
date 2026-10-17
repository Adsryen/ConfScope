/**
 * 展开态必须挂在「认这个状态」的角色上（R43）。
 *
 * 为什么要静态守：`aria-expanded` 挂在 `<input>` 上，tsc 绿、jsdom 绿、DOM 属性也确实写进去了，
 * 但 WAI-ARIA/APG 的组合框模式说的是「显示当前值的那个控件本体」是 combobox、由它带 aria-expanded；
 * 挂在隐式 textbox 上时读屏念到的是「编辑框」，展开/收起不播报，用户不知道自己按下方向键后多出来一层候选。
 * 这类缺陷写错一次就会跟着复制粘贴扩散，所以把「带 aria-expanded 的元素角色是否合格」静态扫一遍：只许减，不许加。
 *
 * 口径说明（别误读成规范全文）：这里不搬 ARIA 规范的支持属性总表，只拦两种最常见的错挂——
 * 裸 `<input>`（隐式 textbox）和无 role 的 `<div>/<span>`（隐式 generic）；
 * 以及自定义组件（大写开头的标签）——属性是转发给组件的，由组件内部那条站点自己负责。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC = join(PROJECT_ROOT, "src");

/** 认 aria-expanded 的角色。新增成员要么给出规范依据，要么就别加——这份表的作用是让「挂错地方」变响。 */
const SUPPORTING_ROLES = [
  "button",
  "combobox",
  "link",
  "listbox",
  "menu",
  "menubar",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "tree",
  "treeitem",
  "grid",
  "table",
  "row",
  "columnheader",
  "rowgroup",
  "application",
  "region",
];

/** 历史遗留的错挂处。修一处删一行，下面「基线不得留着已消失条目」的用例盯着这点。 */
const BASELINE: Record<string, string[]> = {};

/** 注释里也写着 aria-expanded 的例子，换成等长空白，报出来的行号才对得上原文件。 */
function blankComments(code: string): string {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const two = code.slice(i, i + 2);
    if (two === "//") {
      const end = code.indexOf("\n", i);
      const stop = end === -1 ? code.length : end;
      out += code.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (two === "/*") {
      const end = code.indexOf("*/", i + 2);
      const stop = end === -1 ? code.length : end + 2;
      out += code.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else {
      out += code[i];
      i += 1;
    }
  }
  return out;
}

/** 跳过一对花括号（含字符串里的伪括号），返回右括号之后的位置。 */
function skipBraces(src: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i += 1;
        i += 1;
      }
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return src.length;
}

/** 跳过引号字面量，返回闭合引号之后的位置。 */
function skipQuoted(src: string, open: number): number {
  const quote = src[open];
  let i = open + 1;
  while (i < src.length && src[i] !== quote) {
    if (src[i] === "\\") i += 1;
    i += 1;
  }
  return i + 1;
}

interface OpenTag {
  tag: string;
  /** 属性名 → 原始取值文本；布尔式写法（无 =）记为 true */
  attrs: Map<string, string | true>;
  /** 起始标签的起止位置，用来确认某个属性确实属于这个元素 */
  start: number;
  end: number;
}

/** 从 `<button` 这种起点解析一个 JSX 起始标签；解析不出来就返回 null（交给 TS 报错，不猜）。 */
function parseOpenTag(src: string, start: number): OpenTag | null {
  const name = /^\s*([A-Za-z][\w.]*)/.exec(src.slice(start + 1));
  if (!name) return null;
  const tag: OpenTag = { tag: name[1], attrs: new Map(), start, end: -1 };
  let i = start + 1 + name[0].length;
  for (let guard = 0; guard < 400; guard += 1) {
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (i >= src.length) return null;
    if (src[i] === "/" && src[i + 1] === ">") {
      tag.end = i + 2;
      return tag;
    }
    if (src[i] === ">") {
      tag.end = i + 1;
      return tag;
    }
    if (src[i] === "{") {
      i = skipBraces(src, i); // {...props} 这类展开，内容不逐条展开看
      continue;
    }
    const attr = /^[A-Za-z_][\w-]*/.exec(src.slice(i));
    if (!attr) return null;
    i += attr[0].length;
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (src[i] === "=") {
      i += 1;
      while (i < src.length && /\s/.test(src[i])) i += 1;
      if (src[i] === '"' || src[i] === "'") {
        const raw = src.slice(i, skipQuoted(src, i));
        tag.attrs.set(attr[0], raw.slice(1, -1));
        i = skipQuoted(src, i);
      } else if (src[i] === "{") {
        const close = skipBraces(src, i);
        tag.attrs.set(attr[0], src.slice(i + 1, close - 1));
        i = close;
      } else {
        const value = /^[^\s>]+/.exec(src.slice(i));
        tag.attrs.set(attr[0], value ? value[0] : true);
        if (value) i += value[0].length;
      }
    } else {
      tag.attrs.set(attr[0], true);
    }
  }
  return null;
}

/** 找到真正持有这个属性的起始标签：往前逐个 `<X` 试解析，谁的范围包住它就算谁。 */
function ownerOfAttr(src: string, attrIndex: number): OpenTag | null {
  const candidates: number[] = [];
  let cursor = attrIndex;
  while (true) {
    cursor = src.lastIndexOf("<", cursor - 1);
    if (cursor === -1) break;
    if (/[A-Za-z]/.test(src[cursor + 1] ?? "")) candidates.push(cursor);
    if (candidates.length > 40) break;
  }
  for (const candidate of candidates) {
    const tag = parseOpenTag(src, candidate);
    if (tag && tag.end > attrIndex) return tag;
  }
  return null;
}

interface ExpandedSite {
  tag: string;
  role: string;
  line: number;
  hasControls: boolean;
}

/** 元素最终落到哪个角色：显式 role 优先，其次 HTML 隐式角色。 */
function roleOf(tag: OpenTag): string {
  const explicit = tag.attrs.get("role");
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim().toLowerCase();
  const lower = tag.tag.toLowerCase();
  if (lower === "button" || lower === "summary") return "button";
  if (lower === "a" && tag.attrs.has("href")) return "link";
  if (lower === "select") return "combobox";
  if (lower === "details") return "group";
  if (lower === "input") {
    const type = typeof tag.attrs.get("type") === "string" ? String(tag.attrs.get("type")).toLowerCase() : "text";
    return type === "checkbox" || type === "radio" ? type : "textbox";
  }
  if (/^[A-Z]/.test(tag.tag)) return "component"; // 自定义组件：属性由组件内部落到哪个元素，静态扫看不穿
  if (lower === "div" || lower === "span" || lower === "p" || lower === "section") return "generic";
  return lower;
}

function expandedSites(source: string): ExpandedSite[] {
  const src = blankComments(source);
  const sites: ExpandedSite[] = [];
  const pattern = /\baria-expanded\s*=/g;
  let match = pattern.exec(src);
  while (match) {
    const owner = ownerOfAttr(src, match.index);
    if (owner) {
      sites.push({
        tag: owner.tag,
        role: roleOf(owner),
        line: src.slice(0, match.index).split("\n").length,
        hasControls: owner.attrs.has("aria-controls"),
      });
    }
    match = pattern.exec(src);
  }
  return sites;
}

function productionComponents(dir: string, out: string[] = []): string[] {
  readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) productionComponents(full, out);
    else if (/\.tsx$/.test(entry.name) && !/\.(test|spec)\.tsx$/.test(entry.name)) out.push(full);
  });
  return out;
}

function offenders(): string[] {
  const bad: string[] = [];
  productionComponents(SRC).forEach((file) => {
    const path = relative(PROJECT_ROOT, file).split(/[\\/]/).join("/");
    expandedSites(readFileSync(file, "utf8"))
      .filter((site) => !SUPPORTING_ROLES.includes(site.role) && site.role !== "component")
      .filter((site) => !(path in BASELINE) || !BASELINE[path].includes(`L${site.line}`))
      .forEach((site) =>
        bad.push(
          `${path}:L${site.line} <${site.tag}> 的隐式/显式角色是「${site.role}」，它不认 aria-expanded，给本体补 role（组合框用 combobox）或换掉挂载点`
        )
      );
  });
  return bad;
}

describe("aria-expanded 必须挂在认这个状态的角色上", () => {
  it("src 生产代码里不存在挂错角色的展开态", () => {
    const found = offenders();
    expect(found, `这些 aria-expanded 落在不支持它的角色上，读屏不会播报展开/收起：\n${found.join("\n")}`).toEqual([]);
  });

  it("基线只减不增：已经改好的条目要一起删掉", () => {
    const alive = new Set(
      productionComponents(SRC).flatMap((file) => {
        const path = relative(PROJECT_ROOT, file).split(/[\\/]/).join("/");
        return expandedSites(readFileSync(file, "utf8")).map((site) => `${path}|L${site.line}`);
      })
    );
    const stale = Object.entries(BASELINE)
      .flatMap(([path, lines]) => lines.map((line) => `${path}|${line}`))
      .filter((key) => !alive.has(key));
    expect(stale, "这些站点已经不存在了，请把基线里对应条目删掉").toEqual([]);
  });

  it("组合框本体自己带 aria-expanded，展开时还要用 aria-controls 指向候选列表", () => {
    const combobox = expandedSites(readFileSync(join(SRC, "components/Combobox.tsx"), "utf8"));
    expect(combobox, "Combobox 不再声明展开态了？那这条守卫的靶子也得一起改").toHaveLength(1);
    expect(combobox[0].role).toBe("combobox");
    expect(combobox[0].hasControls, "展开态有了、但没有 aria-controls 指向 listbox，读屏仍然数不出候选").toBe(true);

    const select = expandedSites(readFileSync(join(SRC, "components/Select.tsx"), "utf8"));
    expect(select.every((site) => site.role === "button" && site.hasControls)).toBe(true);
  });
});

describe("守卫自己：fixture 反例必须能被抓到", () => {
  it("裸 input 带 aria-expanded 判违规", () => {
    const sites = expandedSites(`<input aria-expanded={open} value={v} />`);
    expect(sites).toHaveLength(1);
    expect(sites[0].role).toBe("textbox");
  });

  it("显式 role=combobox 就合格", () => {
    const sites = expandedSites(`<input role="combobox" aria-expanded={open} aria-controls={id} onChange={(e) => set(e.target.value)} />`);
    expect(sites[0].role).toBe("combobox");
    expect(sites[0].hasControls).toBe(true);
  });

  it("button 的隐式角色算合格，div 不算", () => {
    const good = expandedSites(`<button type="button" aria-expanded={open}>×</button>`);
    const bad = expandedSites(`<div className="x" aria-expanded={open} onClick={() => set(v)}><span>…</span></div>`);
    expect(good[0].role).toBe("button");
    expect(bad[0].role, "generic 不认 aria-expanded，必须报出来").toBe("generic");
  });

  it("属性值里嵌着别的元素时不会把展开态算到内层元素头上", () => {
    const sites = expandedSites(`<div title={<Icon aria-label="x" />} aria-expanded={open} className="a"><span>b</span></div>`);
    expect(sites).toHaveLength(1);
    expect(sites[0].tag).toBe("div");
  });

  it("自定义组件不算违规，但要真的被识别出来（别默默漏掉）", () => {
    const sites = expandedSites(`<Combobox aria-expanded={open} />`);
    expect(sites[0].role).toBe("component");
  });

  it("注释里的 aria-expanded 不算站点", () => {
    expect(expandedSites(`{/* aria-expanded={true} */}\n<input aria-expanded={open} />`)).toHaveLength(1);
  });
});
