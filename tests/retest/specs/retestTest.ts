import { test as base } from "@playwright/test";
import { loadRetestState, type RetestState } from "../state";
import { sweepRetestStrays } from "../strays";

// 注意：Playwright 1.61.1 中，依赖 `page` 的自定义 fixture 会导致该页面的
// addInitScript 不生效（Wails bridge 注入失败）。因此 retest fixture 仅提供
// 环境状态，不碰 page；Wails bridge 由每个测试体开头显式调用 installRetestBridge 安装。
interface RetestFixtures {
  retest: RetestState;
}

interface RetestWorkerFixtures {
  /** 残留清扫（worker 作用域 + auto）：见 ../strays.ts 的立轮理由。 */
  retestSweep: void;
}

export const test = base.extend<RetestFixtures, RetestWorkerFixtures>({
  retest: async ({}, use) => {
    use(loadRetestState());
  },
  // 起跑前先扫一次：上一批崩在中间留下的 `retest-*` 不能污染本批第一条条数断言；
  // 收工后再扫一次：这一批红掉的用例没跑完自己的收尾，兜底得在它之后、而不是靠它自己。
  // worker 作用域 + auto = 每条用例都会带上这道清扫，且失败路径同样执行 teardown
  // （Playwright 的 globalTeardown 只在正常结束时跑，恰恰漏掉最需要它的场景）。
  retestSweep: [
    async ({}, use) => {
      await sweepRetestStrays("worker-start");
      await use();
      await sweepRetestStrays("worker-end");
    },
    { scope: "worker", auto: true },
  ],
});

export { expect } from "@playwright/test";

/** 从真实 Nacos 直接读取配置原文（用于断言 UI 操作是否真正落到存储）。 */
export async function fetchNacosContent(baseUrl: string, namespace: string, dataId: string, group = "DEFAULT_GROUP"): Promise<string> {
  const url = `${baseUrl}/v1/cs/configs?dataId=${encodeURIComponent(dataId)}&group=${encodeURIComponent(group)}&tenant=${encodeURIComponent(namespace)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Nacos ${res.status} for ${dataId}`);
  return res.text();
}

/**
 * 轮询读取 Nacos 直到内容满足判据（或耗尽次数后返回最后一次读数）。
 *
 * 为什么必须有这个：Nacos v1 写入是**最终一致**的——POST 返回 true 后立刻 GET
 * 可能短暂读到旧值，新建的配置甚至可能先回 404。harness 自己的
 * `publishNacosContent()`（tests/retest/bridge/republishData.ts）早就为此写了重试，
 * 但用例侧的落库断言一直是单次读取，于是「执行完成 → 读服务端」这类断言天然带
 * 竞态红（轮43 实测：T-CR-01/02 与 P1/P2 探针都在同一位置误红，而桥日志显示
 * publish 已经真实发生）。
 *
 * 用法：`expect(await fetchNacosContentUntil(..., (t) => t.includes(marker))).toContain(marker)`
 * ——判据不满足时返回最后一次读数，让断言信息仍然可读。
 */
export async function fetchNacosContentUntil(
  baseUrl: string,
  namespace: string,
  dataId: string,
  group: string,
  until: (content: string) => boolean,
  tries = 12,
  intervalMs = 500
): Promise<string> {
  let last = "";
  for (let i = 0; i < tries; i += 1) {
    try {
      last = await fetchNacosContent(baseUrl, namespace, dataId, group);
      if (until(last)) return last;
    } catch (error) {
      last = String(error);
    }
    if (i < tries - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return last;
}

/** 等服务端内容变成「与给定文本不同」，用于断言删除/改写的落库。 */
export async function fetchNacosContentChanged(
  baseUrl: string,
  namespace: string,
  dataId: string,
  group: string,
  before: string,
  tries = 12,
  intervalMs = 500
): Promise<string> {
  return fetchNacosContentUntil(baseUrl, namespace, dataId, group, (content) => content !== before, tries, intervalMs);
}
