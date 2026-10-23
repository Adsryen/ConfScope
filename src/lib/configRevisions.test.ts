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
import {
  CONFIG_REVISION_KIND_CONFIRMED_WRITE,
  CONFIG_REVISION_KIND_OBSERVED,
  configRevisionAcceleratorSize,
  configRevisionKeyOf,
  listRevisionsForKey,
  observeLoadedDocument,
  recordConfirmedWrite,
  resetConfigRevisionAccelerator,
} from "./configRevisions";
import type { Connection } from "../store/connections";

const { appendRevision, readForKey } = vi.hoisted(() => ({ appendRevision: vi.fn(), readForKey: vi.fn() }));

vi.mock("../../wailsjs/go/app/App", () => ({
  AppendConfigRevision: appendRevision,
  ReadConfigRevisionsForKey: readForKey,
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
  appended();
  resetConfigRevisionAccelerator();
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
    observeLoadedDocument(conn({ sourceType: "local-snapshot", provider: undefined, localPath: "/tmp/snap" }), target, { content: "a: 1\n" });
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
