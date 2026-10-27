/**
 * 截断的正文必须能被复制走（R62）。
 *
 * `styles.css` 里 `body { user-select: none }` 是本项目的既定设计（拖动列表不许整屏刷蓝），
 * 代价很隐蔽：带省略号的 dataId / namespace / 路径 / 报错原文，**眼睛看得见、鼠标抄不走**。
 * 抄不走就只能凭眼睛记或重新敲——在配置工具里这是最容易出错的一条路（抄错一个字符就找不到那条配置）。
 * 所以定这条规矩：凡自身被省略号或行数钳制截断的文本，必须在可复制白名单里出现。
 *
 * 口径细节（都是实测出来的坑）：
 * 1. 判定按**选择器片段**（逗号拆开、空白压平）而不是类名。
 *    `.audit-cell.value` 与 `.log-viewer .log-detail-meta .task-item-name` 各算一条；
 *    只按类名摊平会把「谁截断了」糊成一团，`.value` 这种通用类还会串到别的规则上。
 * 2. `user-select` 是可继承属性，所以覆盖有两种静态可证明的来源：
 *    片段自己被某条规则放开；或白名单里某条 selector 正好是这条片段的其中一层复合（祖先后代关系由选择器本身给出）。
 *    「我记得那个祖先类放开了」不算——改名、摘类、后面再补一条 none 都不会报错。
 * 3. 取值按**层叠里的最后一份**算，不看第一次声明。
 *    只查「出现过 user-select: text」的话，后面一行 `.x { user-select: none }` 就把它悄悄顶掉了，
 *    这正是 `.apply-item-row` 本来的写法（整行禁选，正文却在同一行里）。
 * 4. 行号槽、minimap、diff 标记列必须**继续禁选**：选中它们，复制出来会夹一整列空白。
 *    所以正反都要钉住。
 * 5. 豁免必须写理由；片段一旦不再截断或已被放开，条目就过期必须删——基线只减不增。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CSS_PATH = join(PROJECT_ROOT, "src/styles.css");

/** styles.css 里「可复制正文」那一段的定位标记，负控用它只改那一段。 */
const COPYABLE_BLOCK_MARKER = "/* ── 可复制正文（R62 / 波18）";

/** `all` 也算放开：整块正文全选的写法，不是漏禁选。 */
const TRUNCATED = /text-overflow\s*:[^;]*ellipsis|-webkit-line-clamp\s*:/;

/**
 * 不要求可复制的截断片段 → 理由。**只许减不许加。**
 * 加一条等于承认「这里截断了但没人负责抄得走」，先补进 styles.css 的白名单再回来删这行。
 */
const NOT_REQUIRED: Record<string, string> = {
  ".side-label": "侧栏导航文案：按钮里的标签不是要抄的内容，放开反而干扰点按",
  ".env-badge": "两三字的环境徽章，且同一行右侧就是完整环境列",
};

/** 整块正文都该能抄走的容器（正文在子树里，自身不一定带省略号）。 */
const MUST_BE_SELECTABLE = [
  ".apply-item-row",
  ".modal-body",
  ".settings-data-location-path",
  // 轮67 R67-WP10：这两块都不截断，所以不在上面那套「截断必须有出口」的判据里，
  // 但内容同样是要抄走的东西——确认文本要手敲进输入框，半截失败的 ref 要拿去定位那条配置。
  ".apply-confirmation-code",
  ".apply-partial-write",
];

/** 必须继续禁选的编辑器部件，理由见文件头第 4 条。 */
const MUST_STAY_UNSELECTABLE = [".code-gutter", ".code-minimap", ".udiff-gutter", ".udiff-mark", ".diff-gutter"];

interface CssRule {
  selector: string;
  body: string;
}

/** 注释里也写着选择器和属性值，算之前一律换成等长空白。 */
function blankComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

function normalize(selector: string): string {
  return selector.replace(/\s+/g, " ").trim();
}

/** `[^{}]+\{[^{}]*\}` 摊平：@media 内的规则当普通规则处理（继承关系一样成立），顶层 @media 本身没有 body 属性可漏。 */
function cssRules(css: string): CssRule[] {
  const text = blankComments(css);
  return Array.from(text.matchAll(/([^{}]+)\{([^{}]*)\}/g), (match) => ({
    selector: normalize(match[1]),
    body: match[2],
  }));
}

function selectorParts(selector: string): string[] {
  return selector.split(",").map(normalize).filter(Boolean);
}

function classSet(part: string): Set<string> {
  return new Set(Array.from(part.matchAll(/\.([A-Za-z0-9_-]+)/g), (match) => match[1]));
}

