// 审计结果导出：CSV / JSON，支持脱敏开关。
// 配置导出：CSV / JSON / YAML / Properties / Diff
import type { AuditRow } from "./audit";
import type { EnvSource } from "../components/AuditView";
import { translate } from "../locales";

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
    schemaVersion: number;
    exportedAt: string;
    envCount: number;
    rowCount: number;
    sanitized: boolean;
  };
  sources: AuditExportSource[];
  rows: Array<{
    providerType: string;
    namespace: string;
    group: string;
    dataId: string;
    key: string;
    status: string;
    ignoreReason?: string;
    originalDataIds: Record<string, string>;
    values: Record<string, { value?: string; updatedAt?: string; exists: boolean; originalDataId?: string }>;
  }>;
}

export interface AuditExportSource {
  envId: string;
  provider: string;
  connectionId: string;
  connectionName: string;
  projectName: string;
  environmentName: string;
  sourceName: string;
  sourceType: string;
  namespace: string;
  group: string;
}

/** 敏感字段匹配，AK/SK 只按独立 path 片段命中，避免误伤普通单词。 */
const SENSITIVE_SUBSTRING_RE = /(password|token|secretKey|accessKey|accessKeyId|accessKeySecret|securityToken|privateKey|passphrase)/i;
const SENSITIVE_SEGMENTS = new Set([
  "password",
  "token",
  "secret",
  "secretkey",
  "accesskey",
  "accesskeyid",
  "accesskeysecret",
  "securitytoken",
  "ak",
  "sk",
  "privatekey",
  "passphrase",
]);
const KEY_VALUE_LINE_RE = /^(\s*["']?)([^"'=:]*?)(["']?\s*[:=]\s*)(.*?)(\s*,?\s*)$/;

/** 脱敏替换 */
function sanitizeValue(key: string, value: string | undefined): string | undefined {
  if (value === undefined) return value;
  if (isSensitiveKey(key)) return "***";
  return value;
}

/** 判断字段名是否命中敏感模式。 */
function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_SUBSTRING_RE.test(key)) return true;
  return keySegments(key).some((segment) => SENSITIVE_SEGMENTS.has(segment));
}

function keySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1.$2")
    .split(/[^a-z0-9]+/i)
    .map((part) => part.toLowerCase())
    .filter(Boolean);
}

/** 对配置内容逐行脱敏，保留常见 key/value 结构。 */
function sanitizeConfigContent(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const match = line.match(KEY_VALUE_LINE_RE);
      if (!match) return line;
      const [, prefixStart, key, separator, value, suffix] = match;
      if (!isSensitiveKey(key)) return line;
      const prefix = `${prefixStart}${key}${separator}`;
      const trimmedValue = value.trim();
      const masked = prefix.includes(":") && /^["']/.test(trimmedValue) ? '"***"' : "***";
      return `${prefix}${masked}${suffix}`;
    })
    .join("\n");
}

/** 生成脱敏后的配置项副本。 */
function sanitizeConfigItems(items: ConfigItem[]): ConfigItem[] {
  return items.map((item) => ({
    ...item,
    content: isSensitiveKey(`${item.namespace}.${item.group}.${item.dataId}`)
      ? "***"
      : sanitizeConfigContent(item.content),
  }));
}

/** 脱敏 diff 左右值。 */
function sanitizeDiffValue(item: DiffItem, value: string): string {
  if (isSensitiveKey(`${item.namespace}.${item.group}.${item.dataId}`)) return "***";
  return sanitizeConfigContent(value);
}

