import type { ConfigListAllResult } from "../api/nacos";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * 把列表聚合结果里的「不完整」信号翻成用户可见的提示文案。
 *
 * 返回空数组代表结果完整，调用方不应显示任何警告；非空时调用方必须展示，
 * 否则「缺失配置」「全部一致」这类结论可能建立在被截断/少页的数据上（R1）。
 *
 * 命中安全上限比少页更严重（一定有数据没扫到），两者同时出现时都列出来。
 */
export function describeConfigListGaps(result: Pick<ConfigListAllResult, "items" | "failedPages" | "truncated">, t: Translate): string[] {
  const gaps: string[] = [];
  if (result.truncated) {
    gaps.push(t("common.configListTruncated", { count: result.items.length }));
  }
  if (result.failedPages.length > 0) {
    gaps.push(t("common.configListPartial", { pages: result.failedPages.join(", "), count: result.items.length }));
  }
  return gaps;
}

/**
 * 判断异常是否为「请求已作废」（用户切走了数据源/命名空间）。
 *
 * 这类异常是内部取消信号，调用方必须静默丢弃，不能当错误展示或上报。
 */
export function isStaleRequestError(error: unknown): boolean {
  return error instanceof Error && error.name === "StaleRequestError";
}
