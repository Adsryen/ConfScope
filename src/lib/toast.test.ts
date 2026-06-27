import { beforeEach, describe, expect, it, vi } from "vitest";

describe("toast store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
  });

  it("notifies a subscriber with the current items immediately", async () => {
    const { subscribe } = await import("./toast");
    const listener = vi.fn();

    const unsubscribe = subscribe(listener);

    expect(listener).toHaveBeenCalledWith([]);
    unsubscribe();
  });

  it("adds toast items and removes them after the timeout", async () => {
    const { subscribe, toast } = await import("./toast");
    const snapshots: unknown[] = [];
    const unsubscribe = subscribe((items) => snapshots.push(items));

    toast("saved", "success");

    expect(snapshots[snapshots.length - 1]).toEqual([{ id: 1, text: "saved", type: "success" }]);

    vi.advanceTimersByTime(2600);

    expect(snapshots[snapshots.length - 1]).toEqual([]);
    unsubscribe();
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
