/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "../test/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import Pager from "./Pager";

function renderPager(props: Parameters<typeof Pager>[0], locale = "zh-CN") {
  localStorage.setItem("locale", locale);
  return render(
    <I18nProvider>
      <Pager {...props} />
    </I18nProvider>
  );
}

describe("Pager", () => {
  it("renders nothing when there is only one page", () => {
    const { container } = renderPager({ page: 1, pages: 1, onPage: vi.fn() });

    expect(container).toBeEmptyDOMElement();
  });

  it("moves to previous and next pages", () => {
    const onPage = vi.fn();
    renderPager({ page: 2, pages: 3, onPage });

    fireEvent.click(screen.getByTitle("上一页"));
    fireEvent.click(screen.getByTitle("下一页"));

    expect(onPage).toHaveBeenNthCalledWith(1, 1);
    expect(onPage).toHaveBeenNthCalledWith(2, 3);
  });

  it("disables navigation at boundaries or while loading", () => {
    const onPage = vi.fn();
    const { rerender } = renderPager({ page: 1, pages: 3, onPage });

    expect(screen.getByTitle("上一页")).toBeDisabled();

    rerender(
      <I18nProvider>
        <Pager page={2} pages={3} loading onPage={onPage} />
      </I18nProvider>
    );

    expect(screen.getByTitle("上一页")).toBeDisabled();
    expect(screen.getByTitle("下一页")).toBeDisabled();
  });

  it("localizes navigation titles", () => {
    renderPager({ page: 2, pages: 3, onPage: vi.fn() }, "en-US");

    expect(screen.getByTitle("Previous Page")).toBeInTheDocument();
    expect(screen.getByTitle("Next Page")).toBeInTheDocument();
  });
});
