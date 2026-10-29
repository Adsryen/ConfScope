/**
 * 只读正文（滚动区）必须能被键盘到达（R39 / 轮9 波20）。
 *
 * 缺陷长什么样：错误详情、日志原文、配置正文这类 `overflow: auto` 的只读块，
 * 整块里没有任何可聚焦子孙，Tab 一按就跨过去了 —— 鼠标用户滚轮一看到底，
 * 键盘用户连后半段内容都看不见。这类问题不报错、不影响渲染，
 * 单测里 fireEvent 又永远点得到，只有静态扫才拦得住。
 *
 * 口径：
 * 1. styles.css 里带 overflow: auto|scroll 的类，凡挂在 <pre> 上，开标签必须齐
 *    tabIndex={0} + role="region" + aria-label|aria-labelledby（region 是给读屏的：
 *    aria-label 挂在裸 pre/div 这类隐式 generic 上会被部分读屏忽略）；
 * 2. 高亮叠层这类「假正文」豁免（真焦点在别的元素上），但要钉死数量并验证 aria-hidden；
 * 3. 非 pre 的滚动区靠登记表：合规数与总数都钉死，静默新增或漏改都会红；
 *    轮48 修补了一个空洞——原先「没登记的非 pre 滚动区」被扫描直接丢掉，最后那条
 *    「先登记再实现」永远咬不住新写的块。现在未登记的也进视野，按**类名**分档：
 *    纯展示正文必须登记进 NON_PRE_REGISTRY，内部本来就有可聚焦项的进遗留名单（只减不增）；
 * 4. 能被 Tab 到达就得看得见：styles.css 里该类的 :focus-visible 必须真的画 outline。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, readScannedSource, sourceFiles } from "./scanUtils";

const CSS = readFileSync(join(PROJECT_ROOT, "src/styles.css"), "utf8");

/** styles.css 里带 overflow: auto|scroll 的类名集合（先抹注释，别把说明文字当规则）。 */
function scrollableClasses(): Set<string> {
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const found = new Set<string>();
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/overflow(?:-[xy])?\s*:\s*(auto|scroll)\b/.test(body)) continue;
    for (const part of selector.split(",")) {
      for (const [, name] of part.matchAll(/\.([A-Za-z][\w-]*)/g)) found.add(name);
    }
  }
  return found;
}

const SCROLLABLE = scrollableClasses();

