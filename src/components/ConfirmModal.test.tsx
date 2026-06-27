/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import ConfirmModal from "./ConfirmModal";

function renderModal(props: Partial<Parameters<typeof ConfirmModal>[0]> = {}) {
  return render(
    <I18nProvider>
      <ConfirmModal
        title="确认操作"
        message="是否继续?"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        {...props}
      />
    </I18nProvider>
  );
}

describe("ConfirmModal", () => {
  beforeEach(() => {
    localStorage.setItem("locale", "zh-CN");
  });

  it("renders title, message, and default actions", () => {
    renderModal();

    expect(screen.getByText("确认操作")).toBeInTheDocument();
    expect(screen.getByText("是否继续?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确定" })).toBeInTheDocument();
  });

  it("calls callbacks from buttons and keyboard shortcuts", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderModal({ onConfirm, onCancel });

    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "Enter" });

    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("cancels when clicking the overlay", () => {
    const onCancel = vi.fn();
    renderModal({ onCancel });

    fireEvent.click(screen.getByText("确认操作").closest(".modal-overlay")!);

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
