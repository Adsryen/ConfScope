/**
 * 解析错误的展示层文案（轮26 波57 F-5）。
 *
 * 这里的输入串**全部是实测抓出来的**，不是照着英文语法编的：
 * - JSON 那批：Playwright chromium 里逐条 `JSON.parse` 坏输入抓的 `error.message`；
 * - YAML 那批：`node + node_modules/yaml` 跑 `parseDocument(...).errors[].message`（取 `\n` 前首行），
 *   下面「字典不许留死条目」那条测试还会用真 yaml 现场反查一遍，升级依赖后字典漂了就判红。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import zhLocale from "../locales/zh-CN.json";
import enLocale from "../locales/en-US.json";
import { parseDocument } from "yaml";
import {
  ARCHIVE_TAIL_KEYS,
  JSON_CONTEXT_TERMS,
  JSON_EXPECT_TERMS,
  JSON_KIND_TERMS,
  PARSE_ERROR_DICT_KEYS,
  YAML_STEM_KEYS,
  describeParseError,
} from "./parseErrorCopy";
import { normalizeConfig } from "./normalize";

function useLocale(locale: string): void {
  vi.stubGlobal("localStorage", { getItem: () => locale, setItem: () => {}, removeItem: () => {}, clear: () => {} });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function flatten(tree: unknown, prefix = ""): Record<string, string> {
  const acc: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree as Record<string, unknown>)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object") Object.assign(acc, flatten(value, full));
    else acc[full] = String(value);
  }
  return acc;
}

/** 产出侧（normalize.ts）挂在句尾的存档说明，逐字。 */
const TAIL_NOTE = "（duplicate key 已按后值覆盖处理，不阻塞同步）";

const locales = {
  "zh-CN": flatten(zhLocale),
  "en-US": flatten(enLocale),
};

/** V8 实测句式 → 中文界面应该看到整句什么。 */
const JSON_CASES: { raw: string; zh: string }[] = [
  {
    raw: "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
    zh: "JSON 解析失败:此处应为属性名或右花括号「}」（第 1 行第 2 列）",
  },
  {
    raw: "Expected double-quoted property name in JSON at position 7 (line 1 column 8)",
    zh: "JSON 解析失败:此处应为带双引号的属性名（第 1 行第 8 列）",
  },
  {
    raw: "Expected ',' or '}' after property value in JSON at position 7 (line 1 column 8)",
    zh: "JSON 解析失败:属性值之后应为逗号「,」或右花括号「}」（第 1 行第 8 列）",
  },
  {
    raw: "Expected ',' or ']' after array element in JSON at position 5 (line 1 column 6)",
    zh: "JSON 解析失败:数组元素之后应为逗号「,」或右方括号「]」（第 1 行第 6 列）",
  },
  {
    raw: "Expected ':' after property name in JSON at position 5 (line 1 column 6)",
    zh: "JSON 解析失败:属性名之后应为冒号「:」（第 1 行第 6 列）",
  },
  {
    raw: "Unexpected non-whitespace character after JSON at position 2 (line 1 column 3)",
    zh: "JSON 解析失败:JSON 内容之后还有多余的字符（第 1 行第 3 列）",
  },
  {
    raw: 'Unexpected token \'}\', "{"a":}" is not valid JSON',
    zh: 'JSON 解析失败:「{"a":}」不是合法的 JSON，出现了不该出现的字符「}」',
  },
  { raw: "Unexpected end of JSON input", zh: "JSON 解析失败:JSON 内容不完整，还没读到值就结束了" },
  {
    raw: "Unterminated string in JSON at position 7 (line 1 column 8)",
    zh: "JSON 解析失败:字符串缺少结尾的引号（第 1 行第 8 列）",
  },
  {
    raw: "Bad control character in string literal in JSON at position 7 (line 1 column 8)",
    zh: "JSON 解析失败:字符串里出现了控制字符（第 1 行第 8 列）",
  },
  {
    raw: "Bad escaped character in JSON at position 7 (line 1 column 8)",
    zh: "JSON 解析失败:转义字符写法不正确（第 1 行第 8 列）",
  },
  {
    raw: "Unexpected number in JSON at position 6 (line 1 column 7)",
    zh: "JSON 解析失败:此处不该出现数字（第 1 行第 7 列）",
  },
];

