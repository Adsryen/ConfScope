import { describe, expect, it, vi } from "vitest";
import { closeAllPopovers, subscribeClosePopovers } from "./popoverBus";

describe("popoverBus", () => {
  it("通知已注册的弹层收起，取消注册后不再收到", () => {
    const close = vi.fn();
    const unsubscribe = subscribeClosePopovers(close);

    closeAllPopovers();
    expect(close).toHaveBeenCalledTimes(1);

    unsubscribe();
    closeAllPopovers();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("派发过程中有处理器自行取消注册（组件卸载）也不影响其余处理器", () => {
    const second = vi.fn();
    const unsubscribeFirst = subscribeClosePopovers(() => {
      unsubscribeFirst();
      second();
    });
    subscribeClosePopovers(second);

    closeAllPopovers();

    // 两处都应被收起：复制快照再遍历，避免边遍历边改 Set 漏掉后来的订阅者
    expect(second).toHaveBeenCalledTimes(2);
    unsubscribeFirst();
  });
});
