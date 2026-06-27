import { describe, expect, it } from "vitest";
import { highlightCode, highlightLine } from "./highlight";

describe("highlightCode", () => {
  it("escapes HTML for plain text", () => {
    expect(highlightCode("<script>&</script>", "TEXT")).toBe("&lt;script&gt;&amp;&lt;/script&gt;");
  });

  it("highlights known config formats", () => {
    expect(highlightCode('{"server":8080}', "JSON")).toContain("hljs-");
  });
});

describe("highlightLine", () => {
  it("returns an empty string for empty lines", () => {
    expect(highlightLine("", "JSON")).toBe("");
  });

  it("returns stable cached output for the same line and format", () => {
    const first = highlightLine("server.port=8080", "Properties");
    const second = highlightLine("server.port=8080", "Properties");

    expect(second).toBe(first);
  });
});
