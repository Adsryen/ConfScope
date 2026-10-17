import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToastItem } from "./toast";

/**
 * R25：轻提示的生命周期契约。
 *
 * 关键点是「出错时看得见」——error 的时长、悬停暂停、合并计数、条数上限都住在这个模块里，
 * 一旦哪天有人把 6s 改回 2.6s 或把 hold 的顺序写反（先改状态再撤倒计时，暂停期到点自己消失），
 * 组件层的用例照样全绿，只有这里的数值/时序断言会红。
 */
describe("toast store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // resetModules 只换模块实例，已排定的 setTimeout 还留在同一个假时钟里；
    // 不清干净的话后面的用例数到的定时器是上一条留下的遗产。
    vi.clearAllTimers();
    vi.resetModules();
  });

  it("notifies a subscriber with the current items immediately", async () => {
    const { subscribe } = await import("./toast");
    const listener = vi.fn();

    const unsubscribe = subscribe(listener);

    expect(listener).toHaveBeenCalledWith([]);
    unsubscribe();
  });

  it("adds toast items and removes them after the success duration", async () => {
    const { subscribe, toast, TOAST_DURATION } = await import("./toast");
    const snapshots: ToastItem[][] = [];
    const unsubscribe = subscribe((items) => snapshots.push(items));
    const at = Date.now();

    toast("saved", "success");

    expect(snapshots[snapshots.length - 1]).toEqual([{ id: 1, text: "saved", type: "success", count: 1, held: false, at }]);

    vi.advanceTimersByTime(TOAST_DURATION.success - 1);
    expect(snapshots[snapshots.length - 1]).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(snapshots[snapshots.length - 1]).toEqual([]);
    unsubscribe();
  });

  it("gives errors at least six seconds so they can be read", async () => {
    const { subscribe, toast, TOAST_DURATION } = await import("./toast");
    const snapshots: ToastItem[][] = [];
    subscribe((items) => snapshots.push(items));
    const last = () => snapshots[snapshots.length - 1];

    expect(TOAST_DURATION.error).toBeGreaterThanOrEqual(6000);

    toast("boom", "error");
    vi.advanceTimersByTime(TOAST_DURATION.success);
    expect(last()).toHaveLength(1);

    vi.advanceTimersByTime(TOAST_DURATION.error - TOAST_DURATION.success);
    expect(last()).toEqual([]);
  });

  it("merges identical text into a counter instead of stacking duplicates", async () => {
    const { subscribe, toast, DEDUPE_WINDOW } = await import("./toast");
    const snapshots: ToastItem[][] = [];
    subscribe((items) => snapshots.push(items));

    toast("saved", "success");
    toast("saved", "success");
    toast("saved", "success");

    expect(snapshots[snapshots.length - 1]).toEqual([{ id: 1, text: "saved", type: "success", count: 3, held: false, at: Date.now() }]);

    // 文案相同但类型不同，属于两条不同的反馈，不合并
    toast("saved", "error");
    expect(snapshots[snapshots.length - 1]).toHaveLength(2);

    // 合并窗口过后另起一条，不再把几秒前的动作算进同一次反馈
    vi.advanceTimersByTime(DEDUPE_WINDOW);
    toast("saved", "error");
    expect(snapshots[snapshots.length - 1]).toHaveLength(3);
  });

  it("pauses the countdown while held and gives a short tail on release", async () => {
    const { subscribe, toast, hold, release, RESUME_GRACE, TOAST_DURATION } = await import("./toast");
    const snapshots: ToastItem[][] = [];
    subscribe((items) => snapshots.push(items));
    const last = () => snapshots[snapshots.length - 1];

    const id = toast("boom", "error");
    hold(id);

    expect(last()[0].held).toBe(true);
    // 先撤倒计时再改状态，所以暂停期间不留任何待触发的定时器
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(TOAST_DURATION.error * 2);
    expect(last()).toHaveLength(1);

    release(id);
    expect(last()[0].held).toBe(false);
    vi.advanceTimersByTime(RESUME_GRACE - 1);
    expect(last()).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(last()).toEqual([]);
  });

  it("merging into a held item keeps it paused", async () => {
    const { subscribe, toast, hold } = await import("./toast");
    const snapshots: ToastItem[][] = [];
    subscribe((items) => snapshots.push(items));
    const last = () => snapshots[snapshots.length - 1];

    const id = toast("boom", "error");
    hold(id);
    toast("boom", "error");

    expect(last()[0].count).toBe(2);
    expect(last()[0].held).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps the visible stack by dropping the oldest item", async () => {
    const { subscribe, toast, MAX_VISIBLE } = await import("./toast");
    const snapshots: { text: string }[][] = [];
    subscribe((items) => snapshots.push(items));

    for (let i = 0; i < MAX_VISIBLE + 2; i += 1) toast(`m${i}`, "info");

    const texts = snapshots[snapshots.length - 1].map((item) => item.text);
    expect(texts).toHaveLength(MAX_VISIBLE);
    // 最旧的两条被挤掉，留下最后发的 MAX_VISIBLE 条、顺序不变
    expect(texts).toEqual(["m2", "m3", "m4", "m5"]);
  });

  it("dismiss removes only the targeted item", async () => {
    const { subscribe, toast, dismiss } = await import("./toast");
    const snapshots: ToastItem[][] = [];
    subscribe((items) => snapshots.push(items));

    const first = toast("first", "success");
    toast("second", "success");
    dismiss(first);
    // 重复撤下与撤不存在的 id 都不该再发通知
    dismiss(first);

    expect(snapshots[snapshots.length - 1]).toEqual([{ id: 2, text: "second", type: "success", count: 1, held: false, at: Date.now() }]);
  });

  it("clearToasts drops items together with their pending timers", async () => {
    const { toast, clearToasts, subscribe } = await import("./toast");
    const listener = vi.fn();
    subscribe(listener);
    listener.mockClear();

    toast("a", "success");
    toast("b", "error");
    clearToasts();

    expect(listener).toHaveBeenLastCalledWith([]);
    expect(vi.getTimerCount()).toBe(0);

    const callsAfterClear = listener.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    // 定时器已被 clearToasts 撤干净，不会再有迟到的 dismiss 通知
    expect(listener).toHaveBeenCalledTimes(callsAfterClear);
  });

  it("ignoring hold/dismiss/release for an unknown id does not emit", async () => {
    const { hold, release, dismiss, subscribe } = await import("./toast");
    const listener = vi.fn();
    subscribe(listener);
    listener.mockClear();

    hold(999);
    release(999);
    dismiss(999);

    expect(listener).not.toHaveBeenCalled();
  });

  it("does not notify unsubscribed listeners", async () => {
    const { subscribe, toast } = await import("./toast");
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    listener.mockClear();

    unsubscribe();
    toast("ignored", "info");

    expect(listener).not.toHaveBeenCalled();
  });
});
