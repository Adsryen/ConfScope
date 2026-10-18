/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, settleFindInputCommit, waitFor } from "../test/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import CodeEditor, { type CodeEditorHandle } from "./CodeEditor";
import CodeView from "./CodeView";
import { MAX_CODE_HITS, normalizeLineEndings } from "../lib/codeLines";
import { FIND_INPUT_DEFER_MIN_LINES } from "../lib/findInput";
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

describe("CodeEditor 查找词输入的延迟（轮29 F-16，与浏览态同一份策略）", () => {
  const BIG = Array.from({ length: FIND_INPUT_DEFER_MIN_LINES }, (_, i) => `key${i}: spring-cloud-${i}`).join("\n");

  it("大文档敲字期间不动命中层，停顿后才落地", async () => {
    const { container } = renderEditor(<CodeEditor value={BIG} onChange={() => {}} format="YAML" />);
    fireEvent.keyDown(container.querySelector("textarea") as HTMLTextAreaElement, { key: "f", ctrlKey: true });
    const input = container.querySelector(".code-find-input") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "spring" } });
    expect(input.value, "输入框该是即时值").toBe("spring");
    expect(container.querySelectorAll(".code-editor-pre mark.search-hit")).toHaveLength(0);

    await settleFindInputCommit();
    expect(container.querySelectorAll(".code-editor-pre mark.search-hit").length).toBeGreaterThan(0);
    expect((container.querySelector(".code-find-count") as HTMLElement).textContent).toBe(`第 1/${FIND_INPUT_DEFER_MIN_LINES} 处`);
  });
});

describe("CodeEditor 命中触顶要说得出口（轮28 F-10）", () => {
  const CAPPED = Array.from({ length: MAX_CODE_HITS + 1 }, () => "port = 8080;").join("\n");

  function openFind(container: HTMLElement) {
    fireEvent.keyDown(container.querySelector("textarea") as HTMLTextAreaElement, { key: "f", ctrlKey: true });
    return container.querySelector(".code-find-input") as HTMLInputElement;
  }

  it("编辑态与浏览态同一口径：触顶报「第 x/5000+ 处」，没触顶仍是精确数", async () => {
    const { container } = renderEditor(<CodeEditor value={CAPPED} onChange={() => {}} format="Properties" />);
    const input = openFind(container);
    expect(input, "Ctrl+F 没打开编辑态查找栏").toBeTruthy();
    fireEvent.change(input, { target: { value: "port" } });
    // 5001 行正文已过输入延迟阈值（轮29 F-16）：先让这次提交落地，再读命中
    await settleFindInputCommit();

    const count = container.querySelector(".code-find-count") as HTMLElement;
    expect(count.textContent).toBe(`第 1/${MAX_CODE_HITS}+ 处`);
    expect(count.getAttribute("title")).toContain(`只标红前 ${MAX_CODE_HITS} 处`);
    expect(container.querySelectorAll(".code-editor-pre mark.search-hit")).toHaveLength(MAX_CODE_HITS);
    expect((container.querySelector(".code-editor-pre") as HTMLElement).textContent).toBe(CAPPED);

    fireEvent.keyDown(input, { key: "Enter" });
    expect((container.querySelector(".code-find-count") as HTMLElement).textContent).toBe(`第 2/${MAX_CODE_HITS}+ 处`);

    // 未触顶：文案逐字不变，title 不留空值
    const small = renderEditor(<CodeEditor value={INITIAL + "\nport = 1;"} onChange={() => {}} format="Properties" />);
    const smallInput = openFind(small.container);
    fireEvent.change(smallInput, { target: { value: "port" } });
    const smallCount = small.container.querySelector(".code-find-count") as HTMLElement;
    expect(smallCount.textContent).toBe("第 1/2 处");
    expect(smallCount.getAttribute("title")).toBeNull();
  });
});

/**
 * 轮30 F-21：编辑态的行号 / 命中行底色按 `visibleRange = f(clientHeight)` 虚拟化，
 * 而 `clientHeight` 只由 scroll 事件与挂载时那两次同步更新。浏览态有
 * `new ResizeObserver(() => syncScroll()); ro.observe(area)`，编辑态只观察了查找条。
 * 于是把面板拉高 / 浏览器缩放 / 侧栏收起之后没有 scroll 事件，下半截就没有行号，得手动滚一下才补齐。
 */
