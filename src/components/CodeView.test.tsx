/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "../test/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import CodeView from "./CodeView";
import type { Format } from "../lib/format";

function renderView(
  code: string,
  format: Format = "TEXT",
  props: { searchTerm?: string; showMinimap?: boolean; enableFind?: boolean; active?: boolean } = {}
) {
  localStorage.setItem("locale", "zh-CN");
  return render(
    <I18nProvider>
      <CodeView code={code} format={format} {...props} />
    </I18nProvider>
  );
}

const MULTI = 'server.port=8080\nname = "a<b&c>"\nqps: 10000\nport = 8081\n';

describe("CodeView 行号 / 命中 / 标红", () => {
  afterEach(() => {
    // jsdom 无真实布局：确保用例互不干扰
  });

  it("渲染行号，且行号绝不混入 .code-area 的文本", () => {
    const { container } = renderView(MULTI, "Properties");
    const gutter = container.querySelector(".code-gutter");
    const numbers = gutter ? [...gutter.querySelectorAll(".code-ln")].map((n) => n.textContent) : [];
    expect(numbers[0]).toBe("1");
    expect(numbers).toContain("4");

    const area = container.querySelector(".code-area") as HTMLElement;
    expect(area.textContent).toBe(MULTI); // 行号 / 命中底色都在 .code-area 之外
  });

  it("内容搜索：命中词标红、命中行高亮、文本内容逐字不变", () => {
    const { container } = renderView(MULTI, "Properties", { searchTerm: "8080" });
    const marks = container.querySelectorAll(".code-area mark.search-hit");
    expect(marks.length).toBeGreaterThan(0);
    const hitLines = container.querySelectorAll(".code-lines .code-line.is-hit");
    expect(hitLines.length).toBeGreaterThan(0);
    const area = container.querySelector(".code-area") as HTMLElement;
    expect(area.textContent).toBe(MULTI);
    expect(container.innerHTML).not.toContain("&amp;amp;");
  });

  it("跨语法 token 的搜索词也能标红（properties 里被拆分的 key=value）", () => {
    const { container } = renderView(MULTI, "Properties", { searchTerm: "port=8080" });
    // 命中跨越 hljs 拆分的 token：整文档匹配仍完整，只是被切成相邻的多个 <mark>，
    // 拼接其文本应还原出完整搜索词（旧实现里这类跨 token 命中会被整体漏掉）。
    const marks = [...container.querySelectorAll(".code-area mark.search-hit")];
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.map((m) => m.textContent).join("")).toBe("port=8080");
  });

  it("无搜索词时不产生命中结构", () => {
    const { container } = renderView(MULTI, "Properties");
    expect(container.querySelector(".code-area mark.search-hit")).toBeNull();
    expect(container.querySelector(".code-lines .code-line.is-hit")).toBeNull();
  });
});

describe("CodeView 缩略图", () => {
  it("默认渲染缩略图与 canvas；showMinimap=false 时隐藏", () => {
    const { container } = renderView(MULTI);
    expect(container.querySelector(".code-minimap")).not.toBeNull();
    expect(container.querySelector(".code-minimap canvas")).not.toBeNull();

    const { container: c2 } = renderView(MULTI, "TEXT", { showMinimap: false });
    expect(c2.querySelector(".code-minimap")).toBeNull();
  });

  it("有可见布局尺寸后显示视口框", async () => {
    const { container } = renderView(MULTI);
    const pre = container.querySelector(".code-area") as HTMLElement;
    Object.defineProperty(pre, "clientHeight", { configurable: true, get: () => 100 });
    Object.defineProperty(pre, "scrollHeight", { configurable: true, get: () => 400 });
    fireEvent.scroll(pre);
    await waitFor(() => {
      const vp = container.querySelector(".code-minimap-viewport") as HTMLElement;
      expect(vp).not.toBeNull();
      expect(vp.style.height).toBe("25%");
    });
  });

  it("空文件不渲染缩略图", () => {
    const { container } = renderView("");
    expect(container.querySelector(".code-minimap")).toBeNull();
  });
});

describe("CodeView Ctrl+F 查找", () => {
  it("Ctrl+F 打开查找栏并聚焦输入框", async () => {
    const { container } = renderView(MULTI);
    expect(container.querySelector(".code-find-input")).toBeNull();
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    await waitFor(() => {
      expect(container.querySelector(".code-find-input")).not.toBeNull();
    });
  });

  it("输入关键词后统计命中并可跳到当前命中", async () => {
    const { container } = renderView(MULTI, "Properties", { searchTerm: "8080" });
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = container.querySelector(".code-find-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "port" } });
    const count = container.querySelector(".code-find-count") as HTMLElement;
    expect(count.textContent).toContain("/2"); // server.port / port = 8081 两行各含一次 port

    // 当前命中被特殊标记
    expect(container.querySelector(".code-area mark.search-hit-current")).not.toBeNull();

    fireEvent.keyDown(input, { key: "Enter" }); // 下一处
    expect(container.querySelector(".code-area mark.search-hit-current")).not.toBeNull();

    // 命中行高亮里应有“当前”行
    expect(container.querySelector(".code-lines .code-line.is-current")).not.toBeNull();
  });

  it("Esc 关闭查找栏", async () => {
    const { container } = renderView(MULTI);
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = container.querySelector(".code-find-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => {
      expect(container.querySelector(".code-find-input")).toBeNull();
    });
  });

  it("焦点在其它输入框时 Ctrl+F 不被代码视图劫持", () => {
    localStorage.setItem("locale", "zh-CN");
    const { container } = render(
      <I18nProvider>
        <input data-testid="external" />
        <CodeView code={MULTI} format="TEXT" />
      </I18nProvider>
    );
    const external = screen.getByTestId("external") as HTMLInputElement;
    external.focus(); // 真正移动 activeElement（fireEvent.focus 不会）
    fireEvent.keyDown(external, { key: "f", ctrlKey: true });
    expect(container.querySelector(".code-find-input")).toBeNull();
  });

  it("active=false（宿主页面被保活隐藏）时不劫持全局 Ctrl+F", () => {
    const { container } = renderView(MULTI, "TEXT", { active: false });
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(container.querySelector(".code-find-input")).toBeNull();
  });

  it("enableFind=false 时无查找入口且不响应 Ctrl+F", () => {
    const { container } = renderView(MULTI, "TEXT", { enableFind: false });
    expect(container.querySelector(".code-find-open")).toBeNull();
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(container.querySelector(".code-find-input")).toBeNull();
  });
});

