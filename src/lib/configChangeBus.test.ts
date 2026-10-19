import { describe, expect, it, vi } from "vitest";
import {
  changeTouchesConfig,
  changeTouchesNamespace,
  normalizeGroup,
  normalizeNamespace,
  publishConfigChange,
  subscribeConfigChanges,
  type ConfigChangeNotice,
} from "./configChangeBus";

const notice = (overrides: Partial<ConfigChangeNotice> = {}): ConfigChangeNotice => ({
  connectionId: "retest-a",
  namespace: "retest-dev",
  refs: [{ dataId: "svc-pay.properties", group: "RETEST-PROD" }],
  ...overrides,
});

describe("configChangeBus", () => {
  it("通知已订阅者，取消订阅后不再收到", () => {
    const seen: ConfigChangeNotice[] = [];
    const unsubscribe = subscribeConfigChanges((next) => seen.push(next));

    publishConfigChange(notice());
    expect(seen).toHaveLength(1);

    unsubscribe();
    publishConfigChange(notice());
    expect(seen).toHaveLength(1);
  });

  it("refs 为空时不发布（没有任何数据变化就不该惊动视图）", () => {
    const handler = vi.fn();
    const unsubscribe = subscribeConfigChanges(handler);

    publishConfigChange({ connectionId: "retest-a", namespace: "retest-dev", refs: [] });
    expect(handler).not.toHaveBeenCalled();

    unsubscribe();
  });

  it("派发过程中有订阅者自行取消订阅也不影响其余订阅者", () => {
    const second = vi.fn();
    const unsubscribeFirst = subscribeConfigChanges(() => {
      unsubscribeFirst();
      second();
    });
    subscribeConfigChanges(second);

    publishConfigChange(notice());

    expect(second).toHaveBeenCalledTimes(2);
    unsubscribeFirst();
  });

  it("命名空间归一：空串与 public 同一语义", () => {
    expect(normalizeNamespace("")).toBe("public");
    expect(normalizeNamespace("   ")).toBe("public");
    expect(normalizeNamespace(null)).toBe("public");
    expect(normalizeNamespace(undefined)).toBe("public");
    expect(normalizeNamespace("public")).toBe("public");
    expect(normalizeNamespace("retest-dev")).toBe("retest-dev");

    expect(changeTouchesNamespace(notice({ namespace: "public" }), "retest-a", "")).toBe(true);
    expect(changeTouchesNamespace(notice({ namespace: "" }), "retest-a", "public")).toBe(true);
    expect(changeTouchesNamespace(notice(), "retest-a", "retest-qa")).toBe(false);
    expect(changeTouchesNamespace(notice(), "retest-b", "retest-dev")).toBe(false);
    expect(changeTouchesNamespace(notice(), null, "retest-dev")).toBe(false);
  });

  it("group 归一：空 group 就是 DEFAULT_GROUP", () => {
    expect(normalizeGroup("")).toBe("DEFAULT_GROUP");
    expect(normalizeGroup(null)).toBe("DEFAULT_GROUP");
    expect(normalizeGroup("RETEST-PROD")).toBe("RETEST-PROD");

    expect(changeTouchesConfig(notice({ refs: [{ dataId: "a", group: "" }] }), {
      connectionId: "retest-a",
      namespace: "retest-dev",
      dataId: "a",
      group: "DEFAULT_GROUP",
    })).toBe(true);
  });

  it("位置级判据：连接/命名空间/ dataId 任一不符即不相关", () => {
    const target = { connectionId: "retest-a", namespace: "retest-dev", dataId: "svc-pay.properties", group: "RETEST-PROD" };
    expect(changeTouchesConfig(notice(), target)).toBe(true);
    expect(changeTouchesConfig(notice({ refs: [{ dataId: "other.yaml", group: "RETEST-PROD" }] }), target)).toBe(false);
    expect(changeTouchesConfig(notice({ refs: [{ dataId: "svc-pay.properties", group: "DEFAULT_GROUP" }] }), target)).toBe(false);
    expect(changeTouchesConfig(notice({ connectionId: "retest-b" }), target)).toBe(false);
  });
});
