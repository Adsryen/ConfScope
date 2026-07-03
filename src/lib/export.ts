// 审计结果导出：CSV / JSON，支持脱敏开关。
// 配置导出：CSV / JSON / YAML / Properties / Diff
import type { AuditRow } from "./audit";
import type { EnvSource } from "../components/AuditView";

/** 导出选项 */
export interface ExportOptions {
  sanitize: boolean;
}

/** 通用导出选项 */
export interface ConfigExportOptions {
  format: ExportFormat;
  sensitive: boolean; // 是否导出敏感字段
  includeMeta: boolean; // 是否包含元信息
}

/** 导出格式类型 */
export type ExportFormat = "csv" | "json" | "yaml" | "properties" | "diff";

/** 配置项 */
export interface ConfigItem {
  dataId: string;
  group: string;
  content: string;
  configType: string;
  namespace: string;
  namespaceId: string;
  updateTime: string;
}

/** 差异项 */
export interface DiffItem {
  dataId: string;
  group: string;
  namespace: string;
  leftValue: string;
  rightValue: string;
  diffType: "added" | "deleted" | "modified";
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

// ── 通用配置导出 ──

/** CSV 转义通用字段 */
function csvEscape(value: string | undefined): string {
  if (value === undefined || value === "") return "";
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** 生成配置 CSV */
function generateConfigCSV(items: ConfigItem[]): string {
  const header = "namespace,group,dataId,configType,content,updateTime";
  const rows = items.map((item) =>
    [
      csvEscape(item.namespace),
      csvEscape(item.group),
      csvEscape(item.dataId),
      csvEscape(item.configType),
      csvEscape(item.content),
      csvEscape(item.updateTime),
    ].join(",")
  );
  return "﻿" + header + "\n" + rows.join("\n");
}

/** 生成配置 JSON */
function generateConfigJSON(items: ConfigItem[]): string {
  return JSON.stringify(
    {
      metadata: {
        exportedAt: new Date().toISOString(),
        total: items.length,
        format: "json",
      },
      items,
    },
    null,
    2
  );
}

/** 生成配置 YAML */
function generateConfigYAML(items: ConfigItem[], includeMeta: boolean): string {
  const parts: string[] = [];
  items.forEach((item, index) => {
    if (index > 0) parts.push("---");
    if (includeMeta) {
      parts.push(`# DataID: ${item.dataId}`);
      parts.push(`# Group: ${item.group}`);
      parts.push(`# Namespace: ${item.namespace}`);
      parts.push(`# Update Time: ${item.updateTime}`);
      parts.push("");
    }
    if (item.content.trim()) {
      parts.push(item.content);
    }
  });
  return parts.join("\n");
}

/** 生成配置 Properties */
function generateConfigProperties(items: ConfigItem[], includeMeta: boolean): string {
  const parts: string[] = [];
  items.forEach((item, index) => {
    if (index > 0) parts.push("");
    if (includeMeta) {
      parts.push(`# DataID: ${item.dataId}`);
      parts.push(`# Group: ${item.group}`);
      parts.push(`# Namespace: ${item.namespace}`);
      parts.push(`# Update Time: ${item.updateTime}`);
    }
    if (item.content.trim()) {
      parts.push(item.content);
    }
  });
  return parts.join("\n");
}

/** 生成差异文本 */
function generateDiffText(items: ConfigItem[]): string {
  return items
    .map((item) => `=== ${item.namespace}/${item.group}/${item.dataId} ===\n${item.content}`)
    .join("\n\n");
}

/** 获取格式对应的 MIME 类型 */
function getMimeType(format: ExportFormat): string {
  const map: Record<ExportFormat, string> = {
    csv: "text/csv",
    json: "application/json",
    yaml: "text/yaml",
    properties: "text/plain",
    diff: "text/plain",
  };
  return map[format] || "text/plain";
}

/** 获取格式对应的文件扩展名 */
function getFileExt(format: ExportFormat): string {
  const map: Record<ExportFormat, string> = {
    csv: "csv",
    json: "json",
    yaml: "yaml",
    properties: "properties",
    diff: "txt",
  };
  return map[format] || "txt";
}

/** 通用配置导出到文件 */
export function exportConfigs(items: ConfigItem[], opts: ConfigExportOptions): void {
  let content: string;

  switch (opts.format) {
    case "csv":
      content = generateConfigCSV(items);
      break;
    case "json":
      content = generateConfigJSON(items);
      break;
    case "yaml":
      content = generateConfigYAML(items, opts.includeMeta);
      break;
    case "properties":
      content = generateConfigProperties(items, opts.includeMeta);
      break;
    case "diff":
      content = generateDiffText(items);
      break;
    default:
      throw new Error(`不支持的导出格式: ${opts.format}`);
  }

  const filename = `configs_${Date.now()}.${getFileExt(opts.format)}`;
  downloadFile(content, filename, getMimeType(opts.format));
}

/** 导出差异对比 */
export function exportDiff(items: DiffItem[], format: "text" | "json"): void {
  let content: string;
  let filename: string;

  if (format === "json") {
    content = JSON.stringify(
      {
        metadata: {
          exportedAt: new Date().toISOString(),
          total: items.length,
        },
        items,
      },
      null,
      2
    );
    filename = `diff_${Date.now()}.json`;
  } else {
    content = items
      .map((item) => {
        const label =
          item.diffType === "added"
            ? "[+]"
            : item.diffType === "deleted"
              ? "[-]"
              : "[~]";
        return `${label} ${item.namespace}/${item.group}/${item.dataId}\n← ${item.leftValue}\n→ ${item.rightValue}`;
      })
      .join("\n\n");
    filename = `diff_${Date.now()}.txt`;
  }

  downloadFile(content, filename, format === "json" ? "application/json" : "text/plain");
}
