/**
 * 历史能力的入口与请求必须说实话（轮55 R55-E1/E2/E3，真机取证驱动）。
 *
 * 事实源：.trellis/tasks/10-21-ui-ux-55-apply-safety-history/research/nacos-history-probe-2026-10-21.md
 *   - Nacos 2.5.2 实测：版本级历史（列表+详情）真可用；服务端 opType 是定长 CHAR（"U         "）；
 *     命名空间级「中心历史」v1 恒 0 行且不报错（静默假空）。
 *   - Apollo/Consul 的 ListHistory 在 Go 侧返回「当前为只读模式」——点进 tab 只能看到与历史无关的报错。
 *
 * 守卫拆成两半：
 *   1. 能力表本身用动态单测钉死（口径错，全链路一起错）；
 *   2. 三个接线点（ConfigBrowser tab 闸门 / OperationHistoryView 请求闸门 / opType 前端兜底）
 *      用静态指针钉住，并各自带变异负控——把实现改回旧写法，对应守卫必须变红。
 */
import { describe, expect, it } from "vitest";
import { loadLocale, readScannedSource } from "./scanUtils";
import {
  effectiveProvider,
  supportsCenterHistory,
  supportsConfigHistory,
} from "../../src/lib/configCapabilities";
import type { Connection } from "../../src/store/connections";

const conn = (patch: Partial<Connection>): Connection =>
  ({
    id: "c1",
    name: "test",
    baseUrl: "http://127.0.0.1:8848/nacos",
    username: "",
    password: "",
    defaultNamespace: "",
    ...patch,
  }) as Connection;

describe("历史能力表（单一事实源）", () => {
  it("Nacos 与 aliyun-mse（走 Nacos 兼容协议）支持版本级历史", () => {
    expect(supportsConfigHistory(conn({ provider: "nacos" }))).toBe(true);
    expect(supportsConfigHistory(conn({ distribution: "aliyun-mse" }))).toBe(true);
    // 旧数据没有 provider 字段时默认 nacos，与 api 层口径一致
    expect(effectiveProvider(conn({}))).toBe("nacos");
  });

  it("Apollo/Consul/本地快照不出现版本级历史能力", () => {
    expect(supportsConfigHistory(conn({ provider: "apollo" }))).toBe(false);
    expect(supportsConfigHistory(conn({ provider: "consul" }))).toBe(false);
    expect(supportsConfigHistory(conn({ provider: "nacos", sourceType: "local-snapshot" }))).toBe(false);
  });

  it("中心历史当前对所有 provider 关闭（取证：v1 恒 0 行、blur 500）", () => {
    for (const c of [
      conn({ provider: "nacos" }),
      conn({ provider: "apollo" }),
      conn({ provider: "consul" }),
      conn({ sourceType: "local-snapshot" }),
    ]) {
      expect(supportsCenterHistory(c)).toBe(false);
    }
  });
});

