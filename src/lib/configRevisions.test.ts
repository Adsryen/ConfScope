/**
 * 本机配置版本历史的前端写入口（R57）。
 *
 * 这一层的三条硬规矩，每条都有对应的「不这么做会怎样」：
 * 1. fire-and-forget 且吞掉所有异常——记不上历史是日志问题，绝不能把读配置或写配置拖下水；
 * 2. md5 加速器只在服务端给了内容级摘要时才允许省 IPC——Apollo/Consul/本地快照没有 md5，
 *    若拿空串当「同一版」判据，那些 provider 的本机历史会永远攒不起来；
 * 3. 写入确认（confirmed-write）绝不走加速器——正文与刚才回读观测那一版完全相同时，
 *    Go 侧要做的是把那一版的来历就地升级（promote），跳过 IPC 等于把 planId 回链永久抹掉。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "../locales";
import {
  CONFIG_REVISION_KEEP_SOURCE_OUT_OF_RANGE,
  CONFIG_REVISION_KIND_CONFIRMED_WRITE,
  CONFIG_REVISION_KIND_OBSERVED,
  configRevisionAcceleratorSize,
  configRevisionKeyOf,
  flushPendingRevisionAppends,
  getConfigRevisionPolicy,
  isRevisionPinned,
  listRevisionsForKey,
  observeLoadedDocument,
  pendingRevisionAppendCount,
  pruneConfigRevisionsByPolicy,
  recordConfirmedWrite,
  resetConfigRevisionAccelerator,
  revisionPolicyStoreAvailable,
  saveRevisionKeepPerKey,
  toggleRevisionPinned,
} from "./configRevisions";
import type { Connection } from "../store/connections";
import type { ConfigRevisionPinnedRef, ConfigRevisionPolicyView } from "../../wailsjs/go/app/App";

const { appendRevision, readForKey, getPolicy, savePolicy, setPinned, prune } = vi.hoisted(() => ({
  appendRevision: vi.fn(),
  readForKey: vi.fn(),
  getPolicy: vi.fn(),
  savePolicy: vi.fn(),
  setPinned: vi.fn(),
  prune: vi.fn(),
}));

vi.mock("../../wailsjs/go/app/App", () => ({
  AppendConfigRevision: appendRevision,
  ReadConfigRevisionsForKey: readForKey,
  GetConfigRevisionPolicy: getPolicy,
  SaveConfigRevisionPolicy: savePolicy,
  SetConfigRevisionPinned: setPinned,
  PruneConfigRevisions: prune,
}));

const target = { namespace: "public", group: "DEFAULT_GROUP", dataId: "app.yml" };

function conn(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn-a",
    name: "Retest Nacos A",
    provider: "nacos",
    distribution: "opensource",
    authType: "nacos-password",
    baseUrl: "http://127.0.0.1:19848",
    defaultNamespace: "public",
    ...overrides,
  } as Connection;
}

/**
 * 把桌面运行时的原生命名空间搭起来。
 *
 * 存在性探测（revisionPolicyStoreAvailable / localRevisionStoreAvailable）读的是 window.go.app.App，
 * 而真正的调用走上面那份模块替身——两条路必须都能摸到，否则「不可用就整块不出现」这条
 * 降级判据在测试里根本没被走过。
 */
function stubNativeAppNamespace(bindings: Record<string, unknown>): void {
  vi.stubGlobal("go", { app: { App: bindings } });
}

function clearNativeAppNamespace(): void {
  vi.unstubAllGlobals();
}

/** 一份典型策略视图：区间、来源档与默认值都由 Go 回，前端只是转发。 */
function policyView(patch: Partial<ConfigRevisionPolicyView> = {}): ConfigRevisionPolicyView {
  return {
    path: "/tmp/confscope-retest/data/app-data/config-revisions-policy.json",
    keepPerKey: 50,
    keepSource: "policy",
    minKeepPerKey: 10,
    maxKeepPerKey: 1000,
    defaultKeepPerKey: 50,
    pinned: [],
    pinnedCount: 0,
    unpinnedOverQuota: 0,
    ...patch,
  };
}

