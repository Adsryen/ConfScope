/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CopyButton from "./CopyButton";

vi.mock("../lib/clipboard", () => ({
  copyText: vi.fn(),
}));

describe("CopyButton", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("is disabled without text", () => {
    render(<CopyButton text="" />);

    expect(screen.getByRole("button", { name: "复制" })).toBeDisabled();
  });

  it("shows copied feedback after successful copy", async () => {
    const { copyText } = await import("../lib/clipboard");
    vi.mocked(copyText).mockResolvedValue(true);
    render(<CopyButton text="hello" label="复制内容" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "复制内容" }));
    });

    expect(screen.getByRole("button", { name: "✓ 已复制" })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1200);
    });

    expect(screen.getByRole("button", { name: "复制内容" })).toBeInTheDocument();
  });
});