/** yaml 2.9.0 实测句式（坏输入直接给引擎串，输入侧在下面单独反查）。 */
const YAML_CASES: { raw: string; zh: string }[] = [
  { raw: "Map keys must be unique at line 2, column 1:", zh: "YAML 解析失败:映射的键必须唯一（第 2 行第 1 列）" },
  {
    raw: "Nested mappings are not allowed in compact mappings at line 1, column 4:",
    zh: "YAML 解析失败:紧凑写法里不允许嵌套映射（第 1 行第 4 列）",
  },
  {
    raw: "Implicit keys need to be on a single line at line 1, column 4:",
    zh: "YAML 解析失败:隐式键必须写在同一行（第 1 行第 4 列）",
  },
  {
    raw: "Implicit map keys need to be followed by map values at line 3, column 1:",
    zh: "YAML 解析失败:隐式键后面必须跟映射的值（第 3 行第 1 列）",
  },
  {
    raw: "All mapping items must start at the same column at line 3, column 1:",
    zh: "YAML 解析失败:同一组映射项必须从同一列开始（第 3 行第 1 列）",
  },
  {
    raw: "Flow sequence in block collection must be sufficiently indented and end with a ] at line 2, column 1:",
    zh: "YAML 解析失败:块级集合里的流式序列要缩进到位并以「]」结尾（第 2 行第 1 列）",
  },
  {
    raw: "Flow sequence must end with a ] at line 2, column 1:",
    zh: "YAML 解析失败:流式序列必须以「]」结尾（第 2 行第 1 列）",
  },
  {
    raw: "Flow map in block collection must be sufficiently indented and end with a } at line 2, column 1:",
    zh: "YAML 解析失败:块级集合里的流式映射要缩进到位并以「}」结尾（第 2 行第 1 列）",
  },
  {
    raw: "Flow map must end with a } at line 2, column 1:",
    zh: "YAML 解析失败:流式映射必须以「}」结尾（第 2 行第 1 列）",
  },
  {
    raw: 'Missing closing "quote at line 2, column 1:',
    zh: "YAML 解析失败:字符串缺少结尾的双引号（第 2 行第 1 列）",
  },
  {
    raw: "Missing closing 'quote at line 2, column 1:",
    zh: "YAML 解析失败:字符串缺少结尾的单引号（第 2 行第 1 列）",
  },
  {
    raw: "Block collections are not allowed within flow collections at line 1, column 5:",
    zh: "YAML 解析失败:流式集合里不允许出现块级集合（第 1 行第 5 列）",
  },
  {
    raw: "Tabs are not allowed as indentation at line 2, column 1:",
    zh: "YAML 解析失败:不允许用 Tab 缩进（第 2 行第 1 列）",
  },
];

describe("describeParseError：JSON 引擎串", () => {
  it.each(JSON_CASES)("中文界面整句本地化（含行列）：$raw", ({ raw, zh }) => {
    useLocale("zh-CN");
    expect(describeParseError(`JSON:${raw}`)).toBe(zh);
  });

  it("英文界面同样翻成英文框架，且不许残留中文", () => {
    useLocale("en-US");
    for (const { raw } of JSON_CASES) {
      const out = describeParseError(`JSON:${raw}`);
      expect(out.startsWith("JSON parse failed:")).toBe(true);
      expect(out).not.toMatch(/[\u3400-\u9fff]/);
      // 机器坐标不许和行列同时出现
      expect(out).not.toContain("at position");
    }
  });

  it("字典外的新句式只换外壳，英文正文原样保留（宁可露英文也不吞掉真错误）", () => {
    useLocale("zh-CN");
    const raw = "Some brand new V8 sentence at position 3 (line 1 column 4)";
    expect(describeParseError(`JSON:${raw}`)).toBe("JSON 解析失败:Some brand new V8 sentence（第 1 行第 4 列）");
  });

  it("完全没有位置线索时不许编行号", () => {
    useLocale("zh-CN");
    for (const raw of ["Unexpected end of JSON input", 'Unexpected token \'}\', "{"a":}" is not valid JSON']) {
      expect(describeParseError(`JSON:${raw}`)).not.toContain("第");
    }
  });

  it("只有 position、没有行列的旧句式退回「第 N 个字符处」，且按 V8 的列号口径 +1", () => {
    useLocale("zh-CN");
    expect(describeParseError("JSON:Unexpected foo at position 5")).toBe("JSON 解析失败:Unexpected foo（第 6 个字符处）");
    useLocale("en-US");
    expect(describeParseError("JSON:Unexpected foo at position 5")).toBe("JSON parse failed:Unexpected foo (character 6)");
  });

  it("V8 的 Expected/Unexpected 框架词一旦收进字典就不许再露在界面上", () => {
    useLocale("zh-CN");
    for (const { raw, zh } of JSON_CASES) {
      if (/^(Expected|Unexpected (?!end|token|non-whitespace))/.test(raw) || raw.startsWith("Bad ") || raw.startsWith("Unterminated ")) {
        expect(zh).not.toMatch(/Expected |Unexpected |Bad |Unterminated /);
      }
    }
  });
});

