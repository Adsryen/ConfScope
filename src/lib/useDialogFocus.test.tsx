/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render } from "../test/react";
import { useRef, useState, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useDialogFocus } from "./useDialogFocus";

/** 探针：把 hook 接到一个真实容器上。active=false 时容器仍然存在（模拟保活隐藏）。 */
function Probe({ active, children }: { active: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus({ active, containerRef: ref });
  return (
    <div className="dlg" ref={ref} role="dialog" aria-modal="true">
      {children}
    </div>
  );
}

const dialogButtons = () => [...document.querySelectorAll<HTMLButtonElement>(".dlg button")];

describe("useDialogFocus", () => {
  it("打开时优先把焦点交给 [data-dialog-autofocus]", () => {
    render(
      <>
        <button className="bg">背景按钮</button>
        <Probe active>
          <button>取消</button>
          <button data-dialog-autofocus="">确定</button>
        </Probe>
      </>
    );

    expect(document.activeElement?.textContent).toBe("确定");
  });

  it("没有标记时退到容器内首个可聚焦元素，并跳过禁用项", () => {
    render(
      <Probe active>
        <button disabled>不可用</button>
        <input aria-label="输入" />
      </Probe>
    );

    expect(document.activeElement?.tagName).toBe("INPUT");
  });

  it("Tab 落在最后一个元素时被拽回首个，Shift+Tab 从首个反向跳到末个", () => {
    render(
      <Probe active>
        <button>A</button>
        <button>B</button>
      </Probe>
    );
    const [a, b] = dialogButtons();

    b.focus();
    fireEvent.keyDown(b, { key: "Tab" });
    expect(document.activeElement).toBe(a);

    a.focus();
    fireEvent.keyDown(a, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(b);
  });

  it("中间元素之间的 Tab 不拦截，交回浏览器原生顺序", () => {
    render(
      <Probe active>
        <button>A</button>
        <button>B</button>
        <button>C</button>
      </Probe>
    );
    const [, b] = dialogButtons();

    b.focus();
    const handled = fireEvent.keyDown(b, { key: "Tab" });
    // fireEvent 返回 false 表示 preventDefault 被调用
    expect(handled).toBe(true);
  });

  it("焦点掉到容器外（点过遮罩后 body 持有焦点）时，Tab 把它拽回弹框", () => {
    render(
      <Probe active>
        <button>A</button>
        <button>B</button>
      </Probe>
    );
    const [a] = dialogButtons();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    // 焦点已在 body，但这次按键发生在弹框内的非聚焦节点上
    fireEvent.keyDown(a, { key: "Tab" });
    expect(document.activeElement).toBe(a);
  });

  it("禁用（active=false）时不设焦点陷阱，也不抢初始焦点", () => {
    render(
      <>
        <button className="bg">背景按钮</button>
        <Probe active={false}>
          <button>A</button>
        </Probe>
      </>
    );
    const bg = document.querySelector<HTMLButtonElement>(".bg")!;
    const [a] = dialogButtons();
    bg.focus();

    expect(document.activeElement).toBe(bg);
    fireEvent.keyDown(bg, { key: "Tab" });
    expect(document.activeElement).toBe(bg);
    // 隐藏的保活弹层不该把焦点吞进去
    expect(a.textContent).toBe("A");
  });

  it("关闭后焦点归位到打开前的元素", () => {
    let openDialog: () => void = () => {};
    let closeDialog: () => void = () => {};
    function Host() {
      const [open, setOpen] = useState(false);
      openDialog = () => setOpen(true);
      closeDialog = () => setOpen(false);
      const ref = useRef<HTMLDivElement>(null);
      useDialogFocus({ active: open, containerRef: ref });
      return (
        <>
          <button className="bg" type="button">
            背景按钮
          </button>
          {open ? (
            <div className="dlg" ref={ref} role="dialog">
              <button type="button" data-dialog-autofocus="" onClick={closeDialog}>
                关闭
              </button>
            </div>
          ) : null}
        </>
      );
    }
    render(<Host />);

    const bg = document.querySelector<HTMLButtonElement>(".bg")!;
    bg.focus();
    act(openDialog);
    const closer = dialogButtons()[0];
    expect(document.activeElement).toBe(closer);

    act(() => closer.click());
    expect(document.activeElement).toBe(bg);
  });

  it("用户已把焦点移到别处时，关闭弹框不抢回焦点", () => {
    let openDialog: () => void = () => {};
    let closeDialog: () => void = () => {};
    function Host() {
      const [open, setOpen] = useState(false);
      openDialog = () => setOpen(true);
      closeDialog = () => setOpen(false);
      const ref = useRef<HTMLDivElement>(null);
      useDialogFocus({ active: open, containerRef: ref });
      return (
        <>
          <input aria-label="背景输入框" />
          {open ? (
            <div className="dlg" ref={ref} role="dialog">
              <button type="button" data-dialog-autofocus="" onClick={closeDialog}>
                关闭
              </button>
            </div>
          ) : null}
        </>
      );
    }
    render(<Host />);

    const bgInput = document.querySelector("input")!;
    bgInput.focus();
    act(openDialog);

    const closer = dialogButtons()[0];
    // 打开后用户主动把焦点挪到背景输入框（点了别的地方）
    bgInput.focus();
    act(() => closer.click());

    expect(document.activeElement).toBe(bgInput);
  });
});
