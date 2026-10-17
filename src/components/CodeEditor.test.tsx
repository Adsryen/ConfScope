/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "../test/react";
import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import CodeEditor, { type CodeEditorHandle } from "./CodeEditor";
import CodeView from "./CodeView";
import { normalizeLineEndings } from "../lib/codeLines";

const INITIAL = "server.port=8080";

function Harness() {
  const [value, setValue] = useState(INITIAL);
  return <CodeEditor value={value} onChange={setValue} format="Properties" />;
}

function textarea(container: HTMLElement) {
  return container.querySelector("textarea") as HTMLTextAreaElement;
}

/** CodeEditor 现在用了 t()（查找栏文案），必须包在 I18nProvider 里。 */
function renderEditor(ui: React.ReactElement) {
  localStorage.setItem("locale", "zh-CN");
  return render(<I18nProvider>{ui}</I18nProvider>);
}
describe("CodeEditor Tab 与输入法组合态（R23）", () => {
  it("非组合态 Tab 插入两个空格，不切换焦点", () => {
    const { container } = renderEditor(<Harness />);
    const ta = textarea(container);
    ta.selectionStart = ta.selectionEnd = 0;

    const notPrevented = fireEvent.keyDown(ta, { key: "Tab" });

    expect(ta.value).toBe("  " + INITIAL);
    // 我们拦下了默认行为（否则会跳出编辑器）
    expect(notPrevented).toBe(false);
  });

  it("组合态的 Tab 属于输入法：不插空格、也不拦截默认行为", () => {
    const { container } = renderEditor(<Harness />);
    const ta = textarea(container);
    ta.selectionStart = ta.selectionEnd = 0;

    const notPrevented = fireEvent.keyDown(ta, { key: "Tab", isComposing: true });

    expect(ta.value).toBe(INITIAL);
    expect(notPrevented).toBe(true);
  });

  it("组合态的另一种信号 keyCode 229 同样放行给输入法", () => {
    const { container } = renderEditor(<Harness />);
    const ta = textarea(container);
    ta.selectionStart = ta.selectionEnd = 0;

    const notPrevented = fireEvent.keyDown(ta, { key: "Tab", keyCode: 229 });

    expect(ta.value).toBe(INITIAL);
    expect(notPrevented).toBe(true);
  });
});

const MULTI = "server.port=8080\nserver.name=demo\nserver.port=9090\n";

function MultiHarness() {
  const [value, setValue] = useState(MULTI);
  return <CodeEditor value={value} onChange={setValue} format="Properties" />;
}

function SearchHarness() {
  const [value, setValue] = useState(MULTI);
  return <CodeEditor value={value} onChange={setValue} format="Properties" searchTerm="demo" />;
}

// CRLF 草稿：原文里保留 \r，用来验证编辑态所有 DOM 坐标都落在归一后的文本上
// （textarea.value 会吃掉 \r，坐标口径不同就会整段串位）
const CRLF_MULTI = MULTI.replace(/\n/g, "\r\n");

function RefHarness({ content = MULTI }: { content?: string }) {
  const ref = useRef<CodeEditorHandle>(null);
  const [value, setValue] = useState(content);
  return (
    <>
      <button type="button" onClick={() => ref.current?.revealLine(3)}>
        jump
      </button>
      <CodeEditor ref={ref} value={value} onChange={setValue} format="Properties" />
    </>
  );
}

function WithCodeViewHarness() {
  const [value, setValue] = useState(MULTI);
  return (
    <>
      <CodeView code="a\nb" format="TEXT" />
      <CodeEditor value={value} onChange={setValue} format="Properties" />
    </>
  );
}

function gutterNumbers(container: HTMLElement) {
  return Array.from(container.querySelectorAll(".code-ln")).map((el) => el.textContent);
}

function findInput(container: HTMLElement) {
  return container.querySelector(".code-find-input") as HTMLInputElement | null;
}

describe("CodeEditor 行号槽（R22-1）", () => {
  it("行号数量与 textarea 的行数逐一对应，末尾换行也占一行", () => {
    const { container } = renderEditor(<MultiHarness />);

    // "…\n" 结尾：最后一行是空行，浏览态与编辑态都得给它一个行号
    expect(gutterNumbers(container)).toEqual(["1", "2", "3", "4"]);
  });

  it("末尾没有换行时不凭空多出一行", () => {
    const { container } = renderEditor(<CodeEditor value={"a\nb"} onChange={() => {}} format="TEXT" />);

    expect(gutterNumbers(container)).toEqual(["1", "2"]);
  });

  it("空内容不渲染行号槽", () => {
    const { container } = renderEditor(<CodeEditor value="" onChange={() => {}} format="TEXT" />);

    expect(container.querySelectorAll(".code-ln")).toHaveLength(0);
  });
});

