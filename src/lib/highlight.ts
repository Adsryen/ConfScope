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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