/** 转义 CSV 字段 */
function csvField(value: string | undefined): string {
  if (value === undefined || value === "") return "";
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function auditEnvId(source: EnvSource): string {
  return `${source.conn.id}:${source.namespace}`;
}

function providerOf(source: EnvSource): string {
  return source.conn.provider ?? (source.conn.sourceType === "local-snapshot" ? "local" : "nacos");
}

function sourceNameOf(source: EnvSource): string {
  return source.conn.sourceName || source.conn.name || "default";
}

function sourceLabel(source: EnvSource): string {
  const provider = providerOf(source);
  const project = source.conn.projectName || "Default Project";
  const environment = source.conn.environmentName || source.conn.name || "Default Environment";
  const sourceName = sourceNameOf(source);
  const connectionName = source.conn.name || sourceName;
  const namespace = source.namespace || "public";
  const group = source.group || "DEFAULT_GROUP";
  return `${provider}:${project}/${environment}/${sourceName}/${connectionName}/${namespace}/${group}`;
}

function auditSources(envSources: EnvSource[]): AuditExportSource[] {
  return envSources.map((source) => ({
    envId: auditEnvId(source),
    provider: providerOf(source),
    connectionId: source.conn.id,
    connectionName: source.conn.name || "",
    projectName: source.conn.projectName || "",
    environmentName: source.conn.environmentName || "",
    sourceName: sourceNameOf(source),
    sourceType: source.conn.sourceType || providerOf(source),
    namespace: source.namespace,
    group: source.group || "DEFAULT_GROUP",
  }));
}

/** 导出审计结果为 CSV（UTF-8 BOM） */
export function exportAuditCSV(
  rows: AuditRow[],
  envSources: EnvSource[],
  options: ExportOptions
): string {
  const sources = auditSources(envSources);
  const envIds = sources.map((source) => source.envId);
  const envLabels = envSources.map(sourceLabel);

  const header = [
    "providerType",
    "namespace",
    "group",
    "dataId",
    "key",
    "status",
    "ignoreReason",
    "originalDataIds",
    ...envLabels.map((label) => `${label}_value`),
    ...envLabels.map((label) => `${label}_exists`),
    ...envLabels.map((label) => `${label}_updatedAt`),
    ...envLabels.map((label) => `${label}_originalDataId`),
  ]
    .map(csvField)
    .join(",");

  const body = rows
    .map((row) => {
      const values = envIds.map((envId) => {
        const cell = row.values[envId];
        const rawValue = cell?.exists ? cell.value : undefined;
        const value = options.sanitize ? sanitizeValue(row.key, rawValue) : rawValue;
        return csvField(value);
      });
      const exists = envIds.map((envId) => csvField(row.values[envId]?.exists ? "true" : "false"));
      const updatedAts = envIds.map((envId) => {
        const cell = row.values[envId];
        return csvField(cell?.updatedAt);
      });
      const originalDataIds = envIds.map((envId) => csvField(row.originalDataIds[envId]));
      return [
        csvField(row.providerType),
        csvField(row.namespace),
        csvField(row.group),
        csvField(row.dataId),
        csvField(row.key),
        csvField(row.status),
        csvField(row.ignoreReason),
        csvField(JSON.stringify(row.originalDataIds)),
        ...values,
        ...exists,
        ...updatedAts,
        ...originalDataIds,
      ].join(",");
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
  const sources = auditSources(envSources);
  const envIds = sources.map((source) => source.envId);

  return {
    metadata: {
      schemaVersion: 2,
      exportedAt: new Date().toISOString(),
      envCount: envSources.length,
      rowCount: rows.length,
      sanitized: options.sanitize,
    },
    sources,
    rows: rows.map((row) => {
      const values: Record<string, { value?: string; updatedAt?: string; exists: boolean; originalDataId?: string }> = {};
      for (const envId of envIds) {
        const cell = row.values[envId];
        const rawValue = cell?.exists ? cell.value : undefined;
        const value = options.sanitize ? sanitizeValue(row.key, rawValue) : rawValue;
        values[envId] = { value, updatedAt: cell?.updatedAt, exists: cell?.exists ?? false, originalDataId: row.originalDataIds[envId] };
      }
      return {
        providerType: row.providerType,
        namespace: row.namespace,
        group: row.group,
        dataId: row.dataId,
        key: row.key,
        status: row.status,
        ignoreReason: row.ignoreReason,
        originalDataIds: row.originalDataIds,
        values,
      };
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
function generateConfigJSON(items: ConfigItem[], sanitized: boolean): string {
  return JSON.stringify(
    {
      metadata: {
        exportedAt: new Date().toISOString(),
        total: items.length,
        format: "json",
        sanitized,
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
  const sanitized = !opts.sensitive;
  const exportItems = sanitized ? sanitizeConfigItems(items) : items;

  switch (opts.format) {
    case "csv":
      content = generateConfigCSV(exportItems);
      break;
    case "json":
      content = generateConfigJSON(exportItems, sanitized);
      break;
    case "yaml":
      content = generateConfigYAML(exportItems, opts.includeMeta);
      break;
    case "properties":
      content = generateConfigProperties(exportItems, opts.includeMeta);
      break;
    case "diff":
      content = generateDiffText(exportItems);
      break;
    default:
      throw new Error(translate("export.unsupportedFormat", { format: opts.format }));
  }

  const filename = `configs_${Date.now()}.${getFileExt(opts.format)}`;
  downloadFile(content, filename, getMimeType(opts.format));
}

/** 导出差异对比 */
export function exportDiff(items: DiffItem[], format: "text" | "json"): void {
  let content: string;
  let filename: string;
  const sanitizedItems = items.map((item) => ({
    ...item,
    leftValue: sanitizeDiffValue(item, item.leftValue),
    rightValue: sanitizeDiffValue(item, item.rightValue),
  }));

  if (format === "json") {
    content = JSON.stringify(
      {
        metadata: {
          exportedAt: new Date().toISOString(),
          total: sanitizedItems.length,
          sanitized: true,
        },
        items: sanitizedItems,
      },
      null,
      2
    );
    filename = `diff_${Date.now()}.json`;
  } else {
    content = sanitizedItems
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
