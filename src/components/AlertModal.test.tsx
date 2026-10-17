/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import AlertModal from "./AlertModal";

function renderAlert(props: { onClose?: () => void; active?: boolean } = {}) {
  const onClose = props.onClose ?? vi.fn();
  render(
    <I18nProvider>
      <AlertModal title="格式校验未通过" messages={["第 2 行缺少冒号", "第 5 行缩进错误"]} onClose={onClose} active={props.active} />
    </I18nProvider>
  );
  return { onClose };
}

describe("AlertModal", () => {
  beforeEach(() => {
    localStorage.setItem("locale", "zh-CN");
  });

  it("列出全部问题并可点「确定」关闭", () => {
    const { onClose } = renderAlert();

    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("打开即把焦点交给「确定」，之后回车走原生按钮激活", () => {
    renderAlert();

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "确定" }));
  });

  it("Tab 在弹框内成环，不会跑到被遮住的背景", () => {
    render(<button className="bg">背景按钮</button>);
    renderAlert();
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')];
    const last = buttons[buttons.length - 1];

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });

    expect(document.activeElement).toBe(buttons[0]);
  });

  it("Esc 关闭，输入法组合态的 Esc 不关闭", () => {
    const { onClose } = renderAlert();

    fireEvent.keyDown(window, { key: "Escape", isComposing: true });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("active=false 时交出 Enter/Esc，并保留宿主页面的焦点", () => {
    const onClose = vi.fn();
    const { container } = render(
      <I18nProvider>
        <input aria-label="背景输入框" />
        <AlertModal title="格式校验未通过" messages={["…"]} onClose={onClose} active={false} />
      </I18nProvider>
    );
    const bg = container.querySelector("input")!;
    bg.focus();

    fireEvent.keyDown(bg, { key: "Enter" });
    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(bg);
  });

  it("点遮罩关闭", () => {
    const { onClose } = renderAlert();

    fireEvent.click(screen.getByText("格式校验未通过").closest(".modal-overlay")!);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
