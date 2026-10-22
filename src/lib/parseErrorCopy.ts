// 解析错误的**展示层**文案（轮26 F-5）。
//
// 为什么不在产出侧翻译：`JSON:` / `YAML:` 开头的这串文本是数据，不是文案——
// 它随草稿与变更计划快照持久化（applyPlan.ts 的 parseError 字段）、参与内容搜索命中
// （configContentSearch.ts）。改产出串等于改存档格式，老计划里的快照会对不上。
// 所以产出侧一个字不动，只在渲染前把这一句翻成人话。
//
// 为什么不吞原文：句式跟着 V8 / yaml 版本变。字典里只收**实测跑出来过**的句子，
// 认不出来就原样保留——宁可露一句英文，也不能把真正的错误信息翻译没了。
// 同理，提取不到行列时绝不编一个行号出来（V8 的 `Unexpected token '}', ... is not valid JSON`
// 与 `Unexpected end of JSON input` 这两种就不带位置）。

import { translate } from "../locales";

/** 产出侧前缀：normalize.ts 与 validate.ts 都按 `<格式>:<引擎原文>` 存串。 */
const PREFIX_RE = /^(JSON|YAML):([\s\S]*)$/;

/** JSON：`... (line 1 column 8)`，V8 自己算好的行列。 */
const JSON_LINE_COLUMN = /\s*\(line (\d+) column (\d+)\)\s*$/;
/** JSON：`... in JSON at position 7` / `... after JSON at position 10`。 */
const JSON_AT_POSITION = /\s*(?:in JSON\s+)?at position (\d+)\s*$/;
/** YAML：`... at line 2, column 1:`。可能在句中出现——duplicate key 的警告串尾还挂着一段中文说明。 */
const YAML_LINE_COLUMN = /\s*at line (\d+), column (\d+):?\s*/;

/** V8「此处应为 X」里的 X。实测来源见 parseErrorCopy.test.ts 的句式表。 */
export const JSON_EXPECT_TERMS: Record<string, string> = {
  "property name": "parseError.term.propertyName",
  "double-quoted property name": "parseError.term.doubleQuotedPropertyName",
  value: "parseError.term.value",
  data: "parseError.term.data",
  "':'": "parseError.term.colon",
  "','": "parseError.term.comma",
  "'}'": "parseError.term.closeBrace",
  "']'": "parseError.term.closeBracket",
};

/** V8「Expected X after Y」里的 Y。 */
export const JSON_CONTEXT_TERMS: Record<string, string> = {
  "property name": "parseError.context.propertyName",
  "property value": "parseError.context.propertyValue",
  "array element": "parseError.context.arrayElement",
};

/** V8「Unexpected <kind>」里的类型名（`{"a":01}` → Unexpected number）。 */
export const JSON_KIND_TERMS: Record<string, string> = {
  number: "parseError.kind.number",
  string: "parseError.kind.string",
  boolean: "parseError.kind.boolean",
  null: "parseError.kind.null",
  object: "parseError.kind.object",
  array: "parseError.kind.array",
};

/**
 * yaml 库（实测 2.9.0）的句式主干。**必须按长度倒序匹配**：
 * `Flow map must end with a }` 这类短句可能成为长句的前缀，先长后短才不误伤。
 *
 * 每条都用 `node + node_modules/yaml` 跑过 `parseDocument(...).errors[0].message`，
 * 并和 `yaml/dist/compose/*.js`、`yaml/dist/parse/*.js` 里的字面量核对过。
 * 1.x 时代的 `bad indentation of a mapping entry` / `Missing , between collection elements`
 * 在 2.9.0 里已经不存在（对应的是 `All mapping items must start at the same column` 等），
 * 所以不收——字典只收跑得出来的句子，收不到的原样保留。
 */