function isSubset(needle: Set<string>, haystack: Set<string>): boolean {
  return needle.size > 0 && [...needle].every((cls) => haystack.has(cls));
}

/** 一条规则 body 里的 user-select 终值（同一条里 -webkit- 与前缀版都写时，取标准属性那份）。 */
function ruleUserSelectValue(body: string): string | null {
  const standard = /(?:^|[;{\s])user-select\s*:\s*([^;}]+)/.exec(body);
  if (standard) return standard[1].trim().toLowerCase();
  const prefixed = /-webkit-user-select\s*:\s*([^;}]+)/.exec(body);
  return prefixed ? prefixed[1].trim().toLowerCase() : null;
}

/**
 * 某个选择器片段在层叠里**最后**生效的 user-select 取值；没有任何规则声明它时返回 null。
 * 只看顶层声明（不含继承），继承由 selectabilityFor 的祖先分支负责判断。
 */
function declaredValue(part: string, rules: CssRule[]): string | null {
  let value: string | null = null;
  rules.forEach((rule) => {
    if (selectorParts(rule.selector).includes(part)) {
      const next = ruleUserSelectValue(rule.body);
      if (next !== null) value = next;
    }
  });
  return value;
}

function isOpenValue(value: string | null): boolean {
  return value === "text" || value === "auto" || value === "all";
}

function truncatedParts(rules: CssRule[]): string[] {
  const acc = new Set<string>();
  rules.filter((rule) => TRUNCATED.test(rule.body)).forEach((rule) => selectorParts(rule.selector).forEach((part) => acc.add(part)));
  return [...acc].sort();
}

/** 终值仍为「放开」的选择器片段（先出现过、但后面又被改成 none 的不算）。 */
function openSelectors(rules: CssRule[]): string[] {
  const candidates = new Set<string>();
  rules.forEach((rule) => {
    if (isOpenValue(ruleUserSelectValue(rule.body))) selectorParts(rule.selector).forEach((part) => candidates.add(part));
  });
  return [...candidates].filter((part) => isOpenValue(declaredValue(part, rules))).sort();
}

/**
 * 这条截断片段能不能被复制走：返回提供放开的那条 selector（自身命中就返回自己），抄不走返回 null。
 * 自身没声明时，只认「同一条选择器里更高的一层」（`.apply-ledger strong` 靠 `.apply-ledger`），
 * 或类集合是某一层复合子集的多类写法（`.audit-cell.value` 靠 `.audit-cell`）——都是选择器本身给出的关系，不需要猜 DOM。
 */
function selectabilityFor(part: string, rules: CssRule[], opened: string[]): string | null {
  const own = declaredValue(part, rules);
  if (own !== null) return isOpenValue(own) ? part : null;
  const compounds = part.split(/[\s>+~]+/).filter(Boolean);
  return (
    opened.find(
      (candidate) => compounds.includes(candidate) || compounds.some((compound) => isSubset(classSet(candidate), classSet(compound)))
    ) ?? null
  );
}

interface Findings {
  /** 截断了却抄不走 */
  unselectable: string[];
  /** 该禁选的没禁选 */
  mustStayUnselectable: string[];
  /** 该整片放开的容器没放开 */
  mustBeSelectable: string[];
  /** 白名单/豁免里的过期条目 */
  staleExemptions: string[];
}

function analyze(css: string): Findings {
  const rules = cssRules(css);
  const opened = openSelectors(rules);
  const truncated = truncatedParts(rules);
  const findings: Findings = { unselectable: [], mustStayUnselectable: [], mustBeSelectable: [], staleExemptions: [] };

  truncated.forEach((part) => {
    const covered = selectabilityFor(part, rules, opened);
    const exemptReason = NOT_REQUIRED[part];
    if (covered && exemptReason !== undefined) {
      findings.staleExemptions.push(`${part}：已经能被复制（${covered}），豁免过期，删掉 NOT_REQUIRED 里的这条`);
      return;
    }
    if (exemptReason !== undefined) {
      if (!exemptReason.trim()) findings.staleExemptions.push(`${part}：豁免必须写理由，否则下次没人敢删`);
      return;
    }
    if (!covered) {
      const own = declaredValue(part, rules);
      findings.unselectable.push(
        own !== null
          ? `${part}：自身被显式设为 user-select: ${own}，截断了还抄不走`
          : `${part}：截断了却抄不走，去 styles.css 的「可复制正文」补一条`
      );
    }
  });

  Object.keys(NOT_REQUIRED).forEach((part) => {
    if (!truncated.includes(part)) findings.staleExemptions.push(`${part}：这条选择器已经不带截断了，豁免要一起删`);
  });

  MUST_BE_SELECTABLE.forEach((part) => {
    const value = declaredValue(part, rules);
    if (!isOpenValue(value)) findings.mustBeSelectable.push(`${part}：整块正文都该能抄，现在最后生效的是 ${value ?? "（没声明）"}`);
  });

  MUST_STAY_UNSELECTABLE.forEach((part) => {
    const value = declaredValue(part, rules);
    if (value !== "none")
      findings.mustStayUnselectable.push(`${part}：行号槽/标记列的禁选没了（现在是 ${value ?? "（没声明）"}），复制会带出一整列空白`);
  });

  return findings;
}

