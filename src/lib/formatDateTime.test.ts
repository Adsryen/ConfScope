/**
 * 时间显示事实源的行为约定（轮11 R41）。
 *
 * 重点钉三件事：格式不跟系统区域变、非法值不出现 NaN 也不变空白、
 * 列表口径（formatListTime）与时长口径（formatElapsed）也归这里，页面不再各写一份。
 */
import { describe, expect, it } from "vitest";
import { formatClock, formatDateTime, formatElapsed, formatListTime } from "./formatDateTime";

describe("formatDateTime", () => {
  it("ISO 串固定输出数字 24 小时制，带秒", () => {
    const text = formatDateTime("2026-10-17T21:40:07");
    expect(text).toBe("2026-10-17 21:40:07");
  });

  it("seconds:false 只到分钟，列表用", () => {
    expect(formatDateTime("2026-10-17T21:40:07", { seconds: false })).toBe("2026-10-17 21:40");
  });

  it("epoch 毫秒字符串也能认：接口层给的就是这种", () => {
    const ms = new Date("2026-10-17T21:40:07").getTime();
    expect(formatDateTime(String(ms))).toBe(formatDateTime(ms));
  });

  it("非法值退回原串，不静默变空", () => {
    expect(formatDateTime("not-a-date")).toBe("not-a-date");
    expect(formatDateTime("")).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
    expect(formatDateTime("oops", { fallback: "未知" })).toBe("未知");
  });

  it("换 locale 环境不影响结果：不接 locale 参数", () => {
    expect(formatDateTime("2026-01-05T09:08:07")).toBe("2026-01-05 09:08:07");
  });
});

describe("formatClock", () => {
  it("只出时刻", () => {
    expect(formatClock("2026-10-17T21:40:07")).toBe("21:40:07");
    expect(formatClock("2026-10-17T21:40:07", { seconds: false })).toBe("21:40");
  });

  it("非法值同样不空不 NaN", () => {
    expect(formatClock("")).toBe("—");
    expect(formatClock("nope")).toBe("nope");
  });
});

describe("formatListTime", () => {
  // 传固定 now 才不会今天跑绿、明天红
  const NOW = "2026-10-17T21:40:07";

  it("同一天只出时刻，列表一屏都是今天时读起来最短", () => {
    expect(formatListTime("2026-10-17T09:08:07", { now: NOW })).toBe("09:08:07");
    expect(formatListTime("2026-10-17T09:08:07", { now: NOW, seconds: false })).toBe("09:08");
  });

  it("跨天补日期，不再让人猜隔夜那条是哪天", () => {
    expect(formatListTime("2026-10-16T23:59:59", { now: NOW })).toBe("10-16 23:59:59");
    expect(formatListTime("2026-01-05T09:08:07", { now: NOW, seconds: false })).toBe("01-05 09:08");
  });

  it("同一天的判定按本地日历日，不按 UTC：跨零点前后各归一档", () => {
    expect(formatListTime("2026-10-17T00:00:01", { now: NOW, seconds: false })).toBe("00:00");
    expect(formatListTime("2026-10-18T00:00:01", { now: NOW, seconds: false })).toBe("10-18 00:00");
  });

  it("不传 now 时按当前时间，非法值仍旧退回原串不空白", () => {
    expect(formatListTime("nope")).toBe("nope");
    expect(formatListTime("")).toBe("—");
    expect(formatListTime("2026-10-17T09:08:07", { fallback: "未知" })).not.toBe("未知");
  });
});

describe("formatElapsed", () => {
  it("四档量级各有写法，秒以内看毫秒", () => {
    expect(formatElapsed(800)).toBe("800ms");
    expect(formatElapsed(9_500)).toBe("9.5s");
    expect(formatElapsed(60_000)).toBe("1m 00s");
    expect(formatElapsed(192_000)).toBe("3m 12s");
    expect(formatElapsed(7_500_000)).toBe("2h 05m");
  });

  it("两三秒的会话不许读成 0s", () => {
    expect(formatElapsed(2_340)).toBe("2.3s");
  });

  it("非数字与负数如实给出占位，不出现 NaN", () => {
    expect(formatElapsed(Number.NaN)).toBe("—");
    expect(formatElapsed(-5)).toBe("—");
  });
});
