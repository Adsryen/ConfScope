/**
 * @vitest-environment node
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeReports, recordCase, writeFinalReport } from "./report";
import { createSmokeWorkspace } from "./workspace";

const tempRoots: string[] = [];

describe("smoke report", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("separates tested cases from not-tested cases with explicit reasons", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "confscope-report-"));
    tempRoots.push(projectRoot);
    const workspace = createSmokeWorkspace({ projectRoot, runId: "report-contract" });
    initializeReports(workspace);

    recordCase(workspace, {
      id: "VITE-NACOS-BROWSE-01",
      area: "Browse",
      status: "PASS",
      evidence: "opened smoke-app.yaml",
      notes: "Docker Nacos",
    });
    recordCase(workspace, {
      id: "NATIVE-SSH-TUNNEL-01",
      area: "SSH Manager",
      status: "NOT_RUN_ENV_MISSING",
      evidence: "Windows Docker tunnel route unavailable",
      notes: "recorded instead of fake PASS",
    });

    writeFinalReport(workspace);

    const result = readFileSync(join(workspace.reportsDir, "result.md"), "utf8");
    expect(result).toContain("## Tested");
    expect(result).toContain("| VITE-NACOS-BROWSE-01 | Browse | PASS | opened smoke-app.yaml | Docker Nacos |");
    expect(result).toContain("## Not Tested / Why");
    expect(result).toContain(
      "| NATIVE-SSH-TUNNEL-01 | SSH Manager | NOT_RUN_ENV_MISSING | Windows Docker tunnel route unavailable | recorded instead of fake PASS |"
    );
  });
});
