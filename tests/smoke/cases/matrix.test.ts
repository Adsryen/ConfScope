import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("full smoke matrix", () => {
  it("tracks Operation History data replay as automated smoke coverage", () => {
    const matrix = readFileSync(join(process.cwd(), "tests", "smoke", "cases", "matrix.md"), "utf8");
    const row = matrix
      .split(/\r?\n/)
      .find((line) => line.startsWith("| FS-HISTORY-DATA-01 |"));

    expect(row).toBeDefined();
    expect(row).toContain("| PASS |");
    expect(row).toContain("tests/smoke/specs/25-operation-history.spec.ts");
  });
});
