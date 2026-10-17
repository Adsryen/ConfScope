/**
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { escapeRegex, matchLiteral, type MatchRange } from "./textMatch";

/**
 * 期望位置优先由 indexOf 现场推导，测试里不抄第二份「事实源」
 * （历史上踩过：数字写死 → 改实现时顺手改数字 → 断言失去意义）。
 * 只有「全词边界」这种实现本身定义的行为，才用小型定向 fixture 逐条说明。
 */
function indexesOf(text: string, needle: string, caseSensitive: boolean): number[] {
  const out: number[] = [];
  if (!needle) return out;
  const haystack = caseSensitive ? text : text.toLowerCase();
  const pattern = caseSensitive ? needle : needle.toLowerCase();
  for (let i = haystack.indexOf(pattern); i >= 0; i = haystack.indexOf(pattern, i + pattern.length)) {
    out.push(i);
  }
  return out;
}

function startsOf(ranges: MatchRange[]): number[] {
  return ranges.map((range) => range.index);
}

/** 命中区间回读原文，验证 length 始终按原始文本计（而非小写化之后）。 */
function slicesOf(text: string, ranges: MatchRange[]): string[] {
  return ranges.map((range) => text.slice(range.index, range.index + range.length));
}

const FIXTURE = "export const port = 8080;\nconst PORT=1;\nSupports = true;\n数据库端口配置 = 1\nserver.port=9090\n";

describe("textMatch 默认口径（与左侧列表内容搜索同源）", () => {
  it("不带选项时是大小写不敏感的子串匹配", () => {
    const ranges = matchLiteral(FIXTURE, "port");
    expect(startsOf(ranges)).toEqual(indexesOf(FIXTURE, "port", false));
    // export / PORT / Supports 里的 port 都算命中：这就是列表端的口径
    expect(ranges.length).toBeGreaterThan(3);
    expect(ranges.every((range) => range.length === "port".length)).toBe(true);
  });

  it("命中文本按原文切片，大小写原样保留", () => {
    const ranges = matchLiteral(FIXTURE, "PORT");
    expect(slicesOf(FIXTURE, ranges)).toEqual(indexesOf(FIXTURE, "PORT", false).map((i) => FIXTURE.slice(i, i + 4)));
  });

  it("空白搜索词不产生命中", () => {
    expect(matchLiteral(FIXTURE, "")).toEqual([]);
    expect(matchLiteral(FIXTURE, "   ")).toEqual([]);
  });

  it("搜索词首尾空白被忽略，命中偏移仍相对原文", () => {
    expect(startsOf(matchLiteral(FIXTURE, "  port  "))).toEqual(startsOf(matchLiteral(FIXTURE, "port")));
  });

  it("字面量里的正则元字符不被当模式解释", () => {
    expect(startsOf(matchLiteral("a.b axb a+b", "."))).toEqual([1]);
    expect(matchLiteral("a+b", "a+b")).toHaveLength(1);
    expect(matchLiteral("(x)", "(x)")).toHaveLength(1);
    expect(escapeRegex("$1.0\\2")).toBe("\\$1\\.0\\\\2");
  });
});

describe("textMatch 区分大小写", () => {
  it("caseSensitive 只命中原文同形的词", () => {
    const ranges = matchLiteral(FIXTURE, "port", { caseSensitive: true });
    expect(startsOf(ranges)).toEqual(indexesOf(FIXTURE, "port", true));
    expect(slicesOf(FIXTURE, ranges).every((s) => s === "port")).toBe(true);
  });

  it("caseSensitive 下大写变体另算", () => {
    const ranges = matchLiteral(FIXTURE, "PORT", { caseSensitive: true });
    expect(slicesOf(FIXTURE, ranges)).toEqual(indexesOf(FIXTURE, "PORT", true).map(() => "PORT"));
  });

  it("两个开关都为 false 时与默认口径逐位相同（开关不改变基线）", () => {
    expect(matchLiteral(FIXTURE, "port", { caseSensitive: false, wholeWord: false })).toEqual(matchLiteral(FIXTURE, "port"));
  });
});

