/**
 * tone → 播报语义 的唯一映射（轮14 波33 / R54）。
 *
 * 这里钉的是「判定」而不是站点：站点接线由 tests/ux/statusMessageLiveSemantics.test.ts 静态守卫钉死，
 * 本文件保证映射本身不跑偏——错误必须是 alert 且不得再写 aria-live（双写会让部分读屏把同一句念两遍），
 * 成功与中性提示必须是 status + polite（打断用户当前朗读的 assertive 在这儿没有正当理由）。
 */
import { describe, expect, it } from "vitest";
import { statusMessageProps, type StatusTone } from "./statusSemantics";

const TONES: StatusTone[] = ["error", "success", "info"];

describe("statusMessageProps（波33 R54）", () => {
  it("error 只给 role=alert，不再手写 aria-live", () => {
    expect(statusMessageProps("error")).toEqual({ role: "alert" });
  });

  it("success 给 status + polite", () => {
    expect(statusMessageProps("success")).toEqual({ role: "status", "aria-live": "polite" });
  });

  it("info 与 success 同档：中性说明也不该打断朗读", () => {
    expect(statusMessageProps("info")).toEqual(statusMessageProps("success"));
  });

  it("任何档位都不产出 assertive / off", () => {
    for (const tone of TONES) {
      expect(statusMessageProps(tone)["aria-live"]).not.toBe("assertive");
      expect(statusMessageProps(tone)["aria-live"]).not.toBe("off");
    }
  });

  it("只有 error 是 alert：其余一律 status", () => {
    const roles = TONES.map((tone) => statusMessageProps(tone).role);
    expect(roles).toEqual(["alert", "status", "status"]);
  });

  it("档位集合是闭包枚举，新增 tone 必须在这里同步", () => {
    expect(TONES.slice().sort()).toEqual(["error", "info", "success"]);
  });
});
