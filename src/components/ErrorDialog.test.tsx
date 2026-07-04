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

    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
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
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(within(dialog).getByTitle("Close")).toBeInTheDocument();
  });
});