export const YAML_STEM_KEYS: Record<string, string> = {
  "Map keys must be unique": "parseError.yaml.mapKeysUnique",
  "Nested mappings are not allowed in compact mappings": "parseError.yaml.nestedMappingsInCompact",
  "Implicit keys need to be on a single line": "parseError.yaml.implicitKeysSingleLine",
  "Implicit map keys need to be followed by map values": "parseError.yaml.implicitKeysNeedValue",
  "All mapping items must start at the same column": "parseError.yaml.mappingItemsSameColumn",
  "Flow sequence in block collection must be sufficiently indented and end with a ]": "parseError.yaml.flowSequenceUnclosedInBlock",
  "Flow sequence must end with a ]": "parseError.yaml.flowSequenceUnclosed",
  "Flow map in block collection must be sufficiently indented and end with a }": "parseError.yaml.flowMapUnclosedInBlock",
  "Flow map must end with a }": "parseError.yaml.flowMapUnclosed",
  'Missing closing "quote': "parseError.yaml.missingClosingDoubleQuote",
  "Missing closing 'quote": "parseError.yaml.missingClosingSingleQuote",
  "Block collections are not allowed within flow collections": "parseError.yaml.blockCollectionsInFlow",
  "Tabs are not allowed as indentation": "parseError.yaml.tabsAsIndentation",
};

/**
 * 产出侧挂在句尾的说明（轮66 WP-5）。
 *
 * `normalize.ts` 把这句中文尾注拼进了存档串——它是数据（进变更计划快照、进内容搜索命中），
 * 一个字都不能动，所以在这里按逐字尾注查文案键，只在展示层翻。
 * key 与产出侧必须**逐字一致**，且 zh-CN 的取值也要与 key 逐字一致：
 * 中文界面靠「翻回原样」做到零变化，任何一处改动都必须三处同步
 * （normalize.ts 的产出串 / 这里的 key / zh-CN 的取值），否则尾注会从界面上凭空消失。
 */
export const ARCHIVE_TAIL_KEYS: Record<string, string> = {
  "（duplicate key 已按后值覆盖处理，不阻塞同步）": "parseError.yaml.duplicateKeyNote",
};

/** 本模块可能吐出的全部文案键（字典侧）。字面量键由 localeParity 的字面量扫描覆盖。 */
export const PARSE_ERROR_DICT_KEYS: string[] = [
  ...new Set([
    ...Object.values(JSON_EXPECT_TERMS),
    ...Object.values(JSON_CONTEXT_TERMS),
    ...Object.values(JSON_KIND_TERMS),
    ...Object.values(YAML_STEM_KEYS),
    ...Object.values(ARCHIVE_TAIL_KEYS),
  ]),
];

interface Extracted {
  /** 去掉位置片段后的引擎正文（可能为空串）。 */
  body: string;
  line?: number;
  column?: number;
  /** V8 的 0 基字符偏移。只在既拿不到行也拿不到列时用它，展示时 +1 对齐 V8 自己的列号口径。 */
  position?: number;
}

/** 先把位置片段从正文里摘出来：行列优先，其次才是机器坐标 position。 */
function extractPosition(raw: string): Extracted {
  let body = raw.trim();
  let line: number | undefined;
  let column: number | undefined;
  let position: number | undefined;

  const jsonPos = body.match(JSON_LINE_COLUMN);
  if (jsonPos) {
    line = Number(jsonPos[1]);
    column = Number(jsonPos[2]);
    body = body.slice(0, jsonPos.index);
  }
  const atPos = body.match(JSON_AT_POSITION);
  if (atPos) {
    // 行列已经拿到时，position 只是同一件事的机器坐标，丢掉不重复展示。
    if (line === undefined) position = Number(atPos[1]);
    body = body.slice(0, atPos.index);
  }
  if (line === undefined) {
    const yamlPos = body.match(YAML_LINE_COLUMN);
    if (yamlPos) {
      line = Number(yamlPos[1]);
      column = Number(yamlPos[2]);
      // YAML 的位置在句中（后面可能还挂着说明文字），所以只挖掉这一段而不是切掉尾巴
      const from = yamlPos.index ?? 0;
      body = `${body.slice(0, from)}${body.slice(from + yamlPos[0].length)}`;
    }
  }
  return { body: body.trim(), line, column, position };
}

function positionSuffix({ line, column, position }: Extracted): string {
  if (line) return column ? translate("validation.atLineColumn", { line, column }) : translate("validation.atLine", { line });
  if (position !== undefined) return translate("parseError.atOffset", { offset: position + 1 });
  return "";
}

