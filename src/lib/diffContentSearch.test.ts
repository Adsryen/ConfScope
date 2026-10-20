import { describe, expect, it } from "vitest";
import { MAX_DIFF_SEARCH_ITEMS, searchDiffContent, type DiffSearchableItem } from "./diffContentSearch";

function entry(dataId: string, leftText: string, rightText = ""): DiffSearchableItem {
  return { dataId, leftText, rightText };
}

describe("searchDiffContent 作用域与空词", () => {
  it("空词与纯空格词返回空结果，但作用域条数照实说", () => {
    const items = [entry("a.properties", "port=8080"), entry("b.yaml", "timeout: 3000")];
    for (const term of ["", "   ", "\t"]) {
      const result = searchDiffContent(items, term);
      expect(result.term).toBe("");
      expect(result.hits).toEqual([]);
      expect(result.matchedItemCount).toBe(0);
      expect(result.listedMatches).toBe(0);
      // 没在搜 ⇒ 没有「扫过」这一说，但作用域（这批有几个配置）仍要报出来
      expect(result.scannedItems).toBe(0);
      expect(result.scopeItems).toBe(2);
      expect(result.capped).toBe(false);
    }
  });

  it("搜索词两端空白被去掉后才是真正参与匹配的词", () => {
    const result = searchDiffContent([entry("a", "redis.port=6379")], "  port  ");
    expect(result.term).toBe("port");
    expect(result.hits[0].total).toBe(1);
  });
});

describe("searchDiffContent 计数", () => {
  it("左右两侧分开计数，total 是两侧之和", () => {
    const result = searchDiffContent([entry("a.properties", "port=8080\nport=8081", "port=9090")], "port");
    const hit = result.hits[0];
    expect(hit.left.count).toBe(2);
    expect(hit.right.count).toBe(1);
    expect(hit.total).toBe(3);
    expect(result.listedMatches).toBe(3);
  });

  it("只有一侧命中时另一侧是零值而不是缺失", () => {
    const result = searchDiffContent([entry("a", "nothing here", "keyword=x")], "keyword");
    const hit = result.hits[0];
    expect(hit.left).toEqual({ count: 0, line: 0, snippet: "" });
    expect(hit.right.count).toBe(1);
    // 只有 B 侧有 ⇒ 「会被删掉」这类语义要靠徽标区分，两侧必须都能独立表达
    expect(result.matchedItemCount).toBe(1);
  });

  it("默认大小写不敏感，与代码视图查找栏关闭时的口径一致", () => {
    const result = searchDiffContent([entry("a", "REDIS_HOST=localhost", "RedisPort: 6379")], "redis");
    expect(result.hits[0].left.count).toBe(1);
    expect(result.hits[0].right.count).toBe(1);
  });

  it("按字面量匹配，正则元字符不被当模式", () => {
    const result = searchDiffContent([entry("a", "a.b=1\naxb=2")], "a.b");
    expect(result.hits[0].total).toBe(1);
  });

  it("无命中的配置不进入 hits", () => {
    const result = searchDiffContent([entry("a", "one"), entry("b", "two")], "three");
    expect(result.hits).toEqual([]);
    expect(result.matchedItemCount).toBe(0);
    expect(result.scannedItems).toBe(2);
  });
});

describe("searchDiffContent 行号", () => {
  it("行号按该侧正文从 1 起算，左右各按各的正文", () => {
    const result = searchDiffContent([entry("a", "a\nb\nc\ntarget", "x\ntarget")], "target");
    const hit = result.hits[0];
    expect(hit.left.line).toBe(4);
    expect(hit.right.line).toBe(2);
  });

  it("多行正文取首个命中的行，正文含 CRLF 时行号仍对", () => {
    const result = searchDiffContent([entry("a", "a\r\nb\r\ntarget\r\nd")], "target");
    expect(result.hits[0].left.line).toBe(3);
  });
});

describe("searchDiffContent 片段", () => {
  it("行尾 \\r 被压掉，片段里没有隐形字符", () => {
    const result = searchDiffContent([entry("a", "key=target_value\r\n")], "target");
    expect(result.hits[0].left.snippet).not.toContain("\r");
    expect(result.hits[0].left.snippet).toBe("key=target_value");
  });

  it("长行按窗口裁剪并在两侧补省略号", () => {
    const long = `${"x".repeat(80)}target${"y".repeat(80)}`;
    const result = searchDiffContent([entry("a", long)], "target");
    const snippet = result.hits[0].left.snippet;
    expect(snippet.startsWith("...")).toBe(true);
    expect(snippet.endsWith("...")).toBe(true);
    expect(snippet).toContain("target");
    // 窗口 = 前 28 + 词 + 后 48，不会把整行几十 KB 灌进左栏
    expect(snippet.length).toBeLessThanOrEqual(28 + "target".length + 48 + 6);
  });

  it("行首命中不补前导省略号，短行不补任何省略号", () => {
    expect(searchDiffContent([entry("a", "target=1 and more text here")], "target").hits[0].left.snippet).not.toMatch(/^\.\.\./);
    expect(searchDiffContent([entry("a", "target")], "target").hits[0].left.snippet).toBe("target");
  });
});

describe("searchDiffContent 触顶截断", () => {
  function many(count: number): DiffSearchableItem[] {
    return Array.from({ length: count }, (_, index) => entry(`c${index}.properties`, `port=${index}`));
  }

  it("攒够上限就停止扫描，capped 与未扫条数一起说清", () => {
    const result = searchDiffContent(many(120), "port");
    expect(result.capped).toBe(true);
    expect(result.hits).toHaveLength(MAX_DIFF_SEARCH_ITEMS);
    expect(result.matchedItemCount).toBe(MAX_DIFF_SEARCH_ITEMS);
    // 关键：scannedItems 是「真的扫了几个」，scopeItems 是「这批一共几个」
    expect(result.scannedItems).toBe(MAX_DIFF_SEARCH_ITEMS);
    expect(result.scopeItems).toBe(120);
  });

  it("未触顶时 capped 为 false，listedMatches 就是全局总数", () => {
    const result = searchDiffContent(many(MAX_DIFF_SEARCH_ITEMS), "port");
    expect(result.capped).toBe(false);
    expect(result.matchedItemCount).toBe(MAX_DIFF_SEARCH_ITEMS);
    expect(result.scannedItems).toBe(MAX_DIFF_SEARCH_ITEMS);
  });

  it("listedMatches 只统计已列出的配置，不把截断后的局部数当全局数", () => {
    const items = [...many(100), entry("extra", "port port port")];
    const result = searchDiffContent(items, "port");
    expect(result.capped).toBe(true);
    expect(result.listedMatches).toBe(100);
  });
});
