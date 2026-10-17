/**
 * @vitest-environment jsdom
 *
 * 语义真的落到 DOM 上（轮14 波33 / R54）。
 *
 * 静态守卫只能证明「站点展开了 statusMessageProps(...)」，证不出展开以后读屏拿到的东西对不对：
 * 键名写成 `arialive`、error 档顺手多挂一个 aria-live、三元站点在成功↔失败之间切换时留下上一档的
 * `aria-live="polite"`——这些都不会让编译或渲染报错，只有真渲一次才看得见。
 * 这里的 DOM 形态与各站点一致：容器挂语义，内层 `.test-msg-text` 不带。
 */
import { render } from "../test/react";
import { describe, expect, it } from "vitest";
import { statusMessageProps, type StatusTone } from "./statusSemantics";

function Hint({ tone, ok }: { tone?: StatusTone; ok?: boolean }) {
  const resolved = tone ?? (ok ? "success" : "error");
  return (
    <div className={`test-msg ${ok === false ? "err" : "ok"}`} {...statusMessageProps(resolved)}>
      <span className="test-msg-text">saved</span>
    </div>
  );
}

describe("statusMessageProps 渲染后的 DOM（波33 R54）", () => {
  it("error 渲染成 role=alert，且不带 aria-live", () => {
    render(<Hint tone="error" ok={false} />);
    const box = document.querySelector(".test-msg") as HTMLElement;
    expect(box).toHaveAttribute("role", "alert");
    expect(box).not.toHaveAttribute("aria-live");
  });

  it("success 渲染成 role=status + aria-live=polite", () => {
    render(<Hint tone="success" />);
    const box = document.querySelector(".test-msg") as HTMLElement;
    expect(box).toHaveAttribute("role", "status");
    expect(box).toHaveAttribute("aria-live", "polite");
  });

  it("播报只由容器负责：内层文本节点不重复挂语义", () => {
    render(<Hint tone="error" ok={false} />);
    const text = document.querySelector(".test-msg-text") as HTMLElement;
    expect(text).not.toHaveAttribute("role");
    expect(text).not.toHaveAttribute("aria-live");
  });

  it("三元站点从成功切到失败时，上一档的 aria-live 不会残留", () => {
    const view = render(<Hint ok />);
    expect(document.querySelector(".test-msg")).toHaveAttribute("aria-live", "polite");
    view.rerender(<Hint ok={false} />);
    const box = document.querySelector(".test-msg") as HTMLElement;
    expect(box).toHaveAttribute("role", "alert");
    expect(box).not.toHaveAttribute("aria-live");
  });

  it("className 一字未改：语义是附加属性，不是换容器", () => {
    render(<Hint ok={false} />);
    const box = document.querySelector(".test-msg") as HTMLElement;
    expect(box.className).toBe("test-msg err");
  });
});
