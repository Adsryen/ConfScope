/**
 * 时间显示事实源的行为约定（轮11 R41）。
 *
 * 重点钉两件事：格式不跟系统区域变、非法值不出现 NaN 也不变空白。
 */
import { describe, expect, it } from "vitest";
import { formatClock, formatDateTime } from "./formatDateTime";

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
