/**
 * 复测桥 ↔ Go 绑定的契约守卫（轮72C）。
 *
 * 立测理由：`ConfigCenterDeleteConfigFromApplyPlan` 的 arg2 在 Go 侧是 **provider.ConfigRef 本体**
 * （internal/app/app.go:130），只有发布类才是 `{ref, content, format}` 信封
 * （`provider.PublishConfigRequest`）。桥从 8bf4ccf 起把删除也按信封解包 `req.ref`，拿到 undefined
 * → normalizeRefLike 兜成空串 → 空 dataId 发给 Nacos → 服务端 400 "invalid dataId"。
 * 后果不是"测试麻烦"：产品唯一的删除写路径在真机复测里红了 26 天，还被记成
 * 「Nacos 对畸形 dataId 返 400，既定不修」——**测试替身比被测系统更像 bug 时，
 * 整条链路的取证都失真**。这两条守卫把「绑定名到底存不存在」和「arg2 到底什么形状」变成机器判定：
 *  1) 桥里出现的绑定名必须能在 Go 侧找到同名 App 方法（幻影名只会诱导出错误的参数形状）；
 *  2) 桥对写绑定的取值方式必须与 Go 签名的参数类型一致，且产品 api 层的调用形状与之一致。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadRetestState } from "./state";
import { createRetestInvoke } from "./bridge/retestBinding";

const ROOT = join(process.cwd());
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf-8");

/** Go 侧真正导出的 App 绑定名（internal/app 下非测试文件，方法接收者 *App）。 */
function goAppMethods(): Set<string> {
  const names = new Set<string>();
  const dir = join(ROOT, "internal", "app");
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".go") || file.endsWith("_test.go")) continue;
    for (const m of readFileSync(join(dir, file), "utf-8").matchAll(/^func \(\w+ \*App\) (\w+)\(/gm)) {
      names.add(m[1]);
    }
  }
  return names;
}

/** 桥自有的绑定（Go 查无此名，由桥提供内存替身）——必须显式登记，不许悄悄塞进 WAILS_METHODS。 */
const BRIDGE_ONLY_BINDINGS = ["RetestAppDataDocSnapshot", "RetestRevisionsSnapshot"];

function arrayStrings(src: string, marker: string): string[] {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`守卫自身失效：找不到 ${marker}`);
  // 数组以「行首 ]」收尾（这份是 `] as const;`）：按 "];" 找会越过终点，把后面的字符串字面量当绑定名。
  const tail = /^\]/m.exec(src.slice(start + marker.length));
  if (!tail) throw new Error(`守卫自身失效：${marker} 之后找不到数组结尾`);
  const body = src.slice(start, start + marker.length + tail.index);
  return [...body.matchAll(/"(\w+)"/g)].map((m) => m[1]);
}

interface Sent {
  url: string;
  method: string;
  body: string;
}

