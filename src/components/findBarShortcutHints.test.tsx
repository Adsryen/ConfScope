/**
 * @vitest-environment jsdom
 */
import { fireEvent, render } from "../test/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import CodeEditor from "./CodeEditor";
import CodeView from "./CodeView";

/**
 * 波42（R65）：查找栏实现了 Enter / Shift+Enter / F3 / Shift+F3 / Esc，
 * 但界面上一个字都没提——用户只能拿鼠标点箭头，快捷键等于没做。
 * 这里钉两态（浏览态 CodeView / 编辑态 CodeEditor）口径一致：
 * 鼠标悬停看得到键名（title），读屏听到的是纯文案（aria-label 不含键名），
 * 键名另外通过 aria-keyshortcuts 告诉辅助技术。
 */

const MULTI = 'server.port=8080\nname = "a<b&c>"\nqps: 10000\nport = 8081\n';

interface View {
  name: string;
  render: () => ReturnType<typeof render>;
  openFind: (container: HTMLElement) => void;
}

const views: View[] = [
  {
    name: "浏览态 CodeView",
    render: () =>
      render(
        <I18nProvider>
          <CodeView code={MULTI} format="Properties" />
        </I18nProvider>
      ),
    openFind: () => {
      fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    },
  },
  {
    name: "编辑态 CodeEditor",
    render: () =>
      render(
        <I18nProvider>
          <CodeEditor value={MULTI} onChange={() => {}} format="Properties" />
        </I18nProvider>
      ),
    openFind: (container) => {
      fireEvent.keyDown(container.querySelector("textarea") as HTMLTextAreaElement, { key: "f", ctrlKey: true });
    },
  },
];

function buttons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>(".code-find-btn"));
}

function openBar(view: View, locale: string) {
  localStorage.setItem("locale", locale);
  const { container } = view.render();
  const opener = container.querySelector<HTMLButtonElement>(".code-find-open") as HTMLButtonElement;
  const before = {
    title: opener.getAttribute("title") ?? "",
    keyshortcuts: opener.getAttribute("aria-keyshortcuts") ?? "",
  };
  view.openFind(container);
  return { container, before };
}

describe.each(views)("$name 的查找栏交代快捷键", (view) => {
  it("开栏按钮的 title 有 Ctrl+F，aria-keyshortcuts 把同一件事告诉辅助技术", () => {
    const { before } = openBar(view, "zh-CN");
    expect(before.title).toContain("Ctrl+F");
    expect(before.keyshortcuts).toBe("Control+F");
  });

  it("三个导航按钮的 title 含键名，aria-label 保持纯文案（读屏不该念出 Shift+Enter）", () => {
    const { container } = openBar(view, "zh-CN");
    const [prev, next, close] = buttons(container);
    expect(prev).toBeTruthy();

    expect(prev.title).toMatch(/Shift\+Enter/);
    expect(prev.title).toMatch(/F3/);
    expect(next.title).toMatch(/Enter/);
    expect(next.title).toMatch(/F3/);
    expect(close.title).toMatch(/Esc/);

    for (const btn of [prev, next, close]) {
      const label = btn.getAttribute("aria-label") ?? "";
      expect(label).toBeTruthy();
      expect(label).not.toMatch(/Enter|Esc|F3|\+/);
      expect(btn.getAttribute("aria-keyshortcuts")).toBeTruthy();
    }
    expect(prev.getAttribute("aria-keyshortcuts")).toBe("Shift+Enter");
    expect(next.getAttribute("aria-keyshortcuts")).toBe("Enter");
    expect(close.getAttribute("aria-keyshortcuts")).toBe("Escape");
  });

  it("还没输入时，栏内直接写着 Enter / Esc 怎么用（不用悬停也能看见）", () => {
    const { container } = openBar(view, "zh-CN");
    const count = container.querySelector(".code-find-count") as HTMLElement;
    expect(count.textContent).toContain("Enter");
    expect(count.textContent).toContain("Esc");
  });

  it("输入有命中后让位给计数，提示不长期占着栏目", () => {
    const { container } = openBar(view, "zh-CN");
    const input = container.querySelector(".code-find-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "port" } });
    const count = container.querySelector(".code-find-count") as HTMLElement;
    expect(count.textContent).toMatch(/\d+\/\d+/);
    expect(count.textContent).not.toContain("Enter");
  });

  it("英文界面同样带键名，不会只在中文里提示", () => {
    const { container } = openBar(view, "en-US");
    const [prev, next, close] = buttons(container);
    expect(prev.title).toMatch(/Shift\+Enter/);
    expect(next.title).toMatch(/F3/);
    expect(close.title).toMatch(/Esc/);
    const count = container.querySelector(".code-find-count") as HTMLElement;
    expect(count.textContent).toContain("Enter");
    expect(count.textContent).toContain("Esc");
    const label = prev.getAttribute("aria-label") ?? "";
    expect(label).not.toMatch(/Enter|Shift|F3|\+/);
  });
});
