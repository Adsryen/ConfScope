// 语法高亮：只按需注册配置常见的几种语言，控制体积。输出已转义的 HTML，
// 可安全用于 dangerouslySetInnerHTML（highlight.js 会转义代码中的 HTML 实体）。

import hljs from "highlight.js/lib/core";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import xml from "highlight.js/lib/languages/xml";
import properties from "highlight.js/lib/languages/properties";
import ini from "highlight.js/lib/languages/ini"; // 覆盖 TOML
import type { Format } from "./format";

hljs.registerLanguage("json", json);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("properties", properties);
hljs.registerLanguage("ini", ini);

function langOf(fmt: Format): string | null {
  switch (fmt) {
    case "JSON":
      return "json";
    case "YAML":
      return "yaml";
    case "XML":
    case "HTML":
      return "xml";
    case "Properties":
      return "properties";
    case "TOML":
      return "ini";
    case "TEXT":
    default:
      return null;
  }
}

/** 转义 HTML 文本节点中的 & < >（与 highlight.js 的转义口径一致）。 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 把代码高亮成 HTML（带 hljs-* class）。未知/纯文本返回转义后的原文。 */
export function highlightCode(code: string, fmt: Format): string {
  const lang = langOf(fmt);
  if (!lang) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

// 逐行高亮带缓存：diff 视图会对大量行重复调用，缓存避免重复计算。
// 注意：单行高亮会丢失跨行上下文（如跨行字符串），但对配置文件足够好用。
const lineCache = new Map<string, string>();

export function highlightLine(line: string, fmt: Format): string {
  if (line === "") return "";
  const key = `${fmt}\u0000${line}`;
  const hit = lineCache.get(key);
  if (hit !== undefined) return hit;
  if (lineCache.size > 5000) lineCache.clear();
  const html = highlightCode(line, fmt);
  lineCache.set(key, html);
  return html;
}
