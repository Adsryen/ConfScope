/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import CopyButton from "./CopyButton";

vi.mock("../lib/clipboard", () => ({
  copyText: vi.fn(),
}));

function renderCopyButton(props: Parameters<typeof CopyButton>[0], locale = "zh-CN") {
  localStorage.setItem("locale", locale);
  return render(
    <I18nProvider>
      <CopyButton {...props} />
    </I18nProvider>
  );
}

describe("CopyButton", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  it("is disabled without text", () => {
    renderCopyButton({ text: "" });

    expect(screen.getByRole("button", { name: "复制" })).toBeDisabled();
  });

  it("shows copied feedback after successful copy", async () => {
    const { copyText } = await import("../lib/clipboard");
    vi.mocked(copyText).mockResolvedValue(true);
    renderCopyButton({ text: "hello", label: "复制内容" });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "复制内容" }));
    });

    expect(screen.getByRole("button", { name: "✓ 已复制" })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1200);
    });

    expect(screen.getByRole("button", { name: "复制内容" })).toBeInTheDocument();
  });

  it("localizes the default label, tooltip, and copied feedback", async () => {
    const { copyText } = await import("../lib/clipboard");
    vi.mocked(copyText).mockResolvedValue(true);
    renderCopyButton({ text: "hello" }, "en-US");

    const button = screen.getByRole("button", { name: "Copy" });
    expect(button).toHaveAttribute("title", "Copy to clipboard");

    await act(async () => {
      fireEvent.click(button);
    });

    expect(screen.getByRole("button", { name: "✓ Copied" })).toBeInTheDocument();
  });
});