describe("CodeEditor 搜索词标红（R22-1 / R1）", () => {
  it("外部内容搜索词在编辑态继续标红，并点亮所在行的行号", () => {
    const { container } = renderEditor(<SearchHarness />);

    expect(container.querySelectorAll("mark.search-hit")).toHaveLength(1);
    const hit = container.querySelector(".code-ln.is-hit") as HTMLElement;
    expect(hit.textContent).toBe("2");
    expect(container.querySelector(".code-line.is-hit")).not.toBeNull();
  });

  it("标红只作用于高亮层：高亮层文本与 textarea 的值逐字相等", () => {
    const { container } = renderEditor(<SearchHarness />);

    const code = container.querySelector(".code-editor-pre code") as HTMLElement;
    expect(code.textContent).toBe(MULTI);
  });
});

describe("CodeEditor 视图内查找（R22-2）", () => {
  it("焦点在 textarea 时 Ctrl+F 打开查找栏（此前是死键）", () => {
    const { container } = renderEditor(<MultiHarness />);
    const ta = textarea(container);

    fireEvent.keyDown(ta, { key: "f", ctrlKey: true });

    expect(findInput(container)).not.toBeNull();
  });

  it("焦点在 body 时也能按出查找栏", () => {
    const { container } = renderEditor(<MultiHarness />);

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });

    expect(findInput(container)).not.toBeNull();
  });

  it("组合态的 Ctrl+F 交给输入法，不弹查找栏", () => {
    const { container } = renderEditor(<MultiHarness />);
    const ta = textarea(container);

    fireEvent.keyDown(ta, { key: "f", ctrlKey: true, isComposing: true });

    expect(findInput(container)).toBeNull();
  });

  it("页面里存在浏览态 CodeView 时，body 上的 Ctrl+F 不被编辑态抢走", () => {
    const { container } = renderEditor(<WithCodeViewHarness />);

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });

    // 编辑态自己没有抢；接管与否由 CodeView 决定
    expect(container.querySelectorAll(".code-editor .code-find-input")).toHaveLength(0);
  });

  it("查找命中只移动选区与滚动，绝不改动内容", () => {
    const { container } = renderEditor(<MultiHarness />);
    const ta = textarea(container);

    fireEvent.keyDown(ta, { key: "f", ctrlKey: true });
    fireEvent.change(findInput(container) as HTMLInputElement, { target: { value: "server.port" } });

    expect(ta.value).toBe(MULTI);
    const count = container.querySelector(".code-find-count") as HTMLElement;
    expect(count.textContent).toContain("2");
    expect(ta.selectionStart).toBe(0);
    expect(ta.selectionEnd).toBe("server.port".length);
  });

  it("F3 跳到下一处、Shift+F3 回到上一处，越界自动环绕", async () => {
    const { container } = renderEditor(<MultiHarness />);
    const ta = textarea(container);

    fireEvent.keyDown(ta, { key: "f", ctrlKey: true });
    fireEvent.change(findInput(container) as HTMLInputElement, { target: { value: "server.port" } });
    expect(ta.selectionStart).toBe(0);

    fireEvent.keyDown(window, { key: "F3" });
    expect(ta.selectionStart).toBe(MULTI.indexOf("server.port=9090"));

    fireEvent.keyDown(window, { key: "F3", shiftKey: true });
    expect(ta.selectionStart).toBe(0);

    // 第二处命中所在行的行号标成「当前命中」
    fireEvent.keyDown(window, { key: "F3" });
    await waitFor(() => expect(container.querySelector(".code-ln.is-current")?.textContent).toBe("3"));
  });

  it("查找无命中时给出计数提示而不是静默", () => {
    const { container } = renderEditor(<MultiHarness />);

    fireEvent.keyDown(textarea(container), { key: "f", ctrlKey: true });
    fireEvent.change(findInput(container) as HTMLInputElement, { target: { value: "zzz" } });

    expect((container.querySelector(".code-find-count") as HTMLElement).textContent).toContain("无匹配");
  });

  it("Esc 关闭查找栏并把焦点还给编辑区", () => {
    const { container } = renderEditor(<MultiHarness />);
    const ta = textarea(container);

    fireEvent.keyDown(ta, { key: "f", ctrlKey: true });
    const input = findInput(container) as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Escape" });

    expect(findInput(container)).toBeNull();
    expect(document.activeElement).toBe(ta);
  });

  it("active=false（宿主页面被保活隐藏）时不再挂全局 Ctrl+F 监听", () => {
    const { container } = renderEditor(<CodeEditor value={MULTI} onChange={() => {}} format="Properties" active={false} />);

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });

    expect(findInput(container)).toBeNull();
  });

  it("enableFind=false 时不渲染查找入口", () => {
    const { container } = renderEditor(<CodeEditor value={MULTI} onChange={() => {}} format="Properties" enableFind={false} />);

    fireEvent.keyDown(textarea(container), { key: "f", ctrlKey: true });

    expect(container.querySelector(".code-find-open")).toBeNull();
    expect(findInput(container)).toBeNull();
  });
});

