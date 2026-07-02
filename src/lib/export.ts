// 审计结果导出：CSV / JSON，支持脱敏开关。
import type { AuditRow } from "./audit";
import type { EnvSource } from "../components/AuditView";

/** 导出选项 */
export interface ExportOptions {
  sanitize: boolean;
}

/** JSON 导出结构 */
export interface ExportMetadata {
  metadata: {
    exportedAt: string;
    envCount: number;
    rowCount: number;
    sanitized: boolean;
  };
  rows: Array<{
    dataId: string;
    key: string;
    status: string;
    values: Record<string, { value?: string; updatedAt?: string; exists: boolean }>;
  }>;
}

/** 敏感字段正则 */
const SENSITIVE_RE = /(password|token|secretKey|accessKey|secret|privateKey|passphrase)/i;

/** 脱敏替换 */
function sanitizeValue(key: string, value: string | undefined): string | undefined {
  if (value === undefined) return value;
  if (SENSITIVE_RE.test(key)) return "***";
  return value;
}

/** 转义 CSV 字段 */
function csvField(value: string | undefined): string {
  if (value === undefined || value === "") return "";
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** 导出审计结果为 CSV（UTF-8 BOM） */
export function exportAuditCSV(
  rows: AuditRow[],
  envSources: EnvSource[],
  options: ExportOptions
): string {
  const envIds = envSources.map((s) => `${s.conn.id}:${s.namespace}`);
  const envLabels = envSources.map(
    (s) => `${s.conn.environmentName || s.conn.name}/${s.conn.name || s.conn.sourceName}/${s.namespace || "public"}`
  );

  const header = ["dataId", "key", "status", ...envLabels, ...envLabels.map((l) => `${l}_updatedAt`)].join(",");

  const body = rows
    .map((row) => {
      const values = envIds.map((envId) => {
        const cell = row.values[envId];
        const rawValue = cell?.exists ? cell.value : undefined;
        const value = options.sanitize ? sanitizeValue(row.key, rawValue) : rawValue;
        return csvField(value);
      });
      const updatedAts = envIds.map((envId) => {
        const cell = row.values[envId];
        return csvField(cell?.updatedAt);
      });
      return [csvField(row.dataId), csvField(row.key), csvField(row.status), ...values, ...updatedAts].join(",");
    })
    .join("\n");

  // UTF-8 BOM + header + body
  return "﻿" + header + "\n" + body;
}

/** 导出审计结果为 JSON */
export function exportAuditJSON(
  rows: AuditRow[],
  envSources: EnvSource[],
  options: ExportOptions
): ExportMetadata {
  const envIds = envSources.map((s) => `${s.conn.id}:${s.namespace}`);

  return {
    metadata: {
      exportedAt: new Date().toISOString(),
      envCount: envSources.length,
      rowCount: rows.length,
      sanitized: options.sanitize,
    },
    rows: rows.map((row) => {
      const values: Record<string, { value?: string; updatedAt?: string; exists: boolean }> = {};
      for (const envId of envIds) {
        const cell = row.values[envId];
        const rawValue = cell?.exists ? cell.value : undefined;
        const value = options.sanitize ? sanitizeValue(row.key, rawValue) : rawValue;
        values[envId] = { value, updatedAt: cell?.updatedAt, exists: cell?.exists ?? false };
      }
      return { dataId: row.dataId, key: row.key, status: row.status, values };
    }),
  };
}

/** 触发浏览器下载 */
export function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
