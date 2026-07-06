import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SmokeWorkspace } from "./workspace";

export type SmokeCaseStatus =
  | "PASS"
  | "FAIL_PRODUCT_BUG"
  | "FAIL_TEST_SETUP"
  | "NOT_RUN_UNIMPLEMENTED"
  | "NOT_RUN_ENV_MISSING"
  | "NOT_RUN_RISK_ACCEPTANCE"
  | "NOT_RUN_AUTOMATION_GAP";

export interface SmokeCaseResult {
  id: string;
  area: string;
  status: SmokeCaseStatus;
  evidence: string;
  notes: string;
}

export function initializeReports(workspace: SmokeWorkspace): void {
  mkdirSync(workspace.reportsDir, { recursive: true });
  writeFileSync(join(workspace.reportsDir, "cases.json"), "[]", "utf8");
  writeFileSync(join(workspace.reportsDir, "defects.md"), "# Smoke Defects\n\n| ID | Severity | Area | Repro | Expected | Actual | Evidence |\n| --- | --- | --- | --- | --- | --- | --- |\n", "utf8");
}

export function recordCase(workspace: SmokeWorkspace, result: SmokeCaseResult): void {
  mkdirSync(workspace.reportsDir, { recursive: true });
  const path = join(workspace.reportsDir, "cases.json");
  const current = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as SmokeCaseResult[]) : [];
  current.push(result);
  writeFileSync(path, JSON.stringify(current, null, 2), "utf8");
}

export function writeFinalReport(workspace: SmokeWorkspace): void {
  const casesPath = join(workspace.reportsDir, "cases.json");
  const cases = existsSync(casesPath) ? (JSON.parse(readFileSync(casesPath, "utf8")) as SmokeCaseResult[]) : [];
  const statuses: SmokeCaseStatus[] = [
    "PASS",
    "FAIL_PRODUCT_BUG",
    "FAIL_TEST_SETUP",
    "NOT_RUN_UNIMPLEMENTED",
    "NOT_RUN_ENV_MISSING",
    "NOT_RUN_RISK_ACCEPTANCE",
    "NOT_RUN_AUTOMATION_GAP",
  ];
  const lines = [
    "# Full Product Smoke Result",
    "",
    `- Run ID: ${workspace.runId}`,
    `- Root: ${workspace.rootDir}`,
    `- Generated: ${new Date().toISOString()}`,
    "",
    "## Summary",
    "",
    ...statuses.map((status) => `- ${status}: ${cases.filter((item) => item.status === status).length}`),
    "",
    "## Tested",
    "",
    "| ID | Area | Status | Evidence | Notes |",
    "| --- | --- | --- | --- | --- |",
    ...cases.map((item) => `| ${item.id} | ${item.area} | ${item.status} | ${escapeCell(item.evidence)} | ${escapeCell(item.notes)} |`),
    "",
  ];
  writeFileSync(join(workspace.reportsDir, "result.md"), `${lines.join("\n")}\n`, "utf8");
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", "<br>");
}
