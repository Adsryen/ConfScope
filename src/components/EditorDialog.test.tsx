/**
 * @vitest-environment jsdom
 */
// 长文本编辑弹层外壳（r136）的行为用例：只钉「壳」该做对的四件事——dialog 语义、初始焦点、
// Esc 分层、遮罩判定。草稿与保存语义归宿主，这里刻意不测（那是 DiffView / ApplyPlanView 的用例）。
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clickOverlay, dragFromPanelOntoOverlay, fireEvent, render, screen } from "../test/react";
import { I18nProvider } from "../i18n";
import EditorDialog from "./EditorDialog";
import ConfirmModal from "./ConfirmModal";

/** 假正文：外壳只认 `.code-editor-ta` 这个类（真实 CodeEditor 的 textarea 就叫这个）。 */
function FakeEditor() {
  return (
    <div className="apply-edit-panel diff-tune-panel">
      <div className="apply-edit-editor">
        <textarea className="code-editor-ta" aria-label="正文" defaultValue={"line1\nline2\n"} />
      </div>
    </div>
  );
}

function renderDialog(props: { onClose?: () => void; active?: boolean; footer?: boolean; hint?: string } = {}) {
  const onClose = props.onClose ?? vi.fn();
  const utils = render(
    <I18nProvider>
      <EditorDialog
        title="微调右侧：svc-gateway.yaml"
        hint={props.hint ?? "手写最终要接收的内容"}
        active={props.active}
        onClose={onClose}
        footer={
          props.footer === false ? undefined : (
            <>
              <button type="button" onClick={onClose}>
                取消
              </button>
              <button type="button" onClick={vi.fn()}>
                保存微调
              </button>
            </>
          )
        }
      >
        <FakeEditor />
      </EditorDialog>
    </I18nProvider>
  );
  return { onClose, utils };
}

/**
 * 真机形状的宿主：`onClose` 真的把弹层从树上摘掉。
 *
 * 「关闭后焦点归位」这条契约发生在 useDialogFocus 的卸载清理里，用裸 `vi.fn()` 当 onClose 时
 * 组件压根没消失，焦点自然留在正文上——轮136 第一版就是这么写错的，红的是用例不是产品。
 */
function renderDialogWithUnmount() {
  const dismiss = vi.fn();
  function Host() {
    const [open, setOpen] = useState(true);
    const onClose = () => {
      dismiss();
      setOpen(false);
    };
    if (!open) return null;
    return (
      <EditorDialog
        title="微调右侧：svc-gateway.yaml"
        hint="手写最终要接收的内容"
        onClose={onClose}
        footer={
          <button type="button" onClick={onClose}>
            取消
          </button>
        }
      >
        <FakeEditor />
      </EditorDialog>
    );
  }
  render(
    <I18nProvider>
      <Host />
    </I18nProvider>
  );
  return dismiss;
}

describe("EditorDialog", () => {
  beforeEach(() => {
    localStorage.setItem("locale", "zh-CN");
  });

  it("是带名字的 dialog：标题文本就是 aria-labelledby 指向的那一个", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const labelId = dialog.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId as string)?.textContent).toBe("微调右侧：svc-gateway.yaml");
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("打开即把焦点交给正文，不是右上角的 ×", () => {
    renderDialog();
    expect(document.activeElement).toBe(document.querySelector(".code-editor-ta"));
  });

  it("Tab 在弹层内成环，跑不出被遮住的背景", () => {
    render(<button className="bg">背景按钮</button>);
    renderDialog();
    const items = [...document.querySelectorAll<HTMLElement>('[role="dialog"] button, [role="dialog"] textarea')];
    const last = items[items.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(items[0]);
  });

  it("Esc 收起弹层；输入法组合态的 Esc 不算", () => {
    const { onClose } = renderDialog();
    fireEvent.keyDown(window, { key: "Escape", isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("宿主被保活隐藏（active=false）时不抢 Esc、不伸焦点陷阱", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { onClose } = renderDialog({ active: false });
    expect(document.activeElement).toBe(opener);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("点遮罩收起；在正文里起手拖到遮罩上松手不算点遮罩（长文本选中不许连草稿一起丢）", () => {
    const { onClose, utils } = renderDialog();
    const overlay = document.querySelector(".modal-overlay") as Element;
    const panel = document.querySelector('[role="dialog"]') as Element;

    dragFromPanelOntoOverlay(panel, overlay);
    expect(onClose).not.toHaveBeenCalled();

    clickOverlay(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
    utils.rerender(<I18nProvider>{null}</I18nProvider>);
  });

  it("关闭后焦点回到打开它的那颗按钮", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    renderDialogWithUnmount();
    expect(document.activeElement).toBe(document.querySelector(".code-editor-ta"));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(document.querySelector('[role="dialog"]')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener);
  });

  it("内层确认框开着时，一次 Esc 只关内层，弹层与草稿都还在", () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    render(
      <I18nProvider>
        <EditorDialog title="微调右侧：svc-gateway.yaml" onClose={onClose}>
          <FakeEditor />
        </EditorDialog>
        <ConfirmModal title="还原人工微调的内容？" message="还原会丢掉手写的正文" danger onConfirm={onConfirm} onCancel={onConfirm} />
      </I18nProvider>
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "微调右侧：svc-gateway.yaml" })).toBeInTheDocument();
  });

  it("没有动作区时不渲染空 footer", () => {
    renderDialog({ footer: false });
    expect(document.querySelector(".modal-footer")).not.toBeInTheDocument();
  });
});
