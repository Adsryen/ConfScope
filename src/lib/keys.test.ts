import { describe, expect, it } from "vitest";
import { extractKeys, keysDoc } from "./keys";

describe("extractKeys", () => {
  it("extracts sorted unique JSON object paths without array indexes", () => {
    const keys = extractKeys(
      JSON.stringify({
        server: { port: 8080 },
        spring: { profiles: ["prod"], datasource: { url: "jdbc" } },
      }),
      "JSON"
    );

    expect(keys).toEqual([
      "server",
      "server.port",
      "spring",
      "spring.datasource",
      "spring.datasource.url",
      "spring.profiles",
    ]);
  });

  it("falls back to line parsing when JSON is invalid", () => {
    expect(extractKeys("server:\n  port: 8080", "JSON")).toEqual(["server", "server.port"]);
  });

  it("extracts YAML-like nested keys by indentation", () => {
    expect(
      extractKeys(
        [
          "# ignored",
          "server:",
          "  port: 8080",
          "spring:",
          "  application:",
          "    name: demo",
        ].join("\n"),
        "YAML"
      )
    ).toEqual(["server", "server.port", "spring", "spring.application", "spring.application.name"]);
  });

  it("extracts properties keys and removes duplicates", () => {
    expect(
      extractKeys(
        ["server.port=8080", "server.host=localhost", "server.port=9090"].join("\n"),
        "Properties"
      )
    ).toEqual(["server.host", "server.port"]);
  });
});

describe("keysDoc", () => {
  it("joins extracted keys with newlines for diff input", () => {
    expect(keysDoc("b=1\na=2", "Properties")).toBe("a\nb");
  });
});
