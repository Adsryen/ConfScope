import { readFile } from "node:fs/promises";
import type { Download, Page } from "@playwright/test";
import { expect } from "./smokeTest";

export interface AuditExportJSON {
  metadata: {
    schemaVersion: number;
    sanitized: boolean;
  };
  sources: AuditExportSource[];
  rows: AuditExportRow[];
}

export interface AuditExportSource {
  provider: string;
  connectionName: string;
}

export interface AuditExportRow {
  providerType: string;
  dataId: string;
}

export async function downloadAuditJSON(page: Page): Promise<AuditExportJSON> {
  await page.getByLabel("JSON").check();
  const button = page.getByRole("button", { name: "Export (JSON)" });
  await expect(button).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), button.click()]);
  return parseAuditExportJSON(await downloadText(download));
}

export async function downloadAuditCSV(page: Page): Promise<string> {
  const jsonToggle = page.getByLabel("JSON");
  if (await jsonToggle.isChecked()) await jsonToggle.uncheck();
  const button = page.getByRole("button", { name: "Export (CSV)" });
  await expect(button).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), button.click()]);
  return downloadText(download);
}

async function downloadText(download: Download): Promise<string> {
  const path = await download.path();
  if (!path) throw new Error("Audit export download path is unavailable");
  return readFile(path, "utf-8");
}

function parseAuditExportJSON(text: string): AuditExportJSON {
  const value = JSON.parse(text) as unknown;
  if (!isRecord(value) || !isRecord(value.metadata) || !Array.isArray(value.sources) || !Array.isArray(value.rows)) {
    throw new Error("Audit JSON export has an invalid shape");
  }

  return {
    metadata: {
      schemaVersion: numberValue(value.metadata.schemaVersion),
      sanitized: value.metadata.sanitized === true,
    },
    sources: value.sources.map(parseSource),
    rows: value.rows.map(parseRow),
  };
}

function parseSource(value: unknown): AuditExportSource {
  if (!isRecord(value)) throw new Error("Audit JSON source has an invalid shape");
  return {
    provider: stringValue(value.provider),
    connectionName: stringValue(value.connectionName),
  };
}

function parseRow(value: unknown): AuditExportRow {
  if (!isRecord(value)) throw new Error("Audit JSON row has an invalid shape");
  return {
    providerType: stringValue(value.providerType),
    dataId: stringValue(value.dataId),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
