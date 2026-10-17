/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, within } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import Toaster from "./Toaster";
import { clearToasts, RESUME_GRACE, toast, TOAST_DURATION } from "../lib/toast";

/**
 * R25 组件层契约：提示条要能被读屏播报、能被暂停、能单独关掉、重复文案折叠成「× N」。
 * 时长/合并窗口这些数值本身在 lib/toast.test.ts 守住，这里只管「有没有暴露给用户」。
 */
/** 假时钟推进包在 act 里：定时器回调里的 setState 也要在同一批 flush 完，否则断言读到的是旧 DOM。 */
function tick(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function renderToaster() {
  return render(
    <I18nProvider>
      <Toaster />
    </I18nProvider>
  );
}

describe("Toaster", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearToasts();
  });

  it("活区常驻，内容插入前就在 DOM 里", () => {
    renderToaster();
    const region = screen.getByRole("region", { name: "Notifications" });

    expect(region).toHaveClass("toaster");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(within(region).queryAllByRole("status")).toHaveLength(0);
  });

  it("报错用 alert 立刻打断，普通提示用 status 排队播报", () => {
    renderToaster();
    act(() => {
      toast("saved", "success");
      toast("boom", "error");
    });

    expect(screen.getByRole("status")).toHaveTextContent("saved");
    expect(screen.getByRole("alert")).toHaveTextContent("boom");
    // 文案单独成节点：既能选中复制，也不会被「×」关闭按钮的可读名混进去
    expect(screen.getByRole("status").querySelector(".toast-text")?.textContent).toBe("saved");
  });

  it("关闭按钮只撤自己那一条", () => {
    renderToaster();
    act(() => {
      toast("first", "success");
      toast("second", "success");
    });
    const [first] = screen.getAllByRole("status");

    fireEvent.click(within(first).getByRole("button", { name: "Close" }));

    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("second");
  });

  it("鼠标悬停期间不消失，移开后再补一段短尾巴", () => {
    renderToaster();
    act(() => {
      toast("boom", "error");
    });
    const item = screen.getByRole("alert");

    fireEvent.mouseEnter(item);
    tick(TOAST_DURATION.error * 2);
    expect(screen.getByRole("alert")).toHaveTextContent("boom");

    fireEvent.mouseLeave(item);
    tick(RESUME_GRACE - 1);
    expect(screen.queryByRole("alert")).not.toBeNull();

    tick(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("键盘聚焦关闭按钮同样暂停倒计时", () => {
    renderToaster();
    act(() => {
      toast("saved", "success");
    });
    const item = screen.getByRole("status");
    const close = within(item).getByRole("button", { name: "Close" });

    fireEvent.focusIn(close);
    tick(TOAST_DURATION.success + 1000);
    expect(screen.getByRole("status")).toHaveTextContent("saved");

    fireEvent.focusOut(close);
    tick(RESUME_GRACE);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("重复提示叠成一条并显示次数", () => {
    renderToaster();
    act(() => {
      toast("saved", "success");
      toast("saved", "success");
      toast("saved", "success");
    });
    const items = screen.getAllByRole("status");

    expect(items).toHaveLength(1);
    expect(within(items[0]).getByText(/×\s*3/)).toBeInTheDocument();
  });
});
