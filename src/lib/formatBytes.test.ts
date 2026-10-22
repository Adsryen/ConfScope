import { describe, expect, it } from "vitest";
import { formatBytes } from "./formatBytes";

/**
 * 数据位置面板里的体积展示（轮62）。
 * 盯三件容易写错的事：进位边界、小数位随量级收紧、异常输入不能显示成 "NaN GB"。
 */
describe("formatBytes", () => {
  it("小于 1KB 取整到字节", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("1024 起进位到 KB，并按量级收紧小数位", () => {
    expect(formatBytes(1024)).toBe("1.00 KB");
    expect(formatBytes(1536)).toBe("1.50 KB");
    expect(formatBytes(20 * 1024)).toBe("20.0 KB");
    expect(formatBytes(1023 * 1024)).toBe("1023 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.00 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.00 GB");
  });

  it("坏输入显示占位符而不是 NaN", () => {
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("—");
  });
});
