import "@testing-library/jest-dom/vitest";
import { FIND_INPUT_DEBOUNCE_MS } from "../lib/findInput";
import { act, cleanup, fireEvent } from "@testing-library/react";
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
 * 等查找词的输入延迟落地（轮29 F-16）。
 *
 * 正文达到 `FIND_INPUT_DEFER_MIN_LINES` 之后，命中层不再逐字实时，而是停顿 `FIND_INPUT_DEBOUNCE_MS`
 * 才提交一次。用例里凡是「敲完立刻断言命中数/红字个数」而正文又够大的，必须先走这一步；
 * 别把断言改成 `waitFor` 轮询——那等于把「到底提交了几次」重新藏回看不见的位置。
 */
export async function settleFindInputCommit(): Promise<void> {
  // 必须包在 act 里：定时器在 act 之外写状态时，这次提交会被推到「下一次 act」里落地，
  // 于是「输入框敲完 → 断言计数 → 按 Enter」三步里，Enter 的那一次 act 才把提交渲染出来，
  // 换词重置当前命中序号的效果（setActiveIdx(0)）就压掉了 Enter 刚推进的那一格。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, FIND_INPUT_DEBOUNCE_MS + 20));
  });
}

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
