// 从配置内容提取「键路径」集合,用于「仅对比 key(忽略顺序/值)」。
// YAML 按缩进拼成 a.b.c;env/properties 取 :/= 前的标识;JSON 解析后扁平化。

import type { Format } from "./format";

/** 行式提取(YAML / properties / env / 文本):按缩进还原层级路径。 */
function lineKeys(text: string): string[] {
  const out: string[] = [];
  const stack: { indent: number; key: string }[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const m = raw.match(/^(\s*)([A-Za-z0-9_.\-/]+)\s*[:=]/);
    if (!m) continue;
    const indent = m[1].replace(/\t/g, "  ").length;
    const key = m[2];
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ indent, key });
    out.push(stack.map((s) => s.key).join("."));
  }
  return out;
}

/** JSON 对象扁平化为点路径(数组不展开下标)。 */
function jsonKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  let out: string[] = [];
  for (const k of Object.keys(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    out.push(path);
    out = out.concat(jsonKeys((value as Record<string, unknown>)[k], path));
  }
  return out;
}

/** 提取去重排序后的键路径列表。 */
export function extractKeys(text: string, fmt: Format): string[] {
  let keys: string[];
  if (fmt === "JSON") {
    try {
      keys = jsonKeys(JSON.parse(text));
    } catch {
      keys = lineKeys(text);
    }
  } else {
    keys = lineKeys(text);
  }
  return Array.from(new Set(keys)).sort();
}

/** 提取后拼成多行文本(每行一个 key),便于喂给行级 diff。 */
export function keysDoc(text: string, fmt: Format): string {
  return extractKeys(text, fmt).join("\n");
}
