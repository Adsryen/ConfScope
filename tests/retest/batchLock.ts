/**
 * 真机批互斥锁（2026-10-29 r129 事故后新增）。
 *
 * 事故形态：上一轮 r128 的批被「杀掉」了——死的只是外层脚本，Playwright 主进程（自己的进程组）
 * 活得好好的，继续在同一个 relwt / 同一个 dev server / 同一对 nacos 上跑。我以为是残留，
 * 于是直接起了 r129。两批各自串行跑自己的用例，却共享同一份 Nacos 数据：
 * 对面一次 `republishAndVerifyBaseline()` 就把 r129 里 T-AP-02 刚写进 B 侧的 11 项配置
 * 重新播种回了种子内容。r129 的红灯是两批互相踩出来的，跟产品一行关系都没有——
 * 而这种红一旦被人拿去「修判据」，就是给一个不存在的缺陷放宽断言。
 *
 * 所以把「一个 nacos 环境同一时刻只允许一批真机」变成可执行的闸门：
 * 起批前先抢锁，抢不到就当场红并说清是谁占着，而不是跑完 26 分钟才发现数据被改。
 *
 * 锁按 nacos 端点组合定键（真正的共享资源是配置中心，不是 dev server）：
 * 两套隔离环境可以并行，同一套环境只允许一批。
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRetestState } from "./state";

export interface RetestLockHolder {
  pid: number;
  label: string;
  webServerUrl: string;
  startedAt: string;
  /** epoch 秒，用于「holder 写得半截或 pid 判不出活性」时决定能不能接管。 */
  startedEpoch: number;
}

export interface RetestLockHandle {
  dir: string;
  key: string;
  holder: RetestLockHolder;
}

/** 判不出活性的残锁超过这个时长就允许被接管（整批实测 ~30 分钟，留足余量）。 */
const STALE_AFTER_SECONDS = 6 * 60 * 60;

let acquired: RetestLockHandle | null = null;

function lockRoot(): string {
  return process.env.CONFSCOPE_RETEST_LOCK_ROOT ?? tmpdir();
}

function disabled(): boolean {
  return process.env.CONFSCOPE_RETEST_LOCK_DISABLE === "1";
}

/** 锁键：只对「会被两批同时改写的东西」敏感——两侧配置中心的地址。 */
export function retestLockKey(): string {
  const state = loadRetestState();
  const raw = `${state.nacos.a.baseUrl}|${state.nacos.b.baseUrl}`;
  return createHash("sha1").update(raw).digest("hex").slice(0, 12);
}

export function retestLockDir(): string {
  const prefix = process.env.CONFSCOPE_RETEST_LOCK_PREFIX ?? "confscope-retest-batch";
  return join(lockRoot(), `${prefix}-${retestLockKey()}.lock`);
}

/**
 * pid 为 0 / 非法一律按「无法证明活着」处理，再叠时长上限，
 * 避免一个写坏的 holder 把后面所有人的批永久锁死。
 */
function isPidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // 信号 0 只做存在性检查，不真发消息
    return true;
  } catch (error) {
    // EPERM：进程存在但不属于当前用户——照样算活着。ESRCH 才是真的没了。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readHolder(dir: string): RetestLockHolder | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "holder.json"), "utf8")) as RetestLockHolder;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function holderAgeSeconds(holder: RetestLockHolder | null): number {
  const epoch = holder?.startedEpoch;
  if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor(Date.now() / 1000) - epoch);
}

function describeHolder(dir: string, holder: RetestLockHolder | null): string {
  if (!holder) return `锁目录 ${dir} 里没有可信的 holder.json（可能是上一批被硬杀留下的残锁）`;
  return (
    `占用者 pid=${holder.pid} label=${holder.label || "(未命名)"} ` +
    `webServer=${holder.webServerUrl || "(未知)"} 起于 ${holder.startedAt || "(未知)"}`
  );
}

function makeHolder(): RetestLockHolder {
  const state = loadRetestState();
  return {
    pid: process.pid,
    label: process.env.CONFSCOPE_RETEST_BATCH_LABEL ?? "",
    webServerUrl: state.webServerUrl,
    startedAt: new Date().toISOString(),
    startedEpoch: Math.floor(Date.now() / 1000),
  };
}

