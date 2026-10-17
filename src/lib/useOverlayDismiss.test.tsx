/**
 * @vitest-environment jsdom
 */
import { fireEvent, render } from "../test/react";
import { describe, expect, it, vi } from "vitest";
import { useOverlayDismiss } from "./useOverlayDismiss";

/**
 * 探针：照组件里的写法搭一层遮罩 + 弹层本体。
 * 弹层本体的 `stopPropagation` 保留着——波32 要证的正是「它挡不住按下与释放分裂的那条轨迹」，
 * 只有这里的双判定挡得住。
 */
function Probe({ onDismiss, enabled, testId }: { onDismiss: () => void; enabled?: boolean; testId: string }) {
  const overlayDismiss = useOverlayDismiss(onDismiss, enabled);
  return (
    <div className="modal-overlay" {...overlayDismiss}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <p data-testid={testId}>可以选中的长文本</p>
      </div>
    </div>
  );
}

// 同一份 document 里会同时挂两层探针（enabled 那条用例），testid 逐个编号才撞不上。
let probeSeq = 0;

function renderProbe(onDismiss: () => void, enabled?: boolean) {
  probeSeq += 1;
  const testId = `probe-${probeSeq}`;
  const { getByTestId } = render(<Probe onDismiss={onDismiss} enabled={enabled} testId={testId} />);
  const text = getByTestId(testId);
  return { text, overlay: text.closest(".modal-overlay") as Element, panel: text.closest(".modal") as Element };
}

describe("useOverlayDismiss（轮14 波32 / R53）", () => {
  it("按下与释放都落在遮罩上才关，且一次手势只关一次", () => {
    const onDismiss = vi.fn();
    const { overlay } = renderProbe(onDismiss);

    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(overlay);
    fireEvent.click(overlay);

    expect(onDismiss).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(overlay);
    fireEvent.click(overlay);

    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("弹层内按下、拖到遮罩上松手不关（真 bug 轨迹：click 派发到共同祖先=遮罩）", () => {
    const onDismiss = vi.fn();
    const { overlay, text } = renderProbe(onDismiss);

    fireEvent.mouseDown(text);
    fireEvent.mouseUp(overlay);
    fireEvent.click(overlay);

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("遮罩上按下、拖回弹层内松手也不关", () => {
    const onDismiss = vi.fn();
    const { overlay, panel } = renderProbe(onDismiss);

    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(panel);
    // 两端点的最近共同祖先仍是遮罩，所以这一发 click 依然会落到遮罩上
    fireEvent.click(overlay);

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("没有按下动作的 click 不算点遮罩（脚本代点不该被当成一次遮罩点击）", () => {
    const onDismiss = vi.fn();
    const { overlay } = renderProbe(onDismiss);

    fireEvent.click(overlay);

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("点弹层本体不关：stopPropagation 之外，target===currentTarget 再挡一道", () => {
    const onDismiss = vi.fn();
    const { panel, text } = renderProbe(onDismiss);

    fireEvent.mouseDown(text);
    fireEvent.mouseUp(text);
    fireEvent.click(text);

    fireEvent.mouseDown(panel);
    fireEvent.mouseUp(panel);
    fireEvent.click(panel);

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("enabled=false 时手势照常记录但不关；开着的那层同一手势能关", () => {
    const blocked = vi.fn();
    const { overlay } = renderProbe(blocked, false);

    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(overlay);
    fireEvent.click(overlay);

    expect(blocked).not.toHaveBeenCalled();

    const allowed = vi.fn();
    const next = renderProbe(allowed, true);
    fireEvent.mouseDown(next.overlay);
    fireEvent.mouseUp(next.overlay);
    fireEvent.click(next.overlay);

    expect(allowed).toHaveBeenCalledTimes(1);
  });

  it("作废的手势不会补关，下一次真点遮罩照常关", () => {
    const onDismiss = vi.fn();
    const { overlay, panel } = renderProbe(onDismiss);

    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(panel); // 往回拖进弹层：这一笔手势作废
    fireEvent.click(panel); // 补一发落在弹层上的点击
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(overlay);
    fireEvent.click(overlay);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
