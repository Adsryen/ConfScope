/**
 * 符号按钮的可读名守卫（R26）。
 *
 * 只写「× / x / ↑ / <」的按钮，读屏念出来是「乘号」「小于号」，用户不知道按下去会发生什么；
 * 而这类退化只要有人复制粘贴一行就会重新出现，单测里用 getByText("×") 反而还把它当正确写法。
 * 所以这里静态扫一遍 src 的生产代码：文本只有符号的 <button> 必须带 aria-label 或 title。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC = join(PROJECT_ROOT, "src");

/** 按钮里可能出现的纯符号文本。`-` 放在末尾，避免它被当成区间起点把数字字母全吞进来。 */
const SYMBOL_ONLY = />(\s*[×✕✖⨯xX<>+−…↑↓⌄-]{1,3}\s*)<\/button>/;

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
    const source = readFileSync(file, "utf8");
    const pattern = new RegExp(SYMBOL_ONLY.source, "g");
    let match = pattern.exec(source);
    while (match) {
      const tagStart = source.lastIndexOf("<button", match.index);
      // 找不到起点说明前面有跨节点的怪写法，交给 TS 报错；这里只守能定位到的
      if (tagStart !== -1) {
        const tag = source.slice(tagStart, match.index + 1);
        if (!/aria-label|title|aria-labelledby/.test(tag)) {
          offenders.push({
            file: relative(PROJECT_ROOT, file).split(/[\\/]/).join("/"),
            line: source.slice(0, match.index).split("\n").length,
            text: match[1].trim(),
          });
        }
      }
      match = pattern.exec(source);
    }
  });
  return offenders;
}

describe("符号按钮必须有可读名", () => {
  it("src 生产代码里不存在只写符号又没有任何可访问名称的按钮", () => {
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
