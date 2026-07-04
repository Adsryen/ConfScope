// 发布前的格式校验:语法错误 + 重复 key。返回问题列表(空=通过)。

import { parseDocument } from "yaml";
import { translate } from "../locales";
import type { Format } from "./format";

/** 行式重复 key 检测(properties / env / toml),按 [section] 分组避免误报。 */
function dupKeysByLine(content: string): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  let section = "";
  for (const raw of content.replace(/\r\n/g, "\n").split("\n")) {
    const t = raw.trim();
    if (!t || t.startsWith("#") || t.startsWith(";")) continue;
    const sec = t.match(/^\[(.+)\]$/);
    if (sec) {
      section = sec[1];
      continue;
    }
    const m = t.match(/^([A-Za-z0-9_.\-]+)\s*[:=]/);
    if (!m) continue;
    const key = `${section}\u0000${m[1]}`;
    if (seen.has(key)) dups.add(m[1]);
    seen.add(key);
  }
  return [...dups].map((k) => translate("validation.duplicateKey", { key: k }));
}

function xmlError(message: string): string {
  return translate("validation.xmlFormatError", { message });
}

function validateXml(content: string): string[] {
  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(content, "application/xml");
    const pe = doc.querySelector("parsererror");
    return pe ? [xmlError((pe.textContent || translate("validation.parseFailed")).split("\n")[0])] : [];
  }

  const stack: string[] = [];
  const tagRe = /<\s*(\/?)([A-Za-z_][\w:.-]*)([^>]*)>/g;
  let matched = false;
  for (const match of content.matchAll(tagRe)) {
    matched = true;
    const closing = match[1] === "/";
    const name = match[2];
    const tail = match[3].trim();
    if (tail.endsWith("/") || name.startsWith("?") || name.startsWith("!")) continue;
    if (closing) {
      if (stack.pop() !== name) return [xmlError(translate("validation.xmlTagMismatch", { name }))];
    } else {
      stack.push(name);
    }
  }
  if (!matched || stack.length) return [xmlError(translate("validation.parseFailed"))];
  return [];
}

/** 校验配置内容。返回问题描述数组,空数组表示通过。 */
export function validateConfig(content: string, fmt: Format): string[] {
  if (!content.trim()) return []; // 允许空内容

  switch (fmt) {
    case "JSON": {
      try {
        JSON.parse(content);
      } catch (e) {
        return [translate("validation.jsonParseFailed", { message: (e as Error).message })];
      }
      return [];
    }
    case "YAML": {
      // uniqueKeys 默认开启:重复键会进入 errors;同时捕获语法错误
      const doc = parseDocument(content, { uniqueKeys: true });
      return doc.errors.map((e) => `YAML:${e.message.split("\n")[0]}`);
    }
    case "XML": {
      return validateXml(content);
    }
    case "Properties":
    case "TOML":
      return dupKeysByLine(content);
    case "HTML":
    case "TEXT":
    default:
      return [];
  }
}
