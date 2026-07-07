import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeReports, type SmokeCaseResult } from "../env/report";
import { createSmokeWorkspace, type SmokeState } from "../env/workspace";
import { recordKnownNativeGaps } from "./global-teardown";

const tempRoots: string[] = [];

describe("native smoke global teardown", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records Apollo native provider coverage as an automation gap", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "confscope-native-gaps-"));
    tempRoots.push(projectRoot);
    const state: SmokeState = {
      ...createSmokeWorkspace({ projectRoot, runId: "native-gaps" }),
      fixtures: { strictPublic: "", legacyPublic: "", invalidEmpty: "" },
    };
    initializeReports(state);

    recordKnownNativeGaps(state);

    const cases = JSON.parse(readFileSync(join(state.reportsDir, "cases.json"), "utf8")) as SmokeCaseResult[];
    expect(cases).toContainEqual(
      expect.objectContaining({
        id: "GAP-NATIVE-APOLLO",
        area: "Apollo provider",
        status: "NOT_RUN_AUTOMATION_GAP",
      })
    );
    expect(cases).toContainEqual(
      expect.objectContaining({
        id: "GAP-NATIVE-APPDATA-WEBDAV-LIST",
        area: "App Data Backup",
        status: "NOT_RUN_AUTOMATION_GAP",
      })
    );
  });
});
