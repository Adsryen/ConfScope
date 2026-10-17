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
