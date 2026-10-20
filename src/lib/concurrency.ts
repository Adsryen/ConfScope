/**
 * 批量读的并发口径（轮55 D1）。
 *
 * 为什么要单独成文件：配置浏览的内容搜索早就按这个上限并发拉正文了，
 * 而变更执行器的两趟批读（新鲜度快照 / 写前快照）还是逐条 `await` 串行——
 * 7 项计划光读快照就要串 14 个请求，用户在确认页前面干等着。
 * 循环复制一份最容易漂移（两边数字各改各的），所以提到这里共用。
 *
 * 语义约定：结果数组与入参同序（按下标回填，不靠完成顺序），
 * 单个 mapper 抛错会让整趟 reject——调用方自己决定要不要在 mapper 里兜住。
 */

/** 一次批量读同时在飞的请求上限。太小等于没并发，太大是在给配置中心制造雪崩。 */
export const BATCH_READ_CONCURRENCY = 6;

export async function mapWithConcurrency<T, R>(values: T[], limit: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}
