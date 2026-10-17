/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, within } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import ErrorDialog from "./ErrorDialog";
import { clearErrors, reportError, showMessageDetail } from "../lib/errorCenter";

vi.mock("../lib/clipboard", () => ({
  copyText: vi.fn(),
}));

function renderErrorDialog(locale = "zh-CN") {
  localStorage.setItem("locale", locale);
  return render(
    <I18nProvider>
      <ErrorDialog />
    </I18nProvider>
  );
}

describe("ErrorDialog", () => {
  beforeEach(() => {
    localStorage.clear();
    clearErrors();
  });

  it("shows reported errors, copies the full detail, and closes", async () => {
    const { copyText } = await import("../lib/clipboard");
    vi.mocked(copyText).mockResolvedValue(true);
    renderErrorDialog();

    act(() => {
      const id = reportError({
        title: "Load failed",
        source: "dev / public",
        message: "Short message",
        detail: "Full message\nline 2",
      });
      showMessageDetail(id);
    });

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Load failed")).toBeInTheDocument();
    expect(within(dialog).getByText("dev / public")).toBeInTheDocument();
    expect(within(dialog).getByText("Short message")).toBeInTheDocument();
    expect(within(dialog).getByText(/Full message/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "复制完整错误" }));
    });
    expect(copyText).toHaveBeenCalledWith("Full message\nline 2");

    // R29 之后 × 有了 aria-label，和页脚主按钮同名「关闭」（本来就是同一个动作）。
    // getByLabelText 只认标签关联，正好把标题栏的 × 单独取出来，顺带证明它真的有了可访问名。
    fireEvent.click(within(dialog).getByLabelText("关闭"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("runs the retry action after closing the dialog", () => {
    const onAction = vi.fn();
    renderErrorDialog();

    act(() => {
      const id = reportError({
        title: "Load failed",
        message: "retry me",
        actionLabel: "Retry now",
        onAction,
      });
      showMessageDetail(id);
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("localizes dialog chrome and fallback action labels", () => {
    const onAction = vi.fn();
    renderErrorDialog("en-US");

    act(() => {
      const id = reportError({
        title: "Load failed",
        message: "Short message",
        detail: "Full message\nline 2",
        onAction,
      });
      showMessageDetail(id);
    });

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Full Error")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Copy Full Error" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    // 两个「Close」是有意重名：标题栏的 × 和页脚主按钮都只关闭弹框，读屏念出来都听得懂。
    expect(within(dialog).getAllByRole("button", { name: "Close" })).toHaveLength(2);
    expect(within(dialog).getByTitle("Close")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Close")).toHaveAccessibleName("Close");
  });
});

describe("ErrorDialog 只读详情键盘可达（R39）", () => {
  beforeEach(() => {
    localStorage.clear();
    clearErrors();
  });

  it("完整错误正文能 Tab 停住，读屏念得出区域名", () => {
    renderErrorDialog();
    act(() => {
      const id = reportError({
        title: "Load failed",
        source: "dev / public",
        message: "Short message",
        detail: "Full message\nline 2",
      });
      showMessageDetail(id);
    });

    const region = screen.getByRole("region", { name: "完整错误" });
    expect(region).toHaveAttribute("tabindex", "0");
    region.focus();
    expect(document.activeElement).toBe(region);
  });
});

describe("ErrorDialog 切换报错滚动复位（波29 R49）", () => {
  beforeEach(() => {
    localStorage.clear();
    clearErrors();
  });

  /** jsdom 没有布局引擎，scrollTop 恒为 0；挂可读写的实现才能断言"被重置"。 */
  function stubScroll(el: HTMLElement) {
    const offsets = { top: 0 };
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => offsets.top,
      set: (value: number) => {
        offsets.top = value;
      },
    });
    return offsets;
  }

  function showDetail(item: { title: string; message: string; detail: string }) {
    act(() => {
      const id = reportError({ ...item, level: "error" as const });
      showMessageDetail(id);
    });
  }

  it("从一个报错切到另一个报错，完整错误正文回到顶部", () => {
    renderErrorDialog();
    showDetail({ title: "Load failed", message: "first", detail: "stack A\nat foo" });

    const pre = screen.getByRole("region", { name: "完整错误" }) as HTMLElement;
    const offsets = stubScroll(pre);
    offsets.top = 180;

    showDetail({ title: "Save failed", message: "second", detail: "stack B\nat bar" });

    expect(pre.textContent).toContain("stack B");
    expect(offsets.top).toBe(0);
  });

  it("同一报错重复播报只更新计数，不吞掉用户滚到的位置", () => {
    renderErrorDialog();
    showDetail({ title: "Load failed", message: "boom", detail: "stack A\nat foo" });

    const pre = screen.getByRole("region", { name: "完整错误" }) as HTMLElement;
    const offsets = stubScroll(pre);
    offsets.top = 120;

    showDetail({ title: "Load failed", message: "boom", detail: "stack A\nat foo" });

    expect(pre.textContent).toContain("stack A");
    expect(offsets.top).toBe(120);
  });
});
