import { afterEach, describe, expect, it, vi } from "vitest";
import { validateConfig, validateConfigIssues } from "./validate";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("validateConfig", () => {
  it("allows empty content for every format", () => {
    expect(validateConfig("", "JSON")).toEqual([]);
    expect(validateConfig("   \n\t", "YAML")).toEqual([]);
  });

  it("reports JSON syntax errors", () => {
    const issues = validateConfig('{"server":', "JSON");

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("JSON 解析失败:");
  });

  it("localizes validation errors from the current locale", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en-US" });

    expect(validateConfig("server.port=8080\nserver.port=9090", "Properties")[0]).toContain("Duplicate key:server.port");
    expect(validateConfig('{"server":', "JSON")[0]).toContain("JSON parse failed:");
    expect(validateConfig("<root>", "XML")[0]).toContain("XML format error:");
  });

  it("accepts valid JSON and YAML content", () => {
    expect(validateConfig('{"server":{"port":8080}}', "JSON")).toEqual([]);
    expect(validateConfig("server:\n  port: 8080", "YAML")).toEqual([]);
  });

  it("reports duplicate YAML keys", () => {
    const issues = validateConfig("server:\n  port: 8080\n  port: 9090", "YAML");

    expect(issues.some((issue) => issue.startsWith("YAML:"))).toBe(true);
  });

  it("reports duplicate properties keys while separating sections", () => {
    expect(validateConfig("server.port=8080\nserver.port=9090", "Properties")[0]).toContain("重复的键:server.port");
    expect(validateConfig("[dev]\nserver.port=8080\n[prod]\nserver.port=9090", "Properties")).toEqual([]);
  });

  it("accepts XML and reports parser failures", () => {
    expect(validateConfig("<root><item /></root>", "XML")).toEqual([]);
    expect(validateConfig("<root>", "XML")[0]).toContain("XML 格式错误:");
  });

  it("does not validate free-form text-like formats", () => {
    expect(validateConfig("<root>", "TEXT")).toEqual([]);
    expect(validateConfig("<div>", "HTML")).toEqual([]);
  });
});

describe("validateConfigIssues 定位（R28）", () => {
  it("JSON 少逗号时给出 1 基行列，而不是只甩一个 position", () => {
    const content = '{\n  "a": 1\n  "b": 2\n}';
    const issues = validateConfigIssues(content, "JSON");

    expect(issues).toHaveLength(1);
    expect(issues[0].line).toBeGreaterThan(1);
    expect(issues[0].column).toBeGreaterThan(0);
    expect(issues[0].message).toContain("JSON 解析失败:");
    // 文案里必须出现「第 N 行」，用户不用再自己数
    expect(issues[0].message).toContain(`第 ${issues[0].line} 行`);
  });

  it("JSON 报错偏移越界时按末尾夹取，不返回 undefined 行号", () => {
    const issues = validateConfigIssues('{"server":', "JSON");

    expect(issues).toHaveLength(1);
    expect(issues[0].line).toBe(1);
    expect(issues[0].message).toContain("第 1 行");
  });

  it("重复 key 报出首次与重复的行号，可跳转的是重复那一行", () => {
    const issues = validateConfigIssues("# c\nserver.port=8080\nother=1\nserver.port=9090", "Properties");

    expect(issues).toHaveLength(1);
    expect(issues[0].line).toBe(4);
    expect(issues[0].message).toContain("首次 2 行");
    expect(issues[0].message).toContain("重复于 4 行");
    // 文案只回显裸 key 名：分组维度（section + NUL + name）绝不能漏进用户可见的字符串
    expect(issues[0].message).toContain("server.port");
    expect(issues[0].message).not.toContain(String.fromCharCode(0));
  });

  it("同一 key 重复多次只报一条，但把所有重复行列出来", () => {
    const issues = validateConfigIssues("a=1\na=2\na=3", "Properties");

    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("2、3");
    expect(issues[0].line).toBe(2);
  });

  it("YAML 语法错误带上结构化行列，供「跳到第 N 行」使用", () => {
    const issues = validateConfigIssues("server:\n  port: 8080\n  port: 9090", "YAML");

    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message.startsWith("YAML:")).toBe(true);
    expect(issues[0].line).toBe(3);
  });

  it("CRLF 文件按行首算列，不会把 \\r 混进定位", () => {
    const issues = validateConfigIssues('{\r\n  "a": 1\r\n  "b": 2\r\n}', "JSON");

    expect(issues[0].line).toBeGreaterThan(1);
    expect(issues[0].column).toBeLessThanOrEqual(12);
  });

  it("validateConfig 仍是 string[]，调用方无需感知行列", () => {
    const messages = validateConfig("a=1\na=2", "Properties");

    expect(messages.every((m) => typeof m === "string")).toBe(true);
    expect(validateConfig('{"a":1}', "JSON")).toEqual([]);
    expect(validateConfigIssues('{"a":1}', "JSON")).toEqual([]);
  });
});
