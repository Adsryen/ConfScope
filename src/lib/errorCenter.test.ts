/**
 * @vitest-environment jsdom
 *
 * 反馈通道口径的行为用例（轮94）。
 * 判定式 `shouldAnnounce()` 的规则表在这里被逐条钉住；静态那一半（判定式不许在别处再搓一份、
 * `origin:"system"` 的站点名单）由 `tests/ux/feedbackChannelPolicyStaysWired.test.ts` 守。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearErrors, reportError, reportMessage, shouldAnnounce, subscribeErrors } from "./errorCenter";
import type { AppErrorItem } from "./errorCenter";
import { toast } from "./toast";

vi.mock("./toast", () => ({
  toast: vi.fn(),
}));

function latest(): AppErrorItem[] {
  let snapshot: AppErrorItem[] = [];
  const unsubscribe = subscribeErrors((items) => {
    snapshot = items;
  });
  unsubscribe();
  return snapshot;
}

describe("errorCenter", () => {
  beforeEach(() => {
    localStorage.clear();
    clearErrors();
    vi.mocked(toast).mockReset();
  });

  it("localizes the default toast summary", () => {
    localStorage.setItem("locale", "en-US");

    reportError({ title: "Load failed", message: "Network error" });

    expect(toast).toHaveBeenCalledWith("Load failed, saved to Message Center", "error");
  });

  // 轮94 取证 4：次数以前写进文案（「X（2 次，已记录到消息中心）」），于是每次都不同，
  // `lib/toast` 的 1.5s 合并窗口永远命中不了，同一件事按次数铺满整叠提示。
  it("keeps the toast text stable across merges so the toast layer can dedupe", () => {
    localStorage.setItem("locale", "en-US");

    reportError({ title: "Load failed", message: "first", mergeKey: "load" });
    reportError({ title: "Load failed", message: "second", mergeKey: "load" });

    const texts = vi.mocked(toast).mock.calls.map((call) => call[0]);
    expect(texts, "合并后仍播报同一句话，交给 toast 层叠成 × N").toEqual([texts[0], texts[0]]);
    expect(texts[0]).toBe("Load failed, saved to Message Center");
    expect(latest().find((item) => item.mergeKey === "load")?.count).toBe(2);
  });

  it("keeps explicit toast text unchanged", () => {
    localStorage.setItem("locale", "en-US");

    reportError({ title: "Load failed", message: "Network error", toast: "Custom summary" });

    expect(toast).toHaveBeenCalledWith("Custom summary", "error");
  });

  describe("轮94 口径：谁触发的事件才配占用即时通道", () => {
    it("系统自发的 info/success 只登记，不抢即时通道", () => {
      reportMessage({ level: "info", origin: "system", title: "New version available", message: "notes" });
      reportMessage({ level: "success", origin: "system", title: "Scheduled sync done", message: "ok" });

      expect(toast, "用户没在等结果的事不该打断他").not.toHaveBeenCalled();
      const items = latest();
      expect(items).toHaveLength(2);
      expect(
        items.every((item) => !item.read),
        "静默登记必须留未读，等用户自己来看"
      ).toBe(true);
    });

    it("系统自发的 error/warning 仍然即时播报", () => {
      reportMessage({ level: "error", origin: "system", title: "Data file save failed", message: "disk" });
      reportMessage({ level: "warning", origin: "system", title: "Tunnel dropped", message: "ssh" });

      expect(vi.mocked(toast)).toHaveBeenNthCalledWith(1, expect.stringContaining("Data file save failed"), "error");
      expect(vi.mocked(toast)).toHaveBeenNthCalledWith(2, expect.stringContaining("Tunnel dropped"), "info");
    });

    it("用户动作的结果按默认值播报，包括 info", () => {
      reportMessage({ level: "info", title: "Compare prepared", message: "ok" });
      reportMessage({ level: "success", title: "Saved", message: "ok" });

      expect(vi.mocked(toast)).toHaveBeenCalledTimes(2);
    });

    it("显式 toast:false 一票否决，显式 toast:true 一票放行", () => {
      reportMessage({ level: "info", origin: "system", title: "Muted", message: "ok", toast: false });
      expect(toast).not.toHaveBeenCalled();

      reportMessage({ level: "info", origin: "system", title: "Loud", message: "ok", toast: true });
      expect(toast).toHaveBeenCalledWith(expect.stringContaining("Loud"), "info");
    });

    it("shouldAnnounce 的规则表按优先级走，不靠调用顺序碰运气", () => {
      expect(shouldAnnounce({ origin: "system" }, "info")).toBe(false);
      expect(shouldAnnounce({ origin: "system" }, "success")).toBe(false);
      expect(shouldAnnounce({ origin: "system" }, "error")).toBe(true);
      expect(shouldAnnounce({ origin: "system" }, "warning")).toBe(true);
      expect(shouldAnnounce({}, "info"), "缺省 user：用户动作的结果必须即时可见").toBe(true);
      expect(shouldAnnounce({ origin: "user" }, "info")).toBe(true);
      // 显式意图大于口径：false 连 error 也压住，true 连系统 info 也放行
      expect(shouldAnnounce({ origin: "system", toast: false }, "error")).toBe(false);
      expect(shouldAnnounce({ origin: "user", toast: false }, "error")).toBe(false);
      expect(shouldAnnounce({ origin: "system", toast: "自定义" }, "info")).toBe(true);
      expect(shouldAnnounce({ origin: "system", toast: true }, "info")).toBe(true);
    });
  });
});
