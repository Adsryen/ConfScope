/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from "../test/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeAllPopovers } from "../lib/popoverBus";
import { I18nProvider } from "../i18n";
import Combobox from "./Combobox";

const options = [
  { value: "alpha", sub: "group-a" },
  { value: "beta", sub: "group-b" },
];

const renderCombo = (props: React.ComponentProps<typeof Combobox>) => render(<I18nProvider>{<Combobox {...props} />}</I18nProvider>);
const optionNodes = () => [...document.querySelectorAll<HTMLElement>(".combo-option")];
/** 打开候选弹层：真实聚焦输入框（便于断言焦点未丢），再补发 focus 事件走 onFocus 展开路径。 */
const openMenu = (input: HTMLElement) => {
  input.focus();
  fireEvent.focus(input);
};

describe("Combobox", () => {
  afterEach(() => localStorage.clear());

  it("宿主页面被保活隐藏（模式切换）时收起候选弹层", () => {
    renderCombo({ value: "a", options, onChange: vi.fn() });

    fireEvent.focus(screen.getByRole("textbox"));
    expect(document.querySelector(".combo-menu-portal")).toBeInTheDocument();

    act(() => closeAllPopovers());

    expect(document.querySelector(".combo-menu-portal")).not.toBeInTheDocument();
  });

  it("renders the options menu in a body portal and emits picked values", () => {
    const onChange = vi.fn();
    const onPick = vi.fn();
    renderCombo({ value: "a", options, onChange, onPick });

    fireEvent.focus(screen.getByRole("textbox"));

    const menu = document.querySelector(".combo-menu-portal") as HTMLElement;
    expect(menu).toBeInTheDocument();
    expect(menu.parentElement).toBe(document.body);
    expect(menu).toHaveStyle({ position: "fixed" });

    fireEvent.mouseDown(screen.getByText("alpha"));

    expect(onChange).toHaveBeenCalledWith("alpha");
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ value: "alpha", sub: "group-a" }));
    expect(screen.queryByText("alpha")).not.toBeInTheDocument();
  });

  it("opens on ArrowDown and highlights the current value", () => {
    renderCombo({ value: "beta", options, onChange: vi.fn() });
    const input = screen.getByRole("textbox");

    fireEvent.keyDown(input, { key: "ArrowDown" }); // 收起态：先展开

    const [beta] = optionNodes(); // 查询即当前值，其余候选被模糊过滤掉
    expect(beta).toHaveClass("active");
    expect(beta).toHaveClass("highlighted");
    expect(input).toHaveAttribute("aria-activedescendant", beta.id);
    expect(input).toHaveAttribute("aria-expanded", "true");
  });

  it("highlights the best match when the caret lands on a non-empty query", () => {
    const view = renderCombo({ value: "", options, onChange: vi.fn() });
    const input = screen.getByRole("textbox");

    // 受控父组件把输入回灌成 value："a" 同时命中 alpha/beta
    view.rerender(
      <I18nProvider>
        <Combobox value="a" options={options} onChange={vi.fn()} />
      </I18nProvider>
    );
    openMenu(input);

    const [alpha, beta] = optionNodes();
    expect(alpha).toHaveClass("highlighted");
    expect(beta).not.toHaveClass("highlighted");
  });

  it("moves the highlight with arrows and picks with Enter without stealing focus", () => {
    const onChange = vi.fn();
    const onPick = vi.fn();
    renderCombo({ value: "a", options, onChange, onPick });
    const input = screen.getByRole("textbox");

    openMenu(input); // 展开，高亮 alpha
    fireEvent.keyDown(input, { key: "ArrowDown" }); // beta
    expect(document.querySelector(".combo-option.highlighted")).toHaveTextContent("beta");

    fireEvent.keyDown(input, { key: "ArrowUp" }); // 回到 alpha
    expect(document.querySelector(".combo-option.highlighted")).toHaveTextContent("alpha");

    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("alpha");
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ value: "alpha" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(input);
  });

  it("jumps to first/last candidate with Home/End", () => {
    const onChange = vi.fn();
    renderCombo({ value: "a", options, onChange });
    const input = screen.getByRole("textbox");

    openMenu(input);
    fireEvent.keyDown(input, { key: "End" });
    expect(document.querySelector(".combo-option.highlighted")).toHaveTextContent("beta");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("beta");
  });

  it("hands Home/End back to the caret when the menu is closed", () => {
    renderCombo({ value: "a", options, onChange: vi.fn() });
    const input = screen.getByRole("textbox");

    const event = new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true });
    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it("re-highlights the best match while typing so Enter picks it", () => {
    const onChange = vi.fn();
    const view = renderCombo({ value: "", options, onChange });
    const input = screen.getByRole("textbox");

    openMenu(input);
    fireEvent.change(input, { target: { value: "bet" } });
    // 受控用法：父组件把输入回灌为新的 value
    view.rerender(
      <I18nProvider>
        <Combobox value="bet" options={options} onChange={onChange} />
      </I18nProvider>
    );
    expect(document.querySelector(".combo-option.highlighted")).toHaveTextContent("beta");

    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenLastCalledWith("beta");
  });

  it("closes on Escape but keeps the caret in the input", () => {
    renderCombo({ value: "a", options, onChange: vi.fn() });
    const input = screen.getByRole("textbox");

    openMenu(input);
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(input);
  });

  it("tells the user how many candidates were cut off instead of hiding them silently", () => {
    localStorage.setItem("locale", "zh-CN");
    const many = Array.from({ length: 60 }, (_, i) => ({ value: `zz${i}` }));
    const rerender = renderCombo({ value: "zz", options: many, onChange: vi.fn() });

    openMenu(screen.getByRole("textbox"));

    expect(optionNodes()).toHaveLength(50);
    expect(screen.getByText("还有 10 项未显示，请继续输入缩小范围")).toBeInTheDocument();

    rerender.rerender(
      <I18nProvider>
        <Combobox value="zz59" options={many} onChange={vi.fn()} />
      </I18nProvider>
    );
    openMenu(screen.getByRole("textbox"));

    expect(screen.queryByText(/未显示/)).not.toBeInTheDocument();
  });
});
