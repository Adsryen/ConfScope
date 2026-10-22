/**
 * 符号按钮的可读名守卫（R26 建立，R29 收紧）。
 *
 * 只写「× / x / ↑ / ‹」的按钮，读屏念出来是「乘号」「小于号」，用户不知道按下去会发生什么；
 * 而这类退化只要有人复制粘贴一行就会重新出现，单测里用 getByText("×") 反而还把它当正确写法。
 * 所以这里静态扫一遍 src 的生产代码：文本只有符号的 <button> 必须带可访问名。
 *
 * R29 修掉上一版的两个漏洞：
 * 1. 只认 title 不算达标。按 W3C 的 accname 算法，<button> 有文本内容时，可访问名取自文本，
 *    title 只会在名字为空时兜底——也就是说读屏念的是「乘号」，不是 title 里的「关闭」。
 *    上一版把 title 当合格，等于放过了全站 14 处。
 * 2. 字符集缺 ‹ ›，Pager 的分页箭头从来没被扫到过。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC = join(PROJECT_ROOT, "src");

/**
 * 按钮里可能出现的纯符号文本。`-` 放在末尾，避免它被当成区间起点把数字字母全吞进来。
 * `‹ › « »` 是分页/滚动条里常见的箭头，R29 补进来；`⌃ ⌄` 是折叠箭头，提前防一手。
 */
// `⟳ ↻` 是刷新按钮的写法（轮66 WP-4）：这两颗在移除 disabled 上的 title 之前，
// 可访问名只有 title 兜底过一眼，实际 accname 取的是内容「⟳」——读屏念不出意义。
const SYMBOL_CHARS = "×✕✖⨯xX<>+−…↑↓⌄‹›«»⌃⟳↻-";
/**
 * `>` 与 `</button>` 之间只有符号。两侧用 `\s*` 而不是只吃空格，是因为属性一多 JSX 就折行：
 * 「>\n  ×\n</button>」才是站点的常态写法，只守单行等于没守。
 */
const SYMBOL_ONLY = new RegExp(`>(\\s*[${SYMBOL_CHARS}]{1,3}\\s*)</button>`);

interface SymbolButton {
  /** 按钮里那段符号文本 */
  text: string;
  /** 起始标签上是否带 aria-label / aria-labelledby */
  hasAccessibleName: boolean;
  /** 起始标签上是否带 title（只用来确认悬停提示还在，不代表可访问名合格） */
  hasTitle: boolean;
  line: number;
}

/** 从源码里找出所有「文本只有符号」的按钮。守卫本身的可测单元，fixture 也走它。 */
function findSymbolButtons(source: string): SymbolButton[] {
  const pattern = new RegExp(SYMBOL_ONLY.source, "g");
  const found: SymbolButton[] = [];
  let match = pattern.exec(source);
  while (match) {
    const tagStart = source.lastIndexOf("<button", match.index);
    // 找不到起点说明前面有跨节点的怪写法，交给 TS 报错；这里只守能定位到的
    if (tagStart !== -1) {
      const tag = source.slice(tagStart, match.index + 1);
      found.push({
        text: match[1].trim(),
        hasAccessibleName: /aria-label\s*=|aria-labelledby\s*=/.test(tag),
        hasTitle: /\btitle\s*=/.test(tag),
        line: source.slice(0, match.index).split("\n").length,
      });
    }
    match = pattern.exec(source);
  }
  return found;
}

function productionComponents(dir: string, out: string[] = []): string[] {
  readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) productionComponents(full, out);
    else if (/\.tsx$/.test(entry.name) && !/\.(test|spec)\.tsx$/.test(entry.name)) out.push(full);
  });
  return out;
}

interface Offender {
  file: string;
  line: number;
  text: string;
}

function symbolButtonsWithoutAccessibleName(): Offender[] {
  const offenders: Offender[] = [];
  productionComponents(SRC).forEach((file) => {
    findSymbolButtons(readFileSync(file, "utf8"))
      .filter((button) => !button.hasAccessibleName)
      .forEach((button) =>
        offenders.push({
          file: relative(PROJECT_ROOT, file).split(/[\\/]/).join("/"),
          line: button.line,
          text: button.text,
        })
      );
  });
  return offenders;
}