describe("CodeView 换内容滚动重置（R9）", () => {
  /** jsdom 没有真实布局，scrollTop/scrollLeft 恒为 0；挂可读写的实现才能断言"被重置"。 */
  function stubScrollOffsets(pre: HTMLElement) {
    const offsets = { top: 0, left: 0 };
    Object.defineProperty(pre, "scrollTop", {
      configurable: true,
      get: () => offsets.top,
      set: (value: number) => {
        offsets.top = value;
      },
    });
    Object.defineProperty(pre, "scrollLeft", {
      configurable: true,
      get: () => offsets.left,
      set: (value: number) => {
        offsets.left = value;
      },
    });
    return offsets;
  }

  function renderKeyed(code: string, contentKey?: string) {
    localStorage.setItem("locale", "zh-CN");
    return render(
      <I18nProvider>
        <CodeView code={code} format="TEXT" contentKey={contentKey} />
      </I18nProvider>
    );
  }

  it("正文变化时把纵向与横向偏移归零", () => {
    const { container, rerender } = renderKeyed(MULTI);
    const offsets = stubScrollOffsets(container.querySelector(".code-area") as HTMLElement);
    offsets.top = 120;
    offsets.left = 40;

    rerender(
      <I18nProvider>
        <CodeView code="other=1\n" format="TEXT" />
      </I18nProvider>
    );

    expect(offsets.top).toBe(0);
    expect(offsets.left).toBe(0);
  });

  it("正文逐字相同但版本不同（contentKey 变）同样归零", () => {
    const { container, rerender } = renderKeyed(MULTI, "public::DEFAULT_GROUP::app.json::v1");
    const offsets = stubScrollOffsets(container.querySelector(".code-area") as HTMLElement);
    offsets.top = 120;

    rerender(
      <I18nProvider>
        <CodeView code={MULTI} format="TEXT" contentKey="public::DEFAULT_GROUP::app.json::v2" />
      </I18nProvider>
    );

    expect(offsets.top).toBe(0);
  });

  it("同一内容重复渲染（如搜索词变化）不误触滚动重置", () => {
    const { container, rerender } = renderKeyed(MULTI, "k1");
    const offsets = stubScrollOffsets(container.querySelector(".code-area") as HTMLElement);
    offsets.top = 120;

    rerender(
      <I18nProvider>
        <CodeView code={MULTI} format="TEXT" contentKey="k1" searchTerm="8080" />
      </I18nProvider>
    );

    expect(offsets.top).toBe(120);
  });
});

describe("CodeView 输入法组合态（R11）", () => {
  it("查找栏的组合态 Enter 不跳命中、Esc 不关栏，上屏后的回车照常跳转", async () => {
    const { container } = renderView(MULTI, "Properties", { searchTerm: "port" });
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = container.querySelector(".code-find-input") as HTMLInputElement;
    const currentBefore = container.querySelector(".code-area mark.search-hit-current");
    expect(currentBefore).not.toBeNull();

    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(container.querySelector(".code-area mark.search-hit-current")).toBe(currentBefore);

    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    expect(container.querySelector(".code-find-input")).not.toBeNull();

    // 负控：非组合态回车仍然跳到下一个命中
    fireEvent.keyDown(input, { key: "Enter" });
    expect(container.querySelector(".code-area mark.search-hit-current")).not.toBe(currentBefore);
  });

  it("组合态期间 Ctrl+F 不被代码视图接管", () => {
    const { container } = renderView(MULTI);

    fireEvent.keyDown(window, { key: "f", ctrlKey: true, isComposing: true });

    expect(container.querySelector(".code-find-input")).toBeNull();
  });
});

describe("CodeView 键盘可达（R39）", () => {
  it("正文能 Tab 停住，读屏念得出区域名", () => {
    const { container } = renderView(MULTI, "Properties");

    const region = screen.getByRole("region", { name: "内容" });
    expect(region).toBe(container.querySelector(".code-area"));
    expect(region).toHaveAttribute("tabindex", "0");
    // 焦点真能落上：落上之后方向键 / PageDown 就能滚正文
    region.focus();
    expect(document.activeElement).toBe(region);
  });
});
