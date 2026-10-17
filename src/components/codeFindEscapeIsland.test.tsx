/**
 * @vitest-environment jsdom
 *
 * 查找栏是「弹层内部的瞬时编辑层」，Esc 只能收起它自己（轮16 波37 / R61）。
 *
 * 真 bug：`useEscape` 的分派器挂在 window 的**捕获**阶段并 stopPropagation，React 根监听在冒泡阶段，
 * 所以组件里写裸 `onKeyDown` 处理 Escape 在「有任何一层注册 active」时形同死代码。
 * 代码视图的查找栏正是这么写的，于是：
 * - 配置浏览的编辑态（`ConfigBrowser.tsx:647` 注册 page 级）里按 Esc 收查找条，实际取消了整段编辑，
 *   手写一半的草稿撞上「放弃修改？」确认；
 * - 新建/编辑弹层（`ConfigEditor.tsx:59` 注册 overlay 级）里按 Esc，整个弹层被关。
 * 既有用例「Esc 关闭查找栏」（CodeView.test.tsx:125 / CodeEditor.test.tsx:234）单独渲染代码视图、
 * 外层没有任何注册，所以一直绿——这就是这个缺陷藏这么久的原因。这里把外层镜像出来。
 */
import { fireEvent, render, waitFor } from "../test/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { I18nProvider } from "../i18n";
import { EscapePriority, useEscape } from "../lib/useEscape";
import CodeEditor from "./CodeEditor";
import CodeView from "./CodeView";

const MULTI = 'server.port=8080\nname = "a<b&c>"\nqps: 10000\nport = 8081\n';

/** 宿主镜像：外层弹层按 overlay 优先级登记，与 ConfigEditor / ConfigBrowser 的真实层级一致。 */
function OverlayHost({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEscape(true, onClose, EscapePriority.overlay);
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="宿主弹层">
      {children}
    </div>
  );
}

function renderInOverlay(onClose: () => void, children: ReactNode) {
  localStorage.setItem("locale", "zh-CN");
  return render(
    <I18nProvider>
      <OverlayHost onClose={onClose}>{children}</OverlayHost>
    </I18nProvider>
  );
}

function findInput(container: HTMLElement) {
  return container.querySelector(".code-find-input") as HTMLInputElement | null;
}

function openFindViaButton(container: HTMLElement) {
  fireEvent.click(container.querySelector(".code-find-open") as HTMLElement);
}

describe("浏览态查找栏的 Esc 归属（波37 R61）", () => {
  it("宿主弹层在场时，Esc 只收起查找栏，不穿透去关外层", async () => {
    const onClose = vi.fn();
    const { container } = renderInOverlay(onClose, <CodeView code={MULTI} format="Properties" />);

    openFindViaButton(container);
    await waitFor(() => expect(findInput(container)).not.toBeNull());
    fireEvent.keyDown(findInput(container) as HTMLInputElement, { key: "Escape" });

    expect(onClose, "查找栏自己没登记的 Esc 被外层吃掉，草稿态会被连带取消").not.toHaveBeenCalled();
    expect(findInput(container)).toBeNull();
  });

  it("查找栏没打开时，Esc 照常归外层（本波不许把 Esc 全劫走）", () => {
    const onClose = vi.fn();
    renderInOverlay(onClose, <CodeView code={MULTI} format="Properties" />);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("宿主页面被保活隐藏（active=false）时，隐藏的查找栏不抢外层的 Esc", async () => {
    const onClose = vi.fn();
    const { container } = renderInOverlay(onClose, <CodeView code={MULTI} format="Properties" active={false} />);

    openFindViaButton(container);
    await waitFor(() => expect(findInput(container)).not.toBeNull());
    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose, "看不见的视图登记了 Esc 等于凭空多一层拦截").toHaveBeenCalledTimes(1);
  });
});

describe("编辑态查找栏的 Esc 归属（波37 R61）", () => {
  it("宿主弹层在场时，Esc 只收起查找栏，弹层与草稿都在", async () => {
    const onClose = vi.fn();
    const { container } = renderInOverlay(onClose, <CodeEditor value={MULTI} onChange={() => {}} format="Properties" />);
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;

    fireEvent.keyDown(ta, { key: "f", ctrlKey: true });
    await waitFor(() => expect(findInput(container)).not.toBeNull());
    fireEvent.keyDown(findInput(container) as HTMLInputElement, { key: "Escape" });

    expect(onClose, "ConfigEditor.tsx:59 注册的正是这一层，按一次 Esc 不该把整个弹层关掉").not.toHaveBeenCalled();
    expect(findInput(container)).toBeNull();
    expect(container.querySelector("textarea")).toBe(ta);
  });

  it("查找栏没打开时，Esc 照常关宿主弹层", () => {
    const onClose = vi.fn();
    const { container } = renderInOverlay(onClose, <CodeEditor value={MULTI} onChange={() => {}} format="Properties" />);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(container.querySelector("textarea")).not.toBeNull();
  });

  it("组合态的 Esc 属于输入法：既不关查找栏也不关弹层", async () => {
    const onClose = vi.fn();
    const { container } = renderInOverlay(onClose, <CodeView code={MULTI} format="Properties" />);

    openFindViaButton(container);
    await waitFor(() => expect(findInput(container)).not.toBeNull());
    fireEvent.keyDown(findInput(container) as HTMLInputElement, { key: "Escape", isComposing: true });

    expect(onClose).not.toHaveBeenCalled();
    expect(findInput(container)).not.toBeNull();
  });
});
