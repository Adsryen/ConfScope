/**
 * 浮层的层叠阶梯守卫（轮6 R49）。
 *
 * 真 bug：`.message-panel` 的 z-index 写成 390，比弹框遮罩（100）高——确认框打开时，
 * 消息面板仍浮在暗幕上面、还能点，用户会在「等待确认」的状态下改动别处的状态。
 * 层级这种东西改一个数值就飘，靠肉眼对 CSS 不现实，所以把阶梯钉死：
 * 菜单 60 < 消息面板 90 < 弹框遮罩 100 < 启动遮罩 120 < 报错弹框 420 < 轻提示 460 < 帮助气泡 9999。
 * 另外还要确认消息面板到根层叠上下文之间没有「层叠上下文墙」，否则数字对得上也没用。
 *
 * 顺带钉住 R55：Select / Combobox 的候选弹层 portal 到 body，在弹框里能不能用，
 * 取决于组件内联的 `zIndex: 10000`（CSS 类里那个 60 只是内联生效前的兜底）。
 * 这个数值一旦被人删掉，「新建配置」里的下拉会沉到暗幕底下，表现为「点了没反应」，
 * 而 CSS 那边看起来一切正常——所以它必须有自己的断言。
 */
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT } from "./scanUtils";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSS_RAW = readFileSync(join(PROJECT_ROOT, "src/styles.css"), "utf8");
/** 注释里也写着 `.modal-overlay` 之类的说明，扫之前换成等长空白，行号不飘。 */
const CSS = CSS_RAW.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));

/** selector（去掉空白与换行后的精确串）→ 该规则块里的声明。 */
const rules: { selector: string; body: string; line: number }[] = [];
for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const selector = m[1]
    .slice(m[1].lastIndexOf("}") + 1)
    .replace(/\s+/g, " ")
    .trim();
  if (!selector || selector.startsWith("@")) continue;
  rules.push({ selector, body: m[2], line: CSS_RAW.slice(0, m.index).split("\n").length });
}

/** 某个选择器自己的声明块（不存在则报错，避免守卫空转）。 */
function declarations(selector: string): string {
  const hit = rules.find((rule) =>
    rule.selector
      .split(",")
      .map((part) => part.trim())
      .includes(selector)
  );
  expect(hit, `styles.css 里找不到 ${selector} 的规则块`).toBeTruthy();
  return hit!.body;
}

function zIndexOf(selector: string): number {
  const found = /(?:^|[;\s])z-index:\s*(-?\d+)/.exec(declarations(selector));
  expect(found, `${selector} 没有数值 z-index`).toBeTruthy();
  return Number.parseInt(found![1], 10);
}

/** portal 到 body 的下拉菜单：类名 + 提供内联 zIndex 的组件文件。 */
const PORTAL_MENU_CLASS = [".sel-menu", ".combo-menu"];
const PORTAL_MENU_FILES = [
  { file: "src/components/Select.tsx", className: "sel-menu" },
  { file: "src/components/Combobox.tsx", className: "combo-menu" },
];

const FIXED_LAYERS: { selector: string; fixedBy: string }[] = [
  { selector: ".message-panel", fixedBy: ".message-panel" },
  { selector: ".modal-overlay", fixedBy: ".modal-overlay" },
  { selector: ".startup-overlay", fixedBy: ".startup-overlay" },
  // 报错弹框是 .modal-overlay 的变体：定位来自基础类，自己只写 z-index。
  // 波53 把它写成 .modal-overlay.error-overlay（复合形式），z-index 才不靠文档顺序赢过基础类的 100。
  { selector: ".modal-overlay.error-overlay", fixedBy: ".modal-overlay" },
  { selector: ".toaster", fixedBy: ".toaster" },
  { selector: ".help-popover", fixedBy: ".help-popover" },
];

/** 允许浮在弹框遮罩之上的层：都是「必须比弹框更醒目」或「弹框自己的变体」。 */
const ABOVE_MODAL_ALLOWLIST = [".modal-overlay", ".startup-overlay", ".modal-overlay.error-overlay", ".toaster", ".help-popover"];

