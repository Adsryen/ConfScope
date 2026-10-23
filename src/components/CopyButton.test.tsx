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

  // 轮67 R67-WP5：同一屏 7 行都是「复制」，读屏只能靠 aria-label 点名；可见文字一个字不许动。
  it("把分辨用的名字放aria-label上、可见文字保持原样", () => {
    renderCopyButton({ text: "/var/log/confscope.log", ariaLabel: "复制运行日志的路径" });

    const button = screen.getByRole("button", { name: "复制运行日志的路径" });
    expect(button.textContent).toBe("复制");
  });

  it("没给分辨名时不下发 aria-label（别让读屏丢掉可见文字）", () => {
    renderCopyButton({ text: "boom", label: "复制错误详情" });

    expect(screen.getByRole("button", { name: "复制错误详情" })).not.toHaveAttribute("aria-label");
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
