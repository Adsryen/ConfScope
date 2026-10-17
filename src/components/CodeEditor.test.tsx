/**
 * @vitest-environment jsdom
 */
import { fireEvent, render } from "../test/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import CodeEditor from "./CodeEditor";

const INITIAL = "server.port=8080";

function Harness() {
  const [value, setValue] = useState(INITIAL);
  return <CodeEditor value={value} onChange={setValue} format="Properties" />;
}

function textarea(container: HTMLElement) {
  return container.querySelector("textarea") as HTMLTextAreaElement;
}

describe("CodeEditor Tab 与输入法组合态（R23）", () => {
  it("非组合态 Tab 插入两个空格，不切换焦点", () => {
    const { container } = render(<Harness />);
    const ta = textarea(container);
    ta.selectionStart = ta.selectionEnd = 0;

    const notPrevented = fireEvent.keyDown(ta, { key: "Tab" });

    expect(ta.value).toBe("  " + INITIAL);
    // 我们拦下了默认行为（否则会跳出编辑器）
    expect(notPrevented).toBe(false);
  });

  it("组合态的 Tab 属于输入法：不插空格、也不拦截默认行为", () => {
    const { container } = render(<Harness />);
    const ta = textarea(container);
    ta.selectionStart = ta.selectionEnd = 0;

    const notPrevented = fireEvent.keyDown(ta, { key: "Tab", isComposing: true });

    expect(ta.value).toBe(INITIAL);
    expect(notPrevented).toBe(true);
  });

  it("组合态的另一种信号 keyCode 229 同样放行给输入法", () => {
    const { container } = render(<Harness />);
    const ta = textarea(container);
    ta.selectionStart = ta.selectionEnd = 0;

    const notPrevented = fireEvent.keyDown(ta, { key: "Tab", keyCode: 229 });

    expect(ta.value).toBe(INITIAL);
    expect(notPrevented).toBe(true);
  });
});