function complaints(findings: Findings): string[] {
  return [...findings.unselectable, ...findings.mustStayUnselectable, ...findings.mustBeSelectable, ...findings.staleExemptions];
}

/** 只改「可复制正文」那一段，其余 CSS 原样保留。 */
function mutateCopyableBlock(css: string, mutate: (block: string) => string): string {
  const at = css.indexOf(COPYABLE_BLOCK_MARKER);
  if (at < 0) throw new Error(`找不到可复制正文那一段：${COPYABLE_BLOCK_MARKER}`);
  return css.slice(0, at) + mutate(css.slice(at));
}

const CSS = readFileSync(CSS_PATH, "utf8");
const FINDINGS = analyze(CSS);

describe("截断的正文必须能复制（R62）", () => {
  it("CSS 侧确实扫到截断片段与白名单，守卫不是空跑", () => {
    const rules = cssRules(CSS);
    expect(truncatedParts(rules).length).toBeGreaterThanOrEqual(25);
    expect(truncatedParts(rules).filter((part) => !(part in NOT_REQUIRED)).length).toBeGreaterThanOrEqual(28);
  });

  it("真实代码：截断抄不走、该放开的没放开、该禁选的没禁选，一条都不许有", () => {
    expect(complaints(FINDINGS), complaints(FINDINGS).join("\n")).toEqual([]);
  });

  it("负控：新增一条没登记的截断类 → 必须报", () => {
    const fixture = `${CSS}\n.brand-new-truncated {\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n`;
    expect(analyze(fixture).unselectable.filter((item) => item.startsWith(".brand-new-truncated"))).toHaveLength(1);
  });

  it("负控：把「可复制正文」整段改成禁选 → 报出来必须成规模，不是一个", () => {
    const fixture = mutateCopyableBlock(CSS, (block) => block.replace(/user-select:\s*text;/g, "user-select: none;"));
    expect(analyze(fixture).unselectable.length).toBeGreaterThanOrEqual(20);
  });

  it("负控：删掉容器白名单里的一行 → 靠它继承的那条截断立刻飘红", () => {
    // `.apply-ledger strong` 自身不在白名单里，全靠 `.apply-ledger` 放开后继承
    const fixture = mutateCopyableBlock(CSS, (block) => block.replace(".apply-ledger,\n", ""));
    expect(fixture).not.toBe(CSS);
    expect(analyze(fixture).unselectable.some((item) => item.startsWith(".apply-ledger strong"))).toBe(true);
  });

  it("负控：后面补一条显式禁选 → 按层叠终值算，不能被前面的白名单蒙过去", () => {
    const blocked = `${CSS}\n.audit-dataid {\n  user-select: none;\n}\n`;
    expect(analyze(blocked).unselectable.some((item) => item.startsWith(".audit-dataid"))).toBe(true);

    const rowBlocked = `${CSS}\n.apply-item-row {\n  user-select: none;\n}\n`;
    expect(analyze(rowBlocked).mustBeSelectable.some((item) => item.startsWith(".apply-item-row"))).toBe(true);
  });

  it("负控：豁免条目过期（选择器不再截断，或已经被放开）→ 必须报", () => {
    const staleKey = ".env-badge";
    const noLongerTruncated = CSS.replace(/(\.env-badge\s*\{[^{}]*?)\n\s*text-overflow:\s*ellipsis;/s, "$1");
    expect(noLongerTruncated).not.toBe(CSS);
    expect(analyze(noLongerTruncated).staleExemptions.some((item) => item.startsWith(staleKey))).toBe(true);

    const alsoCovered = `${CSS}\n${staleKey} {\n  user-select: text;\n}\n`;
    expect(analyze(alsoCovered).staleExemptions.some((item) => item.startsWith(staleKey))).toBe(true);
  });

  it("负控：行号槽被放开 → 必须报（复制代码会带出一整列行号）", () => {
    const fixture = `${CSS}\n.code-gutter {\n  user-select: text;\n}\n`;
    expect(analyze(fixture).mustStayUnselectable.some((item) => item.startsWith(".code-gutter"))).toBe(true);
  });
});
