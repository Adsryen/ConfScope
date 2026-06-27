/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "../test/react";
import { describe, expect, it, vi } from "vitest";
import Pager from "./Pager";

describe("Pager", () => {
  it("renders nothing when there is only one page", () => {
    const { container } = render(<Pager page={1} pages={1} onPage={vi.fn()} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("moves to previous and next pages", () => {
    const onPage = vi.fn();
    render(<Pager page={2} pages={3} onPage={onPage} />);

    fireEvent.click(screen.getByTitle("上一页"));
    fireEvent.click(screen.getByTitle("下一页"));

    expect(onPage).toHaveBeenNthCalledWith(1, 1);
    expect(onPage).toHaveBeenNthCalledWith(2, 3);
  });

  it("disables navigation at boundaries or while loading", () => {
    const onPage = vi.fn();
    const { rerender } = render(<Pager page={1} pages={3} onPage={onPage} />);

    expect(screen.getByTitle("上一页")).toBeDisabled();

    rerender(<Pager page={2} pages={3} loading onPage={onPage} />);

    expect(screen.getByTitle("上一页")).toBeDisabled();
    expect(screen.getByTitle("下一页")).toBeDisabled();
  });
});
