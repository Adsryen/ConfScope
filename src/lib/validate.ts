// 发布前的格式校验:语法错误 + 重复 key。返回问题列表(空=通过)。
// 每条问题尽量带上 1 基行号/列号（R28）：长 JSON 少个逗号时，用户要知道滚到第几行，
// 而不是从 position 8123 这种机器坐标开始数。

import { parseDocument } from "yaml";
import { translate } from "../locales";
import { lineOffsets, offsetToLineColumn, splitLines } from "./codeLines";
import type { Format } from "./format";

/** 一条校验问题：文案直接可展示，行列用于「跳到第 N 行」定位。 */
export interface ValidationIssue {
  /** 已本地化的展示文案（含定位提示）。 */
  message: string;
  /** 1 基行号；定位不出来时省略。 */
  line?: number;
  /** 1 基列号。 */
  column?: number;
}

/** 把行列拼成展示后缀；没有行号就不拼，避免出现「第 undefined 行」。 */
function positionSuffix(line?: number, column?: number): string {
  if (!line) return "";
  if (column) return translate("validation.atLineColumn", { line, column });
  return translate("validation.atLine", { line });
}

function issue(message: string, line?: number, column?: number): ValidationIssue {
  return column !== undefined ? { message, line, column } : { message, line };
}

/** 行式重复 key 检测(properties / env / toml),按 [section] 分组避免误报。 */
function dupKeysByLine(content: string): ValidationIssue[] {
  const firstSeen = new Map<string, number>();
  // 同一个 key 可能被重复多次，按出现顺序收集所有重复行
  const dups = new Map<string, { first: number; lines: number[] }>();
  let section = "";
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  lines.forEach((raw, i) => {
    const line = i + 1;
    const t = raw.trim();
    if (!t || t.startsWith("#") || t.startsWith(";")) return;
    const sec = t.match(/^\[(.+)\]$/);
    if (sec) {
      section = sec[1];
      return;
    }
    const m = t.match(/^([A-Za-z0-9_.\-]+)\s*[:=]/);
    if (!m) return;
    const key = `${section}\u0000${m[1]}`;
    const first = firstSeen.get(key);
    if (first === undefined) {
      firstSeen.set(key, line);
      return;
    }
    const entry = dups.get(key) ?? { first, lines: [] };
    if (!entry.lines.includes(line)) entry.lines.push(line);
    dups.set(key, entry);
  });
  return [...dups.entries()].map(([key, { first, lines: dupLines }]) => {
    // 分组维度是 section + NUL + name，展示只回显 key 名（不带分组的 NUL）
    const base = translate("validation.duplicateKey", { key: key.split("\u0000").pop() ?? key });
    return issue(`${base}${translate("validation.duplicateKeyLines", { first, lines: dupLines.join("、") })}`, dupLines[0]);
  });
}

function xmlError(message: string, line?: number, column?: number): ValidationIssue {
  return issue(`${translate("validation.xmlFormatError", { message })}${positionSuffix(line, column)}`, line, column);
}

function validateXml(content: string): ValidationIssue[] {
  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(content, "application/xml");
    const pe = doc.querySelector("parsererror");
    if (!pe) return [];
    const text = (pe.textContent || translate("validation.parseFailed")).split("\n")[0];
    // 各内核 parsererror 文案不统一（"line 3, column 12" / "Line: 3 Column: 12"），
    // 只按数字提取，取不到就退回纯文案，绝不猜行号。
    const line = Number.parseInt(/line\s*[:\s]*(\d+)/i.exec(text)?.[1] ?? "", 10);
    const column = Number.parseInt(/column\s*[:\s]*(\d+)/i.exec(text)?.[1] ?? "", 10);
    return [xmlError(text, Number.isFinite(line) ? line : undefined, Number.isFinite(column) ? column : undefined)];
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
      if (stack.pop() !== name) {
        const pos = offsetToLineColumn(content, match.index);
        return [xmlError(translate("validation.xmlTagMismatch", { name }), pos?.line, pos?.column)];
      }
    } else {
      stack.push(name);
    }
  }
  if (!matched || stack.length) return [xmlError(translate("validation.parseFailed"))];
  return [];
}

/**
 * 从 JSON.parse 的报错里取出整文档偏移。
 * 各引擎文案不同：V8 传统形态是「... at position 8123」，新版会附带
 * 「(line 2 column 12)」，少数只给行列。偏移优先，行列兜底换算成偏移，
 * 最终统一由 offsetToLineColumn 换算，保证和行号槽的口径一致。
 */
function jsonErrorOffset(content: string, message: string): number | undefined {
  // 偏移优先：V8 传统形态是「... at position 8123」
  const at = /position\s+(\d+)/i.exec(message);
  if (at) return Number.parseInt(at[1], 10);
  // 行列兜底：新版 V8 会附带「(line 3 column 3)」
  const line = Number.parseInt(/line\s+(\d+)/i.exec(message)?.[1] ?? "", 10);
  if (Number.isFinite(line)) {
    const column = Number.parseInt(/column\s+(\d+)/i.exec(message)?.[1] ?? "", 10);
    return offsetFromLineColumn(content, line, Number.isFinite(column) ? column : 1);
  }
  // 「Unexpected end of JSON input」这类报错不带位置（截断输入的经典文案），
  // 但语义就是「在这里还没读完」，用文档末尾当落点比不给行号有用得多。
  if (/unexpected end|end of json input|is not valid json/i.test(message)) return content.length;
  return undefined;
}

/** 由 1 基行列反查整文档偏移，复用 codeLines 的 splitLines/lineOffsets 口径，不再自己数换行。 */
function offsetFromLineColumn(content: string, lineOneBased: number, columnOneBased: number): number | undefined {
  const lines = splitLines(content);
  if (!lines.length) return undefined;
  const idx = Math.min(Math.max(lineOneBased - 1, 0), lines.length - 1);
  const start = lineOffsets(lines)[idx] ?? 0;
  return start + Math.min(Math.max(columnOneBased - 1, 0), lines[idx].length);
}

/** 校验配置内容，返回带定位信息的问题列表。 */
export function validateConfigIssues(content: string, fmt: Format): ValidationIssue[] {
  if (!content.trim()) return []; // 允许空内容

  switch (fmt) {
    case "JSON": {
      try {
        JSON.parse(content);
      } catch (e) {
        const raw = (e as Error).message;
        const offset = jsonErrorOffset(content, raw);
        const pos = offset === undefined ? null : offsetToLineColumn(content, offset);
        return [
          issue(
            `${translate("validation.jsonParseFailed", { message: raw })}${positionSuffix(pos?.line, pos?.column)}`,
            pos?.line,
            pos?.column
          ),
        ];
      }
      return [];
    }
    case "YAML": {
      // uniqueKeys 默认开启:重复键会进入 errors;同时捕获语法错误
      const doc = parseDocument(content, { uniqueKeys: true });
      // yaml 的报错文案本身就带「at line L, column C」，这里只补结构化行列供跳转
      return doc.errors.map((e) => {
        const pos = Array.isArray(e.pos) ? offsetToLineColumn(content, e.pos[0]) : null;
        return issue(`YAML:${e.message.split("\n")[0]}`, pos?.line, pos?.column);
      });
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

/** 校验配置内容。返回问题描述数组,空数组表示通过。 */
export function validateConfig(content: string, fmt: Format): string[] {
  return validateConfigIssues(content, fmt).map((i) => i.message);
}
