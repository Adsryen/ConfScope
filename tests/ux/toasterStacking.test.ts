/**
 * 轻提示的层叠与交互守卫（R25）。
 *
 * 为什么要静态读 CSS：toast 的可见性取决于三件分处不同文件的事——
 * `.toaster` 的 z-index 必须高于报错弹框、`.toast` 必须自己接管 pointer-events（容器是 none）、
 * 以及 error 的时长要够读完。jsdom 没有布局引擎也不做命中测试，组件单测全绿也可能真机被压在弹框底下。
 * 与 tests/ux/codeEditorGeometry.test.ts 同一口径：跨文件的数值约束只守一次。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CSS = readFileSync(join(PROJECT_ROOT, "src/styles.css"), "utf8");
const TOASTER = readFileSync(join(PROJECT_ROOT, "src/components/Toaster.tsx"), "utf8");
const STORE = readFileSync(join(PROJECT_ROOT, "src/lib/toast.ts"), "utf8");

/** 取某个选择器规则块里 `property: value;` 的声明值。 */
function cssDecl(selector: string, property: string): string {
  const block = new RegExp(`${selector.replace(/\./g, String.raw`\.`)} \\{([^}]*)\\}`, "m").exec(CSS);
  expect(block, `styles.css 里找不到 ${selector} 规则块`).not.toBeNull();
  const decl = new RegExp(`${property}: ([^;]+);`).exec(block![1]);
  expect(decl, `${selector} 里缺少 ${property}`).not.toBeNull();
  return decl![1].trim();
}

function cssNumber(selector: string, property: string): number {
  return Number.parseInt(cssDecl(selector, property), 10);
}

describe("轻提示的层叠顺序", () => {
  it(".toaster 压在报错弹框之上，否则报错时看不见「已复制 / 已保存」", () => {
    expect(cssNumber(".toaster", "z-index")).toBeGreaterThan(cssNumber(".error-overlay", "z-index"));
    expect(cssNumber(".toaster", "z-index")).toBeGreaterThan(cssNumber(".message-panel", "z-index"));
    // 也要留在帮助气泡之下：气泡是就地解释，不该被飘过的提示盖住
    expect(cssNumber(".toaster", "z-index")).toBeLessThan(cssNumber(".help-popover", "z-index"));
  });

  it("容器不吃事件、条目自己吃：悬停暂停与关闭按钮依赖这条", () => {
    expect(cssDecl(".toaster", "pointer-events")).toBe("none");
    expect(cssDecl(".toast", "pointer-events")).toBe("auto");
  });

  it("Toaster 用到的类都在 styles.css 里定义了", () => {
    ["toast-text", "toast-count", "toast-close"].forEach((cls) => {
      expect(TOASTER, `Toaster.tsx 没再用 .${cls}`).toContain(`"${cls}"`);
      expect(CSS, `styles.css 缺少 .${cls}`).toMatch(new RegExp(String.raw`\.${cls}[^\n]*\{`));
    });
    // 类型变体是拼出来的（toast-${item.type}），组件源码里搜不到字面量，只能要求 CSS 三个都在
    expect(TOASTER).toContain("`toast toast-${item.type}`");
    ["toast-success", "toast-error", "toast-info"].forEach((cls) => {
      expect(CSS, `styles.css 缺少 .${cls}`).toMatch(new RegExp(String.raw`\.${cls}[^\n]*\{`));
    });
  });
});

describe("轻提示的时长与可读性", () => {
  it("error 至少停 6 秒，且明显长于 success/info", () => {
    const duration = /TOAST_DURATION[^=]*= \{([^}]*)\}/m.exec(STORE);
    expect(duration, "找不到 TOAST_DURATION").not.toBeNull();
    const value = (key: string) => Number.parseInt(new RegExp(`${key}: (\\d+)`).exec(duration![1])![1], 10);
    expect(value("error")).toBeGreaterThanOrEqual(6000);
    expect(value("error")).toBeGreaterThan(value("success"));
  });

  it("文本与关闭按钮分开，暂停/关闭/播报的钩子都在", () => {
    expect(TOASTER).toContain('aria-live="polite"');
    expect(TOASTER).toContain('className="toast-text"');
    expect(TOASTER).toMatch(/role=\{item\.type === "error" \? "alert" : "status"\}/);
    expect(TOASTER).toContain("onMouseEnter={() => hold(item.id)}");
    expect(TOASTER).toContain("onMouseLeave={() => release(item.id)}");
    // 有 focus/blur 才谈得上「键盘用户也能暂停」：React 的 onFocus/onBlur 走 focusin/focusout 冒泡
    expect(TOASTER).toContain("onFocus={() => hold(item.id)}");
    expect(TOASTER).toContain("onBlur={() => release(item.id)}");
  });
});
