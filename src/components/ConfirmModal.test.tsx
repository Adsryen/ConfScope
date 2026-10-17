/**
 * @vitest-environment jsdom
 */
import { clickOverlay, dragFromPanelOntoOverlay, fireEvent, render, screen } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { EscapePriority, useEscape } from "../lib/useEscape";
import ConfirmModal from "./ConfirmModal";

function renderModal(props: Partial<Parameters<typeof ConfirmModal>[0]> = {}) {
  return render(
    <I18nProvider>
      <ConfirmModal title="确认操作" message="是否继续?" onConfirm={vi.fn()} onCancel={vi.fn()} {...props} />
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

  it("带 role=dialog / aria-modal，标题与正文用 aria 关联给读屏器", () => {
    renderModal();

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog.getAttribute("aria-labelledby")).toBe(screen.getByText("确认操作").id);
    expect(dialog.getAttribute("aria-describedby")).toBe(screen.getByText("是否继续?").id);
  });

  it("按钮点击与 Esc 都按预期回调", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderModal({ onConfirm, onCancel });

    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("打开时默认焦点落在「确定」，回车由聚焦按钮原生激活", () => {
    renderModal();

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "确定" }));
  });

  it("danger 动作默认焦点落在「取消」：误按回车只会离开，不会丢数据", () => {
    renderModal({ danger: true, confirmLabel: "放弃并切换", cancelLabel: "留在当前" });

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "留在当前" }));
  });

  it("焦点在背景输入框里时，Enter 不再被弹框劫持去执行确认", () => {
    const onConfirm = vi.fn();
    renderModal({ onConfirm });
    const { container } = render(
      <I18nProvider>
        <input data-testid="bg" />
      </I18nProvider>
    );
    const bg = container.querySelector("input")!;
    bg.focus();

    fireEvent.keyDown(bg, { key: "Enter" });

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("输入法组合态的 Esc 属于取消候选词，不关弹框", () => {
    const onCancel = vi.fn();
    renderModal({ onCancel });

    fireEvent.keyDown(window, { key: "Escape", isComposing: true });
    fireEvent.keyDown(window, { key: "Escape", keyCode: 229 });

    expect(onCancel).not.toHaveBeenCalled();
  });

  it("active=false 时交出 Esc 与焦点陷阱（保活隐藏的宿主页面）", () => {
    const onCancel = vi.fn();
    const otherModeClose = vi.fn();
    function OtherMode() {
      useEscape(true, otherModeClose, EscapePriority.page);
      return null;
    }
    render(
      <I18nProvider>
        <OtherMode />
        <ConfirmModal title="确认操作" message="是否继续?" onConfirm={vi.fn()} onCancel={onCancel} active={false} />
      </I18nProvider>
    );
    const bg = document.createElement("button");
    document.body.append(bg);
    bg.focus();

    fireEvent.keyDown(window, { key: "Enter" });
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    // 隐藏弹框不再排在高位，Esc 归前台模式自己处理
    expect(onCancel).not.toHaveBeenCalled();
    expect(otherModeClose).toHaveBeenCalledTimes(1);
    // 也不该抢走前台的焦点
    expect(document.activeElement).toBe(bg);
  });

  it("叠在更高层时一次 Esc 只关最上面那层", () => {
    const underClose = vi.fn();
    const topCancel = vi.fn();
    render(
      <I18nProvider>
        <ConfirmModal title="下层" message="…" onConfirm={vi.fn()} onCancel={underClose} />
      </I18nProvider>
    );
    render(
      <I18nProvider>
        <ConfirmModal title="上层" message="…" onConfirm={vi.fn()} onCancel={topCancel} />
      </I18nProvider>
    );

    fireEvent.keyDown(window, { key: "Escape" });

    expect(topCancel).toHaveBeenCalledTimes(1);
    expect(underClose).not.toHaveBeenCalled();
  });

  it("cancels when clicking the overlay", () => {
    const onCancel = vi.fn();
    renderModal({ onCancel });

    clickOverlay(screen.getByText("确认操作").closest(".modal-overlay")!);

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  // 轮14 波32 / R53：mousedown 落在弹层子树、mouseup 落在遮罩时，click 按规范派发到两者的
  // 最近共同祖先（也就是遮罩），弹层本体上的 stopPropagation 挡不住它，过去整框连带刚填的东西一起没。
  it("从弹层内按下拖到遮罩松手不关，同一起手改在遮罩按下才关", () => {
    const onCancel = vi.fn();
    renderModal({ onCancel });
    const overlay = screen.getByText("确认操作").closest(".modal-overlay")!;
    const panel = overlay.querySelector(".modal") as HTMLElement;

    dragFromPanelOntoOverlay(panel, overlay);
    expect(onCancel).not.toHaveBeenCalled();

    dragFromPanelOntoOverlay(screen.getByText("是否继续?"), overlay);
    expect(onCancel).not.toHaveBeenCalled();

    clickOverlay(overlay);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