describe("浮层层叠阶梯", () => {
  it("每一层都是 fixed 定位（有 position 才有 z-index 可谈）", () => {
    FIXED_LAYERS.forEach(({ fixedBy }) => {
      expect(declarations(fixedBy), `${fixedBy} 不再是 position: fixed`).toMatch(/position:\s*fixed/);
    });
  });

  it("阶梯单调递增：消息面板 < 弹框 < 启动遮罩 < 报错弹框 < 轻提示 < 帮助气泡", () => {
    const order = [".message-panel", ".modal-overlay", ".startup-overlay", ".modal-overlay.error-overlay", ".toaster", ".help-popover"];
    const values = order.map((selector) => ({ selector, z: zIndexOf(selector) }));
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i].z, `${values[i].selector}(${values[i].z}) 必须高于 ${values[i - 1].selector}(${values[i - 1].z})`).toBeGreaterThan(
        values[i - 1].z
      );
    }
  });

  it("弹框遮罩必须盖住消息面板（R49：以前这里是 390 > 100，确认框打开时面板还能点）", () => {
    expect(zIndexOf(".modal-overlay")).toBeGreaterThan(zIndexOf(".message-panel"));
  });

  it("除白名单外，不许有新的 fixed 层压在弹框之上", () => {
    const aboveModal = zIndexOf(".modal-overlay");
    const offenders = rules
      .filter((rule) => /position:\s*fixed/.test(rule.body))
      .flatMap((rule) => {
        const z = /(?:^|[;\s])z-index:\s*(-?\d+)/.exec(rule.body);
        if (!z || Number.parseInt(z[1], 10) <= aboveModal) return [];
        return rule.selector
          .split(",")
          .map((part) => part.trim())
          .filter((part) => !ABOVE_MODAL_ALLOWLIST.includes(part))
          .map((part) => `${part} z=${z[1]} @ styles.css:${rule.line}`);
      });
    expect(offenders).toEqual([]);
  });

  it("消息面板到根之间没有层叠上下文墙，数字比较才有效", () => {
    // 这些祖先一旦带上 z-index / transform / filter / will-change / contain / opacity<1，
    // 面板就被关进自己的层叠上下文，z-index 90 也照样压在弹框之上（真机上会复发 R49）
    const ancestors = [".app-shell", ".app-main", ".sidebar", ".sidebar-bottom"];
    const blockers = ancestors.flatMap((selector) => {
      const body = declarations(selector);
      return [
        /(?:^|[;\s])z-index:\s*(-?\d+)/.test(body) ? `${selector} 设了数值 z-index` : "",
        /(?:^|[;\s])(transform|filter|will-change|contain):/.test(body) ? `${selector} 设了会造层的属性` : "",
        /(?:^|[;\s])opacity:\s*(?!1\b|1;)[\d.]+/.test(body) ? `${selector} 设了 opacity<1` : "",
      ].filter(Boolean);
    });
    expect(blockers).toEqual([]);
  });

  // 下拉菜单（Select / Combobox）portal 到 document.body，和弹框在同一个根层叠上下文里比大小。
  // 类里的 z-index 只是「内联样式生效前那一帧」的兜底，真正决定弹框里能不能用的是组件内联的 zIndex，
  // 两者分开钉（R55）：以前没有任何测试看住那个 10000，删掉它就变成「在弹框里点下拉没反应」。
  it("portal 菜单的内联层级必须高于所有弹框层（否则弹框里点不开下拉）", () => {
    const topLayer = Math.max(...FIXED_LAYERS.map(({ selector }) => zIndexOf(selector)));
    PORTAL_MENU_FILES.forEach(({ file, className }) => {
      const source = readFileSync(join(PROJECT_ROOT, file), "utf8");
      const inline = /zIndex:\s*(\d+)/.exec(source);
      expect(inline, `${file} 的 portal 菜单没有内联 zIndex，会被弹框遮罩盖住`).toBeTruthy();
      const value = Number.parseInt(inline![1], 10);
      expect(value, `${file} 内联 zIndex(${value}) 必须高于最高弹框层（${topLayer}）`).toBeGreaterThan(topLayer);
      // 内联样式确实挂在这个 portal 上，而不是留在某个死代码里
      expect(source, `${file} 的菜单类名与内联样式已脱钩`).toContain(`className="${className} ${className}-portal"`);
      expect(source, `${file} 的菜单没有走 portal，内联 fixed 定位无从生效`).toContain("createPortal(");
    });
  });

  it("菜单类里的兜底 z-index 保持低位（内联一旦失效也不许浮到弹框之上盖住关闭按钮）", () => {
    PORTAL_MENU_CLASS.forEach((selector) => {
      expect(zIndexOf(selector)).toBeLessThan(zIndexOf(".modal-overlay"));
    });
  });
});
