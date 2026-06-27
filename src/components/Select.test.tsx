/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "../test/react";
import { describe, expect, it, vi } from "vitest";
import Select from "./Select";

const options = [
  { value: "json", label: "JSON" },
  { value: "yaml", label: "YAML" },
];

describe("Select", () => {
  it("shows the selected label", () => {
    render(<Select value="json" options={options} onChange={vi.fn()} />);

    expect(screen.getByRole("button")).toHaveTextContent("JSON");
  });

  it("opens options and emits selected value", () => {
    const onChange = vi.fn();
    render(<Select value="json" options={options} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button"));
    fireEvent.mouseDown(screen.getByText("YAML"));

    expect(onChange).toHaveBeenCalledWith("yaml");
    expect(screen.queryByText("YAML")).not.toBeInTheDocument();
  });

  it("closes on Escape", () => {
    render(<Select value="json" options={options} onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("YAML")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByText("YAML")).not.toBeInTheDocument();
  });
});
