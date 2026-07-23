/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "../test/react";
import { describe, expect, it, vi } from "vitest";
import Combobox from "./Combobox";

const options = [
  { value: "alpha", sub: "group-a" },
  { value: "beta", sub: "group-b" },
];

describe("Combobox", () => {
  it("renders the options menu in a body portal and emits picked values", () => {
    const onChange = vi.fn();
    const onPick = vi.fn();
    render(<Combobox value="a" options={options} onChange={onChange} onPick={onPick} />);

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
});
