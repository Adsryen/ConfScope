import { describe, expect, it } from "vitest";
import { diffLines } from "./diff";

describe("diffLines", () => {
  it("returns no rows for two empty documents", () => {
    const result = diffLines("", "");

    expect(result).toEqual({
      rows: [],
      added: 0,
      removed: 0,
      modified: 0,
    });
  });

  it("keeps equal lines aligned with line numbers", () => {
    const result = diffLines("a\nb", "a\nb");

    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.modified).toBe(0);
    expect(result.rows).toEqual([
      { type: "equal", leftNo: 1, rightNo: 1, left: "a", right: "a" },
      { type: "equal", leftNo: 2, rightNo: 2, left: "b", right: "b" },
    ]);
  });

  it("normalizes CRLF and CR line endings", () => {
    const result = diffLines("a\r\nb\rc", "a\nb\nc");

    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.modified).toBe(0);
    expect(result.rows).toHaveLength(3);
  });

  it("pairs adjacent deleted and added lines as modifications", () => {
    const result = diffLines("server.port=8080", "server.port=9090");

    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.modified).toBe(1);
    expect(result.rows).toEqual([
      {
        type: "modify",
        leftNo: 1,
        rightNo: 1,
        left: "server.port=8080",
        right: "server.port=9090",
      },
    ]);
  });

  it("tracks inserted and removed lines around shared context", () => {
    const result = diffLines("a\nb\nc", "a\nx\nc\nd");

    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.modified).toBe(1);
    expect(result.rows).toEqual([
      { type: "equal", leftNo: 1, rightNo: 1, left: "a", right: "a" },
      { type: "modify", leftNo: 2, rightNo: 2, left: "b", right: "x" },
      { type: "equal", leftNo: 3, rightNo: 3, left: "c", right: "c" },
      { type: "add", leftNo: null, rightNo: 4, left: null, right: "d" },
    ]);
  });
});
