import { describe, expect, it } from "vitest";
import { findCodeHits } from "./codeLines";
import type { ConfigDocument, ConfigItem } from "../api/nacos";
import type { ApplyEntryEndpoint } from "./applyEntry";
import {
  buildContentReplaceApplyEntry,
  highlightSearchTerm,
  replacementImpact,
  replaceConfigContent,
  searchConfigContent,
  type ContentSearchResult,
} from "./configContentSearch";

function item(dataId: string, group = "DEFAULT_GROUP"): ConfigItem {
  return { dataId, group, content: "", configType: "yaml" };
}

function document(content: string, format = "yaml"): ConfigDocument {
  return { content, format, version: "v1", source: "test", updateTime: "2026-08-11T00:00:00Z" };
}

function result(configItem: ConfigItem, configDocument: ConfigDocument): ContentSearchResult {
  return { item: configItem, document: configDocument, matchedFields: ["content"], summary: configDocument.content };
}

const source: ApplyEntryEndpoint = {
  provider: "nacos",
  connectionId: "dev",
  connectionName: "开发",
  namespace: "public",
  label: "订单 / 开发 / 云上 / public",
};

const target: ApplyEntryEndpoint = {
  provider: "nacos",
  connectionId: "sandbox",
  connectionName: "沙箱",
  namespace: "public",
  label: "订单 / 沙箱 / 云上 / public",
};

describe("列表摘要与浏览态跳转同源（波49 R74）", () => {
  /**
   * 结果行的摘要取自正文**第一处**命中（contentSummary 的 indexOf），
   * CodeView 打开文件时定位的也是 findCodeHits 的第一处命中（波49）。
   * 两者一旦分叉，用户看到的就是「列表里那句话和点开后停住的那行不是一回事」，
   * 比不跳转更糟。这里用两个互斥的 marker 把锚点钉死：只有第一处命中在窗口内。
   */
  const filler = "z".repeat(120);
  const content = `${filler}\nnote = max-size\n${filler}\nOMEGA-other = max-size\n`;
  const term = "max-size";

  const hit = () => searchConfigContent([{ item: item("app.properties"), document: document(content, "properties") }], term)[0];

  it("摘要窗口锚在第一处命中，而不是别处同名命中", () => {
    const summary = hit().summary;
    expect(summary).toContain(term);
    expect(summary, "摘要锚到了后面的命中，跳转就会和列表说的话不一致").not.toContain("OMEGA");
  });

  it("CodeView 的第一处命中就落在摘要那句话所在的行", () => {
    const hits = findCodeHits(content, term);
    expect(hits[0].line).toBe(1);
    const targetLine = content.split("\n")[hits[0].line].trim();
    expect(targetLine).toBe("note = max-size");
    expect(hit().summary, "摘要里没有跳转目标行那句话").toContain(targetLine);
  });
});

describe("highlightSearchTerm", () => {
  it("wraps case-insensitive hits in mark.search-hit and escapes html", () => {
    const multiple = highlightSearchTerm("8080 and 18080", "8080");
    expect(multiple).toContain('<mark class="search-hit">8080</mark>');
    expect(multiple.match(/<mark class="search-hit">/g)).toHaveLength(2);
    expect(multiple.replace(/<[^>]+>/g, "")).toBe("8080 and 18080");
    expect(highlightSearchTerm("a<b&c>d", "a<b&c>d")).toBe(
      '<mark class="search-hit">a&lt;b&amp;c&gt;d</mark>'
    );
    expect(highlightSearchTerm("no match", "zzz")).toBe("no match");
    expect(highlightSearchTerm("x", " ")).toBe("x");
  });
});

describe("config content search", () => {
  it("matches dataId, group, and Chinese content without case sensitivity", () => {
    const results = searchConfigContent(
      [
        { item: item("Gateway.yaml", "OPS"), document: document("server:\n  name: Order Service") },
        { item: item("app.yaml"), document: document("说明: 支付服务") },
      ],
      "service"
    );

    expect(results).toHaveLength(1);
    expect(results[0].matchedFields).toEqual(["content"]);
    expect(results[0].summary).toContain("Order Service");
    expect(searchConfigContent([{ item: item("app.yaml"), document: document("说明: 支付服务") }], "支付")).toHaveLength(1);
    expect(searchConfigContent([{ item: item("Gateway.yaml", "OPS"), document: document("x") }], "gateway")[0].matchedFields).toEqual([
      "dataId",
    ]);
    expect(searchConfigContent([{ item: item("Gateway.yaml", "OPS"), document: document("x") }], "ops")[0].matchedFields).toEqual([
      "group",
    ]);
  });

  it("replaces literal text and reports its impact", () => {
    expect(replaceConfigContent("host=dev\nhost=dev", "host=dev", "host=sandbox")).toEqual({
      content: "host=sandbox\nhost=sandbox",
      count: 2,
    });
    expect(replacementImpact([result(item("a.properties"), document("host=dev\nhost=dev", "properties"))], "dev", "sandbox")).toEqual({
      configs: 1,
      replacements: 2,
    });
  });

  it("builds a manual batch entry with replacement snapshots and blocks invalid JSON", () => {
    const entry = buildContentReplaceApplyEntry({
      source,
      target,
      findText: "8080",
      replaceText: "",
      results: [result(item("app.json"), document('{"port":8080}', "json"))],
    });

    expect(entry).toMatchObject({
      sourceType: "manual",
      scope: "batch",
      origin: { mode: "manual", returnMode: "browse" },
      items: [
        {
          sourceRef: { connectionId: "dev", key: "__document" },
          targetRef: { connectionId: "sandbox", key: "__document" },
          sourceValueOverride: { content: '{"port":}', parseStatus: "error" },
        },
      ],
    });
  });

  it("does not create a plan entry when no selected config changes", () => {
    expect(
      buildContentReplaceApplyEntry({
        source,
        target,
        findText: "missing",
        replaceText: "sandbox",
        results: [result(item("app.yaml"), document("x"))],
      })
    ).toBeNull();
  });
});