/** 从 `<pre` 的尖括号起取到开标签结束（带括号深度与引号状态，避免被 `=>` 截断）。 */
function openingTagAt(source: string, start: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
    else if (ch === ">" && depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

/** 开标签上的 className 词元（模板串里的 `${}` 片段先抹平成空白再切）。 */
function classTokens(tag: string): string[] {
  const literal = tag.match(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/);
  const raw = literal ? `${literal[1] ?? ""} ${literal[2] ?? ""} ${literal[3] ?? ""}` : "";
  return raw
    .replace(/[`'"]/g, " ")
    .split(/[\s${}]+/)
    .filter(Boolean);
}

function isKeyboardAccessible(tag: string): boolean {
  const focusable = /tabIndex=\{0\}|tabIndex="0"/.test(tag) && !/tabIndex=\{-1\}/.test(tag);
  return focusable && /role="region"/.test(tag) && /aria-labelledby=|aria-label=/.test(tag);
}

/** 剥注释后的文本行数与原文一致，按换行数算行号，fixture（假路径）也能报行号。 */
function lineOf(stripped: string, index: number): number {
  return stripped.slice(0, index).split("\n").length;
}

interface Site {
  id: string;
  cls: string;
  tag: string;
  attrs: string;
  /** aria-labelledby 指向的变量名；用 aria-label 的站点为 null。 */
  labelRef: string | null;
  accessible: boolean;
}

/** aria-labelledby={foo} 里的 foo。写成模板串的按「查不到」处理，宁严不可漏。 */
function labelRefOf(attrs: string): string | null {
  const found = attrs.match(/aria-labelledby=\{(\w+)\}/);
  return found ? found[1] : null;
}

/** 假正文叠层：真正可聚焦的是外层 textarea，pre 本身必须 aria-hidden。 */
const LAYER_EXCEPTIONS: Record<string, number> = {
  "src/components/CodeEditor.tsx|code-editor-pre": 1,
};

/** 非 pre 的滚动区登记表：合规数与总数都钉死（总数里包含故意不可聚焦的那一份）。 */
const NON_PRE_REGISTRY: Record<string, { accessible: number; total: number }> = {
  // 更新说明是纯文本块，Tab 要能停进去
  "src/components/About.tsx|update-release-notes": { accessible: 1, total: 1 },
  // 左右两栏只有右栏是纯展示（左栏每行带 checkbox，Tab 本来就到得了）
  "src/components/DiffView.tsx|match-side-scroll": { accessible: 1, total: 2 },
  // 对比正文：轮48 接查找条时顺手登记（面板唯一滚动容器，Tab 要能停进去滚到底）
  "src/components/DiffPanel.tsx|diff-body": { accessible: 1, total: 1 },
  // 单列差异正文：轮49 接查找条时从遗留名单提上来（关栏要把焦点还给这一层，
  // 少了 tabIndex={0} 那句 bodyRef.focus() 就是空操作，方向键 / PageUp 当场失效）
  "src/components/UnifiedDiff.tsx|udiff": { accessible: 1, total: 1 },
  // 工作流步骤条：轮66 WP-1 让它在窄视口下横向可滚，本波补上「容器自己能被 Tab 到达」。
  // accessible 记 0 不是「还没做」—— tabIndex={0} 已经补上，焦点环由下面的 FOCUS_RING_CLASSES 守住；
  // 判定函数只认 role="region" 这一种命名方式，那是给裸 div/pre 这类隐式 generic 准备的（部分读屏会忽略
  // 它们身上的 aria-label），而这里是 <nav>，导航地标自带可访问名，再套 role="region" 反而把地标降级成
  // 正文区块。别为了凑成 1 去改角色。
  "src/components/DiffWorkflowCard.tsx|diff-workflow-card": { accessible: 0, total: 1 },
};

/**
 * 遗留的非 pre 滚动**类名**基线：这些容器内部本来就有可聚焦项（列表行、按钮、输入框），
 * 或者标签本身可聚焦（textarea），Tab 经子孙到达，所以不需要自己再挂 tabIndex。
 *
 * 这份名单只减不增：轮48 补空洞时才把它建起来（此前这些站点被静默丢弃，从未被回答过）。
 * 真要逐类核实「键盘能不能滚到底」时，把类从名单里删掉并补 tabIndex/role/aria-label。
 */
const LEGACY_NON_PRE_CLASSES = new Set([
  "about-page",
  "apply-detail",
  "apply-item-list",
  // 变更计划整列滚动面（r113 撤「晋级到生产」后整列改唯一滚动面）：列内含执行 / Dry-run 按钮、
  // 确认 checkbox、手敲输入框与差异详情编辑器，Tab 经子孙本来就到得了，容器不另挂 tabIndex。
  "apply-main-column",
  "apply-workspace",
  "audit-matrix-body",
  "audit-page",
  "batch-diff-failures",
  "batch-diff-nav-scroll",
  "browser-items",
  "code-editor-ta", // textarea 本身可聚焦
  "combo-menu",
  "conn-form",
  "conn-list",
  "data-detail",
  "data-list",
  "data-split",
  "diff-workspace",
  "field-error",
  "field-error-box",
  "history-items",
  "log-detail-expanded",
  "log-viewer",
  "message-list",
  "modal",
  "modal-body",
  "sel-menu",
  "settings-panels",
  // 轮73 R73-I1：左栏撤掉了自身滚动（滚轮死区），不再是滚动站点，僵尸登记同步撤掉。
  "ssh-manager-page",
  "ssh-profile-list",
]);

/**
 * 「靠地标自带可访问名」的滚动容器：判定函数只认 role="region"，认不出它们，登记表里只能记
 * accessible: 0。这一格不是逃票口——它们必须自己带 tabIndex={0}，焦点环也必须画得出来，
 * 两样都在这里钉死；哪天真的补上 role="region"，就把它挪回 NON_PRE_REGISTRY 的口径。
 */
const LANDMARK_SCROLLERS: Record<string, string> = {
  // 轮66：窄视口下横向可滚的工作流步骤条，容器是 <nav>（导航地标自带名字，不该降级成 region）
  "src/components/DiffWorkflowCard.tsx|diff-workflow-card": "nav",
};

function scanFile(relPath: string, stripped: string) {
  const preSites: Site[] = [];
  const exceptions: Site[] = [];
  const otherSites: Site[] = [];
  for (const match of stripped.matchAll(/<([a-z][\w-]*)\b/g)) {
    const tag = match[1];
    const start = match.index ?? 0;
    const attrs = openingTagAt(stripped, start);
    if (!attrs) continue;
    const tokens = classTokens(attrs);
    const cls = tokens.find((token) => SCROLLABLE.has(token));
    if (!cls) continue;
    const site: Site = {
      id: `${relPath}|${cls}|${lineOf(stripped, start)}`,
      cls,
      tag,
      attrs,
      labelRef: labelRefOf(attrs),
      accessible: isKeyboardAccessible(attrs),
    };
    const key = `${relPath}|${cls}`;
    if (NON_PRE_REGISTRY[key]) otherSites.push(site);
    else if (tag === "pre") (LAYER_EXCEPTIONS[key] ? exceptions : preSites).push(site);
    // 轮48 修补：以前这一档直接落空（既不登记也不上报），新写的非 pre 滚动区躲得过守卫
    else otherSites.push(site);
  }
  return { preSites, exceptions, otherSites };
}

function scanAll() {
  const acc = { preSites: [] as Site[], exceptions: [] as Site[], otherSites: [] as Site[] };
  sourceFiles().forEach((rel) => {
    const result = scanFile(rel, readScannedSource(rel));
    acc.preSites.push(...result.preSites);
    acc.exceptions.push(...result.exceptions);
    acc.otherSites.push(...result.otherSites);
  });
  return acc;
}

const FOCUS_RING_CLASSES = [
  "code-area",
  "error-detail",
  "history-detail-content",
  "history-detail-error",
  "log-jsonl",
  "log-event-payload",
  "audit-detail-value",
  "inline-error-body",
  "app-crash-detail",
  "update-release-notes",
  "match-side-scroll",
  "diff-body",
  "udiff",
  "diff-workflow-card",
];

/** 该类的 :focus-visible 里有没有真的画 outline（值为 none 等于没画）。 */
function focusRingFor(cls: string): boolean {
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const found = css.match(new RegExp(`(?:^|[,{}\\s])\\.${cls}:focus-visible[^{]*\\{([^}]*)\\}`, "m"));
  if (!found) return false;
  return /outline:/.test(found[1]) && !/outline:\s*none\b/.test(found[1]);
}

describe("只读滚动区必须能被键盘到达", () => {
  it("样式里有 overflow 的只读 pre 都能 Tab 停进去且有可访问名", () => {
    const sites = scanAll().preSites;
    const bad = sites.filter((site) => !site.accessible).map((site) => site.id);
    expect(bad, `这些只读正文键盘滚不到。补 tabIndex={0} + role="region" + aria-label/aria-labelledby：\n${bad.join("\n")}`).toEqual([]);
    // 轮13 波28 把 9 份手抄的 .inline-error 收进 src/components/InlineError.tsx 后，源码里的
    // 字面站点从 17 降到 9：运行时弹出的错误块数量没变，只是不再各写一份 <pre>。
    // 这份结构自带的 tabIndex/role 由 inlineErrorSingleSource.test.ts 钉住，这里只守住下限。
    expect(sites.length, "命中量低于预期，扫描逻辑可能失效了").toBeGreaterThanOrEqual(9);
  });

  it("假正文叠层豁免只减不增，且必须 aria-hidden", () => {
    const exceptions = scanAll().exceptions;
    Object.entries(LAYER_EXCEPTIONS).forEach(([key, count]) => {
      const hits = exceptions.filter((site) => site.id.split("|").slice(0, 2).join("|") === key);
      expect(hits.length, `${key} 的叠层数量变了，请连理由一起登记`).toBe(count);
      // 豁免只在「这一层对读屏隐藏、真焦点在 textarea 上」时成立，所以查它自己开标签上的 aria-hidden
      hits.forEach((site) => {
        expect(/aria-hidden=\{?["']?true/.test(site.attrs), `${site.id} 是叠层豁免，但没有 aria-hidden`).toBe(true);
      });
    });
    const extra = exceptions.filter((site) => !(site.id.split("|").slice(0, 2).join("|") in LAYER_EXCEPTIONS));
    expect(
      extra.map((site) => site.id),
      "新出现的「假正文」豁免要连同理由一起登记"
    ).toEqual([]);
  });

  it("非 pre 的滚动区按登记表钉死", () => {
    const found = scanAll().otherSites;
    Object.entries(NON_PRE_REGISTRY).forEach(([key, expected]) => {
      const hits = found.filter((site) => site.id.split("|").slice(0, 2).join("|") === key);
      expect(hits.length, `${key} 的站点总数变了（登记 ${expected.total}，实际 ${hits.length}）`).toBe(expected.total);
      const accessible = hits.filter((site) => site.accessible).length;
      expect(accessible, `${key} 需要键盘可达的份数对不上（登记 ${expected.accessible}）`).toBe(expected.accessible);
    });
    const unregisteredKeys = found
      .map((site) => site.id.split("|").slice(0, 2).join("|"))
      .filter((key, index, all) => !(key in NON_PRE_REGISTRY) && all.indexOf(key) === index);
    const classOf = (key: string) => key.split("|")[1];
    const freshClasses = unregisteredKeys.map(classOf).filter((cls) => !LEGACY_NON_PRE_CLASSES.has(cls));
    expect(
      freshClasses,
      `新冒出的非 pre 滚动类要先回答「键盘能不能滚到底」：纯展示正文补 tabIndex={0} + role="region" + aria-label 并登记进 NON_PRE_REGISTRY；` +
        `确认内部本来就有可聚焦项的才进遗留名单并写明理由：\n${freshClasses.join("\n")}`
    ).toEqual([]);
    const stale = [...LEGACY_NON_PRE_CLASSES].filter((cls) => !unregisteredKeys.some((key) => classOf(key) === cls));
    expect(stale, `这些遗留类已经扫不到站点，从 LEGACY_NON_PRE_CLASSES 删掉，别留僵尸把守卫拖空：\n${stale.join("\n")}`).toEqual([]);
    // 自检：补空洞后这条路径必须真的扫到东西（轮48 之前 unregisteredKeys 恒为空，守卫是空转的）
    expect(unregisteredKeys.length, "未登记的非 pre 滚动站点一条都没扫到，说明扫描又退回了「静默丢弃」").toBeGreaterThanOrEqual(
      LEGACY_NON_PRE_CLASSES.size
    );
  });

  it("地标命名的滚动容器必须自己可聚焦且画得出焦点环", () => {
    const found = scanAll().otherSites;
    for (const [key, landmarkTag] of Object.entries(LANDMARK_SCROLLERS)) {
      const hits = found.filter((site) => site.id.split("|").slice(0, 2).join("|") === key);
      expect(hits.length, `${key} 没在扫描里出现，登记表是僵尸`).toBe(1);
      const site = hits[0];
      expect(/tabIndex=\{0\}/.test(site.attrs), `${key} 丢了 tabIndex={0}，键盘又滚不动了`).toBe(true);
      expect(site.tag, `${key} 的可访问名靠 <${landmarkTag}> 地标，换成别的元素要重新回答命名`).toBe(landmarkTag);
      expect(site.accessible, `${key} 已经带上 role="region" 了，请改回 NON_PRE_REGISTRY 的 accessible 口径`).toBe(false);
    }
    const missingRing = Object.keys(LANDMARK_SCROLLERS)
      .map((key) => key.split("|")[1])
      .filter((cls) => !focusRingFor(cls));
    expect(missingRing, `这些地标滚动区可达但不可见：${missingRing.join(", ")}`).toEqual([]);
  });

  it("aria-labelledby 指向的 id 在本文件真的挂上了", () => {
    const dangling: string[] = [];
    let checked = 0;
    sourceFiles().forEach((rel) => {
      const stripped = readScannedSource(rel);
      const result = scanFile(rel, stripped);
      const sites = [...result.preSites, ...result.exceptions, ...result.otherSites];
      sites.forEach((site) => {
        if (!site.labelRef) return;
        checked += 1;
        const pattern = new RegExp("id=\\{" + site.labelRef + "\\}|id=\\{[^}]*" + site.labelRef + "[^}]*\\}");
        if (!pattern.test(stripped)) dangling.push(`${site.id} -> ${site.labelRef}`);
      });
    });
    expect(dangling, `这些滚动区的可访问名指向了不存在的 id：\n${dangling.join("\n")}`).toEqual([]);
    expect(checked, "至少要有矩阵详情这类动态命名站点，否则这条守卫是空的").toBeGreaterThanOrEqual(1);
  });

  it("能被 Tab 到达就有看得见的焦点环", () => {
    const missing = FOCUS_RING_CLASSES.filter((cls) => !focusRingFor(cls));
    expect(missing, `这些滚动区可达但不可见：${missing.join(", ")}`).toEqual([]);
  });
});
