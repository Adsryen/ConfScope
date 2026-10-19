/**
 * 真机批残留清扫的判据行为（轮44 AC8）。
 *
 * DK-04 在真机上只能证明「这批跑完是干净的」，证明不了判据本身：
 * 判据放宽到 group、或把失败变成 throw，都要等下一次假红才看得见。这里用假 fetch
 * 把三组合的返回摊开，直接数发出去的 DELETE——这是唯一能钉住「只删 retest- 前缀的 dataId」
 * 「RETEST-* 组名不碰」「失败只记 console」三条的手法。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STRAY_DATAID_PREFIX, sweepRetestStrays, sweepTargets } from "./strays";

interface Fetched {
  url: string;
  method: string;
}

const calls: Fetched[] = [];

/** 每个 namespace 里混着播种数据、组名相似的数据、以及上一批留下的尸体。 */
const ITEMS = [
  { dataId: "svc-gateway.yaml", group: "DEFAULT_GROUP" },
  { dataId: "svc-billing.yaml", group: "RETEST-PROD" },
  { dataId: "svc-order.properties", group: "RETEST-ORDER" },
  // 组名带 RETEST- 但 dataId 是播种的：判据误读成 group 就会被删
  { dataId: "MSG.properties", group: "RETEST-MESSENGE" },
  { dataId: "retest-v44-pollution.properties", group: "RETEST-PROD" },
  { dataId: "RETEST-UPPER.properties", group: "RETEST-PROD" },
  { dataId: "retest-e4-marker.yaml", group: "DEFAULT_GROUP" },
];

function stubFetch(opts: { deleteStatus?: number; listFails?: boolean } = {}) {
  globalThis.fetch = vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method });
    if (method === "DELETE") {
      const ok = (opts.deleteStatus ?? 200) === 200;
      return { ok, status: opts.deleteStatus ?? 200, text: async () => (ok ? "true" : "forbidden") } as Response;
    }
    if (opts.listFails) return { ok: false, status: 500, json: async () => ({}) } as Response;
    return {
      ok: true,
      status: 200,
      json: async () => ({ pageItems: ITEMS, totalCount: ITEMS.length }),
    } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  calls.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sweepRetestStrays", () => {
  it("三个落点各列一次，DELETE 只打在 retest- 前缀的 dataId 上", async () => {
    stubFetch();
    const res = await sweepRetestStrays("unit");
    const targets = sweepTargets();
    expect(targets.map((t) => t.label)).toEqual(["A/dev", "A/qa", "B/qa"]);

    const deletes = calls.filter((c) => c.method === "DELETE");
    // 夹具里 3 条残留（含一条大写开头）× 3 个落点
    expect(deletes.length).toBe(targets.length * 3);
    for (const del of deletes) {
      const dataId = new URL(del.url).searchParams.get("dataId") ?? "";
      expect(dataId.toLowerCase().startsWith(STRAY_DATAID_PREFIX), `误删了 ${dataId}`).toBe(true);
    }
    // 大小写不敏感：RETEST-UPPER.properties 也是 dataId 以 retest- 起头 → 算残留
    expect(res.removed).toHaveLength(targets.length * 3);
    expect(res.removed.filter((r) => r.includes("RETEST-UPPER.properties")).length).toBe(targets.length);
    expect(res.failed).toEqual([]);
  });

  it("播种的 svc-* 与组名 RETEST-* 永不被删", async () => {
    stubFetch();
    await sweepRetestStrays("unit");
    const deleted = calls.filter((c) => c.method === "DELETE").map((c) => new URL(c.url).searchParams.get("dataId"));
    for (const keep of ["svc-gateway.yaml", "svc-billing.yaml", "svc-order.properties", "MSG.properties"]) {
      expect(deleted, `清扫把播种数据 ${keep} 删了`).not.toContain(keep);
    }
  });

  it("DELETE 返回 false / 列表失败都只记账，绝不 throw（它是兜底不是断言）", async () => {
    stubFetch({ deleteStatus: 500 });
    await expect(sweepRetestStrays("unit")).resolves.toMatchObject({ removed: [], failed: expect.arrayContaining([expect.any(String)]) });
    const failed = (await sweepRetestStrays("unit")).failed;
    expect(failed.length).toBeGreaterThan(0);

    stubFetch({ listFails: true });
    const res = await sweepRetestStrays("unit");
    expect(res.removed).toEqual([]);
    expect(res.failed.join(" ")).toContain("list");
  });
});