describe("CodeEditor 校验错误定位（R28）", () => {
  it("revealLine 把选区落到该行行首，CRLF 不把 \r 选进去", () => {
    const { container } = renderEditor(<RefHarness content={CRLF_MULTI} />);

    fireEvent.click(screen.getByRole("button", { name: "jump" }));

    const ta = textarea(container);
    const doc = normalizeLineEndings(CRLF_MULTI);
    // 夹具前提：这份草稿真的带 \r，且原文坐标与 DOM 坐标不是同一个数（否则用例是空断言）
    expect(CRLF_MULTI).toContain("\r\n");
    expect(doc.indexOf("server.port=9090")).not.toBe(CRLF_MULTI.indexOf("server.port=9090"));
    // textarea 的 value getter 会吃掉 \r（Chromium 实测），编辑态只能与归一后的坐标对齐
    expect(ta.value).toBe(doc);
    expect(ta.selectionStart).toBe(doc.indexOf("server.port=9090"));
    // 选区只覆盖本行可见文本：多带一个换行就意味着用户接着按退格会吞掉整行
    expect(ta.value.slice(ta.selectionStart, ta.selectionEnd)).toBe("server.port=9090");
    expect(ta.selectionEnd).toBe(doc.indexOf("server.port=9090") + "server.port=9090".length);
  });

  it("CRLF 草稿里查找命中的选区同样落在归一坐标上（R28）", () => {
    const { container } = renderEditor(<RefHarness content={CRLF_MULTI} />);
    const ta = textarea(container);

    fireEvent.keyDown(ta, { key: "f", ctrlKey: true });
    fireEvent.change(findInput(container) as HTMLInputElement, { target: { value: "server.port" } });

    const doc = normalizeLineEndings(CRLF_MULTI);
    expect(ta.selectionStart).toBe(doc.indexOf("server.port=8080"));

    fireEvent.keyDown(window, { key: "F3" });
    expect(ta.selectionStart).toBe(doc.indexOf("server.port=9090"));
    // 命中长度按查找词本身算，多一个字符就会在用户接着输入时吃掉等号
    expect(ta.value.slice(ta.selectionStart, ta.selectionEnd)).toBe("server.port");
  });

  it("CRLF 草稿里 Tab 缩进按归一后的文本拼接，不会串位（R28）", () => {
    const { container } = renderEditor(<RefHarness content={CRLF_MULTI} />);
    const ta = textarea(container);
    const doc = normalizeLineEndings(CRLF_MULTI);
    const caret = doc.indexOf("server.name");
    ta.selectionStart = ta.selectionEnd = caret;

    fireEvent.keyDown(ta, { key: "Tab" });

    expect(ta.value).toBe(doc.slice(0, caret) + "  " + doc.slice(caret));
  });

  it("跳到第 N 行点亮该行，且不改动内容", () => {
    const { container } = renderEditor(<RefHarness />);
    const ta = textarea(container);

    fireEvent.click(screen.getByRole("button", { name: "jump" }));

    expect(ta.value).toBe(MULTI);
    expect(container.querySelector(".code-line.is-current")).not.toBeNull();
    expect((container.querySelector(".code-ln.is-current") as HTMLElement).textContent).toBe("3");
  });

  it("行号越界按末尾夹取，不会崩", () => {
    const { container } = renderEditor(<RefHarness />);
    const ta = textarea(container);

    fireEvent.click(screen.getByRole("button", { name: "jump" }));
    fireEvent.keyDown(ta, { key: "f", ctrlKey: true });

    expect(ta.value).toBe(MULTI);
  });
});
