import { describe, expect, it } from "vitest";
import { BATCH_READ_CONCURRENCY, mapWithConcurrency } from "./concurrency";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("mapWithConcurrency", () => {
  it("回填顺序与入参一致，不靠完成顺序", async () => {
    // 第 0 项故意最慢：按完成顺序 push 的写法会把它的结果甩到最后
    const results = await mapWithConcurrency([40, 5, 5, 5], 4, async (delay) => {
      await sleep(delay);
      return delay;
    });
    expect(results).toEqual([40, 5, 5, 5]);
  });

  it("在途请求不超过上限，但确实并发", async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, index) => index), BATCH_READ_CONCURRENCY, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(1);
      active -= 1;
      return value;
    });
    expect(peak).toBeLessThanOrEqual(BATCH_READ_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
  });

  it("空列表不排 worker，也不返回多余元素", async () => {
    const mapper = () => {
      throw new Error("不该被调用");
    };
    await expect(mapWithConcurrency([], 4, mapper)).resolves.toEqual([]);
  });

  it("mapper 抛错时整趟 reject（调用方要自己决定是否兜住单项失败）", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (value) => {
        if (value === 2) throw new Error("boom");
        return value;
      })
    ).rejects.toThrow("boom");
  });
});