describe("符号按钮必须有可读名", () => {
  it("src 生产代码里不存在只写符号又没有 aria-label 的按钮", () => {
    expect(symbolButtonsWithoutAccessibleName()).toEqual([]);
  });

  it("审计页规则行的删除按钮带可读名（同时保留 × 文本，别把既有断言弄丢）", () => {
    const audit = readFileSync(join(SRC, "components/AuditView.tsx"), "utf8");
    // 两处规则列表（忽略规则 / 名称归一化）都要有，只补一处不算过
    expect((audit.match(/aria-label=\{t\("audit\.removeRule"\)\}/g) ?? []).length).toBe(2);
    expect((audit.match(/title=\{t\("audit\.removeRule"\)\}/g) ?? []).length).toBe(2);
    expect((audit.match(/×/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("侧栏折叠按钮不只是「< / >」，还报出展开状态", () => {
    const app = readFileSync(join(SRC, "App.tsx"), "utf8");
    // 按源码顺序取按钮块，别用「到第一个 > 为止」：属性里也可能出现 => 箭头，一格式化就误判
    const at = app.indexOf('className="sidebar-toggle"');
    expect(at, "找不到 sidebar-toggle 按钮").toBeGreaterThan(-1);
    const toggle = app.slice(at, app.indexOf("</button>", at));
    expect(toggle).toContain("aria-label=");
    expect(toggle).toContain("aria-expanded={!sidebarCollapsed}");
  });

  it("SSH 配置项的删除按钮用的是 common.delete，不是裸 x", () => {
    const ssh = readFileSync(join(SRC, "components/SSHManagerView.tsx"), "utf8");
    expect(ssh).toMatch(/className="conn-item-del"[\s\S]{0,200}aria-label=\{t\("common\.delete"\)\}/);
  });
});

describe("守卫自身不会漏掉 R29 那两类写法", () => {
  it("刷新按钮 ⟳ 在扫描范围内（轮66 WP-4：title 挪到外层后它只剩符号名）", () => {
    const buttons = findSymbolButtons(`<button className="btn btn-ghost btn-sm" onClick={doMatch} disabled={loading}>\n  ⟳\n</button>`);
    expect(buttons.map((button) => button.text)).toEqual(["⟳"]);
    expect(buttons[0].hasAccessibleName).toBe(false);

    const labelled = findSymbolButtons(`<button className="btn btn-ghost btn-sm" aria-label="重新匹配" disabled>⟳</button>`);
    expect(labelled[0].hasAccessibleName).toBe(true);
  });

  it("分页箭头 ‹ › 在扫描范围内，且 title-only 判不合格", () => {
    const source = `
      <div>
        <button
          className="btn btn-ghost btn-sm"
          title="上一页"
        >
          ‹
        </button>
        <button className="btn btn-ghost btn-sm" title="下一页" aria-label="下一页">›</button>
      </div>`;
    const buttons = findSymbolButtons(source);
    expect(buttons.map((button) => button.text)).toEqual(["‹", "›"]);
    // 上一版：字符集缺 ‹ ›，这两处压根扫不到；再退一步就算扫到也只认 title，全都会被放过
    expect(buttons.filter((button) => !button.hasAccessibleName).map((button) => button.text)).toEqual(["‹"]);
  });

  it("只有 title 不算可访问名，aria-label 才算", () => {
    const titleOnly = findSymbolButtons(`<button className="modal-x" onClick={close} title="关闭">×</button>`);
    expect(titleOnly).toHaveLength(1);
    expect(titleOnly[0].hasTitle).toBe(true);
    expect(titleOnly[0].hasAccessibleName).toBe(false);

    const withAria = findSymbolButtons(`<button className="modal-x" onClick={close} title="关闭" aria-label="关闭">×</button>`);
    expect(withAria[0].hasAccessibleName).toBe(true);
  });

  it("aria-labelledby 也算达标", () => {
    const buttons = findSymbolButtons(`<button aria-labelledby="tpl-close">×</button>`);
    expect(buttons).toHaveLength(1);
    expect(buttons[0].hasAccessibleName).toBe(true);
  });
});