/**
 * 轮30 F-22 / F-23：编辑态的查找落地。
 *
 * F-22 的真症状比 PRD 原先写的更窄也更常见：跳完第三处再改词，落地效果读的是**这一次提交里的旧序号**
 * （归零挂在另一条 useEffect 上，跑在落地之后），于是视图跳到「新词的第三处」、计数却写「第 1 处」；
 * 紧接着的第二次重渲染只换类 + 水平定位，垂直不再动——用户读到"红字在第一处，屏幕停在别处"。
 * 修法两条：序号连着它所属的口径在渲染期派生（不再有先后），落地从绘制后的 useEffect 挪到绘制前的
 * useLayoutEffect（不再闪一帧旧位置）。
 *
 * 但有一条**不许**跟着浏览态改：落地不许把「正文变了」也算作触发条件。编辑态的字是用户自己敲的，
 * 一旦"正文变了就落回第一处"，他在第 31 行改值，第二个字符就落到第一条命中那一行——直接改坏配置。
 * 浏览态的落地依赖里有 html 没这个问题：那边正文只读。下面第二条用例把这条分叉钉住。
 */
describe("CodeEditor 查找落地的口径（轮30 F-22）", () => {
  const VIEWPORT_H = 100;
  const CONTENT_H = 4000;

  // 「beta」不区分大小写 9 处（1/2/3/5/20/35/40/41/42 行），区分大小写只剩 6 处（1/2/3/40/41/42 行）。
  // 两套命中表都超过 6 处，勾上「区分大小写」时旧序号 5 不会被 clamp 顺手夹回第一处——
  // 「按旧序号跳」与「按新序号跳」在断言里才分得开。
  const LAND_LINES = Array.from({ length: 60 }, (_, i) => `key${i} = ${i}`);
  for (const i of [1, 2, 3, 40, 41, 42]) LAND_LINES[i] = `beta = ${i}`;
  for (const i of [5, 20, 35]) LAND_LINES[i] = `BETA = ${i}`;
  const LAND = `${LAND_LINES.join("\n")}\n`;
  const ALPHA_FIRST_OFFSET = LAND.indexOf("beta");

  function LandHarness() {
    const [value, setValue] = useState(LAND);
    return <CodeEditor value={value} onChange={setValue} format="TEXT" />;
  }

  /** scrollTop 可读写 + 高度撑出来：jsdom 没布局，「跳没跳」与「跳歪了」否则分不开。 */
  function stubEditorGeometry(ta: HTMLTextAreaElement) {
    const offsets = { top: 0, left: 0, writes: 0 };
    Object.defineProperty(ta, "scrollTop", {
      configurable: true,
      get: () => offsets.top,
      set: (v: number) => {
        offsets.top = v;
        offsets.writes += 1;
      },
    });
    Object.defineProperty(ta, "scrollLeft", { configurable: true, get: () => offsets.left, set: (v: number) => (offsets.left = v) });
    Object.defineProperty(ta, "clientHeight", { configurable: true, get: () => VIEWPORT_H });
    Object.defineProperty(ta, "scrollHeight", { configurable: true, get: () => CONTENT_H });
    return offsets;
  }

  /** 选区也换成可读写的假实现：revealHit 会不会把光标搬走，得看得见。 */
  function stubSelection(ta: HTMLTextAreaElement) {
    const sel = { start: 0, end: 0 };
    Object.defineProperty(ta, "selectionStart", { configurable: true, get: () => sel.start, set: (v: number) => (sel.start = v) });
    Object.defineProperty(ta, "selectionEnd", { configurable: true, get: () => sel.end, set: (v: number) => (sel.end = v) });
    ta.setSelectionRange = (start: number, end: number) => {
      sel.start = start;
      sel.end = end;
    };
    return sel;
  }

  /**
   * 行 i 的 top = padTop + i * ROW_H：从根节点的两个 CSS 变量取，不把组件常量抄第二份。
   * 走屏幕外的行（断言"停在原处"时目标行常常不在可视区）不能像浏览态那样从 .code-ln 反查。
   */
  function lineTop(container: HTMLElement, lineIndex: number) {
    const root = container.querySelector(".code-editor") as HTMLElement;
    const padTop = parseFloat(root.style.getPropertyValue("--code-pad-top"));
    const rowH = parseFloat(root.style.getPropertyValue("--code-row-h"));
    expect(Number.isFinite(padTop), "净空读不到：查找栏净空那条口径断了").toBe(true);
    return padTop + lineIndex * rowH;
  }

  const expectedTopFor = (container: HTMLElement, lineIndex: number) => Math.max(0, lineTop(container, lineIndex) - VIEWPORT_H / 2);

  function openFindBar(container: HTMLElement, term: string) {
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = findInput(container);
    expect(input, "Ctrl+F 没能打开编辑态查找栏").toBeTruthy();
    fireEvent.change(input as HTMLInputElement, { target: { value: term } });
    return input as HTMLInputElement;
  }

  const offsetOfLine = (text: string, line: number) => text.split("\n").slice(0, line).join("\n").length + (line > 0 ? 1 : 0);
  const countText = (container: HTMLElement) => (container.querySelector(".code-find-count") as HTMLElement).textContent ?? "";

  beforeEach(() => {
    clearViewState("codeFind.");
    (document.activeElement as HTMLElement | null)?.blur?.();
  });

  it("跳完第六处再改口径：视图、计数、当前命中类在同一次提交里落到第一处", () => {
    const { container } = renderEditor(<LandHarness />);
    const ta = textarea(container);
    const offsets = stubEditorGeometry(ta);
    openFindBar(container, "beta");

    expect(countText(container)).toContain("第 1/9");
    expect(offsets.top).toBe(expectedTopFor(container, 1));

    for (let i = 0; i < 5; i += 1) {
      const before = offsets.writes;
      fireEvent.keyDown(window, { key: "F3" });
      expect(offsets.writes - before, "一次 F3 给 scrollTop 赋了不止一次值").toBe(1);
    }
    expect(countText(container)).toContain("第 6/9");
    expect(offsets.top).toBe(expectedTopFor(container, 35));

    // 改口径：命中收窄到 6 处，序号归第一处。归零挂在一条 useEffect 上、跑在落地之后时，
    // 这一次落地读到的还是旧序号 5 → 视图跳到「新表的第 6 处」（第 43 行），
    // 计数与当前命中类却在第一处——下一次重渲染只换类 + 水平定位，垂直不再补。
    fireEvent.click(container.querySelectorAll<HTMLButtonElement>(".code-editor .code-find-toggle")[0]);

    expect(countText(container)).toContain("第 1/6");
    expect(offsets.top, "改口径后视图停在旧序号那一处：归零与落地分在两次提交里").toBe(expectedTopFor(container, 1));
    expect((container.querySelector(".code-editor .code-ln.is-current") as HTMLElement).textContent).toBe("2");
  });

  it("开着查找栏打字：不许把视口与光标从正在编辑的那行拽到第一处命中", () => {
    const { container } = renderEditor(<LandHarness />);
    const ta = textarea(container);
    const offsets = stubEditorGeometry(ta);
    const sel = stubSelection(ta);
    openFindBar(container, "alpha");

    // 用户滚到第 31 行、把光标放进去（第 31 行不含 alpha，第一处在第 6 行）
    const caret = offsetOfLine(LAND, 30);
    const restingTop = expectedTopFor(container, 30);
    offsets.top = restingTop;
    fireEvent.scroll(ta);
    ta.setSelectionRange(caret, caret);

    fireEvent.change(ta, { target: { value: `${LAND.slice(0, caret)}X${LAND.slice(caret)}` } });

    expect(offsets.top, "正文一变就落回第一处：正在编辑的行会被丢到屏幕外").toBe(restingTop);
    expect(sel.start, "正文一变就把光标送到第一处命中：下一个字符会改坏别的行").toBe(caret);
    expect(container.querySelector(".code-editor-pre")?.textContent).toContain("Xkey30");
    expect(ALPHA_FIRST_OFFSET).toBeGreaterThan(0);
  });
});

