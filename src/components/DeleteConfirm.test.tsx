/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { clearErrors, subscribeErrors, type AppErrorItem } from "../lib/errorCenter";
import DeleteConfirm from "./DeleteConfirm";

function renderDeleteConfirm(props: Partial<Parameters<typeof DeleteConfirm>[0]> = {}) {
  const onCancel = vi.fn();
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  return {
    onCancel,
    onConfirm,
    ...render(
      <I18nProvider>
        <DeleteConfirm name="app.json" group="DEFAULT_GROUP" onCancel={onCancel} onConfirm={onConfirm} {...props} />
      </I18nProvider>
    ),
  };
}

function latestError(): AppErrorItem | undefined {
  let errors: AppErrorItem[] = [];
  const unsubscribe = subscribeErrors((items) => {
    errors = items;
  });
  unsubscribe();
  return errors[errors.length - 1];
}

describe("DeleteConfirm", () => {
  beforeEach(() => {
    localStorage.clear();
    clearErrors();
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

    expect(await screen.findByText("delete denied")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制错误" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除" })).toBeEnabled();
  });

  it("reports deletion errors with localized message-center actions", async () => {
    localStorage.setItem("locale", "en-US");
    const onConfirm = vi.fn().mockRejectedValue(new Error("delete denied"));
    renderDeleteConfirm({ onConfirm });

    fireEvent.change(screen.getByPlaceholderText("app.json"), { target: { value: "app.json" } });
    fireEvent.keyDown(screen.getByPlaceholderText("app.json"), { key: "Enter" });

    expect(await screen.findByText("delete denied")).toBeInTheDocument();
    expect(latestError()).toMatchObject({
      title: "Failed to delete config",
      message: "delete denied",
      actionLabel: "Retry Delete",
    });
  });
  it("输入法组合态的 Enter 不提交删除，Esc 不取消", () => {
    const { onConfirm, onCancel } = renderDeleteConfirm();
    const input = screen.getByPlaceholderText("app.json");
    fireEvent.change(input, { target: { value: "app.json" } });

    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape", isComposing: true });
    expect(onCancel).not.toHaveBeenCalled();

    // 负控：上屏之后的那一下真回车仍然提交
    fireEvent.keyDown(input, { key: "Enter" });
    return waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it("删除进行中（busy）时 Esc 不放行", async () => {
    const onConfirm = vi.fn(() => new Promise<void>(() => {})); // 永不 resolve：模拟删除挂起
    const { onCancel } = renderDeleteConfirm({ onConfirm });
    fireEvent.change(screen.getByPlaceholderText("app.json"), { target: { value: "app.json" } });
    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onCancel).not.toHaveBeenCalled();
  });

  it("打开即把焦点送进输入格，Tab 关在弹框里出不去（R38）", () => {
    renderDeleteConfirm();
    const input = screen.getByPlaceholderText("app.json");
    // 删除确认必须靠输入名字来防误删：焦点若在 × 上，用户得先 Tab 一格才能打字
    expect(document.activeElement).toBe(input);

    // 末位（「删除」此刻还禁用，环里的末位是「取消」）Tab 出去时拽回首项 ×，不落回背景
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const items = [
      ...dialog.querySelectorAll<HTMLElement>(`a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])`),
    ];
    const last = items[items.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(items[0]);
  });
});