/** fire-and-forget 之后等微任务跑完：加速器只在 IPC 成功返回后才记住 md5。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function appended(reason = "") {
  appendRevision.mockResolvedValue({ appended: reason !== "duplicate" && reason !== "promoted", reason, record: {} });
}

beforeEach(() => {
  appendRevision.mockReset();
  readForKey.mockReset();
  getPolicy.mockReset();
  savePolicy.mockReset();
  setPinned.mockReset();
  prune.mockReset();
  appended();
  resetConfigRevisionAccelerator();
  clearNativeAppNamespace();
});

describe("读到正文就记一版（observed）", () => {
  it("字段按 Go 侧 Input 的口径交出去，前端不猜版本号", async () => {
    observeLoadedDocument(conn(), target, { content: "server.port: 8080\n", format: "yaml", md5: "aaa" });
    await flush();
    expect(appendRevision).toHaveBeenCalledTimes(1);
    expect(appendRevision.mock.calls[0][0]).toEqual({
      kind: CONFIG_REVISION_KIND_OBSERVED,
      connectionId: "conn-a",
      connectionName: "Retest Nacos A",
      provider: "nacos",
      namespace: "public",
      group: "DEFAULT_GROUP",
      dataId: "app.yml",
      content: "server.port: 8080\n",
      format: "yaml",
      serverMd5: "aaa",
      planId: "",
      appVersion: "",
    });
  });

  it("本地快照连接记成 local，不写 nacos", async () => {
    observeLoadedDocument(conn({ sourceType: "local-snapshot", provider: undefined, localPath: "/tmp/snap" }), target, {
      content: "a: 1\n",
    });
    await flush();
    expect(appendRevision.mock.calls[0][0].provider).toBe("local");
    expect(appendRevision.mock.calls[0][0].serverMd5).toBe("");
  });

  it("服务端 md5 没变就不再发第二次 IPC（批量刷新不放大写入）", async () => {
    observeLoadedDocument(conn(), target, { content: "a: 1\n", md5: "same" });
    await flush();
    observeLoadedDocument(conn(), target, { content: "a: 1\n", md5: "same" });
    await flush();
    expect(appendRevision).toHaveBeenCalledTimes(1);
  });

  it("md5 变了要发；换个连接读同一份正文也要发", async () => {
    observeLoadedDocument(conn(), target, { content: "a: 1\n", md5: "v1" });
    await flush();
    observeLoadedDocument(conn(), target, { content: "a: 2\n", md5: "v2" });
    await flush();
    expect(appendRevision).toHaveBeenCalledTimes(2);
    observeLoadedDocument(conn({ id: "conn-b", name: "另一个" }), target, { content: "a: 2\n", md5: "v2" });
    await flush();
    expect(appendRevision).toHaveBeenCalledTimes(3);
  });

  it("没有服务端 md5 时每次都发 IPC：绝不为省一次调用漏版本", async () => {
    for (let i = 0; i < 3; i += 1) {
      observeLoadedDocument(conn({ provider: "apollo" }), target, { content: "a: 1\n" });
      await flush();
    }
    expect(appendRevision).toHaveBeenCalledTimes(3);
    expect(configRevisionAcceleratorSize()).toBe(0);
  });

  it("空正文也是一版（有人真把配置清空了），只有缺归属或缺字段才不发", async () => {
    observeLoadedDocument(conn(), target, { content: "" });
    await flush();
    expect(appendRevision).toHaveBeenCalledTimes(1);
    observeLoadedDocument(conn({ id: "  " }), target, { content: "x\n" });
    observeLoadedDocument(conn(), { ...target, dataId: "  " }, { content: "x\n" });
    observeLoadedDocument(conn(), target, { content: undefined as unknown as string });
    await flush();
    expect(appendRevision).toHaveBeenCalledTimes(1);
  });

  it("分组键与 Go 侧同口径：四段用 NUL 相连", () => {
    expect(configRevisionKeyOf("c", target)).toBe(["c", "public", "DEFAULT_GROUP", "app.yml"].join(String.fromCharCode(0)));
  });
});

describe("写后回读确认（confirmed-write）", () => {
  it("挂上 planId，且不许被 md5 加速器吞掉（Go 要靠它 promote 来历）", async () => {
    observeLoadedDocument(conn(), target, { content: "a: 1\n", md5: "same" });
    await flush();
    expect(appendRevision).toHaveBeenCalledTimes(1);
    recordConfirmedWrite(conn(), target, { content: "a: 1\n", md5: "same" }, "plan_mvkso08c_3t6xmv");
    await flush();
    expect(appendRevision).toHaveBeenCalledTimes(2);
    const input = appendRevision.mock.calls[1][0];
    expect(input.kind).toBe(CONFIG_REVISION_KIND_CONFIRMED_WRITE);
    expect(input.planId).toBe("plan_mvkso08c_3t6xmv");
  });

  it("写入确认记下 md5：同一版再被读到不必重发", async () => {
    recordConfirmedWrite(conn(), target, { content: "a: 1\n", md5: "same" }, "plan-1");
    await flush();
    observeLoadedDocument(conn(), target, { content: "a: 1\n", md5: "same" });
    await flush();
    expect(appendRevision).toHaveBeenCalledTimes(1);
  });
});

describe("记不上历史绝不能影响功能", () => {
  it("绑定 reject：调用方拿不到异常，且不许记住 md5（留重试机会）", async () => {
    appendRevision.mockRejectedValueOnce(new Error("binding down"));
    expect(() => observeLoadedDocument(conn(), target, { content: "a: 1\n", md5: "v1" })).not.toThrow();
    await flush();
    observeLoadedDocument(conn(), target, { content: "a: 1\n", md5: "v1" });
    await flush();
    expect(appendRevision).toHaveBeenCalledTimes(2);
  });

  it("绑定同步抛（纯浏览器 / web 模式下根本没有 window.go）：静默降级", async () => {
    appendRevision.mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'AppendConfigRevision')");
    });
    expect(() => observeLoadedDocument(conn(), target, { content: "a: 1\n", md5: "v1" })).not.toThrow();
    expect(() => recordConfirmedWrite(conn(), target, { content: "a: 1\n" }, "plan-1")).not.toThrow();
    await flush();
  });

  it("清除本机版本历史后同一份正文必须能重新攒进历史", async () => {
    observeLoadedDocument(conn(), target, { content: "a: 1\n", md5: "v1" });
    await flush();
    resetConfigRevisionAccelerator();
    observeLoadedDocument(conn(), target, { content: "a: 1\n", md5: "v1" });
    await flush();
    expect(appendRevision).toHaveBeenCalledTimes(2);
  });
});

describe("读历史", () => {
  it("参数按归属四段透传，Go 返 null 收成空数组", async () => {
    readForKey.mockResolvedValue(null);
    await expect(listRevisionsForKey(conn(), target, 20)).resolves.toEqual([]);
    expect(readForKey).toHaveBeenCalledWith("conn-a", "public", "DEFAULT_GROUP", "app.yml", 20);
  });

  it("读失败如实抛出：把失败说成「没有历史」是假话", async () => {
    readForKey.mockRejectedValue(new Error("disk boom"));
    await expect(listRevisionsForKey(conn(), target)).rejects.toThrow("disk boom");
  });
});

describe("保留策略与钉住的读出口（轮99）", () => {
  it("绑定不齐就当不可用：设置页与面板据此整块不出现，而不是摆了键再报错", () => {
    expect(revisionPolicyStoreAvailable()).toBe(false);
    stubNativeAppNamespace({ GetConfigRevisionPolicy: getPolicy });
    expect(revisionPolicyStoreAvailable()).toBe(false);
    stubNativeAppNamespace({ GetConfigRevisionPolicy: getPolicy, SetConfigRevisionPinned: setPinned });
    expect(revisionPolicyStoreAvailable()).toBe(true);
  });

  it("策略读回来是空就当没读出来：绝不拿默认值冒充磁盘事实", async () => {
    getPolicy.mockResolvedValue(null);
    await expect(getConfigRevisionPolicy()).rejects.toThrow(translate("configRevisions.policyUnreadable"));
    getPolicy.mockResolvedValue(policyView());
    await expect(getConfigRevisionPolicy()).resolves.toMatchObject({ keepPerKey: 50 });
  });

  it("保存后回的是磁盘那份事实，越界档位原样带上去（钳没钳由 Go 说）", async () => {
    savePolicy.mockResolvedValue(policyView({ keepPerKey: 50, keepSource: CONFIG_REVISION_KEEP_SOURCE_OUT_OF_RANGE }));
    const view = await saveRevisionKeepPerKey(999999);
    expect(savePolicy).toHaveBeenCalledWith(999999);
    expect(view.keepSource).toBe(CONFIG_REVISION_KEEP_SOURCE_OUT_OF_RANGE);
    savePolicy.mockResolvedValue(null);
    await expect(saveRevisionKeepPerKey(80)).rejects.toThrow(translate("configRevisions.policyUnreadableAfterSave"));
  });

  it("清理不带走任何参数：配额只有一个钳制点，多一个入参就多一条绕过策略删数据的路", async () => {
    prune.mockResolvedValue(7);
    await expect(pruneConfigRevisionsByPolicy()).resolves.toBe(7);
    // 「不收参数」要真的能钉住：一旦有人给 Prune 加了入参，这里的第一桶调用就会多出一项
    expect(prune.mock.calls[0]).toEqual([]);
  });

  it("钉住请求按四元组 + 摘要发出，空格钳掉，缺一段就不发（宁可不动也不钉错版本）", async () => {
    stubNativeAppNamespace({ GetConfigRevisionPolicy: getPolicy, SetConfigRevisionPinned: setPinned });
    setPinned.mockResolvedValue({ pinned: true, hits: 1, pinnedCount: 1 });
    await toggleRevisionPinned(conn({ id: "  conn-a  " }), { ...target, dataId: " app.yml " }, " sha256:x ", true);
    expect(setPinned).toHaveBeenCalledWith("conn-a", "public", "DEFAULT_GROUP", "app.yml", "sha256:x", true);

    await expect(toggleRevisionPinned(conn(), target, "", true)).rejects.toThrow(translate("configRevisions.pinIdentityMissing"));
    expect(setPinned).toHaveBeenCalledTimes(1);
    await expect(toggleRevisionPinned(conn({ id: "   " }), target, "sha256:x", false)).rejects.toThrow(
      translate("configRevisions.pinIdentityMissing")
    );
    expect(setPinned).toHaveBeenCalledTimes(1);
  });

  it("钉住与否只按 Go 回的清单判：pinned 为 null（旧二进制）就当没钉住，不炸", () => {
    const pinnedView = policyView({
      pinned: [{ connectionId: "conn-a", namespace: "public", group: "DEFAULT_GROUP", dataId: "app.yml", hash: "sha256:x" }],
      pinnedCount: 1,
    });
    expect(isRevisionPinned(pinnedView, " conn-a ", target, "sha256:x")).toBe(true);
    expect(isRevisionPinned(pinnedView, "conn-a", { ...target, dataId: "other.yml" }, "sha256:x")).toBe(false);
    expect(isRevisionPinned(pinnedView, "conn-a", target, "sha256:y")).toBe(false);
    // 旧 Go 二进制没有钉住清单时回 null：这一版前端必须当「没钉住」而不是崩掉（轮94 那一族的教训）
    const legacy = policyView({ pinnedCount: 0 });
    legacy.pinned = null as unknown as ConfigRevisionPinnedRef[];
    expect(isRevisionPinned(legacy, "conn-a", target, "sha256:x")).toBe(false);
  });
});

describe("在途追加的落地等待（设置页体量与清除前的那道闸）", () => {
  /** 让微任务与定时器都跑一轮。 */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("追加还在途时 flush 不返回，落地后待决归零", async () => {
    let resolveAppend: (value: unknown) => void = () => undefined;
    appendRevision.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAppend = resolve;
        })
    );

    observeLoadedDocument(conn(), target, { content: "server.port: 8080\n", format: "yaml", md5: "in-flight" });
    expect(pendingRevisionAppendCount()).toBe(1);

    let done = false;
    const waiting = flushPendingRevisionAppends().then(() => {
      done = true;
    });
    await settle();
    expect(done, "追加还在途，flush 就返回了——设置页据此读到的还是中途快照").toBe(false);

    resolveAppend({ appended: true, reason: "appended", record: {} });
    await waiting;
    expect(done).toBe(true);
    expect(pendingRevisionAppendCount()).toBe(0);
  });

  it("绑定 reject 也算落地：失败的一版不许把 flush 永远挂住", async () => {
    appendRevision.mockImplementationOnce(() => Promise.reject(new Error("disk full")));

    observeLoadedDocument(conn(), target, { content: "a\n", format: "yaml", md5: "bad" });
    expect(pendingRevisionAppendCount()).toBe(1);
    await flushPendingRevisionAppends();
    expect(pendingRevisionAppendCount(), "失败没从待决里摘掉，之后每次读体量都要白等").toBe(0);
  });

  it("没有在途追加时 flush 立刻返回，且不碰绑定", async () => {
    appendRevision.mockClear();
    await flushPendingRevisionAppends();
    expect(pendingRevisionAppendCount()).toBe(0);
    expect(appendRevision).not.toHaveBeenCalled();
  });

  it("md5 没变被加速器吃掉的那次不待在途集合里", async () => {
    observeLoadedDocument(conn(), target, { content: "a\n", format: "yaml", md5: "same" });
    await settle();
    expect(pendingRevisionAppendCount()).toBe(0);

    observeLoadedDocument(conn(), target, { content: "a\n", format: "yaml", md5: "same" });
    expect(pendingRevisionAppendCount(), "被加速器跳过的那次也该占一个待决位").toBe(0);
    await flushPendingRevisionAppends();
  });
});