describe("describeParseError：YAML 引擎串", () => {
  it.each(YAML_CASES)("中文界面整句本地化（含行列）：$raw", ({ raw, zh }) => {
    useLocale("zh-CN");
    expect(describeParseError(`YAML:${raw}`)).toBe(zh);
  });

  it("duplicate key 警告串尾的中文说明不能被吞（normalize.ts:188 就长这样）", () => {
    useLocale("zh-CN");
    const out = describeParseError(`YAML:Map keys must be unique at line 2, column 1:${TAIL_NOTE}`);
    expect(out).toContain("映射的键必须唯一");
    expect(out).toContain("duplicate key 已按后值覆盖处理，不阻塞同步");
    expect(out).toContain("（第 2 行第 1 列）");
  });

  it("英文界面不残留中文框架，句尾的存档说明也翻成英文", () => {
    useLocale("en-US");
    expect(describeParseError("YAML:Map keys must be unique at line 2, column 1:")).toBe(
      "YAML parse failed:map keys must be unique (line 2, column 1)"
    );
    expect(describeParseError(`YAML:Map keys must be unique at line 2, column 1:${TAIL_NOTE}`)).toBe(
      "YAML parse failed:map keys must be unique (duplicate keys were resolved by keeping the later value; sync not blocked) (line 2, column 1)"
    );
  });

  it("中文界面把尾注翻回原样：与产出侧存档串逐字一致，老快照显示不变", () => {
    useLocale("zh-CN");
    const raw = `YAML:Map keys must be unique at line 2, column 1:${TAIL_NOTE}`;
    // 尾注的译文必须等于尾注本身，否则中文界面会从「原样」变成「少一句 / 多一句」
    expect(locales["zh-CN"][ARCHIVE_TAIL_KEYS[TAIL_NOTE]]).toBe(TAIL_NOTE);
    expect(describeParseError(raw)).toBe(`YAML 解析失败:映射的键必须唯一${TAIL_NOTE}（第 2 行第 1 列）`);
  });

  it("生产者与展示层不许各写一份尾注（真产出串喂进来，en 界面不得露中文）", () => {
    // 这里刻意不复制字面量：尾注从 normalize.ts 现场产出，改产出侧文案时这条会跟着红，
    // 逼着同步 ARCHIVE_TAIL_KEYS 的 key，而不是让英文界面重新漏出中文。
    const produced = normalizeConfig("a: 1\na: 2\n", "YAML").parseError;
    expect(produced).toBeTruthy();
    useLocale("en-US");
    const en = describeParseError(produced);
    expect(en).not.toMatch(/[\u3400-\u9fff]/);
    expect(en).toContain("duplicate keys were resolved");
    useLocale("zh-CN");
    expect(describeParseError(produced)).toContain(TAIL_NOTE);
  });

  it("字典里的每条 yaml 主干都真的能被现版本 yaml 跑出来（防收死条目 / 防升级后漂移）", () => {
    const badDocs = [
      "a: 1\na: 2\n",
      "a: b: c\n",
      "a: 1\n  b: 2\n",
      "a:\n  b: 1\n c: 2\n",
      "a:\nb: 1\nc\n",
      "a: [1, 2\nb: 3\n",
      "[1, 2\n",
      "a: {b: 1\n",
      "{b: 1\n",
      'a: "x\n',
      "a: 'x\n",
      "{a: 1\nb: 2}\n",
      "a:\n\tb: 1\n",
    ];
    const messages = new Set<string>();
    for (const src of badDocs) {
      for (const e of parseDocument(src, { uniqueKeys: true }).errors) messages.add(e.message.split("\n")[0]);
    }
    const dead = Object.keys(YAML_STEM_KEYS).filter((stem) => ![...messages].some((m) => m.startsWith(stem)));
    expect(dead).toEqual([]);
  });
});

