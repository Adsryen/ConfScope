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

/** 同一映射内同名 key 在文件中出现多次（位置不同），按完整路径归并出现行号。 */
export interface DuplicateKeyInfo {
  /** 完整层级路径，如 "payment.mock.enabled"（顶层 key 无点）。 */
  key: string;
  lineNumbers: number[];
}

/**
 * 扫描 YAML 文本中"同一映射内位置不同的重复键"，按**完整层级路径**归并：
 * 维护"缩进 → 父 key"栈，`payment.mock.enabled` 与 `alipay.enabled` 路径不同，互不误报；
 * 数组项（`- ` 开头）不入栈，数组元素内部的同名 key（如 list 项的 `url`）不算重复。
 * 同一父路径下同名 key 出现多次即记录（对应"后值覆盖前值"的真实运行时行为）。
 * 返回每个重复路径及其出现行号（1 起）。
 */
export function extractDuplicateKeys(content: string): DuplicateKeyInfo[] {
  const pathStack: string[] = [];
  const pathIndent: number[] = [];
  // 最近一次列表项（"- " 行）的缩进；其内部字段属于"该列表项"，跨项同名不算同映射重复
  let lastListItemIndent: number | null = null;
  const occurrences = new Map<string, number[]>();
  for (const [index, raw] of content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").entries()) {
    const line = raw;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    // 缩进奇数 / tab 缩进无法可靠判定层级，跳过
    if (indent % 2 !== 0 || line.startsWith("\t")) continue;
    const trimmed = line.trimStart();
    if (trimmed.startsWith("- ") || trimmed === "-") {
      lastListItemIndent = indent;
      continue;
    }
    const m = trimmed.match(/^([A-Za-z0-9_.\-]+)\s*:(.*)$/);
    if (!m) continue;
    const key = m[1];
    const rest = m[2] ?? "";
    // 弹出比当前缩进深的栈帧，得到当前父路径
    while (pathIndent.length > 0 && pathIndent[pathIndent.length - 1] >= indent) {
      pathIndent.pop();
      pathStack.pop();
    }
    // 当前行在某个列表项内部（缩进比该列表项深）：跨列表项的同名 key 不算重复
    const insideListItem = lastListItemIndent !== null && indent > lastListItemIndent;
    if (!insideListItem) {
      const fullKey = pathStack.length > 0 ? `${pathStack.join(".")}.${key}` : key;
      const lines = occurrences.get(fullKey);
      if (lines) lines.push(index + 1);
      else occurrences.set(fullKey, [index + 1]);
    }
    // 有子块（冒号后无值）才压栈；"key: value" 是叶子不压栈
    if (rest.trim() === "") {
      pathIndent.push(indent);
      pathStack.push(key);
    }
    // 遇到同/更浅缩进的普通行，列表项上下文结束
    if (lastListItemIndent !== null && indent <= lastListItemIndent) lastListItemIndent = null;
  }
  const result: DuplicateKeyInfo[] = [];
  for (const [key, lines] of occurrences) {
    if (lines.length < 2) continue;
    result.push({ key, lineNumbers: [...lines].sort((a, b) => a - b) });
  }
  return result.sort((a, b) => a.lineNumbers[0] - b.lineNumbers[0]);
}

function normalizeYaml(content: string): NormalizeResult {
  const doc = parseDocument(content, { uniqueKeys: true });
  if (doc.errors.length) {
    // duplicate key 是真实生产环境最常见的"合法但重复"写法（如多环境合并残留），
    // 降级为 warning 而不是 fatal：toJSON() 仍能产出有效对象（后值覆盖前值，
    // 与运行时 YAML 解析器行为一致），不应阻塞配置同步。
    // 其他 YAML 语法错误（缩进/结构）仍按 fatal 处理。
    const messages = doc.errors.map((e) => e.message.split("\n")[0]);
    // yaml 库 duplicate key 错误文案是 "Map keys must be unique at line N, column M:"
    const allDuplicate = messages.every((m) => /duplicate|map keys must be unique/i.test(m));
    if (allDuplicate) {
      const parseWarning = `YAML:${messages[0]}（duplicate key 已按后值覆盖处理，不阻塞同步）`;
      return {
        parseStatus: "ok",
        parseError: parseWarning,
        entries: normalizeObject(doc.toJSON()),
      };
    }
    const parseError = `YAML:${messages[0]}`;
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
