import { describe, expect, it } from "vitest";
import { normalizeConfig } from "./normalize";

describe("normalizeConfig", () => {
  it("flattens nested JSON objects into sorted config entries", () => {
    const result = normalizeConfig(
      JSON.stringify({
        server: { port: 8080, host: "localhost" },
        features: { enabled: true },
        optional: null,
        tags: ["blue", "green"],
      }),
      "JSON"
    );

    expect(result.parseStatus).toBe("ok");
    expect(result.entries).toEqual([
      {
        key: "features.enabled",
        value: "true",
        valueType: "boolean",
        sourcePath: "features.enabled",
        parseStatus: "ok",
      },
      {
        key: "optional",
        value: "null",
        valueType: "null",
        sourcePath: "optional",
        parseStatus: "ok",
      },
      {
        key: "server.host",
        value: "localhost",
        valueType: "string",
        sourcePath: "server.host",
        parseStatus: "ok",
      },
      {
        key: "server.port",
        value: "8080",
        valueType: "number",
        sourcePath: "server.port",
        parseStatus: "ok",
      },
      {
        key: "tags",
        value: '["blue","green"]',
        valueType: "array",
        sourcePath: "tags",
        parseStatus: "ok",
      },
    ]);
  });

  it("flattens nested YAML objects into config entries", () => {
    const result = normalizeConfig(
      ["server:", "  port: 8080", "  host: localhost", "features:", "  enabled: true"].join("\n"),
      "YAML"
    );

    expect(result.parseStatus).toBe("ok");
    expect(result.entries.map((entry) => [entry.key, entry.value, entry.valueType])).toEqual([
      ["features.enabled", "true", "boolean"],
      ["server.host", "localhost", "string"],
      ["server.port", "8080", "number"],
    ]);
  });

  it("keeps root arrays as a document-level entry", () => {
    const result = normalizeConfig('["dev","prod"]', "JSON");

    expect(result).toEqual({
      parseStatus: "ok",
      entries: [
        {
          key: "__document",
          value: '["dev","prod"]',
          valueType: "array",
          sourcePath: "__document",
          parseStatus: "ok",
        },
      ],
    });
  });

  it("parses properties while ignoring comments and blank lines", () => {
    const result = normalizeConfig(
      ["# app config", "", "server.port=8080", "server.host: localhost", "empty.value="].join("\n"),
      "Properties"
    );

    expect(result.parseStatus).toBe("ok");
    expect(result.entries.map((entry) => [entry.key, entry.value, entry.valueType])).toEqual([
      ["empty.value", "", "empty"],
      ["server.host", "localhost", "string"],
      ["server.port", "8080", "number"],
    ]);
  });

  it("deduplicates properties by keeping the last value", () => {
    const result = normalizeConfig("server.port=8080\nserver.port=9090", "Properties");

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      key: "server.port",
      value: "9090",
      valueType: "number",
    });
  });

  it("returns a document-level fallback entry when parsing fails", () => {
    const result = normalizeConfig('{"server":', "JSON");

    expect(result.parseStatus).toBe("error");
    expect(result.parseError).toContain("JSON");
    expect(result.entries).toEqual([
      {
        key: "__document",
        value: '{"server":',
        valueType: "text",
        sourcePath: "__document",
        parseStatus: "error",
        parseError: result.parseError,
      },
    ]);
  });

  it("keeps text-like formats as a document-level entry", () => {
    const result = normalizeConfig("plain text", "TEXT");

    expect(result).toEqual({
      parseStatus: "fallback",
      entries: [
        {
          key: "__document",
          value: "plain text",
          valueType: "text",
          sourcePath: "__document",
          parseStatus: "fallback",
        },
      ],
    });
  });
});
