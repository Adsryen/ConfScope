import { useRef } from "react";
import type { MouseEvent } from "react";

/** 遮罩要挂上的三个处理器：直接展开到遮罩 div 上即可（`{...overlayDismiss}`）。 */
export interface OverlayDismissHandlers {
  onMouseDown: (event: MouseEvent<HTMLDivElement>) => void;
  onMouseUp: (event: MouseEvent<HTMLDivElement>) => void;
  onClick: (event: MouseEvent<HTMLDivElement>) => void;
}

/**
 * 弹层遮罩的关闭判定：按下、释放、点击三件事都落在遮罩本身才关（轮14 波32 / R53）。
 *
 * 为什么光判 `onClick` 的 target 不够：`click` 按规范派发到 mousedown 与 mouseup 两个目标
 * 的**最近共同祖先**。弹层本体只挂 `onClick={(e) => e.stopPropagation()}` 挡不住这条路径 ——
 * 在弹层里选中一段长文本、拖到遮罩上松手，mousedown 在子树、mouseup 在遮罩，
 * 共同祖先就是遮罩，于是 `target === currentTarget` 成立、整个弹层连刚填的表单一起消失。
 * 反过来「遮罩按下、弹层里松手」也会把 click 派发回遮罩，同样不该算一次点遮罩。
 *
 * 所以这里记两个信号：按下点是否就是遮罩（onMouseDown），释放点是否离开过遮罩（onMouseUp），
 * 最后在 onClick 上再确认点击确实落在遮罩自身。交互约定没变：点遮罩仍关闭，Esc 与关闭按钮不受影响。
 *
 * @param dismiss 关闭动作本身（点遮罩时调用）
 * @param enabled 传 false 时两个判定照常记录，但不触发关闭，留给「忙碌中不许点遮罩关」这类站点
 */
export function useOverlayDismiss(dismiss: () => void, enabled = true): OverlayDismissHandlers {
  // 用 ref 不用 state：这是一次手势内的临时判定，不该多引起一次渲染。
  const pressedOnOverlay = useRef(false);

  const onMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    pressedOnOverlay.current = event.target === event.currentTarget;
  };

  const onMouseUp = (event: MouseEvent<HTMLDivElement>) => {
    // 从遮罩按下去、却在弹层内部松手（往回拖）：这次手势不是「点遮罩」，作废。
    if (pressedOnOverlay.current && event.target !== event.currentTarget) {
      pressedOnOverlay.current = false;
    }
  };

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const gestureOnOverlay = pressedOnOverlay.current;
    pressedOnOverlay.current = false;
    // 三个条件缺一不关：按下点在遮罩、释放没跑回弹层、点击确实落在遮罩自身。
    if (!gestureOnOverlay || event.target !== event.currentTarget) return;
    if (!enabled) return;
    dismiss();
  };

  return { onMouseDown, onMouseUp, onClick };
}
