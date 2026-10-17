/**
 * @vitest-environment jsdom
 *
 * 查找栏开栏时的初值来源（轮26 F-3）：浏览态 CodeView 与编辑态 CodeEditor 必须同口径——
 * **选区 > 栏内旧词 > 外部搜索词**。纯函数部分在 ../lib/findSelection.test.ts 已经钉死，
 * 这里只验"接线"：组件真的在 setState 之前、并从正确的那一层把选区读走了。
 * 接线最容易错的三处：① 等输入框聚焦后再读（选区已被清）；② 读了宿主输入框/别的视图的选区；
 * ③ 编辑态去读 window.getSelection()（textarea 的选中内容根本不在那儿）。
 */
import { fireEvent, render } from "../test/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { I18nProvider } from "../i18n";
import CodeView from "./CodeView";
import CodeEditor from "./CodeEditor";
import { clearViewState } from "../lib/viewState";
import { MAX_FIND_TERM_FROM_SELECTION } from "../lib/findSelection";

const BROWSE_CODE = 'server.port=8080\nname = "confscope"\nqps: 10000\nport = 8081\n';

function renderView(code: string, props: { searchTerm?: string; active?: boolean } = {}) {
  localStorage.setItem("locale", "zh-CN");
  return render(
    <I18nProvider>
      <CodeView code={code} format="TEXT" {...props} />
    </I18nProvider>
  );
}

function EditHarness() {
  const [value, setValue] = useState(BROWSE_CODE);
  localStorage.setItem("locale", "zh-CN");
  return (
    <I18nProvider>
      <CodeEditor value={value} onChange={setValue} format="Properties" />
    </I18nProvider>
  );
}

/** 在 scope 的可见文本里选中 needle（jsdom 支持真 Range，不用 stub）。 */
function selectInScope(scope: HTMLElement, needle: string): void {
  const start = (scope.textContent ?? "").indexOf(needle);
  expect(start, `正文里没有 ${needle}`).toBeGreaterThanOrEqual(0);
  const end = start + needle.length;
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  let consumed = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const len = node.textContent?.length ?? 0;
    if (!startNode && consumed + len >= start) {
      startNode = node as Text;
      startOffset = start - consumed;
    }
    if (startNode && consumed + len >= end) {
      endNode = node as Text;
      endOffset = end - consumed;
      break;
    }
    consumed += len;
  }
  expect(startNode && endNode, `没能在 scope 里定位 ${needle}`).toBeTruthy();
  const range = document.createRange();
  range.setStart(startNode!, startOffset);
  range.setEnd(endNode!, endOffset);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  expect(sel.toString(), "jsdom 没把选区建起来，后面的断言就没有意义了").toBe(needle);
}

function openWithCtrlF(): void {
  fireEvent.keyDown(window, { key: "f", ctrlKey: true });
}

function findInput(container: HTMLElement): HTMLInputElement | null {
  return container.querySelector(".code-find-input") as HTMLInputElement | null;
}

