/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import DeleteConfirm from "./DeleteConfirm";

function renderDeleteConfirm(props: Partial<Parameters<typeof DeleteConfirm>[0]> = {}) {
  const onCancel = vi.fn();
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  return {
    onCancel,
    onConfirm,
    ...render(
      <I18nProvider>
        <DeleteConfirm
          name="app.json"
          group="DEFAULT_GROUP"
          onCancel={onCancel}
          onConfirm={onConfirm}
          {...props}
        />
      </I18nProvider>
    ),
  };
}

describe("DeleteConfirm", () => {
  beforeEach(() => {
    localStorage.setItem("locale", "zh-CN");
  });

  it("requires typing the exact dataId before deletion is enabled", async () => {
    const { onConfirm } = renderDeleteConfirm();
    const deleteButton = screen.getByRole("button", { name: "删除" });

    expect(deleteButton).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("app.json"), { target: { value: "APP.json" } });
    fireEvent.click(deleteButton);

    expect(onConfirm).not.toHaveBeenCalled();
    expect(deleteButton).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("app.json"), { target: { value: "app.json" } });
    fireEvent.click(deleteButton);

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it("cancels from Escape and overlay when not busy", () => {
    const { onCancel } = renderDeleteConfirm();

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByText("删除配置").closest(".modal-overlay")!);

    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("shows an error and re-enables actions when deletion fails", async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error("delete denied"));
    renderDeleteConfirm({ onConfirm });

    fireEvent.change(screen.getByPlaceholderText("app.json"), { target: { value: "app.json" } });
    fireEvent.keyDown(screen.getByPlaceholderText("app.json"), { key: "Enter" });

    expect(await screen.findByText("Error: delete denied")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除" })).toBeEnabled();
  });
});