describe("textMatch 全词匹配", () => {
  it("两侧是边界符（行首尾、空格、括号、等号）才算整词", () => {
    const text = "port=1 (port) ports xxport\nport";
    const ranges = matchLiteral(text, "port", { wholeWord: true });
    // ports 尾部贴 s、xxport 头部贴 x，都被排除；其余三处（行首、括号内、下一行行首）成立
    expect(slicesOf(text, ranges)).toEqual(["port", "port", "port"]);
    expect(startsOf(ranges)).toEqual([
      text.indexOf("port"), // 行首 + 右侧 =
      text.indexOf("(port)") + 1, // 左右都是括号
      text.lastIndexOf("port"), // 换行后
    ]);
  });

  it("全词不会把 export 里的 port 也算进来", () => {
    const text = "export const port = 1";
    const ranges = matchLiteral(text, "port", { caseSensitive: true, wholeWord: true });
    expect(startsOf(ranges)).toEqual([text.lastIndexOf("port")]);
    expect(matchLiteral(text, "port", { wholeWord: true }).length).toBeLessThan(matchLiteral(text, "port").length);
  });

  it("下划线和数字是词字符：max_port2 不是 port 的整词", () => {
    expect(matchLiteral("max_port port_ port2 max_port2 port", "port", { wholeWord: true })).toHaveLength(1);
    expect(matchLiteral("db_port port", "_port", { wholeWord: true })).toHaveLength(0);
  });

  it("CJK 也算词字符：数据库端口配置里的「端口」不是整词", () => {
    expect(matchLiteral("数据库端口配置", "端口", { wholeWord: true })).toHaveLength(0);
    expect(matchLiteral("数据库端口配置", "端口")).toHaveLength(1);
    expect(matchLiteral("端口: 8080", "端口", { wholeWord: true })).toHaveLength(1);
  });

  it("搜索词尾部不是词字符时不贴尾边界，server.port= 仍是可用条件", () => {
    expect(startsOf(matchLiteral("server.port=9090", "server.port=", { wholeWord: true }))).toEqual([0]);
    // 头部仍是词边界：myserver.port= 里的 server.port= 前贴 r，被排除
    expect(matchLiteral("myserver.port=9090", "server.port=", { wholeWord: true })).toHaveLength(0);
    expect(matchLiteral("myserver.port=9090", "server.port=")).toHaveLength(1);
  });

  it("全词模式下元字符依旧按字面量处理", () => {
    expect(matchLiteral("a.b axb", ".", { wholeWord: true })).toHaveLength(1);
    expect(matchLiteral("a.b axb", ".")).toHaveLength(1);
  });

  it("孤立代理（半个 emoji）不会当场抛错，退回后仍能命中", () => {
    const text = "a\ud800b";
    const ranges = matchLiteral(text, "\ud800", { wholeWord: true });
    expect(startsOf(ranges)).toEqual([1]);
    expect(ranges[0].length).toBe(1);
  });
});

describe("textMatch 全词与默认口径的关系", () => {
  /** 独立口径（不借实现里的常量）：词字符 = 字母 / 数字 / 下划线，含 CJK。
   *  命中两侧不许紧贴词字符；搜索词自身那一侧不是词字符时不要求那一侧
   *  （否则 server.port= 这种常用写法会变成死条件）。 */
  const isWord = (char: string | undefined): boolean => (char ? /\p{L}|\p{N}|_/u.test(char) : false);

  function wholeWordStarts(text: string, needle: string, caseSensitive: boolean): number[] {
    const edge = Array.from(needle);
    const checkBefore = isWord(edge[0]) ? (i: number) => i === 0 || !isWord(text[i - 1]) : () => true;
    const checkAfter = isWord(edge[edge.length - 1]) ? (end: number) => end >= text.length || !isWord(text[end]) : () => true;
    return indexesOf(text, needle, caseSensitive).filter((i) => checkBefore(i) && checkAfter(i + needle.length));
  }

  it("FIXTURE 上的全词命中可由边界定义逐位推出（默认口径是全词的真子集）", () => {
    const ww = matchLiteral(FIXTURE, "port", { wholeWord: true });
    expect(startsOf(ww)).toEqual(wholeWordStarts(FIXTURE, "port", false));
    expect(wholeWordStarts(FIXTURE, "port", false).length).toBeLessThan(startsOf(matchLiteral(FIXTURE, "port")).length);
  });

  it("中文词在全词下同样按码点边界判定，不会退化成死条件", () => {
    const text = "数据库端口配置 = 1\n端口 = 2\n超时timeout\ntimeout";
    expect(startsOf(matchLiteral(text, "端口", { wholeWord: true }))).toEqual(wholeWordStarts(text, "端口", false));
    expect(startsOf(matchLiteral(text, "timeout", { wholeWord: true }))).toEqual(wholeWordStarts(text, "timeout", false));
    // 至少能搜到独立成词的「端口」和末尾的 timeout，且不会命中 数据库端口配置 内部
    expect(startsOf(matchLiteral(text, "端口", { wholeWord: true })).length).toBe(1);
    expect(startsOf(matchLiteral(text, "timeout", { wholeWord: true })).length).toBe(1);
  });
});