/**
 * 轮30 F-23：`closeFind` 清了 findOpen / findTerm / activeIdx，唯独没清 pinnedLine，
 * 而 revealHit 每跳一处都往里写一次。Esc 关栏后那一行还带着整行底色，
 * 用户会以为这一行有什么特殊含义（浏览态关栏就干净收回：currentLine 只跟 findOpen）。
 */
describe("CodeEditor 关栏收回命中行底色（轮30 F-23）", () => {
  /** 带外部内容搜索词的编辑态：关栏后命中行底色该留着（那是搜索词口径），只收回「刚看过第几处」。 */
  function PinHarness() {
    const ref = useRef<CodeEditorHandle>(null);
    const [value, setValue] = useState(MULTI);
    return (
      <>
        <button type="button" onClick={() => ref.current?.revealLine(3)}>
          jump
        </button>
        <CodeEditor ref={ref} value={value} onChange={setValue} format="Properties" searchTerm="port" />
      </>
    );
  }

  function openFindBar(container: HTMLElement, term: string) {
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = findInput(container);
    expect(input, "Ctrl+F 没能打开编辑态查找栏").toBeTruthy();
    fireEvent.change(input as HTMLInputElement, { target: { value: term } });
    return input as HTMLInputElement;
  }

  it("Esc 关栏后不留 is-current，而「跳到第 N 行」的高亮照常", () => {
    const { container } = renderEditor(<PinHarness />);
    expect(container.querySelectorAll(".code-editor .code-line.is-hit")).toHaveLength(2); // 第 1、3 行

    const input = openFindBar(container, "port");
    fireEvent.keyDown(window, { key: "F3" });
    expect(container.querySelector(".code-editor .code-line.is-current")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(findInput(container)).toBeNull();
    expect(container.querySelector(".code-editor .code-line.is-current"), "关栏后上一处命中的整行底色还留着").toBeNull();
    expect(container.querySelector(".code-editor .code-ln.is-current"), "关栏后行号还留着当前命中色").toBeNull();
    // 命中行底色本身不动：还红着哪些行由外部搜索词说了算，不是「刚看过第几处」
    expect(container.querySelectorAll(".code-editor .code-line.is-hit")).toHaveLength(2);

    // 「跳到第 N 行」的落点走的是同一层，不许被关栏那次清理顺手带走
    fireEvent.click(screen.getByText("jump"));
    const current = container.querySelector(".code-editor .code-line.is-current") as HTMLElement;
    expect(current, "revealLine 的跳行高亮被一起清掉了").toBeTruthy();
    expect(current.style.top).toBe("52px");
  });
});

describe("CodeEditor 容器尺寸变化（轮30 F-21）", () => {
  const BIG = Array.from({ length: 100 }, (_, i) => `key${i}=value${i}`).join("\n");

  // 假的 ResizeObserver 是全局替身，用完必须撤掉，别让它渗到后面的用例里。
  afterEach(() => vi.unstubAllGlobals());

  /** 装一个假 ResizeObserver，返回「触发所有已登记的回调」。 */
  function stubResizeObserver() {
    const registered: Array<() => void> = [];
    class FakeRO {
      constructor(cb: () => void) {
        registered.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FakeRO);
    return () => registered.forEach((cb) => cb());
  }

  function stubViewport(ta: HTMLTextAreaElement, readHeight: () => number) {
    Object.defineProperty(ta, "clientHeight", { configurable: true, get: readHeight });
    Object.defineProperty(ta, "scrollHeight", { configurable: true, get: () => 4000 });
    Object.defineProperty(ta, "scrollTop", { configurable: true, get: () => 0, set: () => {} });
  }

  it("拉高面板后行号必须补齐：不用滚一下", async () => {
    const fire = stubResizeObserver();
    const { container } = renderEditor(<CodeEditor value={BIG} onChange={() => {}} format="Properties" />);
    const ta = textarea(container);
    let viewportH = 100;
    stubViewport(ta, () => viewportH);
    fireEvent.scroll(ta);

    // 视口 100px / 行高 20px：只渲染窗口内那几行号（+1 行余量）
    await waitFor(() => expect(gutterNumbers(container).length).toBeGreaterThan(0));
    const shortCount = gutterNumbers(container).length;
    expect(shortCount).toBeLessThan(20);

    viewportH = 600;
    fire();

    await waitFor(() => expect(gutterNumbers(container).length).toBeGreaterThan(shortCount));
    expect(Number(gutterNumbers(container)[gutterNumbers(container).length - 1])).toBeGreaterThanOrEqual(30);
  });

  it("没挂尺寸观察就不算这条口径：自检——撤掉 observe 后用例必须失效", () => {
    const fire = stubResizeObserver();
    const { container } = renderEditor(<CodeEditor value={BIG} onChange={() => {}} format="Properties" />);
    const ta = textarea(container);
    stubViewport(ta, () => 100);
    fireEvent.scroll(ta);
    const before = gutterNumbers(container).length;
    fire();
    expect(gutterNumbers(container).length).toBe(before);
  });
});

describe("CodeEditor 右侧缩略图（轮30 F-24，与浏览态同一份实现）", () => {
  const VIEWPORT_H = 100;
  const CONTENT_H = 400;
  const MM_H = 200;
  const MM_LINES = Array.from({ length: 40 }, (_, i) => `key${i} = value${i}`).join("\n");
  const MM_DOC = `${MM_LINES}\n`;

  /** jsdom 没布局：滚动容器的高度与 scrollTop 都得自己装（与浏览态同一手法）。 */
  function stubSurface(el: HTMLElement) {
    const offsets = { top: 0 };
    Object.defineProperty(el, "scrollTop", { configurable: true, get: () => offsets.top, set: (v: number) => (offsets.top = v) });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => VIEWPORT_H });
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => CONTENT_H });
    return offsets;
  }

  function stubGeometry(el: HTMLElement, clientHeight: number, scrollHeight: number) {
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight });
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
    fireEvent.scroll(el);
  }

  /** jsdom 的 getBoundingClientRect 恒给全 0，点击映射必须自己有高度。 */
  function stubMinimapRect(mm: HTMLElement, top = 0, height = MM_H) {
    mm.getBoundingClientRect = () =>
      ({ top, height, bottom: top + height, left: 0, right: 66, width: 66, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  }

  const padVars = (container: HTMLElement) => {
    const root = container.querySelector(".code-editor") as HTMLElement;
    return [root.style.getPropertyValue("--code-pad-right"), root.style.getPropertyValue("--code-find-right")];
  };

  it("编辑态出现缩略图与 canvas；showMinimap=false 时整条收起、留白退回窄值", async () => {
    const { container } = renderEditor(<CodeEditor value={MM_DOC} onChange={() => {}} format="Properties" />);
    const ta = textarea(container);
    stubGeometry(ta, VIEWPORT_H, CONTENT_H);
    await waitFor(() => expect(container.querySelector(".code-minimap")).not.toBeNull());
    expect(container.querySelector(".code-minimap canvas")).not.toBeNull();

    const { container: off } = renderEditor(<CodeEditor value={MM_DOC} onChange={() => {}} format="Properties" showMinimap={false} />);
    const offTa = textarea(off);
    stubGeometry(offTa, VIEWPORT_H, CONTENT_H);
    await waitFor(() => expect(off.querySelector(".code-minimap")).toBeNull());
    expect(padVars(off), "设置关了就不该再为缩略图让位").toEqual(["14px", "16px"]);
  });

  // 轮28 F-13 的同一条口径在编辑态同样成立：留白跟着显隐抖就是抖动本身。
  it("不满一屏时缩略图收起，右侧留白却按设置继续预留（防自激振荡）", async () => {
    const { container } = renderEditor(<CodeEditor value={MM_DOC} onChange={() => {}} format="Properties" />);
    const ta = textarea(container);

    stubGeometry(ta, VIEWPORT_H, CONTENT_H);
    await waitFor(() => expect(container.querySelector(".code-minimap")).not.toBeNull());
    const shown = padVars(container);

    stubGeometry(ta, CONTENT_H, CONTENT_H);
    await waitFor(() => expect(container.querySelector(".code-minimap")).toBeNull());
    expect(padVars(container), "留白跟着显隐变 ⇒ 正文宽变 ⇒ 高度又变 ⇒ 抖动").toEqual(shown);

    stubGeometry(ta, VIEWPORT_H, CONTENT_H);
    await waitFor(() => expect(container.querySelector(".code-minimap")).not.toBeNull());
  });

  it("空正文不渲染缩略图", () => {
    const { container } = renderEditor(<CodeEditor value="" onChange={() => {}} format="Properties" />);
    expect(container.querySelector(".code-minimap")).toBeNull();
  });

  /**
   * F-20 那条不变式在编辑态一样成立：行号层与命中行底色层是 textarea **之外**的独立层，
   * 靠 transform 跟手，浏览器不会替我们滚它们，而 scroll 事件是异步派发的。
   * jsdom 根本不派发 scroll ⇒ 少一次当帧同步必红。
   */
  it("点缩略图落地的那一帧，行号层与命中行层必须已经跟到新偏移", async () => {
    const { container } = renderEditor(<CodeEditor value={MM_DOC} onChange={() => {}} format="Properties" searchTerm="key20" />);
    const ta = textarea(container);
    const offsets = stubSurface(ta);
    fireEvent.scroll(ta);
    await waitFor(() => expect(container.querySelector(".code-minimap-viewport")).not.toBeNull());

    const mm = container.querySelector(".code-minimap") as HTMLElement;
    stubMinimapRect(mm);
    fireEvent.pointerDown(mm, { clientY: 150, pointerId: 1 });

    // 0.75 * 400 - 100/2 = 250
    expect(offsets.top, "点缩略图没把正文滚过去").toBe(250);
    const follow = "translateY(-250px)";
    expect((container.querySelector(".code-gutter-layer") as HTMLElement).style.transform, "行号层没当帧跟上").toBe(follow);
    expect((container.querySelector(".code-lines-layer") as HTMLElement).style.transform, "命中行底色层没当帧跟上").toBe(follow);
    await waitFor(() => expect((container.querySelector(".code-minimap-viewport") as HTMLElement).style.top).toBe("62.5%"));
  });

  it("滚轮落在缩略图上：textarea 与行号层、命中行层当帧一起走（轮31 F-25）", async () => {
    const { container } = renderEditor(<CodeEditor value={MM_DOC} onChange={() => {}} format="Properties" />);
    const ta = textarea(container);
    const offsets = stubSurface(ta);
    fireEvent.scroll(ta);
    await waitFor(() => expect(container.querySelector(".code-minimap")).not.toBeNull());

    const mm = container.querySelector(".code-minimap") as HTMLElement;
    act(() => {
      mm.dispatchEvent(new WheelEvent("wheel", { deltaY: 3, deltaMode: 1, cancelable: true, bubbles: true }));
    });

    // deltaMode=1 是「行」：3 格 × ROW_H(20)，编辑态同样不许当像素用（当像素就只滚 3px）
    expect(offsets.top, "滚轮打在缩略图上，正文一动不动").toBe(60);
    expect((container.querySelector(".code-gutter-layer") as HTMLElement).style.transform, "行号层慢一帧").toBe("translateY(-60px)");
    expect((container.querySelector(".code-lines-layer") as HTMLElement).style.transform, "命中行底色层慢一帧").toBe("translateY(-60px)");
  });

  it("在缩略图上拖动：每一次 pointermove 都当帧同步，且上界夹在可滚最大值", async () => {
    const { container } = renderEditor(<CodeEditor value={MM_DOC} onChange={() => {}} format="Properties" />);
    const ta = textarea(container);
    const offsets = stubSurface(ta);
    fireEvent.scroll(ta);
    await waitFor(() => expect(container.querySelector(".code-minimap")).not.toBeNull());

    const mm = container.querySelector(".code-minimap") as HTMLElement;
    stubMinimapRect(mm);
    fireEvent.pointerDown(mm, { clientY: 20, pointerId: 1 });
    expect((container.querySelector(".code-gutter-layer") as HTMLElement).style.transform).toBe(`translateY(${-offsets.top}px)`);

    fireEvent.pointerMove(mm, { clientY: 120, pointerId: 1 });
    expect(offsets.top, "拖动没跟着走").toBe(190); // 0.6 * 400 - 100/2
    expect((container.querySelector(".code-gutter-layer") as HTMLElement).style.transform, "拖动时行号层慢一帧").toBe("translateY(-190px)");

    fireEvent.pointerMove(mm, { clientY: 200, pointerId: 1 });
    expect(offsets.top, "上界要夹在 scrollHeight - clientHeight，不是 scrollHeight").toBe(300);
  });

  /**
   * AC6 最硬的一条判据：同一份点击映射与同一份视口公式。
   * 两份实现会在这条上分叉——所以这里不读源码，直接拿两个视图的实测值对撞。
   */
  it("两侧同一份点击映射与视口框：同样的几何、同一个落点，编辑态与浏览态必须逐值相等", async () => {
    const view = render(
      <I18nProvider>
        <CodeView code={MM_DOC} format="TEXT" />
      </I18nProvider>
    );
    const editor = renderEditor(<CodeEditor value={MM_DOC} onChange={() => {}} format="TEXT" />);

    const area = view.container.querySelector(".code-area") as HTMLElement;
    const ta = editor.container.querySelector("textarea") as HTMLTextAreaElement;
    const viewOffsets = stubSurface(area);
    const editorOffsets = stubSurface(ta);
    fireEvent.scroll(area);
    fireEvent.scroll(ta);
    await waitFor(() => expect(view.container.querySelector(".code-minimap-viewport")).not.toBeNull());
    await waitFor(() => expect(editor.container.querySelector(".code-minimap-viewport")).not.toBeNull());

    const vpOf = (c: HTMLElement) => {
      const vp = c.querySelector(".code-minimap-viewport") as HTMLElement;
      return `${vp.style.top}/${vp.style.height}`;
    };
    expect(vpOf(editor.container), "视口框公式与浏览态分叉").toBe(vpOf(view.container));

    const viewMm = view.container.querySelector(".code-minimap") as HTMLElement;
    const editorMm = editor.container.querySelector(".code-minimap") as HTMLElement;
    stubMinimapRect(viewMm);
    stubMinimapRect(editorMm);
    for (const clientY of [0, 40, 100, 150, MM_H]) {
      fireEvent.pointerDown(viewMm, { clientY, pointerId: 1 });
      fireEvent.pointerDown(editorMm, { clientY, pointerId: 1 });
      expect(editorOffsets.top, `clientY=${clientY} 时两侧点击映射分叉`).toBe(viewOffsets.top);
    }
  });
});