describe("浏览态：选中正文后按 Ctrl+F，查找词就是那段选中", () => {
  beforeEach(() => {
    clearViewState("codeFind.");
    window.getSelection()?.removeAllRanges();
    (document.activeElement as HTMLElement | null)?.blur?.();
  });

  it("有选区时开栏即搜选区，而不是外部搜索词", () => {
    const { container } = renderView(BROWSE_CODE, { searchTerm: "port" });
    const area = container.querySelector(".code-area") as HTMLElement;
    selectInScope(area, 'name = "confscope"');

    openWithCtrlF();

    expect(findInput(container)?.value).toBe('name = "confscope"');
  });

  it("点 ⌕ 按钮开栏走同一条口径（按钮的普通点击不会清掉正文选区）", () => {
    const { container } = renderView(BROWSE_CODE);
    const area = container.querySelector(".code-area") as HTMLElement;
    selectInScope(area, "qps: 10000");

    fireEvent.click(container.querySelector(".code-find-open") as HTMLElement);

    expect(findInput(container)?.value).toBe("qps: 10000");
  });

  it("跨行选区只取首行，选区里的行尾空白被跳过", () => {
    const { container } = renderView(BROWSE_CODE);
    const area = container.querySelector(".code-area") as HTMLElement;
    selectInScope(area, "port = 8081\n");

    openWithCtrlF();

    expect(findInput(container)?.value).toBe("port = 8081");
  });

  it("超长选区截断到上限，不把整块 JSON 塞进查找框", () => {
    const long = "z".repeat(MAX_FIND_TERM_FROM_SELECTION + 40);
    const { container } = renderView(`${long}\nrest\n`);
    const area = container.querySelector(".code-area") as HTMLElement;
    selectInScope(area, long);

    openWithCtrlF();

    expect(findInput(container)?.value).toBe(long.slice(0, MAX_FIND_TERM_FROM_SELECTION));
  });

  it("没选区时保持旧口径：沿用外部搜索词（CodeView 既有用例的前提）", () => {
    const { container } = renderView(BROWSE_CODE, { searchTerm: "port" });

    openWithCtrlF();

    expect(findInput(container)?.value).toBe("port");
  });

  it("栏已开着、里面有用户刚打的词时，再按 Ctrl+F 不该把词清掉", () => {
    const { container } = renderView(BROWSE_CODE, { searchTerm: "port" });
    openWithCtrlF();
    fireEvent.change(findInput(container) as HTMLInputElement, { target: { value: "qps" } });

    // 此时没有正文选区：旧词必须压过外部 searchTerm
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });

    expect(findInput(container)?.value).toBe("qps");
  });

  it("栏已开着又选了新的文字：选区赢过旧词（这正是这次按键想做的事）", () => {
    const { container } = renderView(BROWSE_CODE);
    openWithCtrlF();
    fireEvent.change(findInput(container) as HTMLInputElement, { target: { value: "port" } });

    const area = container.querySelector(".code-area") as HTMLElement;
    selectInScope(area, "qps: 10000");
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });

    expect(findInput(container)?.value).toBe("qps: 10000");
  });

  it("绝不劫持宿主输入框里的选中：焦点在别的 input 里选中文字时仍沿用外部词", () => {
    localStorage.setItem("locale", "zh-CN");
    const hostInput = document.createElement("input");
    hostInput.value = "confscope";
    document.body.appendChild(hostInput);
    const { container } = renderView(BROWSE_CODE, { searchTerm: "port" });

    hostInput.focus();
    hostInput.setSelectionRange(0, 9);

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });

    // 焦点在可编辑控件上时本视图根本不接管 Ctrl+F；
    // 即便被接管，selectionTextWithin 的 scope 闸也必须挡住这次劫持。
    expect(findInput(container)?.value ?? "").not.toBe("confscope");
    hostInput.remove();
  });

  it("被保活隐藏的视图不参与：选区留给可见的那一个", () => {
    localStorage.setItem("locale", "zh-CN");
    const { container } = render(
      <I18nProvider>
        <div>
          <div id="hidden">
            <CodeView code={BROWSE_CODE} format="TEXT" active={false} />
          </div>
          <CodeView code={BROWSE_CODE} format="TEXT" active searchTerm="port" />
        </div>
      </I18nProvider>
    );
    const areas = container.querySelectorAll<HTMLElement>(".code-area");
    expect(areas.length).toBe(2);
    // 选区落在"隐藏"那一份正文里
    selectInScope(areas[0], "qps: 10000");

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });

    const visibleBar = container.querySelectorAll(".code-find-input")[0] as HTMLInputElement;
    expect(visibleBar.value).toBe("port");
  });
});

describe("编辑态：textarea 的选中内容同样能开栏即搜", () => {
  beforeEach(() => {
    clearViewState("codeFind.");
    window.getSelection()?.removeAllRanges();
    (document.activeElement as HTMLElement | null)?.blur?.();
  });

  it("textarea.setSelectionRange 后按 Ctrl+F，查找词来自选区首行", () => {
    const { container } = render(<EditHarness />);
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    const start = ta.value.indexOf('name = "confscope"');
    ta.setSelectionRange(start, start + 'name = "confscope"'.length);

    openWithCtrlF();

    expect(findInput(container)?.value).toBe('name = "confscope"');
  });

  it("折叠光标（只是把光标放上去）不劫持：沿用外部搜索词", () => {
    const { container } = render(
      <I18nProvider>
        <CodeEditor value={BROWSE_CODE} onChange={() => {}} format="Properties" searchTerm="port" />
      </I18nProvider>
    );
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    ta.setSelectionRange(3, 3);

    openWithCtrlF();

    expect(findInput(container)?.value).toBe("port");
  });

  it("浏览态与编辑态读同一条优先级：编辑态有选区时也是选区赢过旧词", () => {
    const { container } = render(<EditHarness />);
    openWithCtrlF();
    fireEvent.change(findInput(container) as HTMLInputElement, { target: { value: "port" } });

    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    ta.setSelectionRange(0, "server.port".length);
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });

    expect(findInput(container)?.value).toBe("server.port");
  });
});
