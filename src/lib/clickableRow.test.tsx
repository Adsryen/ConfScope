/**
 * @vitest-environment jsdom
 */
import { fireEvent, render } from "../test/react";
import { describe, expect, it, vi } from "vitest";
import { clickableRowProps } from "./clickableRow";

function renderRow(onActivate: () => void, options?: Parameters<typeof clickableRowProps>[1]) {
  return render(
    <div {...clickableRowProps(onActivate, options)}>
      <span data-testid="child">行内文字</span>
    </div>
  );
}

describe("clickableRowProps", () => {
  it("Enter 与空格都等价于点击这一行", () => {
    const onActivate = vi.fn();
    const { getByText } = renderRow(onActivate);
    const row = getByText("行内文字").parentElement as HTMLElement;

    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });

    expect(onActivate).toHaveBeenCalledTimes(2);
  });

  it("空格按下后阻止默认行为，列表不会被滚走", () => {
    const { getByText } = renderRow(vi.fn());
    const row = getByText("行内文字").parentElement as HTMLElement;

    expect(fireEvent.keyDown(row, { key: " " })).toBe(false); // preventDefault 过则返回 false
  });

  it("无关按键既不触发也不拦默认行为", () => {
    const onActivate = vi.fn();
    const { getByText } = renderRow(onActivate);
    const row = getByText("行内文字").parentElement as HTMLElement;

    expect(fireEvent.keyDown(row, { key: "a" })).toBe(true);
    expect(fireEvent.keyDown(row, { key: "Escape" })).toBe(true);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("输入法组合态里的空格与 Enter 属于候选词，页面让路", () => {
    const onActivate = vi.fn();
    const { getByText } = renderRow(onActivate);
    const row = getByText("行内文字").parentElement as HTMLElement;

    fireEvent.keyDown(row, { key: " ", isComposing: true });
    fireEvent.keyDown(row, { key: "Enter", keyCode: 229 });

    // WebView 里 isComposing 只挂在原生事件上，React 合成事件不透传，这条路径单独验一次
    const composing = new window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    Object.defineProperty(composing, "isComposing", { value: true });
    row.dispatchEvent(composing);

    expect(onActivate).not.toHaveBeenCalled();
  });

  it("行内控件自己的 Enter 不重复触发整行", () => {
    const onActivate = vi.fn();
    const { getByText } = renderRow(onActivate);
    const child = getByText("行内文字");

    fireEvent.keyDown(child, { key: "Enter" });

    expect(onActivate).not.toHaveBeenCalled();
  });

  it("默认是 button 语义，选中态带 aria-current", () => {
    const { getByText } = renderRow(vi.fn(), { selected: true });
    const row = getByText("行内文字").parentElement as HTMLElement;

    expect(row).toHaveAttribute("role", "button");
    expect(row).toHaveAttribute("tabindex", "0");
    expect(row).toHaveAttribute("aria-current", "true");
  });

  it("行内有按钮时改用 group，避免子树被无障碍树隐藏", () => {
    const { getByText } = renderRow(vi.fn(), { role: "group" });
    const row = getByText("行内文字").parentElement as HTMLElement;

    expect(row).toHaveAttribute("role", "group");
    expect(row).not.toHaveAttribute("aria-current");
  });

  it("不可选的行不进 Tab 顺序，Enter 也不生效", () => {
    const onActivate = vi.fn();
    const { getByText } = renderRow(onActivate, { disabled: true });
    const row = getByText("行内文字").parentElement as HTMLElement;

    expect(row).toHaveAttribute("tabindex", "-1");
    expect(row).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onActivate).not.toHaveBeenCalled();
  });
});
