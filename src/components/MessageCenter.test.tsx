/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, within } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import ErrorDialog from "./ErrorDialog";
import MessageCenter from "./MessageCenter";
import { clearErrors, reportError, reportMessage } from "../lib/errorCenter";

vi.mock("../lib/clipboard", () => ({
  copyText: vi.fn(),
}));

function renderMessageCenter(locale = "zh-CN") {
  localStorage.setItem("locale", locale);
  return render(
    <I18nProvider>
      <MessageCenter />
      <ErrorDialog />
    </I18nProvider>
  );
}

function openPanel(title = "消息中心"): HTMLElement {
  fireEvent.click(screen.getByTitle(title));
  const panel = document.querySelector(".message-panel") as HTMLElement;
  expect(panel).toBeInTheDocument();
  return panel;
}

describe("MessageCenter", () => {
  beforeEach(() => {
    localStorage.clear();
    clearErrors();
  });

  it("lists messages, copies full detail, deletes items, and opens the detail dialog", async () => {
    const { copyText } = await import("../lib/clipboard");
    vi.mocked(copyText).mockResolvedValue(true);
    renderMessageCenter();

    act(() => {
      reportError({
        title: "Load failed",
        source: "dev / public",
        message: "Short message",
        detail: "Full message\nline 2",
      });
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const panel = openPanel();
    expect(panel).toHaveTextContent("Load failed");
    expect(panel).toHaveTextContent("dev / public");

    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "复制完整消息" }));
    });
    expect(copyText).toHaveBeenCalledWith("Full message\nline 2");

    fireEvent.click(within(panel).getByRole("button", { name: "查看详情" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Full message");

    fireEvent.click(within(panel).getByRole("button", { name: "删除消息" }));
    expect(document.querySelector(".message-panel")).not.toBeInTheDocument();
  });

  it("merges repeated errors by merge key", () => {
    renderMessageCenter();

    act(() => {
      reportError({ title: "Batch failed", message: "first", mergeKey: "batch" });
      reportError({ title: "Batch failed", message: "second", mergeKey: "batch" });
    });

    const panel = openPanel();
    expect(panel).toHaveTextContent("Batch failed");
    expect(panel).toHaveTextContent("second");
    expect(panel).toHaveTextContent("x2");
  });

  it("localizes message center chrome and level labels", () => {
    renderMessageCenter("en-US");

    const emptyPanel = openPanel("Message Center");
    expect(emptyPanel).toHaveTextContent("No messages");
    expect(emptyPanel).toHaveTextContent("Errors, sync progress, and system notifications appear here.");
    expect(within(emptyPanel).getByRole("button", { name: "Clear Messages" })).toBeDisabled();

    act(() => {
      reportMessage({ level: "success", title: "Saved", message: "Saved successfully", toast: false });
      reportMessage({ level: "warning", title: "Slow sync", message: "Took too long", toast: false });
      reportError({ title: "Load failed", message: "Network error", toast: false });
    });

    const panel = document.querySelector(".message-panel") as HTMLElement;
    expect(panel).toHaveTextContent("3 messages");
    expect(panel).toHaveTextContent("Success");
    expect(panel).toHaveTextContent("Warning");
    expect(panel).toHaveTextContent("Error");
    expect(within(panel).getAllByRole("button", { name: "View Details" }).length).toBeGreaterThan(0);
    expect(within(panel).getAllByRole("button", { name: "Copy Full Message" }).length).toBeGreaterThan(0);
    expect(within(panel).getAllByRole("button", { name: "Delete Message" }).length).toBeGreaterThan(0);
  });
});
