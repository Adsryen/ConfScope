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

  // R29：按钮文本只有 ‹ ›，读屏念「小于号」；修前 getByRole(name:"上一页") 取不到东西（名字算出来是 ‹）。
  it("分页按钮靠 aria-label 拿到句子级可访问名", () => {
    renderPager({ page: 2, pages: 3, onPage: vi.fn() });

    expect(screen.getByRole("button", { name: "上一页" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下一页" })).toBeInTheDocument();
    // title 仍然保留，鼠标悬停看提示的行为没被换掉
    expect(screen.getByTitle("上一页")).toBe(screen.getByRole("button", { name: "上一页" }));
  });

  it("分页条整体是可命名的 group，页码念得出「第几页共几页」", () => {
    renderPager({ page: 2, pages: 3, onPage: vi.fn() });

    const group = screen.getByRole("group", { name: "分页导航" });
    expect(group).toBeInTheDocument();
    // 眼睛看到的就是读屏念的那句：修前是 "2 / 3"，念出来是「二 斜杠 三」
    expect(group).toHaveTextContent("第 2 页，共 3 页");
    expect(screen.getByText("第 2 页，共 3 页")).toBeInTheDocument();
  });

  it("en-US 下分页按钮与页码同样可命名", () => {
    renderPager({ page: 2, pages: 3, onPage: vi.fn() }, "en-US");

    expect(screen.getByRole("group", { name: "Pagination" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous Page" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next Page" })).toBeInTheDocument();
    expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();
  });
});
