import { describe, expect, it } from "vitest";
import { errorText } from "./errorText";

describe("errorText（R44 单一出口）", () => {
  it("Error 只取 message，界面不再冒 Error: 前缀", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText(new TypeError("port must be a number"))).toBe("port must be a number");
  });

  it("落盘过的 String(e) 结果再显示时也要擦干净前缀", () => {
    expect(errorText("Error: download denied")).toBe("download denied");
    expect(errorText({ message: "TypeError: read tcp timed out" })).toBe("read tcp timed out");
  });

  it("只认 Error/Exception 结尾的前缀，不误伤正文里的冒号", () => {
    expect(errorText("EOF: connection reset")).toBe("EOF: connection reset");
    expect(errorText("Nacos returned 403: Invalid signature")).toBe("Nacos returned 403: Invalid signature");
  });

  it("非 Error 抛出不再退化成 [object Object]", () => {
    expect(errorText({ code: "ENOENT", path: "/etc/hosts" })).toContain("ENOENT");
    expect(errorText({ code: "ENOENT" })).not.toBe("[object Object]");
  });

  it("正文字段按 message/msg/error/detail/reason 取用", () => {
    expect(errorText({ msg: "socket closed" })).toBe("socket closed");
    expect(errorText({ error: "bad gateway" })).toBe("bad gateway");
  });

  it("空 message 的 Error 退回类型名，界面不会出现空白错误", () => {
    expect(errorText(new Error())).toBe("Error");
    expect(errorText(new RangeError())).toBe("RangeError");
  });

  it("连 toString 都没有的对象也不再抛错", () => {
    const bare = Object.create(null);
    expect(() => errorText(bare)).not.toThrow();
    expect(errorText(bare)).toBe("");
  });

  it("循环引用对象不会把捕获过程炸掉", () => {
    const circular: Record<string, unknown> = { name: "ctx" };
    circular.self = circular;
    expect(() => errorText(circular)).not.toThrow();
  });

  it("原始值给个可读文本", () => {
    expect(errorText("plain failure")).toBe("plain failure");
    expect(errorText(null)).toBe("null");
    expect(errorText(undefined)).toBe("undefined");
    expect(errorText(0)).toBe("0");
    expect(errorText(false)).toBe("false");
  });

  it("不截断长文本：嗅探 403/404 与复制错误详情都依赖全文", () => {
    const long = "x".repeat(20000) + " 403";
    expect(errorText(new Error(long))).toHaveLength(20004);
    expect(errorText(new Error(long))).toContain("403");
  });
});
