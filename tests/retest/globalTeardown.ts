/**
 * 真机批收尾：释放本批占用的配置中心环境锁。
 * 只删自己那把——被判死接管过的批即使还跑到这里，也不能把新占用者的锁拆掉。
 */
import { releaseRetestBatchLock } from "./batchLock";

async function globalTeardown(): Promise<void> {
  releaseRetestBatchLock();
}

export default globalTeardown;