/** 假 fetch：记录发出去的请求，写请求一律回 Nacos v1 的成功响应 "true"。 */
function stubNacos() {
  const sent: Sent[] = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    sent.push({ url, method, body: init?.body ? String(init.body) : "" });
    return { ok: true, status: 200, text: async () => "true", json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
  return sent;
}

/** 从 Go 源码里取某绑定的第二个参数类型（守卫跟着签名走，签名变了就红着要求同步评审）。 */
function secondParamType(method: string): string {
  const go = read("internal/app/app.go");
  const m = new RegExp(`^func \\(\\w+ \\*App\\) ${method}\\(([^)]*)\\)`, "m").exec(go);
  if (!m) throw new Error(`Go 侧没有绑定 ${method}`);
  return m[1].split(",")[1].trim();
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("复测桥绑定名必须是 Go 侧真实存在的绑定", () => {
  it("WAILS_METHODS 与桥内 case 都查得到同名 App 方法", () => {
    const methods = goAppMethods();
    expect(methods.size, "解析不到 Go 方法说明守卫自身失效（接收者写法变了？）").toBeGreaterThan(50);
    const listed = arrayStrings(read("tests/retest/bridge/installRetestBridge.ts"), "const WAILS_METHODS = [");
    const handled = [...read("tests/retest/bridge/retestBinding.ts").matchAll(/case "(\w+)":/g)].map((m) => m[1]);
    expect(listed.length).toBeGreaterThan(50);
    expect(handled.length).toBeGreaterThan(50);
    const known = new Set([...methods, ...BRIDGE_ONLY_BINDINGS]);
    // 一次性列全，免得修一个红一个
    expect(listed.filter((name) => !known.has(name)), "WAILS_METHODS 里有 Go 侧不存在的绑定名").toEqual([]);
    expect(handled.filter((name) => !known.has(name)), "桥内 case 有 Go 侧不存在的绑定名").toEqual([]);
    // 幻影名的成因：产品侧 TS 函数叫 publishConfigRefFromApplyPlan / deleteConfigRefFromApplyPlan，
    // 桥照着造了同名的 Go 绑定条目——那两个 TS 函数实际调的还是普通绑定。
    for (const name of ["ConfigCenterPublishConfigRefFromApplyPlan", "ConfigCenterDeleteConfigRefFromApplyPlan"]) {
      expect(methods.has(name), `${name} 本就不是 Go 绑定，不许回到桥里`).toBe(false);
      expect(listed).not.toContain(name);
      expect(handled).not.toContain(name);
    }
  });
});

describe("写绑定的 arg2 形状按 Go 签名取值", () => {
  it("删除 = ConfigRef 本体；发布 = {ref,content,format} 信封", async () => {
    expect(secondParamType("ConfigCenterDeleteConfigFromApplyPlan")).toBe("ref provider.ConfigRef");
    expect(secondParamType("ConfigCenterPublishConfigFromApplyPlan")).toBe("req provider.PublishConfigRequest");

    const ep = loadRetestState().nacos.a;
    const profile = { id: "retest-a", baseUrl: ep.baseUrl };
    const ref = { provider: "nacos", connectionId: "retest-a", namespace: ep.namespace, group: "RETEST-PROD", dataId: "contract.yaml", key: "__document" };
    const invoke = createRetestInvoke();

    const sent = stubNacos();
    // 删除：arg2 直接是 ref 本体（与 src/api/nacos.ts 的调用形状一致）
    await invoke("ConfigCenterDeleteConfigFromApplyPlan", [profile, ref]);
    const del = sent.find((s) => s.method === "DELETE");
    expect(del, "删除没有发出 DELETE 请求").toBeTruthy();
    const q = new URL(del!.url).searchParams;
    expect(q.get("dataId")).toBe("contract.yaml");
    expect(q.get("group")).toBe("RETEST-PROD");
    expect(q.get("tenant")).toBe(ep.namespace);

    // 发布：arg2 是信封
    sent.length = 0;
    await invoke("ConfigCenterPublishConfigFromApplyPlan", [profile, { ref, content: "a: 1", format: "yaml" }]);
    const pub = sent.find((s) => s.method === "POST");
    expect(pub, "发布没有发出 POST 请求").toBeTruthy();
    const form = new URLSearchParams(pub!.body);
    expect(form.get("dataId")).toBe("contract.yaml");
    expect(form.get("content")).toBe("a: 1");
    expect(form.get("type")).toBe("yaml");
  });

  it("错误的信封形状当场响，不许静默降级成空 dataId", async () => {
    const ep = loadRetestState().nacos.a;
    const profile = { id: "retest-a", baseUrl: ep.baseUrl };
    const ref = { namespace: ep.namespace, group: "RETEST-PROD", dataId: "contract.yaml", key: "__document" };
    const invoke = createRetestInvoke();
    const sent = stubNacos();

    // 8bf4ccf 的写法：把 ConfigRef 当信封解包 → ref 是 undefined
    await expect(invoke("ConfigCenterDeleteConfigFromApplyPlan", [profile, { ref }])).rejects.toThrow(/dataId 为空/);
    expect(sent.filter((s) => s.method === "DELETE"), "空 dataId 已经发出去了").toEqual([]);
  });

  it("产品 api 层的调用形状与桥一致（改一边就红另一边）", () => {
    const api = read("src/api/nacos.ts");
    const deleteSites = [...api.matchAll(/configCenterDeleteConfigFromApplyPlan\(/g)];
    expect(deleteSites.length, "src/api/nacos.ts 不再调用删除绑定，守卫需要跟着重写").toBeGreaterThan(0);
    for (const site of deleteSites) {
      const args = topLevelArgs(api, (site.index ?? 0) + "configCenterDeleteConfigFromApplyPlan(".length);
      expect(args[1], "删除绑定的 arg2 必须是 ConfigRef 本体，不是 { ref } 信封").not.toMatch(/^\s*\{\s*ref:/);
    }
    const publishSites = [...api.matchAll(/configCenterPublishConfigFromApplyPlan\(/g)];
    expect(publishSites.length).toBeGreaterThan(0);
    for (const site of publishSites) {
      const args = topLevelArgs(api, (site.index ?? 0) + "configCenterPublishConfigFromApplyPlan(".length);
      expect(args[1]).toMatch(/ref:/);
    }
  });
});

/** 从开括号之后按顶层逗号切参数（忽略字符串/模板里的括号与逗号，够覆盖 api 层的调用写法）。 */
function topLevelArgs(src: string, from: number): string[] {
  const out: string[] = [];
  let depth = 1;
  let current = "";
  for (let i = from; i < src.length && depth > 0; i += 1) {
    const ch = src[i];
    if (ch === "(" || ch === "{" || ch === "[") depth += 1;
    if (ch === ")" || ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) break;
    }
    if (ch === "," && depth === 1) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((a) => a.trim());
}
