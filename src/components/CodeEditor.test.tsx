/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "../test/react";
import { useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import CodeEditor, { type CodeEditorHandle } from "./CodeEditor";
import CodeView from "./CodeView";
import { normalizeLineEndings } from "../lib/codeLines";
import { clearViewState, writeViewState } from "../lib/viewState";
import { FIND_BAR_FALLBACK_HEIGHT, FIND_BAR_GAP, FIND_BAR_TOP, HIT_REVEAL_MARGIN } from "../lib/codeScroll";
import { isMarkVisible, stubCodeHorizontalLayout, stubScrollLeft } from "../test/codeLayout";

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

function SaveHarness({ onSave }: { onSave?: () => void }) {
  const [value, setValue] = useState(MULTI);
  return <CodeEditor value={value} onChange={setValue} format="Properties" onSave={onSave} />;
}

describe("CodeEditor 保存快捷键（R47）", () => {
  it("焦点在 textarea 时 Ctrl+S 触发宿主 onSave 恰好一次，并拦下原生默认行为", () => {
    const onSave = vi.fn();
    const { container } = renderEditor(<SaveHarness onSave={onSave} />);
    const ta = textarea(container);

    const notPrevented = fireEvent.keyDown(ta, { key: "s", ctrlKey: true });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(notPrevented).toBe(false);
  });

  it("Cmd+S（macOS）同样接管", () => {
    const onSave = vi.fn();
    const { container } = renderEditor(<SaveHarness onSave={onSave} />);

    fireEvent.keyDown(textarea(container), { key: "s", metaKey: true });

    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("保存快捷键只触发 onSave，不改动内容、不动选区", () => {
    const onSave = vi.fn();
    const { container } = renderEditor(<SaveHarness onSave={onSave} />);
    const ta = textarea(container);
    ta.selectionStart = ta.selectionEnd = 5;

    fireEvent.keyDown(ta, { key: "s", ctrlKey: true });

    expect(ta.value).toBe(MULTI);
    expect(ta.selectionStart).toBe(5);
  });

  it("宿主没有保存动作时不装作接管：不炸、也不吞键（交给全局兜底）", () => {
    const { container } = renderEditor(<SaveHarness />);

    const notPrevented = fireEvent.keyDown(textarea(container), { key: "s", ctrlKey: true });

    expect(notPrevented).toBe(true);
  });

  it("组合态的 Ctrl+S 交给输入法，不当成保存", () => {
    const onSave = vi.fn();
    const { container } = renderEditor(<SaveHarness onSave={onSave} />);

    fireEvent.keyDown(textarea(container), { key: "s", ctrlKey: true, isComposing: true });

    expect(onSave).not.toHaveBeenCalled();
  });

  it("带 alt 的组合不算保存", () => {
    const onSave = vi.fn();
    const { container } = renderEditor(<SaveHarness onSave={onSave} />);

    fireEvent.keyDown(textarea(container), { key: "s", ctrlKey: true, altKey: true });

    expect(onSave).not.toHaveBeenCalled();
  });

  it("查找栏里的 Ctrl+S 不算保存：焦点不在编辑区就不该动宿主的保存", () => {
    const onSave = vi.fn();
    const { container } = renderEditor(<SaveHarness onSave={onSave} />);

    fireEvent.keyDown(textarea(container), { key: "f", ctrlKey: true });
    fireEvent.keyDown(findInput(container) as HTMLInputElement, { key: "s", ctrlKey: true });

    expect(onSave).not.toHaveBeenCalled();
  });

  it("Tab 缩进不受新拦截影响（判据顺序别把 Tab 吞掉）", () => {
    const onSave = vi.fn();
    const { container } = renderEditor(<SaveHarness onSave={onSave} />);
    const ta = textarea(container);
    ta.selectionStart = ta.selectionEnd = 0;

    fireEvent.keyDown(ta, { key: "Tab" });

    expect(onSave).not.toHaveBeenCalled();
    expect(ta.value).toBe("  " + MULTI);
  });
});

describe("CodeEditor 查找匹配选项（R75）", () => {
  const EDITOR_CASE = "PORT = 1\nport = 2\nexport const port = 3\nports = 4\n";

  function openFind(container: HTMLElement, term: string) {
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = findInput(container);
    expect(input, "Ctrl+F 没能打开编辑态查找栏").toBeTruthy();
    fireEvent.change(input as HTMLInputElement, { target: { value: term } });
    return input as HTMLInputElement;
  }

  function toggles(container: HTMLElement): HTMLButtonElement[] {
    return [...container.querySelectorAll<HTMLButtonElement>(".code-editor .code-find-toggle")];
  }

  function countText(container: HTMLElement): string {
    return (container.querySelector(".code-find-count") as HTMLElement).textContent ?? "";
  }

  function hitLineNumbers(container: HTMLElement): number[] {
    return [...container.querySelectorAll<HTMLElement>(".code-ln")]
      .filter((el) => el.classList.contains("is-hit") || el.classList.contains("is-current"))
      .map((el) => Number(el.textContent));
  }

  beforeEach(() => {
    // 开关与浏览态共用同一对记忆键，不清掉会互相污染
    clearViewState("codeFind.");
    (document.activeElement as HTMLElement | null)?.blur?.();
  });

  it("编辑态查找栏同样有两个开关，并把状态播报给辅助技术", () => {
    const { container } = renderEditor(<MultiHarness />);
    openFind(container, "server.port");

    const [caseBtn, wordBtn] = toggles(container);
    expect(caseBtn).toBeTruthy();
    expect(wordBtn).toBeTruthy();
    expect(caseBtn.getAttribute("aria-pressed")).toBe("false");
    expect(wordBtn.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(caseBtn);
    expect(caseBtn.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(wordBtn);
    expect(wordBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("勾选口径后命中收窄、选区跟着换到新的首处命中，正文逐字不变", () => {
    const doc = EDITOR_CASE;
    const { container: c2 } = renderEditor(<CodeEditor value={doc} onChange={() => {}} format="TEXT" />);
    const ta2 = textarea(c2);
    openFind(c2, "port");

    expect(countText(c2)).toContain("/5");
    expect(hitLineNumbers(c2)).toEqual([1, 2, 3, 4]);
    expect(ta2.selectionStart).toBe(0); // 不区分大小写时首处是大写那行的 PORT
    expect(ta2.value).toBe(doc);

    fireEvent.click(toggles(c2)[0]); // 区分大小写
    expect(countText(c2)).toContain("/4");
    expect(ta2.selectionStart).toBe(doc.indexOf("port")); // 选区落到新首处命中
    expect(ta2.selectionEnd).toBe(doc.indexOf("port") + "port".length);

    fireEvent.click(toggles(c2)[1]); // 全词
    expect(countText(c2)).toContain("/2");
    expect(hitLineNumbers(c2)).toEqual([2, 3]);
    expect(ta2.value).toBe(doc); // 开关只改标记与选区，绝不改内容
  });

  it("关掉查找栏后外部内容搜索词回到中性口径", () => {
    const { container } = renderEditor(<CodeEditor value={EDITOR_CASE} onChange={() => {}} format="TEXT" searchTerm="port" />);
    expect(hitLineNumbers(container)).toEqual([1, 2, 3, 4]);

    openFind(container, "port");
    fireEvent.click(toggles(container)[0]);
    expect(hitLineNumbers(container)).toEqual([2, 3, 4]);

    fireEvent.keyDown(findInput(container) as HTMLElement, { key: "Escape" });
    expect(findInput(container)).toBeNull();
    expect(hitLineNumbers(container)).toEqual([1, 2, 3, 4]);
  });

  it("点开关不抢走输入框焦点，选区也不丢", () => {
    const { container } = renderEditor(<CodeEditor value={EDITOR_CASE} onChange={() => {}} format="TEXT" />);
    const input = openFind(container, "port");
    input.focus();
    expect(document.activeElement).toBe(input);

    const [caseBtn] = toggles(container);
    // fireEvent 返回 false 表示处理器调用了 preventDefault：浏览器据此不移动焦点
    expect(fireEvent.mouseDown(caseBtn), "开关按下时没挡默认行为：点一下就得重新点输入框").toBe(false);

    fireEvent.click(caseBtn);
    expect(findInput(container)).toBe(input);
    expect(document.activeElement).toBe(input);
  });

  it("口径与浏览态共用同一对记忆键：编辑态沿用上次选的口径", () => {
    writeViewState("codeFind.caseSensitive", true);
    const { container } = renderEditor(<CodeEditor value={"port = 1\n"} onChange={() => {}} format="TEXT" />);
    openFind(container, "PORT");

    expect(toggles(container)[0].getAttribute("aria-pressed")).toBe("true");
    expect(countText(container)).toContain("无匹配");
  });

  it("栏没打开时记住的口径不许污染外部搜索词", () => {
    writeViewState("codeFind.caseSensitive", true);
    writeViewState("codeFind.wholeWord", true);
    const { container } = renderEditor(<CodeEditor value={EDITOR_CASE} onChange={() => {}} format="TEXT" searchTerm="port" />);
    expect(findInput(container)).toBeNull();
    expect(hitLineNumbers(container)).toEqual([1, 2, 3, 4]);
  });
});

describe("CodeEditor 长行里的命中也横向送进视口（轮27 F-7）", () => {
  const CHAR_W = 8;
  const VIEWPORT_W = 800;
  const LONG = `{"a":1,"pad":"${"x".repeat(600)}","serverPort":8080,"pad2":"${"y".repeat(300)}","serverHost":"127.0.0.1"}`;

  beforeEach(() => {
    // 上一组用例把记忆键写成了「区分大小写 + 全词」，不清掉这里搜 server 会一处命中也没有
    clearViewState("codeFind.");
    (document.activeElement as HTMLElement | null)?.blur?.();
  });

  /**
   * 编辑态的几何比浏览态多一层：滚动容器是 textarea，命中标记在下层高亮 pre 里。
   * 水平定位量 pre 里的矩形，写的是 textarea 的 scrollLeft，写完必须同步回 pre——
   * 不然着色层与选区错开一屏，用户看到的红字仍在屏幕外。
   */
  function layout(container: HTMLElement) {
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    const pre = container.querySelector(".code-editor-pre") as HTMLElement;
    const scroll = stubCodeHorizontalLayout(ta, pre, {
      charWidth: CHAR_W,
      viewportWidth: VIEWPORT_W,
      contentWidth: LONG.length * CHAR_W,
    });
    const preScroll = stubScrollLeft(pre);
    Object.defineProperty(ta, "clientHeight", { configurable: true, get: () => 100 });
    Object.defineProperty(ta, "scrollHeight", { configurable: true, get: () => 200 });
    return { ta, pre, scroll, preScroll };
  }

  function openFindWithTerm(container: HTMLElement, term: string) {
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = findInput(container);
    expect(input, "Ctrl+F 没能打开编辑态查找栏").toBeTruthy();
    fireEvent.change(input as HTMLInputElement, { target: { value: term } });
    return input as HTMLInputElement;
  }

  it("搜长行里的词：textarea 横向定位，高亮层立刻跟上同一偏移", async () => {
    const { container } = renderEditor(<CodeEditor value={LONG} onChange={() => {}} format="TEXT" />);
    const { scroll, preScroll } = layout(container);

    openFindWithTerm(container, "server");
    await waitFor(() => expect(container.querySelector("mark.search-hit-current")).not.toBeNull());

    const current = container.querySelector("mark.search-hit-current") as HTMLElement;
    expect(scroll.get(), "命中在第 600 列之后，scrollLeft 还是 0 就是没定位").toBeGreaterThan(0);
    expect(isMarkVisible(container.querySelector("textarea") as HTMLElement, current, HIT_REVEAL_MARGIN)).toBe(true);
    expect(preScroll.get()).toBe(scroll.get());
  });

  it("Enter 换命中：两层的横向偏移一起走，且始终相等", async () => {
    const { container } = renderEditor(<CodeEditor value={LONG} onChange={() => {}} format="TEXT" />);
    const { ta, scroll, preScroll } = layout(container);
    const input = openFindWithTerm(container, "server");
    await waitFor(() => expect(container.querySelector("mark.search-hit-current")).not.toBeNull());
    const leftAtFirst = scroll.get();

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(container.querySelector("mark.search-hit-current")).not.toBeNull());

    const current = container.querySelector("mark.search-hit-current") as HTMLElement;
    expect(scroll.get()).not.toBe(leftAtFirst);
    expect(isMarkVisible(ta, current, HIT_REVEAL_MARGIN)).toBe(true);
    expect(preScroll.get()).toBe(scroll.get());
  });

  it("量不到布局时不许动 textarea 的横向偏移：编辑态尤其不能把用户滚走的位置清零", async () => {
    const { container } = renderEditor(<CodeEditor value={LONG} onChange={() => {}} format="TEXT" />);
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    const scroll = stubScrollLeft(ta);
    scroll.set(500);

    openFindWithTerm(container, "server");
    await waitFor(() => expect(container.querySelector("mark.search-hit-current")).not.toBeNull());
    fireEvent.keyDown(container.querySelector(".code-find-input") as HTMLElement, { key: "Enter" });

    expect(scroll.get()).toBe(500);
  });
});

describe("CodeEditor 查找栏打开时把第一行让到条子下面（轮27 F-8）", () => {
  const OPEN_PAD = FIND_BAR_TOP + FIND_BAR_FALLBACK_HEIGHT + FIND_BAR_GAP;

  function fakeBarHeight(height: number) {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => height });
    return () => {
      if (original) Object.defineProperty(HTMLElement.prototype, "offsetHeight", original);
      else Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
    };
  }

  function padTopOf(root: HTMLElement) {
    return root.style.getPropertyValue("--code-pad-top");
  }

  function rowTop(container: HTMLElement, selector: string, text: string) {
    const row = [...container.querySelectorAll<HTMLElement>(selector)].find((el) => el.textContent === text);
    expect(row, `${selector} 里没有这一行`).toBeTruthy();
    return parseFloat(row!.style.top);
  }

  it("开栏把净空从 12px 抬到条底之下，关栏原样退回", async () => {
    const { container } = renderEditor(<CodeEditor value={INITIAL} onChange={() => {}} format="TEXT" />);
    const root = container.querySelector(".code-editor") as HTMLElement;
    expect(padTopOf(root)).toBe("12px");
    expect(rowTop(container, ".code-ln", "1")).toBe(12);

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    await waitFor(() => expect(container.querySelector(".code-find-input")).not.toBeNull());

    // 命中行底色层要有东西可查：先输入一个真命中的词（.code-line 只在有命中时渲染）
    fireEvent.change(container.querySelector(".code-find-input") as HTMLInputElement, { target: { value: "server" } });
    await waitFor(() => expect(container.querySelector(".code-line")).not.toBeNull());

    expect(padTopOf(root)).toBe(`${OPEN_PAD}px`);
    // textarea / 高亮 pre / 行号槽 / 命中行底色层共用这一条 CSS 变量，改一处四层一起让位
    expect(rowTop(container, ".code-ln", "1")).toBe(OPEN_PAD);
    expect(rowTop(container, ".code-line", "")).toBeGreaterThanOrEqual(OPEN_PAD);
    expect(rowTop(container, ".code-ln", "1") - (FIND_BAR_TOP + FIND_BAR_FALLBACK_HEIGHT)).toBeGreaterThanOrEqual(FIND_BAR_GAP);

    fireEvent.keyDown(container.querySelector(".code-find-input") as HTMLElement, { key: "Escape" });
    await waitFor(() => expect(container.querySelector(".code-find-input")).toBeNull());
    expect(padTopOf(root)).toBe("12px");
    expect(rowTop(container, ".code-ln", "1")).toBe(12);
  });

  it("量到条子换成两行高 60px 时按实测算", async () => {
    const restore = fakeBarHeight(60);
    try {
      const { container } = renderEditor(<CodeEditor value={INITIAL} onChange={() => {}} format="TEXT" />);
      const root = container.querySelector(".code-editor") as HTMLElement;
      fireEvent.keyDown(window, { key: "f", ctrlKey: true });
      await waitFor(() => expect(container.querySelector(".code-find-input")).not.toBeNull());

      const measured = FIND_BAR_TOP + 60 + FIND_BAR_GAP;
      expect(padTopOf(root)).toBe(`${measured}px`);
      expect(rowTop(container, ".code-ln", "1")).toBe(measured);
    } finally {
      restore();
    }
  });
});