describe("CodeEditor 查找栏按钮的焦点（轮32 F-29）", () => {
  /**
   * 编辑态比浏览态更贵：焦点一旦离开 textarea，当前选区跟着消失，接着打字全不见，
   * Ctrl+S 也不再被编辑区接管（保存快捷键挂在 textarea 的按键路径上）。
   * jsdom 测不出焦点丢失，钉的是「有没有取消 mousedown 那一步」（与 CodeView 同一口径）。
   */
  const EDITOR_FIND_DOC = "server.port=8080\nname = a\nport = 8081\n";

  function openFind(container: HTMLElement, term: string) {
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = container.querySelector(".code-find-input") as HTMLInputElement;
    expect(input, "Ctrl+F 没能打开编辑态查找栏").toBeTruthy();
    fireEvent.change(input, { target: { value: term } });
    return input;
  }

  it("点 ↑↓ 取消 mousedown，跳转仍生效；✕ 明确不取消", () => {
    const { container } = renderEditor(<CodeEditor value={EDITOR_FIND_DOC} onChange={() => {}} format="Properties" />);
    openFind(container, "port");
    const [prev, next, close] = [...container.querySelectorAll<HTMLButtonElement>(".code-editor .code-find-btn")];
    expect([prev, next, close], "编辑态查找栏的 ↑↓✕ 读不到三个按钮").toHaveLength(3);

    const toggle = container.querySelector(".code-editor .code-find-toggle") as HTMLButtonElement;
    expect(fireEvent.mouseDown(toggle), "开关原本就承诺不抢焦点").toBe(false);
    expect(fireEvent.mouseDown(next), "点 ↓ 不取消 mousedown：textarea 失焦 + 选区消失").toBe(false);
    expect(fireEvent.mouseDown(prev), "点 ↑ 同上").toBe(false);
    expect(fireEvent.mouseDown(close), "✕ 的 mousedown 必须留着：closeFind 靠它把焦点还给 textarea").toBe(true);

    const count = container.querySelector(".code-find-count") as HTMLElement;
    fireEvent.click(next);
    expect(count.textContent, "点 ↓ 没跳到第 2 处").toContain("2/2");
    fireEvent.click(prev);
    expect(count.textContent, "点 ↑ 没跳回第 1 处").toContain("1/2");
  });
});

