// 配置格式识别与「美化」（格式化）。所有处理都是展示层的，不会写回 Nacos。

import { parseDocument } from "yaml";

export const FORMATS = ["TEXT", "JSON", "XML", "YAML", "HTML", "Properties", "TOML"] as const;
export type Format = (typeof FORMATS)[number];

/** 把 Nacos 的 type 字段 / dataId 后缀归一化为内部 Format。 */
function normalizeType(t: string): Format | null {
  switch (t.trim().toLowerCase()) {
    case "json":
      return "JSON";
    case "xml":
      return "XML";
    case "yaml":
    case "yml":
      return "YAML";
    case "html":
    case "htm":
      return "HTML";
    case "properties":
      return "Properties";
    case "toml":
      return "TOML";
    case "text":
    case "txt":
      return "TEXT";
    default:
      return null;
  }
}

/** 综合 Nacos type、dataId 后缀、内容特征推断格式。 */
export function detectFormat(dataId: string, type: string, content: string): Format {
  const byType = normalizeType(type);
  if (byType) return byType;

  const dot = dataId.lastIndexOf(".");
  if (dot >= 0) {
    const byExt = normalizeType(dataId.slice(dot + 1));
    if (byExt) return byExt;
  }

  const s = content.trim();
  if (!s) return "TEXT";
  if (s.startsWith("{") || s.startsWith("[")) return "JSON";
  if (s.startsWith("<")) return /<!doctype html|<html[\s>]/i.test(s) ? "HTML" : "XML";
  // key=value 占多数 → Properties；key: value 占多数 → YAML
  const lines = s.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
  if (lines.length) {
    const eq = lines.filter((l) => /^[^=:\s][^=]*=/.test(l)).length;
    const colon = lines.filter((l) => /^\s*[^:\s][^:]*:(\s|$)/.test(l)).length;
    if (eq > colon && eq / lines.length > 0.5) return "Properties";
    if (colon / lines.length > 0.5) return "YAML";
  }
  return "TEXT";
}

export interface BeautifyResult {
  ok: boolean;
  text: string;
  error?: string;
  /** 该格式是否有实质的美化能力（false 时只是轻量规整）。 */
  reformatted: boolean;
}

/** 轻量规整：去除行尾空白、合并连续空行、收尾单个换行。注释/顺序全部保留。 */
function tidy(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "")
    .concat("\n");
}

/** 启发式 XML/HTML 缩进（保留注释、文本节点）。 */
function formatMarkup(input: string): string {
  const PAD = "  ";
  // 在标签之间插入换行，便于逐行缩进
  const withBreaks = input
    .replace(/>\s*</g, ">\n<")
    .replace(/\r\n/g, "\n")
    .trim();
  let pad = 0;
  const out: string[] = [];
  for (let raw of withBreaks.split("\n")) {
    const node = raw.trim();
    if (!node) continue;
    const isClose = /^<\//.test(node);
    const isSelf = /\/>$/.test(node) || /^<\?/.test(node) || /^<!--/.test(node) || /^<!/.test(node);
    const isOpenOnly = /^<[^!?/][^>]*[^/]>$/.test(node) && !/^<.*>.*<\/.*>$/.test(node);
    if (isClose) pad = Math.max(pad - 1, 0);
    out.push(PAD.repeat(pad) + node);
    if (!isClose && !isSelf && isOpenOnly) pad += 1;
  }
  return out.join("\n").concat("\n");
}

/** 按格式美化内容。失败时返回原文并带错误说明。 */
export function beautify(content: string, fmt: Format): BeautifyResult {
  try {
    switch (fmt) {
      case "JSON": {
        const parsed = JSON.parse(content);
        return { ok: true, reformatted: true, text: JSON.stringify(parsed, null, 2) + "\n" };
      }
      case "YAML": {
        // eemeli/yaml 的 Document API 在重新格式化时保留注释。
        const doc = parseDocument(content);
        if (doc.errors.length) {
          return { ok: false, reformatted: true, text: content, error: doc.errors[0].message };
        }
        return { ok: true, reformatted: true, text: doc.toString({ indent: 2 }) };
      }
      case "XML":
      case "HTML":
        return { ok: true, reformatted: true, text: formatMarkup(content) };
      case "Properties":
      case "TOML":
      case "TEXT":
      default:
        return { ok: true, reformatted: false, text: tidy(content) };
    }
  } catch (e) {
    return { ok: false, reformatted: true, text: content, error: String(e) };
  }
}
