/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from "../test/react";
import { describe, expect, it, vi } from "vitest";
import { closeAllPopovers } from "../lib/popoverBus";
import Select from "./Select";

const options = [
  { value: "json", label: "JSON" },
  { value: "yaml", label: "YAML" },
];

const manyOptions = Array.from({ length: 8 }, (_, i) => ({ value: `k${i}`, label: `Option ${i}` }));
const wordOptions = [
  { value: "al", label: "Alpha" },
  { value: "de", label: "Delta" },
  { value: "st", label: "Staging" },
  { value: "su", label: "Success" },
];

/** 取弹层里的选项节点（避免与触发器里的已选标签文本冲突）。 */
const optionNodes = () => [...document.querySelectorAll<HTMLElement>(".sel-option")];

describe("Select", () => {
  it("shows the selected label", () => {
    render(<Select value="json" options={options} onChange={vi.fn()} />);

    expect(screen.getByRole("button")).toHaveTextContent("JSON");
  });

  it("opens options and emits selected value", () => {
    const onChange = vi.fn();
    render(<Select value="json" options={options} onChange={onChange} />);

    fireEvent.pointerDown(screen.getByRole("button"));
    fireEvent.mouseDown(screen.getByText("YAML"));

    expect(onChange).toHaveBeenCalledWith("yaml");
    expect(screen.queryByText("YAML")).not.toBeInTheDocument();
  });

  it("宿主页面被保活隐藏（模式切换）时收起展开的菜单", () => {
    render(<Select value="json" options={options} onChange={vi.fn()} />);

    fireEvent.pointerDown(screen.getByRole("button"));
    const menu = document.querySelector(".sel-menu-portal") as HTMLElement;
    // 菜单挂在 document.body 上，不在页面子树里，容器加 hidden 也挡不住它
    expect(menu.parentElement).toBe(document.body);

    act(() => closeAllPopovers());

    expect(document.querySelector(".sel-menu-portal")).not.toBeInTheDocument();
  });

  it("closes on Escape", () => {
    render(<Select value="json" options={options} onChange={vi.fn()} />);

    fireEvent.pointerDown(screen.getByRole("button"));
    expect(screen.getByText("YAML")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByText("YAML")).not.toBeInTheDocument();
  });
  it("opens on ArrowDown and highlights the current value", () => {
    render(<Select value="yaml" options={options} onChange={vi.fn()} />);
    const trigger = screen.getByRole("button");

    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const [json, yaml] = optionNodes();
    expect(yaml).toHaveClass("active");
    expect(yaml).toHaveClass("highlighted");
    expect(json).not.toHaveClass("highlighted");
    expect(trigger).toHaveAttribute("aria-activedescendant", yaml.id);
  });

  it("moves the highlight with ArrowUp/ArrowDown and selects with Enter", () => {
    const onChange = vi.fn();
    render(<Select value="json" options={manyOptions} onChange={onChange} />);
    const trigger = screen.getByRole("button");

    fireEvent.keyDown(trigger, { key: "ArrowDown" }); // 展开并高亮当前项 k0
    fireEvent.keyDown(trigger, { key: "ArrowDown" }); // k1
    fireEvent.keyDown(trigger, { key: "ArrowDown" }); // k2
    expect(document.querySelector(".sel-option.highlighted")).toHaveTextContent("Option 2");

    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    expect(document.querySelector(".sel-option.highlighted")).toHaveTextContent("Option 1");

    fireEvent.keyDown(trigger, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("k1");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("selects the highlighted option with Space", () => {
    const onChange = vi.fn();
    render(<Select value="json" options={options} onChange={onChange} />);
    const trigger = screen.getByRole("button");

    fireEvent.keyDown(trigger, { key: "ArrowDown" }); // 展开并高亮 JSON
    fireEvent.keyDown(trigger, { key: "ArrowDown" }); // 移到 YAML
    fireEvent.keyDown(trigger, { key: " " });

    expect(onChange).toHaveBeenCalledWith("yaml");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("jumps to first/last option with Home/End", () => {
    const onChange = vi.fn();
    render(<Select value="k0" options={manyOptions} onChange={onChange} />);
    const trigger = screen.getByRole("button");

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "End" });
    expect(document.querySelector(".sel-option.highlighted")).toHaveTextContent("Option 7");

    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("k7");

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Home" });
    expect(document.querySelector(".sel-option.highlighted")).toHaveTextContent("Option 0");
  });

  it("stops at the list bounds instead of wrapping around", () => {
    render(<Select value="k0" options={manyOptions} onChange={vi.fn()} />);
    const trigger = screen.getByRole("button");

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    for (let i = 0; i < 12; i++) fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(document.querySelector(".sel-option.highlighted")).toHaveTextContent("Option 7");

    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    expect(document.querySelector(".sel-option.highlighted")).toHaveTextContent("Option 6");
  });

  it("jumps to the option matching a typed character", () => {
    const onChange = vi.fn();
    render(<Select value="al" options={wordOptions} onChange={onChange} />);
    const trigger = screen.getByRole("button");

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "d" });

    expect(document.querySelector(".sel-option.highlighted")).toHaveTextContent("Delta");
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("de");
  });

  it("accumulates typed characters into a prefix", () => {
    const onChange = vi.fn();
    render(<Select value="al" options={wordOptions} onChange={onChange} />);
    const trigger = screen.getByRole("button");

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "s" }); // Staging
    fireEvent.keyDown(trigger, { key: "u" }); // 前缀 "su" -> Success

    expect(document.querySelector(".sel-option.highlighted")).toHaveTextContent("Success");
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("su");
  });

  it("leaves Home/End to the page when the menu is closed", () => {
    render(<Select value="json" options={options} onChange={vi.fn()} />);
    const trigger = screen.getByRole("button");

    const event = new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true });
    trigger.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it("returns focus to the trigger after Escape closes the menu", () => {
    render(<Select value="json" options={options} onChange={vi.fn()} />);
    const trigger = screen.getByRole("button");
    trigger.focus();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("renders the options menu in a body portal so it is not clipped by parent overflow", () => {
    render(<Select value="json" options={options} onChange={vi.fn()} />);

    fireEvent.pointerDown(screen.getByRole("button"));

    const menu = document.querySelector(".sel-menu-portal") as HTMLElement;
    expect(menu).toBeInTheDocument();
    expect(menu.parentElement).toBe(document.body);
    expect(menu).toHaveStyle({ position: "fixed" });
  });
});
