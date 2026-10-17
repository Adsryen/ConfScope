import { describe, expect, it } from "vitest";
import type { ConfigItem } from "../api/nacos";
import { describeConfigListGaps, isStaleRequestError } from "./configListStatus";
import { StaleRequestError } from "../api/nacos";

const t = (key: string, params?: Record<string, string | number>) => `${key}:${JSON.stringify(params ?? {})}`;

/** 只填 describeConfigListGaps 会用到的字段，避免造完整聚合结果。 */
function fakeResult(loadedCount: number, failedPages: number[] = [], truncated = false) {
  const items = Array.from({ length: loadedCount }, (_, index): ConfigItem => ({
    dataId: `app-${index}.yaml`,
    group: "DEFAULT_GROUP",
    content: "",
    configType: "yaml",
  }));
  return { items, failedPages, truncated };
}

describe("describeConfigListGaps", () => {
  it("结果完整时不产生任何提示", () => {
    expect(describeConfigListGaps(fakeResult(500), t)).toEqual([]);
  });

  it("命中安全上限时提示仅扫描前 N 条", () => {
    expect(describeConfigListGaps(fakeResult(5000, [], true), t)).toEqual(['common.configListTruncated:{"count":5000}']);
  });

  it("有页失败时提示失败页与已取条数", () => {
    expect(describeConfigListGaps(fakeResult(200, [3, 4]), t)).toEqual(['common.configListPartial:{"pages":"3, 4","count":200}']);
  });

  it("上限截断与失败页同时出现时两条都提示", () => {
    const gaps = describeConfigListGaps(fakeResult(3000, [7], true), t);
    expect(gaps).toHaveLength(2);
    expect(gaps[0]).toContain("common.configListTruncated");
    expect(gaps[1]).toContain("common.configListPartial");
  });
});

describe("isStaleRequestError", () => {
  it("识别 StaleRequestError 实例", () => {
    expect(isStaleRequestError(new StaleRequestError())).toBe(true);
  });

  it("按 name 识别等价异常（跨模块实例场景）", () => {
    const duck = new Error("stale");
    duck.name = "StaleRequestError";
    expect(isStaleRequestError(duck)).toBe(true);
  });

  it("不误判普通错误与非异常值", () => {
    expect(isStaleRequestError(new Error("boom"))).toBe(false);
    expect(isStaleRequestError(undefined)).toBe(false);
    expect(isStaleRequestError("StaleRequestError")).toBe(false);
  });
});
