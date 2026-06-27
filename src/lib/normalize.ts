import { parseDocument } from "yaml";
import type { Format } from "./format";

export type ParseStatus = "ok" | "fallback" | "error";
export type ConfigValueType = "string" | "number" | "boolean" | "array" | "object" | "null" | "empty" | "text";

export interface ConfigEntry {
  key: string;
  value: string;
  valueType: ConfigValueType;
  sourcePath: string;
  parseStatus: ParseStatus;
  parseError?: string;
}

export interface NormalizeResult {
  parseStatus: ParseStatus;
  parseError?: string;
  entries: ConfigEntry[];
}

const DOCUMENT_KEY = "__document";

function valueTypeOf(value: unknown): ConfigValueType {
  if (value === "") return "empty";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    case "string":
      if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.trim())) return "number";
      if (/^(true|false)$/i.test(value.trim())) return "boolean";
      return value.length ? "string" : "empty";
    default:
      return "text";
  }
}

function stringifyValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function documentEntry(content: string, parseStatus: ParseStatus, parseError?: string): ConfigEntry {
  return {
    key: DOCUMENT_KEY,
    value: content,
    valueType: "text",
    sourcePath: DOCUMENT_KEY,
    parseStatus,
    ...(parseError ? { parseError } : {}),
  };
}

function makeEntry(key: string, value: unknown, parseStatus: ParseStatus): ConfigEntry {
  return {
    key,
    value: stringifyValue(value),
    valueType: valueTypeOf(value),
    sourcePath: key,
    parseStatus,
  };
}

function flattenValue(value: unknown, prefix = ""): ConfigEntry[] {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length > 0
  ) {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return flattenValue(child, path);
    });
  }
  if (!prefix) return [];
  return [makeEntry(prefix, value, "ok")];
}

function normalizeObject(value: unknown): ConfigEntry[] {
  const entries = flattenValue(value).sort((a, b) => a.key.localeCompare(b.key));
  if (entries.length > 0) return entries;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [makeEntry(DOCUMENT_KEY, value, "ok")];
  }
  return entries;
}

function normalizeJson(content: string): NormalizeResult {
  try {
    return {
      parseStatus: "ok",
      entries: normalizeObject(JSON.parse(content)),
    };
  } catch (error) {
    const parseError = `JSON:${(error as Error).message}`;
    return { parseStatus: "error", parseError, entries: [documentEntry(content, "error", parseError)] };
  }
}

function normalizeYaml(content: string): NormalizeResult {
  const doc = parseDocument(content, { uniqueKeys: true });
  if (doc.errors.length) {
    const parseError = `YAML:${doc.errors[0].message.split("\n")[0]}`;
    return { parseStatus: "error", parseError, entries: [documentEntry(content, "error", parseError)] };
  }
  return {
    parseStatus: "ok",
    entries: normalizeObject(doc.toJSON()),
  };
}

function normalizeProperties(content: string): NormalizeResult {
  const entries = new Map<string, ConfigEntry>();
  for (const raw of content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";") || line.startsWith("!")) continue;

    const match = line.match(/^([^:=\s][^:=]*?)\s*[:=]\s*(.*)$/);
    if (!match) continue;

    const key = match[1].trim();
    const value = match[2];
    entries.set(key, makeEntry(key, value, "ok"));
  }

  return {
    parseStatus: "ok",
    entries: Array.from(entries.values()).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

export function normalizeConfig(content: string, format: Format): NormalizeResult {
  switch (format) {
    case "JSON":
      return normalizeJson(content);
    case "YAML":
      return normalizeYaml(content);
    case "Properties":
      return normalizeProperties(content);
    case "TOML":
    case "XML":
    case "HTML":
    case "TEXT":
    default:
      return {
        parseStatus: "fallback",
        entries: [documentEntry(content, "fallback")],
      };
  }
}
