/**
 * @vitest-environment node
 *
 * 真机批互斥锁的判据。r129 的红灯是两批同时打同一对 nacos 踩出来的，
 * 这道闸门本身就是发布链路的一部分——它自己没被测试过，就等于没有。
 */
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tempRoots: string[] = [];
let lockRoot = "";
let savedRoot: string | undefined;
let savedPrefix: string | undefined;
let savedDisable: string | undefined;
let savedLabel: string | undefined;

async function loadBatchLock(): Promise<typeof import("./batchLock")> {
  vi.resetModules();
  return import("./batchLock");
}

function writeForeignHolder(dir: string, holder: Record<string, unknown>): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true }); // 占住目录，模拟上一批留下的锁
  writeFileSync(join(dir, "holder.json"), `${JSON.stringify(holder, null, 2)}\n`, "utf8");
}

beforeEach(async () => {
  lockRoot = mkdtempSync(join(tmpdir(), "confscope-retest-lock-"));
  tempRoots.push(lockRoot);
  savedRoot = process.env.CONFSCOPE_RETEST_LOCK_ROOT;
  savedPrefix = process.env.CONFSCOPE_RETEST_LOCK_PREFIX;
  savedDisable = process.env.CONFSCOPE_RETEST_LOCK_DISABLE;
  savedLabel = process.env.CONFSCOPE_RETEST_BATCH_LABEL;
  process.env.CONFSCOPE_RETEST_LOCK_ROOT = lockRoot;
  process.env.CONFSCOPE_RETEST_LOCK_PREFIX = "unit-lock";
  delete process.env.CONFSCOPE_RETEST_LOCK_DISABLE;
  process.env.CONFSCOPE_RETEST_BATCH_LABEL = "unit";
  await loadBatchLock();
});

afterEach(() => {
  const restore = (name: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore("CONFSCOPE_RETEST_LOCK_ROOT", savedRoot);
  restore("CONFSCOPE_RETEST_LOCK_PREFIX", savedPrefix);
  restore("CONFSCOPE_RETEST_LOCK_DISABLE", savedDisable);
  restore("CONFSCOPE_RETEST_BATCH_LABEL", savedLabel);
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("真机批互斥锁", () => {
  it("抢锁写入 holder 并记下本进程 pid 与批次标签", async () => {
    const mod = await loadBatchLock();
    const handle = mod.acquireRetestBatchLock();
    expect(handle).not.toBeNull();
    expect(existsSync(handle!.dir)).toBe(true);
    const holder = JSON.parse(readFileSync(join(handle!.dir, "holder.json"), "utf8"));
    expect(holder.pid).toBe(process.pid);
    expect(holder.label).toBe("unit");
    expect(holder.startedEpoch).toBeGreaterThan(0);
    expect(mod.currentRetestBatchLock()?.key).toBe(handle!.key);

    expect(mod.releaseRetestBatchLock()).toBe(true);
    expect(existsSync(handle!.dir)).toBe(false);
    expect(mod.currentRetestBatchLock()).toBeNull();
    // 没在持锁时释放不该报错，只要返回「没做事」
    expect(mod.releaseRetestBatchLock()).toBe(false);
  });

  it("锁键只对两侧配置中心地址敏感，同一环境两批算出同一个键", async () => {
    const mod = await loadBatchLock();
    const first = mod.acquireRetestBatchLock();
    const key = first!.key;
    mod.releaseRetestBatchLock();
    const second = await loadBatchLock();
    expect(second.retestLockDir()).toBe(join(lockRoot, `unit-lock-${key}.lock`));
  });

  it("别人的批还活着时直接抛错并点名占用者", async () => {
    const mod = await loadBatchLock();
    // pid=1 一定存在（init）：非 root 拿到 EPERM、root 拿到成功，两种都判「活着」
    writeForeignHolder(mod.retestLockDir(), {
      pid: 1,
      label: "r128-残留批",
      webServerUrl: "http://127.0.0.1:1430",
      startedAt: new Date().toISOString(),
      startedEpoch: Math.floor(Date.now() / 1000),
    });

    await expect(() => mod.acquireRetestBatchLock()).toThrow(/已经有真机批在跑/);
    try {
      mod.acquireRetestBatchLock();
      expect.unreachable("活锁被占用时必须抛错");
    } catch (error) {
      const message = String(error);
      expect(message).toContain("r128-残留批");
      expect(message).toContain("http://127.0.0.1:1430");
    }
    // 抢锁失败不能顺手把别人的锁删掉
    expect(existsSync(mod.retestLockDir())).toBe(true);
  });

  it("上一批被硬杀留下的残锁按 pid 判死后接管", async () => {
    const mod = await loadBatchLock();
    writeForeignHolder(mod.retestLockDir(), {
      pid: 2_147_483_647,
      label: "被 SIGKILL 的批",
      webServerUrl: "http://127.0.0.1:1430",
      startedAt: "1970-01-01T00:00:00.000Z",
      startedEpoch: 1,
    });
    const handle = mod.acquireRetestBatchLock();
    expect(handle).not.toBeNull();
    const holder = JSON.parse(readFileSync(join(handle!.dir, "holder.json"), "utf8"));
    expect(holder.pid).toBe(process.pid);
    mod.releaseRetestBatchLock();
  });

  it("holder 写坏（pid 非法）时不许把后来的人永久锁死", async () => {
    const mod = await loadBatchLock();
    writeForeignHolder(mod.retestLockDir(), {
      pid: "not-a-pid",
      label: "半截 holder",
      startedEpoch: Math.floor(Date.now() / 1000),
    });
    expect(() => mod.acquireRetestBatchLock()).not.toThrow();
    mod.releaseRetestBatchLock();
  });

  it("逃生口 CONFSCOPE_RETEST_LOCK_DISABLE=1 时不建锁目录", async () => {
    process.env.CONFSCOPE_RETEST_LOCK_DISABLE = "1";
    const mod = await loadBatchLock();
    expect(mod.acquireRetestBatchLock()).toBeNull();
    expect(existsSync(mod.retestLockDir())).toBe(false);
    expect(mod.releaseRetestBatchLock()).toBe(false);
  });

  it("锁已被别人接管时释放只清状态、不删别人的目录", async () => {
    const mod = await loadBatchLock();
    const handle = mod.acquireRetestBatchLock();
    // 模拟被判死接管：holder 换成别人的 pid
    writeFileSync(
      join(handle!.dir, "holder.json"),
      `${JSON.stringify({ pid: 2_147_483_647, label: "接管者", startedEpoch: Math.floor(Date.now() / 1000) }, null, 2)}\n`,
      "utf8",
    );
    expect(mod.releaseRetestBatchLock()).toBe(false);
    expect(existsSync(handle!.dir)).toBe(true);
    expect(mod.currentRetestBatchLock()).toBeNull();
  });

  it("模块状态丢失时仍能按 pid 认回自己的锁并释放", async () => {
    const first = await loadBatchLock();
    const handle = first.acquireRetestBatchLock();
    // 换一份模块实例：acquired 为 null，只能靠 holder 里的 pid 认锁
    const second = await loadBatchLock();
    expect(second.currentRetestBatchLock()).toBeNull();
    expect(second.releaseRetestBatchLock()).toBe(true);
    expect(existsSync(handle!.dir)).toBe(false);
  });
});