describe("describeParseError：边界", () => {
  it("没有 <格式>: 前缀的串原样返回（本模块不认识产出方，不猜）", () => {
    useLocale("zh-CN");
    expect(describeParseError("connection refused")).toBe("connection refused");
    expect(describeParseError(null)).toBe("");
    expect(describeParseError(undefined)).toBe("");
    expect(describeParseError("")).toBe("");
  });

  it("前缀只在句首生效，正文里再出现冒号不会被当成前缀", () => {
    useLocale("zh-CN");
    expect(describeParseError('JSON:Unexpected token \':\', "{"a":1:2}" is not valid JSON')).toBe(
      'JSON 解析失败:「{"a":1:2}」不是合法的 JSON，出现了不该出现的字符「:」'
    );
  });
});

describe("parseError 文案字典与 locale 对齐", () => {
  it("字典里的每个键在两份语言文件里都有非空文案（反向死钩子）", () => {
    expect(PARSE_ERROR_DICT_KEYS.length).toBeGreaterThan(25);
    const missing = PARSE_ERROR_DICT_KEYS.filter((key) => !locales["zh-CN"][key]?.trim() || !locales["en-US"][key]?.trim());
    expect(missing).toEqual([]);
  });

  it("字典覆盖了三张 JSON 表、yaml 表和存档尾注表，新增条目不会漏登记", () => {
    const all = [
      ...Object.values(JSON_EXPECT_TERMS),
      ...Object.values(JSON_CONTEXT_TERMS),
      ...Object.values(JSON_KIND_TERMS),
      ...Object.values(YAML_STEM_KEYS),
      ...Object.values(ARCHIVE_TAIL_KEYS),
    ];
    expect([...new Set(all)].sort()).toEqual([...PARSE_ERROR_DICT_KEYS].sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it("parseError.* 的英文文案不含中文，占位符两侧一致", () => {
    const zhKeys = Object.keys(locales["zh-CN"]).filter((key) => key.startsWith("parseError."));
    const enKeys = Object.keys(locales["en-US"]).filter((key) => key.startsWith("parseError."));
    expect(zhKeys.sort()).toEqual(enKeys.sort());
    const ph = (text: string) =>
      [...text.matchAll(/\{([^{}]+)\}/g)]
        .map((m) => m[1])
        .sort()
        .join(",");
    const drift = zhKeys.filter((key) => ph(locales["zh-CN"][key]) !== ph(locales["en-US"][key]));
    expect(drift).toEqual([]);
    const leaked = zhKeys.filter((key) => /[\u3400-\u9fff]/.test(locales["en-US"][key]));
    expect(leaked).toEqual([]);
  });

  it("外壳键 jsonParseFailed / yamlParseFailed 两份都在，且都只有一个 {message}", () => {
    for (const locale of ["zh-CN", "en-US"] as const) {
      expect(locales[locale]["validation.jsonParseFailed"].trim()).toBeTruthy();
      expect(locales[locale]["validation.yamlParseFailed"].trim()).toBeTruthy();
      expect(ph_count(locales[locale]["validation.yamlParseFailed"])).toBe(1);
    }
  });
});

function ph_count(text: string): number {
  return (text.match(/\{message\}/g) ?? []).length;
}
