import { describe, expect, it } from "vitest";
import { detectFormat, nacosType } from "./format";

describe("detectFormat", () => {
  it("prefers explicit Nacos type over file extension and content", () => {
    expect(detectFormat("app.json", "yaml", '{"a":1}')).toBe("YAML");
  });

  it("detects format from dataId extension", () => {
    expect(detectFormat("app.yml", "", "")).toBe("YAML");
    expect(detectFormat("app.properties", "", "")).toBe("Properties");
    expect(detectFormat("app.toml", "", "")).toBe("TOML");
  });

  it("detects JSON, HTML, and XML from content", () => {
    expect(detectFormat("config", "", '{"server":{"port":8080}}')).toBe("JSON");
    expect(detectFormat("config", "", "<!doctype html><html></html>")).toBe("HTML");
    expect(detectFormat("config", "", "<root></root>")).toBe("XML");
  });

  it("uses line heuristics for properties and YAML content", () => {
    expect(detectFormat("config", "", "server.port=8080\nserver.host=localhost")).toBe("Properties");
    expect(detectFormat("config", "", "server:\n  port: 8080\n  host: localhost")).toBe("YAML");
  });

  it("falls back to TEXT for empty or unknown content", () => {
    expect(detectFormat("config", "", "")).toBe("TEXT");
    expect(detectFormat("config", "", "just some text")).toBe("TEXT");
  });
});

describe("nacosType", () => {
  it("maps internal format names to Nacos type values", () => {
    expect(nacosType("Properties")).toBe("properties");
    expect(nacosType("YAML")).toBe("yaml");
    expect(nacosType("TEXT")).toBe("text");
  });
});
