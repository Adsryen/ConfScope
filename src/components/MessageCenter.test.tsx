/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, within } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ErrorDialog from "./ErrorDialog";
import MessageCenter from "./MessageCenter";
import { clearErrors, reportError } from "../lib/errorCenter";

vi.mock("../lib/clipboard", () => ({
  copyText: vi.fn(),
}));

function openPanel(): HTMLElement {
  fireEvent.click(screen.getByTitle("消息中心"));
  const panel = document.querySelector(".message-panel") as HTMLElement;
  expect(panel).toBeInTheDocument();
  return panel;
}

describe("MessageCenter", () => {
  beforeEach(() => {
    clearErrors();
  });

  it("lists messages, copies full detail, deletes items, and opens the detail dialog", async () => {
    const { copyText } = await import("../lib/clipboard");
    vi.mocked(copyText).mockResolvedValue(true);
    render(
      <>
        <MessageCenter />
        <ErrorDialog />
      </>
    );

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
    render(<MessageCenter />);

    act(() => {
      reportError({ title: "Batch failed", message: "first", mergeKey: "batch" });
      reportError({ title: "Batch failed", message: "second", mergeKey: "batch" });
    });

    const panel = openPanel();
    expect(panel).toHaveTextContent("Batch failed");
    expect(panel).toHaveTextContent("second");
    expect(panel).toHaveTextContent("x2");
  });
});
