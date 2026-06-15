// 配置格式识别与类型映射。用于语法高亮的语言选择与发布时的 type 字段。

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

/** Format → Nacos 的 type 字段（小写）。 */
export function nacosType(fmt: Format): string {
  return fmt === "Properties" ? "properties" : fmt.toLowerCase();
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