/** `Expected <X> [or <Y>] [after <Z>]` → 「…应为…」；认不出的组合返回 null，交给上层保留原文。 */
function describeExpectation(clause: string): string | null {
  const after = clause.match(/^(.*?)\s+after\s+(.+)$/);
  const termsRaw = (after ? after[1] : clause).trim();
  const contextRaw = after ? after[2].trim() : "";
  const termKeys = termsRaw.split(/\s+or\s+/).map((term) => JSON_EXPECT_TERMS[term.trim()]);
  if (termKeys.some((key) => !key)) return null;
  const contextKey = contextRaw ? JSON_CONTEXT_TERMS[contextRaw] : undefined;
  if (contextRaw && !contextKey) return null;
  const expected = termKeys.map((key) => translate(key!)).join(translate("parseError.orJoin"));
  return contextKey
    ? translate("parseError.expectedAfter", { context: translate(contextKey), expected })
    : translate("parseError.expectedHere", { expected });
}

/** JSON 正文 → 本地化句子；返回 null 表示这句不在字典里。 */
function describeJsonBody(body: string): string | null {
  if (!body) return null;
  switch (body) {
    case "Unexpected end of JSON input":
      return translate("parseError.unexpectedEnd");
    case "Unterminated string":
      return translate("parseError.unterminatedString");
    case "Bad control character in string literal":
      return translate("parseError.badControlCharacter");
    case "Bad escaped character":
      return translate("parseError.badEscapeCharacter");
    case "Unexpected non-whitespace character after JSON":
      return translate("parseError.trailingContent");
    default:
      break;
  }
  const tokenIn = body.match(/^Unexpected token '(.*)',\s*"(.*)"\s+is not valid JSON$/);
  if (tokenIn) return translate("parseError.unexpectedTokenIn", { token: tokenIn[1], snippet: tokenIn[2] });
  const token = body.match(/^Unexpected token '(.*)'$/);
  if (token) return translate("parseError.unexpectedToken", { token: token[1] });
  const unexpected = body.match(/^Unexpected (.+)$/);
  if (unexpected) {
    const kindKey = JSON_KIND_TERMS[unexpected[1].trim()];
    // 既不是字典里的类型、也不是上面几种整句 → 保留原文，不猜
    if (!kindKey) return null;
    return translate("parseError.unexpectedKind", { kind: translate(kindKey) });
  }
  const expected = body.match(/^Expected (.+)$/);
  if (expected) return describeExpectation(expected[1]);
  return null;
}

/** YAML 正文 → 本地化句子。按「句主干」前缀匹配，句尾原样保留（duplicate key 那条后面挂着说明）。 */
function describeYamlBody(body: string): string | null {
  if (!body) return null;
  const stem = Object.keys(YAML_STEM_KEYS)
    .sort((a, b) => b.length - a.length)
    .find((candidate) => body.startsWith(candidate));
  if (!stem) return null;
  const tail = body.slice(stem.length);
  // 存档尾注命中字典就翻成本地文案（en 界面不再露中文）；认不出的尾注原样保留，不猜
  const tailKey = ARCHIVE_TAIL_KEYS[tail] ?? ARCHIVE_TAIL_KEYS[tail.trim()];
  return translate(YAML_STEM_KEYS[stem]) + (tailKey ? translate(tailKey) : tail);
}

/**
 * 把 `JSON:` / `YAML:` 开头的解析错误原始串翻成当前界面语言。
 *
 * - 空串 → 空串（调用方自己决定要不要渲染这一行）；
 * - 没有 `<格式>:` 前缀 → 原样返回：本模块不认识产出方，不猜；
 * - 字典外的句式 → 只换外壳（「JSON 解析失败：…」+ 行列），英文正文保留。
 */
export function describeParseError(raw: string | null | undefined): string {
  if (!raw) return "";
  const prefixed = raw.match(PREFIX_RE);
  if (!prefixed) return raw;
  const [, engine, rest] = prefixed;
  const parts = extractPosition(rest);
  const detail = (engine === "JSON" ? describeJsonBody(parts.body) : describeYamlBody(parts.body)) ?? parts.body;
  const message = `${detail}${positionSuffix(parts)}`;
  return translate(engine === "JSON" ? "validation.jsonParseFailed" : "validation.yamlParseFailed", { message });
}
