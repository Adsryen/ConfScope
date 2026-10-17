import type { ConfigItem, ConfigListAllResult, ConfigPage } from "../api/nacos";

type PageFetcher = (conn: never, namespace: string, dataId: string, group: string, pageNo: number, pageSize: number) => Promise<ConfigPage>;
type ListAllOptions = { pageSize?: number; safeCap?: number; isStale?: () => boolean; onProgress?: (loaded: number) => void };

/**
 * 组件测试专用：把「单页 listConfigs 的 mock」桥接成 listAllConfigs 的聚合语义。
 *
 * 原因：`vi.mock("../api/nacos")` 只能替换模块导出，`listAllConfigs` 内部闭包引用的
 * 仍是未被打桩的真实 `listConfigs`（会去访问 window.go 绑定）。这里用 mock 的分页结果
 * 复现聚合/安全上限/少页语义，既有分页夹具无需重写。
 * 聚合行为本身的正确性由 `src/api/nacos.test.ts` 的 listAllConfigs 用例覆盖。
 */
export function listAllConfigsBridge(listConfigs: PageFetcher) {
  return async (
    conn: Parameters<PageFetcher>[0],
    namespace: string,
    dataId: string,
    group: string,
    opts: ListAllOptions = {}
  ): Promise<ConfigListAllResult> => {
    const pageSize = Math.max(1, Math.floor(opts.pageSize ?? 500));
    const safeCap = Math.max(pageSize, Math.floor(opts.safeCap ?? 5000));
    const first = await listConfigs(conn, namespace, dataId, group, 1, pageSize);
    if (opts.isStale?.()) throw staleError();
    const items: ConfigItem[] = [...first.pageItems];
    const pagesAvailable = Math.max(first.pagesAvailable || 1, 1);
    const capPages = Math.ceil(safeCap / pageSize);
    const truncated = pagesAvailable > capPages;
    const targetPages = Math.min(pagesAvailable, capPages);
    const failedPages: number[] = [];
    opts.onProgress?.(items.length);

    for (let page = 2; page <= targetPages; page += 1) {
      try {
        const next = await listConfigs(conn, namespace, dataId, group, page, pageSize);
        if (opts.isStale?.()) throw staleError();
        items.push(...next.pageItems);
        opts.onProgress?.(items.length);
      } catch (error) {
        if (error instanceof Error && error.name === "StaleRequestError") throw error;
        failedPages.push(page);
        break;
      }
    }

    return { items, pagesAvailable, loadedPages: failedPages.length ? failedPages[0] - 1 : targetPages, failedPages, truncated };
  };
}

function staleError(): Error {
  const error = new Error("config list request is stale");
  error.name = "StaleRequestError";
  return error;
}
