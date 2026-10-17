/**
 * busyProps 的返回值形态（轮15 波36 / R55）。
 *
 * 静态守卫只能证明容器上展开了 busyProps(...)，证不出展开出来的键值对不对：
 * 键名写成 arialive、忙完还留着 aria-busy=false、顺手多带一个 role —— 这三样都不报错，
 * 但读屏拿到的是「这块永远在变」或者同一句念两遍。契约钉在这里。
 */
import { describe, expect, it } from "vitest";
import { busyProps } from "./busyRegion";

describe("busyProps 的返回值（波36 R55）", () => {
  it("busy 为真时只输出一个键：aria-busy=true", () => {
    expect(busyProps(true)).toEqual({ "aria-busy": true });
  });

  it("busy 为假时键还在但值是 undefined，交给 React 把属性整个摘掉", () => {
    const props = busyProps(false);
    expect(Object.keys(props)).toEqual(["aria-busy"]);
    expect(props["aria-busy"]).toBeUndefined();
  });

  it("不夹带 role 与 aria-live：播报归波23 的占位文本，这里只管区域状态", () => {
    for (const busy of [true, false]) {
      const keys = Object.keys(busyProps(busy));
      expect(keys).toEqual(["aria-busy"]);
      expect(keys).not.toContain("role");
      expect(keys).not.toContain("aria-live");
    }
  });
});
