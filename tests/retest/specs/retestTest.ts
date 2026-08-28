import { test as base } from "@playwright/test";
import { loadRetestState, type RetestState } from "../state";

// 注意：Playwright 1.61.1 中，依赖 `page` 的自定义 fixture 会导致该页面的
// addInitScript 不生效（Wails bridge 注入失败）。因此 retest fixture 仅提供
// 环境状态，不碰 page；Wails bridge 由每个测试体开头显式调用 installRetestBridge 安装。
interface RetestFixtures {
  retest: RetestState;
}

export const test = base.extend<RetestFixtures>({
  retest: async ({}, use) => {
    use(loadRetestState());
  },
});

export { expect } from "@playwright/test";

/** 从真实 Nacos 直接读取配置原文（用于断言 UI 操作是否真正落到存储）。 */
export async function fetchNacosContent(baseUrl: string, namespace: string, dataId: string, group = "DEFAULT_GROUP"): Promise<string> {
  const url = `${baseUrl}/v1/cs/configs?dataId=${encodeURIComponent(dataId)}&group=${encodeURIComponent(group)}&tenant=${encodeURIComponent(namespace)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Nacos ${res.status} for ${dataId}`);
  return res.text();
}
