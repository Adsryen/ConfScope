/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import InlineError from "./InlineError";

vi.mock("../lib/clipboard", () => ({
  copyText: vi.fn(),
}));

type Props = Parameters<typeof InlineError>[0];

function renderError(props: Props, locale = "zh-CN") {
  localStorage.setItem("locale", locale);
  return render(
    <I18nProvider>
      <InlineError {...props} />
    </I18nProvider>
  );
}

describe("InlineError", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("读屏能播报、键盘能滚到详情", () => {
    renderError({ title: "操作失败", message: "boom" });

    expect(screen.getByRole("alert")).toBeInTheDocument();
    const detail = screen.getByRole("region", { name: "错误详情" });
    expect(detail).toHaveAttribute("tabindex", "0");
    expect(detail).toHaveTextContent("boom");
  });

  it("不传 onRetry 就不该多出重试按钮", () => {
    renderError({ title: "操作失败", message: "boom" });

    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制错误" })).toBeInTheDocument();
  });

  it("传了 onRetry 用 common.retry 兜底，点下去真能重试", () => {
    const onRetry = vi.fn();
    renderError({ title: "操作失败", message: "boom", onRetry });

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("retryLabel/copyLabel 可以覆盖默认文案", () => {
    renderError({
      title: "生成失败",
      message: "boom",
      onRetry: () => {},
      retryLabel: "再来一次",
      copyLabel: "复制报错",
    });

    expect(screen.getByRole("button", { name: "再来一次" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制报错" })).toBeInTheDocument();
  });

  it("复制按钮复制的是详情原文", async () => {
    const { copyText } = await import("../lib/clipboard");
    vi.mocked(copyText).mockResolvedValue(true);
    renderError({ title: "操作失败", message: "403 forbidden" });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "复制错误" }));
    });

    expect(copyText).toHaveBeenCalledWith("403 forbidden");
  });

  it("extraClassName 只加在容器上，不改结构", () => {
    const { container } = renderError({ title: "操作失败", message: "boom", extraClassName: "app-data-backup-error" });

    const box = container.querySelector(".inline-error");
    expect(box).toHaveClass("app-data-backup-error");
    expect(box?.getAttribute("class")).toBe("inline-error app-data-backup-error");
    expect(container.querySelectorAll(".inline-error-head").length).toBe(1);
  });

  it("英文语种下 label 跟着走", () => {
    renderError({ title: "Operation failed", message: "boom", onRetry: () => {} }, "en-US");

    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Error details" })).toBeInTheDocument();
  });
});
