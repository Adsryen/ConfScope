/**
 * 端口输入与禁用按钮的跨文件静态守卫（R24 / R19）。
 *
 * 为什么读磁盘而不是跑渲染：端口上界、输入框类名、「禁用按钮 + title」这三件事分处 5 个文件，
 * 单文件单测各自都绿——jsdom 也不会告诉你 title 挂在 disabled 按钮上其实弹不出来。
 * 这类「多处必须同源」的约束按 tests/ux/codeEditorGeometry.test.ts 的同一口径静态守住。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC = join(PROJECT_ROOT, "src");
const CSS = readFileSync(join(SRC, "styles.css"), "utf8");
const FIELD = readFileSync(join(SRC, "components/NumberField.tsx"), "utf8");
const CONNECTIONS_FORM = readFileSync(join(SRC, "components/ConnectionManager.tsx"), "utf8");
const SSH_FORM = readFileSync(join(SRC, "components/SSHManagerView.tsx"), "utf8");

/** src 下全部生产代码（排除测试），用来查「同一个魔数是不是被抄了两份」。 */
function productionFiles(dir: string, out: string[] = []): string[] {
  readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) productionFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) out.push(full);
  });
  return out;
}

describe("端口范围只有一个出处", () => {
  it("65535 这个字面量在 src 生产代码里只允许出现在 lib/ports.ts", () => {
    const hits = productionFiles(SRC)
      .filter((file) => readFileSync(file, "utf8").includes("65535"))
      .map((file) => relative(PROJECT_ROOT, file).split(/[\\/]/).join("/"));

    expect(hits).toEqual(["src/lib/ports.ts"]);
  });

  it("两个表单的端口字段都显式传 min/max，不再各写 parseInt(...) || 默认值", () => {
    [CONNECTIONS_FORM, SSH_FORM].forEach((source) => {
      expect(source).toContain("min={PORT_MIN}");
      expect(source).toContain("max={PORT_MAX}");
      expect(source).not.toMatch(/parseInt\(e\.target\.value\)\s*\|\|/);
    });
  });

  it("默认端口 22 也走同一个常量", () => {
    expect(CONNECTIONS_FORM).toContain("SSH_DEFAULT_PORT");
    expect(SSH_FORM).toContain("SSH_DEFAULT_PORT");
    expect(readFileSync(join(SRC, "store/sshProfiles.ts"), "utf8")).toContain("SSH_DEFAULT_PORT");
  });
});

describe("数字输入框的样式钩子", () => {
  it("styles.css 定义了 NumberField 用到的类，而不是继续蹭 .search-input", () => {
    ["number-field", "field-input", "field-error", "btn-guard"].forEach((cls) => {
      expect(CSS, `styles.css 缺少 .${cls}`).toMatch(new RegExp(String.raw`\.${cls}[^\n]*\{`));
    });
    expect(FIELD).toContain('className="field-input mono"');
    expect(FIELD).not.toContain("search-input");
  });

  it("非法态有可见反馈：aria-invalid 变红 + 行内错误用主题红", () => {
    expect(CSS).toMatch(/\.field-input\[aria-invalid="true"\] \{[^}]*var\(--red\)/);
    expect(CSS).toMatch(/\.field-error \{[^}]*var\(--red-h\)/);
    expect(FIELD).toContain('role="alert"');
  });

  it("禁用按钮的 title 挂在 .btn-guard 外层，disabled 按钮自己收不到鼠标事件（R19）", () => {
    [CONNECTIONS_FORM, SSH_FORM].forEach((source) => {
      expect(source).toMatch(/<span className="btn-guard" title=\{portBlock\}>/);
    });
    expect(CONNECTIONS_FORM + SSH_FORM).toContain("disabled={!!portBlock}");
  });
});