function writeHolder(dir: string, holder: RetestLockHolder): void {
  writeFileSync(join(dir, "holder.json"), `${JSON.stringify(holder, null, 2)}\n`, "utf8");
}

/**
 * 抢锁。已被别人占着就抛错（消息里带占用者信息），残锁判死后接管。
 * `CONFSCOPE_RETEST_LOCK_DISABLE=1` 是逃生口：只在明确知道自己在干什么时用。
 */
export function acquireRetestBatchLock(): RetestLockHandle | null {
  if (disabled()) {
    console.log("[retest-lock] 已按 CONFSCOPE_RETEST_LOCK_DISABLE=1 跳过互斥检查（同一套 nacos 并发跑批会互相改数据）");
    return null;
  }

  const dir = retestLockDir();
  const holder = makeHolder();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(dir); // 原子创建：存在即 EEXIST，没有竞态窗口
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;

      const current = readHolder(dir);
      const alive = isPidAlive(current?.pid);
      const staleByAge = holderAgeSeconds(current) > STALE_AFTER_SECONDS;
      if (alive && !staleByAge) {
        const state = loadRetestState();
        throw new Error(
          `[retest-lock] 这套配置中心环境已经有真机批在跑了，不能再起第二批：\n` +
            `  ${describeHolder(dir, current)}\n` +
            `  两批共用 ${state.nacos.a.baseUrl} / ${state.nacos.b.baseUrl}，任何一批重新播种基线` +
            `都会把另一批刚写进去的配置改回去（r129 的 T-AP-02 就是这么红的）。\n` +
            `  先把上面那一批真的结束（别只杀外层脚本，要杀整个进程组），或者给新一批换一套隔离环境。`,
        );
      }

      console.log(
        `[retest-lock] 发现残锁，判死后接管：${describeHolder(dir, current)}` +
          `${alive ? `（pid 仍在，但已超过 ${STALE_AFTER_SECONDS / 60} 分钟）` : ""}`,
      );
      rmSync(dir, { recursive: true, force: true });
      continue;
    }

    writeHolder(dir, holder);
    const handle: RetestLockHandle = { dir, key: retestLockKey(), holder };
    acquired = handle;
    console.log(
      `[retest-lock] 已占用真机批环境 key=${handle.key} pid=${holder.pid} ` +
        `webServer=${holder.webServerUrl} label=${holder.label || "(未命名)"}`,
    );
    return handle;
  }

  throw new Error(`[retest-lock] 抢锁失败：${dir} 反复被占用，检查是不是有批在循环重启`);
}

/**
 * 放锁。只删自己占的那把——万一锁已被后来的批接管（我们被判死过），
 * 删掉别人的锁等于把闸门拆了。
 */
export function releaseRetestBatchLock(): boolean {
  // 模块状态丢失（globalSetup 与 globalTeardown 被不同模块实例加载）时，
  // 兜底按「本进程 pid 是否写在自己环境的 holder 里」认锁，别把闸门留在原地生锈。
  const dir = acquired?.dir ?? ownLockDir();
  if (!dir) return false;
  const current = readHolder(dir);
  if (!current || current.pid !== process.pid) {
    console.log(`[retest-lock] 跳过释放：${dir} 已经不是本次批的锁了（${describeHolder(dir, current)}）`);
    acquired = null;
    return false;
  }
  rmSync(dir, { recursive: true, force: true });
  const key = acquired?.key ?? retestLockKey();
  acquired = null;
  console.log(`[retest-lock] 已释放真机批环境 key=${key}`);
  return true;
}

/** holder 里写的是本进程 pid 时返回锁目录，否则 null。 */
function ownLockDir(): string | null {
  if (disabled()) return null;
  let dir: string;
  try {
    dir = retestLockDir();
  } catch {
    return null; // 环境键都算不出来（缺 state 配置）就别再猜了
  }
  const holder = readHolder(dir);
  return holder && holder.pid === process.pid ? dir : null;
}

/** 当前持有的句柄（主要给单测断言用）。 */
export function currentRetestBatchLock(): RetestLockHandle | null {
  return acquired;
}
