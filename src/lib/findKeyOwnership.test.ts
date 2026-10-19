/**
 * @vitest-environment jsdom
 *
 * 查找快捷键所有权的四支判据（轮39 R39-1/2/4/5）。
 * 这里钉的是**纯函数**：两个视图各自只递参数，所以判据的边界（readonly 输入框算不算持有光标、
 * 多视图会不会同时弹两条查找栏、焦点停在不可编辑控件上该谁接管）必须能脱离组件直接跑。
 */
import { afterEach, describe, expect, it } from "vitest";
import { FIND_KEY_OWNER_ATTR, findKeyOwners, holdsTextCaret, takesFindKeyOwnership } from "./findKeyOwnership";

afterEach(() => {
  document.body.innerHTML = "";
});

function makeView(className: string): HTMLElement {
  const el = document.createElement("div");
  el.className = className;
  el.setAttribute(FIND_KEY_OWNER_ATTR, "1");
  document.body.appendChild(el);
  return el;
}

function makeFocusable(tag: string, attrs: Record<string, string> = {}): HTMLElement {
  const el = document.createElement(tag) as HTMLElement;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

describe("判据①：事件源或焦点在本视图内 → 本视图接管", () => {
  it("事件源是视图内的正文（点进正文再按 Ctrl+F）", () => {
    const root = makeView("code-view");
    const pre = document.createElement("pre");
    root.appendChild(pre);
    expect(takesFindKeyOwnership({ target: pre, root })).toBe(true);
  });

  it("事件源在 window、但焦点落在视图内的 textarea 上（编辑态）", () => {
    const root = makeView("code-editor");
    const ta = document.createElement("textarea");
    root.appendChild(ta);
    expect(takesFindKeyOwnership({ target: null, root, activeElement: ta })).toBe(true);
  });

  it("查找输入框自己（栏开着时 F3 / Enter 要能继续导航）", () => {
    const root = makeView("code-view");
    const input = document.createElement("input");
    input.className = "code-find-input";
    root.appendChild(input);
    expect(takesFindKeyOwnership({ target: input, root, activeElement: input })).toBe(true);
  });
});

describe("判据②：焦点被文本输入控件持有 → 谁都不接管", () => {
  it.each([
    ["text", { type: "text" }],
    ["search", { type: "search" }],
    ["email", { type: "email" }],
    ["url", { type: "url" }],
    ["tel", { type: "tel" }],
    ["password", { type: "password" }],
    ["number", { type: "number" }],
    ["无 type 属性（浏览器按 text 处理）", {}],
  ])("外部 %s 输入框持有焦点时让位", (_label, attrs) => {
    const root = makeView("code-view");
    const input = makeFocusable("input", { ...(attrs as Record<string, string>), class: "search-input wide" });
    expect(takesFindKeyOwnership({ target: input, root, activeElement: input })).toBe(false);
  });

  it("外部 textarea 持有焦点时让位", () => {
    const root = makeView("code-view");
    const ta = makeFocusable("textarea");
    expect(takesFindKeyOwnership({ target: ta, root, activeElement: ta })).toBe(false);
  });

  it("contenteditable 持有焦点时让位", () => {
    const root = makeView("code-view");
    const box = makeFocusable("div", { contenteditable: "true" });
    expect(takesFindKeyOwnership({ target: box, root, activeElement: box })).toBe(false);
  });

  it("只读 / 禁用输入框落不下光标，不许拿它当挡箭牌造死键", () => {
    const root = makeView("code-view");
    const readonly = makeFocusable("input", { type: "text", readonly: "readonly" });
    const disabled = makeFocusable("textarea", { disabled: "disabled" });
    expect(takesFindKeyOwnership({ target: readonly, root, activeElement: readonly })).toBe(true);
    expect(takesFindKeyOwnership({ target: disabled, root, activeElement: disabled })).toBe(true);
    expect(holdsTextCaret(readonly)).toBe(false);
    expect(holdsTextCaret(disabled)).toBe(false);
  });

  it.each(["checkbox", "radio", "range", "button", "submit", "file", "color"])(
    "%s 类型的 input 没有光标，Ctrl+F 不该因此变死键",
    (type) => {
      const root = makeView("code-view");
      const input = makeFocusable("input", { type });
      expect(takesFindKeyOwnership({ target: input, root, activeElement: input })).toBe(true);
      expect(holdsTextCaret(input)).toBe(false);
    }
  );
});

describe("判据③：焦点落在别的代码视图里 → 让给那个视图", () => {
  it("一页多个编辑器时只许一个接管（否则同时弹两条查找栏）", () => {
    const first = makeView("code-editor");
    const second = makeView("code-editor");
    const ta = document.createElement("textarea");
    second.appendChild(ta);
    // 焦点在第二个里：第二个走判据①接管，第一个不许跟着接管
    expect(takesFindKeyOwnership({ target: null, root: second, activeElement: ta, owners: [first, second] })).toBe(true);
    expect(takesFindKeyOwnership({ target: null, root: first, activeElement: ta, owners: [first, second] })).toBe(false);
  });
});

describe("判据④：页面里没有光标 → 文档序第一个挂着的视图接管（本轮主修）", () => {
  it.each([
    ["左侧配置列表项", "browser-item active"],
    ["侧边导航项", "side-nav-item active"],
    ["自定义下拉触发器", "sel-trigger"],
    ["工具栏按钮", "btn btn-ghost btn-sm"],
  ])("焦点停在不可编辑的 %s 上时，当前视图必须接管（真机取证：此前是死键）", (_label, className) => {
    const root = makeView("code-view");
    const item = makeFocusable("div", { class: className });
    expect(takesFindKeyOwnership({ target: item, root, activeElement: item, owners: [root] })).toBe(true);
  });

  it("完全没有焦点（activeElement 是 body）时仍然接管", () => {
    const root = makeView("code-view");
    expect(takesFindKeyOwnership({ target: null, root, activeElement: document.body, owners: [root] })).toBe(true);
  });

  it("浏览态在前时，编辑态不抢页面上的 Ctrl+F（既有口径，靠文档序成立而不是猜 .code-view 存在）", () => {
    const view = makeView("code-view");
    const editor = makeView("code-editor");
    expect(takesFindKeyOwnership({ target: null, root: view, activeElement: document.body, owners: [view, editor] })).toBe(true);
    expect(takesFindKeyOwnership({ target: null, root: editor, activeElement: document.body, owners: [view, editor] })).toBe(false);
  });

  it("视图还没注册（owners 为空，首帧）时放行，别把快捷键做成死键", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    expect(takesFindKeyOwnership({ target: null, root, activeElement: document.body, owners: [] })).toBe(true);
  });
});

describe("注册表：属性与监听同生同灭，不看类名", () => {
  it("findKeyOwners 只认带属性的根，按文档序返回", () => {
    const a = makeView("code-view");
    const detached = document.createElement("div");
    detached.setAttribute(FIND_KEY_OWNER_ATTR, "1"); // 不在 document 里，不该被算进来
    const b = makeView("code-editor");
    expect(findKeyOwners(document)).toEqual([a, b]);
    expect(findKeyOwners(document).length).toBe(2);
    expect(detached).toBeTruthy();
  });

  it("被保活隐藏的视图（摘掉属性但类名还在）不再被算成会抢", () => {
    const hidden = makeView("code-view");
    const editor = makeView("code-editor");
    hidden.removeAttribute(FIND_KEY_OWNER_ATTR); // active=false：监听已摘
    const owners = findKeyOwners(document);
    expect(owners).toEqual([editor]);
    expect(takesFindKeyOwnership({ target: null, root: editor, activeElement: document.body, owners })).toBe(true);
  });

  it("scope 缺失（SSR / 无 document）时退化成空表而不是抛错", () => {
    expect(findKeyOwners(null)).toEqual([]);
  });
});
