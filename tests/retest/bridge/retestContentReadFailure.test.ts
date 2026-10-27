/**
 * 正文读取失败注入的契约守卫（轮97 K2）。
 *
 * 立测理由：这条注入是 K3 真机用例唯一的「读取真的试过 / 真的没试过」证据来源，
 * 注入本身一旦写歪，用例就会朝着错的方向自证清白。四种错法必须当场判红：
 *  1) 注入恒真（没命中也抛）——K3 的「撤掉注入后重试成功」就成了假的；
 *  2) 注入把列表请求一起吃掉（正文与列表都打 /cs/configs，只差 pageNo）——浏览页
 *     连列表都进不来，整条链路的读数都失真；
 *  3) 抛了错却不记账——K3 里「过期重试没再发一次正文读取」就退化成「注入没生效」，
 *     读数是空的而不是零，两者在断言信息里长得一模一样；
 *  4) 先发出真实读取再抛错——服务端侧的 stamp / Last-Modified 会被这次多余的请求推动，
 *     后续用例的时间读数失真。
 * 调用形状按真实的来（arg1 = 扁平 ConfigRef，arg0 = ConnectionProfile），
 * 与 tests/retest/bridgeContract.test.ts 同源。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRetestState } from "../state";
import {
  createRetestInvoke,
  retestContentReadFailureHitsSnapshot,
  resetRetestContentReadFailures,
  setRetestContentReadFailures,
} from "./retestBinding";

const state = loadRetestState();
const BASE_A = state.nacos.a.baseUrl;
const NS_A = state.nacos.a.namespace;
const GROUP = "RETEST-PROD";
const BLOCKED = "svc-billing.yaml";
const OTHER = "svc-search.yaml";

/** 记录 fetch 调用（mock.calls 里的 url），用于「注入命中时不该再有正文读取」那条判据。 */
function urlsCalled(): string[] {
  const mock = (globalThis.fetch as unknown as { mock?: { calls: unknown[][] } })?.mock;
  return (mock?.calls ?? []).map((call) => String(call[0]));
}

/**
 * 假 Nacos：正文读取回原文，列表回一页数据。
 *
 * 刻意按「有没有 pageNo」区分两类请求——桥里列表走 ConfigCenterListConfigs，URL 同样指向
 * /cs/configs，注入若下在 HTTP 层，这里就会看出被注入那条 dataId 的列表请求也一起挂了。
 */