describe("接线点（静态指针 + 变异负控）", () => {
  const BROWSER = readScannedSource("src/components/ConfigBrowser.tsx");
  const OP_HISTORY = readScannedSource("src/components/OperationHistoryView.tsx");
  const API = readScannedSource("src/api/nacos.ts");

  /** ConfigBrowser：tab 按钮与正文面板都必须走 canBrowseHistory，不许退回 !isLocalSnapshot。 */
  function browserViolations(src: string): string[] {
    const out: string[] = [];
    if (!/const canBrowseHistory = supportsConfigHistory\(conn\);/.test(src)) {
      out.push("canBrowseHistory 必须由 supportsConfigHistory(conn) 判定");
    }
    if (!src.includes("canBrowseHistory && (")) {
      out.push("「历史变更」tab 按钮必须挂在 canBrowseHistory 闸门之后");
    }
    if (/!isLocalSnapshot\s*&&\s*\(\s*<button/.test(src)) {
      out.push("tab 闸门不许退回 !isLocalSnapshot（Apollo/Consul 会被放进只报错的入口）");
    }
    if (!src.includes('tab === "content" || !canBrowseHistory')) {
      out.push("正文面板要防「连接被改成 Apollo 后 tab 停在 history」的越权渲染");
    }
    return out;
  }

  /** OperationHistoryView：不支持中心历史的连接不发请求；逐 ns 的 catch 不许吞掉失败。 */
  function opHistoryViolations(src: string): string[] {
    const out: string[] = [];
    const gate = src.indexOf("if (!supportsCenterHistory(conn)) return;");
    const call = src.indexOf("listHistory(");
    if (gate < 0) out.push("fetchCenterHistory 必须按 supportsCenterHistory 收口");
    else if (call >= 0 && gate > call) out.push("能力闸门必须挡在 listHistory 请求之前");
    if (!src.includes('t("history.centerHistoryUnsupported")')) {
      out.push("不支持中心历史时必须给出说明文案，不能静默假空");
    }
    if (/catch\s*\{\s*\}/.test(src) || /catch \{\n\s*\/\//.test(src.replace(/\/\/[^\n]*/g, ""))) {
      out.push("逐命名空间的 catch 不再允许匿名吞错");
    }
    return out;
  }

  /** 服务端脏 opType（定长 CHAR "U         "）在前端映射层兜 trim（Go 解析层已钉真机样本用例）。 */
  function apiViolations(src: string): string[] {
    const out: string[] = [];
    if (!src.includes('opType: String(r.opType ?? "").trim()')) {
      out.push("历史列表映射必须 trim opType，否则徽标退回裸字母");
    }
    if (!src.includes('opType: String(detail.opType ?? "").trim()')) {
      out.push("历史详情映射必须 trim opType");
    }
    if (!src.includes("return effectiveProvider(conn);")) {
      out.push("providerForConnection 必须委托 configCapabilities 单一事实源");
    }
    return out;
  }

  it("三个接线点的守卫对当前实现全绿", () => {
    expect(browserViolations(BROWSER)).toEqual([]);
    expect(opHistoryViolations(OP_HISTORY)).toEqual([]);
    expect(apiViolations(API)).toEqual([]);
  });

  it("负控：退回旧写法时守卫必须变红", () => {
    expect(browserViolations(BROWSER.replace("canBrowseHistory && (", "!isLocalSnapshot && ("))).not.toEqual([]);
    expect(browserViolations(BROWSER.replace("const canBrowseHistory = supportsConfigHistory(conn);", "const canBrowseHistory = !isLocalSnapshot;"))).not.toEqual([]);
    expect(opHistoryViolations(OP_HISTORY.replace("if (!supportsCenterHistory(conn)) return;", ""))).not.toEqual([]);
    expect(opHistoryViolations(OP_HISTORY.replace('t("history.centerHistoryUnsupported")', 't("history.empty")'))).not.toEqual([]);
    expect(apiViolations(API.replace('opType: String(r.opType ?? "").trim()', 'opType: String(r.opType ?? "")'))).not.toEqual([]);
  });
});

describe("HistoryView 把版本自身的信息讲出来（R55-E1/E4）", () => {
  const HISTORY = readScannedSource("src/components/HistoryView.tsx");

  it("徽标映射仍按清洗后的单字符严格比较，且 class 跟着 opType 走", () => {
    expect(HISTORY).toMatch(/if \(opType === "U"\) return t\("history\.opUpdated"\);/);
    expect(HISTORY).toMatch(/op-\$\{h\.opType \|\| "x"\}/);
  });

  it("历史正文按该版本自己的格式渲染，而不是当前配置的格式", () => {
    expect(HISTORY).toContain("versionFormat");
    expect(HISTORY).toMatch(/format=\{versionFormat\(rightNid \?\? leftNid\)\}/);
    expect(HISTORY).toMatch(/format=\{versionFormat\(dv\)\}/);
    // 旧写法：正文/差异直接吃当前配置的 format prop——回退即判红
    expect(HISTORY).not.toMatch(/format=\{format\}/);
    // 回退链要留：extInfo 没给格式时退回当前配置格式（detectFormat 兜底）
    expect(HISTORY).toMatch(/if \(!version\?\.format\) return format;/);
  });

  it("发布来源（srcUser 优先、srcIp 兜底）出现在列表行与详情头", () => {
    expect(HISTORY).toMatch(/\(h\.srcUser \|\| h\.srcIp\) && \(/);
    expect(HISTORY).toMatch(/h\.srcUser \|\| h\.srcIp/);
    expect(HISTORY).toMatch(/publisherOf\(viewing\)/);
    expect(HISTORY).toContain('title={t("history.publisher")}');
  });
});

describe("文案（R55-E3/E4）在双语 locale 都已备", () => {
  it.each(["zh-CN", "en-US"])("%s 含发布来源与中心历史说明", (file) => {
    const locale = loadLocale(`${file}.json`);
    expect(locale["history.publisher"]).toBeTruthy();
    expect(locale["history.centerHistoryUnsupported"]).toBeTruthy();
  });
});
