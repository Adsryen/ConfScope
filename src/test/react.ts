import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, vi } from "vitest";

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

export * from "@testing-library/react";

/**
 * 完整的「点遮罩」手势（轮14 波32 / R53）。
 *
 * 遮罩的关闭判定要求按下与释放都落在遮罩本身，所以只 dispatch 一个 click 测的是浏览器里走不通的轨迹。
 * 需要按住遮罩再往上拖的场合请改用 dragFromPanelOntoOverlay。
 */
export function clickOverlay(overlay: Element): void {
  fireEvent.mouseDown(overlay);
  fireEvent.mouseUp(overlay);
  fireEvent.click(overlay);
}

/**
 * 「在弹层里选中文本、拖出弹层、在遮罩上松手」这条轨迹。
 *
 * 浏览器把 click 派发给 mousedown 与 mouseup 两个目标的最近共同祖先，也就是遮罩本身，
 * 弹层本体上的 stopPropagation 挡不住它 —— 这正是过去误关弹层、丢表单的那一下。
 */
export function dragFromPanelOntoOverlay(panel: Element, overlay: Element): void {
  fireEvent.mouseDown(panel);
  fireEvent.mouseUp(overlay);
  fireEvent.click(overlay);
}
