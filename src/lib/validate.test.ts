import { describe, expect, it } from "vitest";
import { validateConfig } from "./validate";

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

  it("accepts valid JSON and YAML content", () => {
    expect(validateConfig('{"server":{"port":8080}}', "JSON")).toEqual([]);
    expect(validateConfig("server:\n  port: 8080", "YAML")).toEqual([]);
  });

  it("reports duplicate YAML keys", () => {
    const issues = validateConfig("server:\n  port: 8080\n  port: 9090", "YAML");

    expect(issues.some((issue) => issue.startsWith("YAML:"))).toBe(true);
  });

  it("reports duplicate properties keys while separating sections", () => {
    expect(validateConfig("server.port=8080\nserver.port=9090", "Properties")).toEqual([
      "重复的键:server.port",
    ]);
    expect(validateConfig("[dev]\nserver.port=8080\n[prod]\nserver.port=9090", "Properties")).toEqual(
      []
    );
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
