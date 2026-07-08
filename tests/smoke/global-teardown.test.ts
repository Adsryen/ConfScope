import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeReports, type SmokeCaseResult } from "./env/report";
import { createSmokeWorkspace, type SmokeState } from "./env/workspace";
import { recordKnownGaps } from "./global-teardown";

const tempRoots: string[] = [];

describe("smoke global teardown", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not re-add gaps for product coverage that now has smoke automation", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "confscope-vite-gaps-"));
    tempRoots.push(projectRoot);
    const state: SmokeState = {
      ...createSmokeWorkspace({ projectRoot, runId: "vite-gaps" }),
      fixtures: { strictPublic: "", legacyPublic: "", invalidEmpty: "" },
    };
    initializeReports(state);

    recordKnownGaps(state);

    const cases = JSON.parse(readFileSync(join(state.reportsDir, "cases.json"), "utf8")) as SmokeCaseResult[];
    const ids = cases.map((item) => item.id);
    expect(ids).not.toContain("GAP-CONFIG-WEBDAV");
    expect(ids).not.toContain("GAP-NATIVE-WAILS");
  });
});