function stubNacos() {
  globalThis.fetch = vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const q = new URL(url).searchParams;
    if (q.get("pageNo")) {
      const payload = {
        totalCount: 2,
        pageNumber: 1,
        pagesAvailable: 1,
        pageItems: [
          { dataId: BLOCKED, group: GROUP, content: "blocked: 1\n", type: "yaml", lastModifiedTime: 1700000000000 },
          { dataId: OTHER, group: GROUP, content: "other: 1\n", type: "yaml", lastModifiedTime: 1700000000000 },
        ],
      };
      return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload } as unknown as Response;
    }
    const content = q.get("dataId") === BLOCKED ? "blocked: 1\n" : "other: 1\n";
    return {
      ok: true,
      status: 200,
      headers: { get: () => "" },
      text: async () => content,
      json: async () => ({}),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const profile = { id: "retest-a", baseUrl: BASE_A };
const refFor = (dataId: string) => ({ provider: "nacos", connectionId: "retest-a", namespace: NS_A, group: GROUP, dataId, key: "" });

beforeEach(() => {
  resetRetestContentReadFailures();
  stubNacos();
});

afterEach(() => {
  resetRetestContentReadFailures();
  vi.restoreAllMocks();
});

describe("正文读取失败注入只咬命中的那一份正文", () => {
  it("命中：抛错、记账，错误照旧从绑定冒出来", async () => {
    setRetestContentReadFailures([{ dataId: BLOCKED, group: GROUP, namespace: NS_A }]);
    const invoke = createRetestInvoke();

    await expect(invoke("ConfigCenterGetConfig", [profile, refFor(BLOCKED)])).rejects.toThrow(/content denied for svc-billing\.yaml/);

    const hits = retestContentReadFailureHitsSnapshot();
    expect(hits, "抛了错却没记账，K3 的「没再发读取」分不清是零还是空").toEqual([
      { namespace: NS_A, group: GROUP, dataId: BLOCKED, message: expect.stringContaining("content denied") },
    ]);
  });

  it("可重复：同一条正文连着读两次都拒、记两笔（服务端持续不可读的等价物）", async () => {
    setRetestContentReadFailures([{ dataId: BLOCKED, group: GROUP, namespace: NS_A }]);
    const invoke = createRetestInvoke();

    await expect(invoke("ConfigCenterGetConfig", [profile, refFor(BLOCKED)])).rejects.toThrow(/content denied/);
    await expect(invoke("ConfigCenterGetConfig", [profile, refFor(BLOCKED)])).rejects.toThrow(/content denied/);
    expect(retestContentReadFailureHitsSnapshot()).toHaveLength(2);
  });

  it("未命中的 dataId 正常返回：注入不许是恒真的", async () => {
    setRetestContentReadFailures([{ dataId: BLOCKED, group: GROUP, namespace: NS_A }]);
    const invoke = createRetestInvoke();

    const doc = (await invoke("ConfigCenterGetConfig", [profile, refFor(OTHER)])) as { content: string; source: string };
    expect(doc.content).toBe("other: 1\n");
    expect(doc.source).toBe("nacos");
    expect(retestContentReadFailureHitsSnapshot(), "没命中的读取也被记了账").toEqual([]);
  });

  it("namespace/group 留空当通配，dataId 必须精确", async () => {
    setRetestContentReadFailures([{ dataId: BLOCKED }]);
    const invoke = createRetestInvoke();

    await expect(invoke("ConfigCenterGetConfig", [profile, refFor(BLOCKED)])).rejects.toThrow(/content denied/);
    await expect(invoke("ConfigCenterGetConfig", [profile, { ...refFor(BLOCKED), namespace: "other-ns" }])).rejects.toThrow(
      /content denied/
    );
    await expect(invoke("ConfigCenterGetConfig", [profile, refFor(OTHER)])).resolves.toBeTruthy();
  });

  it("列表请求不受影响：注入只咬正文，不吃 pageNo 那条路", async () => {
    setRetestContentReadFailures([{ dataId: BLOCKED, group: GROUP, namespace: NS_A }]);
    const invoke = createRetestInvoke();

    const page = (await invoke("ConfigCenterListConfigs", [profile, { namespace: NS_A, group: "", dataId: "", pageNo: 1, pageSize: 20 }])) as {
      totalCount: number;
      pageItems: Array<{ ref: { dataId: string } }>;
    };

    expect(page.totalCount, "列表被注入吃掉：浏览页根本进不到编辑那一步").toBe(2);
    expect(page.pageItems.map((item) => item.ref.dataId)).toEqual([BLOCKED, OTHER]);
    expect(retestContentReadFailureHitsSnapshot(), "列表不该记账").toEqual([]);
  });

  it("撤掉注入后同一份正文立刻可读，且记账清零（K3 的恢复用例靠这一步）", async () => {
    setRetestContentReadFailures([{ dataId: BLOCKED, group: GROUP, namespace: NS_A }]);
    const invoke = createRetestInvoke();
    await expect(invoke("ConfigCenterGetConfig", [profile, refFor(BLOCKED)])).rejects.toThrow(/content denied/);

    resetRetestContentReadFailures();
    const doc = (await invoke("ConfigCenterGetConfig", [profile, refFor(BLOCKED)])) as { content: string };
    expect(doc.content).toBe("blocked: 1\n");
    expect(retestContentReadFailureHitsSnapshot()).toEqual([]);
  });

  it("抛错发生在网络调用之前：命中时一条正文 GET 都不该发出去", async () => {
    setRetestContentReadFailures([{ dataId: BLOCKED, group: GROUP, namespace: NS_A }]);
    const invoke = createRetestInvoke();

    await expect(invoke("ConfigCenterGetConfig", [profile, refFor(BLOCKED)])).rejects.toThrow(/content denied/);
    const contentGets = urlsCalled().filter((u) => u.includes("/cs/configs") && !new URL(u).searchParams.get("pageNo"));
    expect(contentGets, "注入先发了真实读取才抛错：服务端时间读数会被这次多余的请求推动").toHaveLength(0);
  });
});