describe("CodeEditor 滚轮落在查找控件上（轮32 F-33，与浏览态同一份出口）", () => {
  const VIEWPORT_H = 100;
  const CONTENT_H = 400;
  const FIND_DOC = "server.port=8080\nname = a\nport = 8081\n";

  /** jsdom 没布局：滚动容器的偏移与两个高度都得自己装（与缩略图那组同一手法）。 */
  function stubSurface(el: HTMLElement) {
    const offsets = { top: 0 };
    Object.defineProperty(el, "scrollTop", { configurable: true, get: () => offsets.top, set: (v: number) => (offsets.top = v) });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => VIEWPORT_H });
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => CONTENT_H });
    return offsets;
  }

  function wheelOn(target: EventTarget, init: WheelEventInit): WheelEvent {
    const event = new WheelEvent("wheel", { cancelable: true, bubbles: true, ...init });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  function mount() {
    const view = renderEditor(<CodeEditor value={FIND_DOC} onChange={() => {}} format="Properties" />);
    const ta = textarea(view.container);
    const offsets = stubSurface(ta);
    fireEvent.scroll(ta);
    return { ...view, ta, offsets };
  }

  function openFindBar(container: HTMLElement): HTMLElement {
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const bar = container.querySelector(".code-editor .code-find") as HTMLElement;
    expect(bar, "Ctrl+F 没能打开编辑态查找栏").toBeTruthy();
    return bar;
  }

  const transforms = (container: HTMLElement) =>
    [".code-gutter-layer", ".code-lines-layer"].map((sel) => (container.querySelector(sel) as HTMLElement).style.transform);

  it("滚轮打在查找条上：textarea 与行号层、命中行层当帧一起走", () => {
    const { container, offsets } = mount();
    const bar = openFindBar(container);

    const event = wheelOn(bar, { deltaY: 40, deltaMode: 0 });
    expect(offsets.top, "编辑态滚轮打在查找条上，正文一动不动").toBe(40);
    expect(transforms(container), "行号层与命中行层慢一帧").toEqual(["translateY(-40px)", "translateY(-40px)"]);
    expect(event.defaultPrevented, "不取消默认动作：外层面板会跟着一起滚").toBe(true);
  });

  it("deltaMode=1 按行换算（Linux 上 WebKitGTK 常见这一档，当像素就只滚 3px）", () => {
    const { container, offsets } = mount();
    const bar = openFindBar(container);
    wheelOn(bar, { deltaY: 3, deltaMode: 1 });
    expect(offsets.top, "行档位被当像素用：一格只滚 3px，等于没滚").toBe(60);
  });

  it("关着查找栏时，⌕ 浮标上滚一格也要滚正文", () => {
    const { container, offsets } = mount();
    const pill = container.querySelector(".code-editor .code-find-open") as HTMLElement;
    expect(pill, "编辑态悬停入口没渲染出来").toBeTruthy();

    const event = wheelOn(pill, { deltaY: 40, deltaMode: 0 });
    expect(offsets.top, "⌕ 浮标上正文停在原地").toBe(40);
    expect(transforms(container), "行号层与命中行层慢一帧").toEqual(["translateY(-40px)", "translateY(-40px)"]);
    expect(event.defaultPrevented).toBe(true);
  });

  it("关掉再打开：新节点照样接得住", () => {
    const { container, offsets } = mount();
    const bar = openFindBar(container);
    wheelOn(bar, { deltaY: 20 });
    expect(offsets.top, "开栏后新挂上的查找条接不住滚轮").toBe(20);

    const buttons = [...container.querySelectorAll<HTMLElement>(".code-editor .code-find-btn")];
    fireEvent.click(buttons[buttons.length - 1]);
    expect(container.querySelector(".code-editor .code-find"), "✕ 没关掉编辑态查找栏").toBeNull();

    const nextBar = openFindBar(container);
    expect(nextBar, "重开后还是旧节点？").not.toBe(bar);
    offsets.top = 0;
    wheelOn(nextBar, { deltaY: 40 });
    expect(offsets.top, "节点被重建后监听还挂在旧节点上：这条出口静默失活").toBe(40);
  });

  it("纯横向与捏合缩放放手", () => {
    const { container, offsets } = mount();
    const bar = openFindBar(container);
    expect(wheelOn(bar, { deltaY: 0, deltaX: 120 }).defaultPrevented, "横划要留给原生").toBe(false);
    expect(offsets.top).toBe(0);
    expect(wheelOn(bar, { deltaY: 100, ctrlKey: true }).defaultPrevented, "ctrl+wheel 是浏览器缩放").toBe(false);
    expect(offsets.top).toBe(0);
  });
});
