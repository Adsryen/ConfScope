/**
 * 真机批起跑前的互斥闸门（2026-10-29 r129 事故后新增）。
 *
 * 事故形态：r128 只杀了外层脚本，Playwright 主进程活着继续跑；我以为是残留，直接起了 r129。
 * 两批共用同一对 nacos，对面一次基线重播种把 r129 刚写进 B 侧的配置改了回去——
 * 红的是环境，不是产品。这种红一旦被拿去「修判据」，就是给不存在的缺陷放宽断言。
 *
 * 所以现在起批先抢锁：抢不到当场红并点名占用者，而不是烧完 26 分钟才发现数据被改。
 * 抛错发生在浏览器启动之前，不会在 test-results 里留下假的用例失败。
 */
import { acquireRetestBatchLock } from "./batchLock";

async function globalSetup(): Promise<void> {
  acquireRetestBatchLock();
}

export default globalSetup;
