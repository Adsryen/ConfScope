// 写后失效广播（轮43）。
//
// 动机：配置浏览与配置对比两张页面是**保活**的（App.tsx 的 `.browse-cache` / `.diff-apply-cache`
// 切走只是 display:none，不卸载、不重新取数），而全站唯一的写路径是变更计划执行器
// （轮42 起四个直写入口也只生成计划）。执行器写完，这两张页面手里仍是执行前那一刻的数据：
// 界面刚说「变更执行完成」，正文却还是旧的——用户只能理解成「没写进去」，于是重复生成、重复执行。
//
// 形态照 popoverBus：模块级订阅集合 + 宿主自己决定怎么刷新，组件之间不互传状态。
// 发布点只有一个（执行器），订阅方各自重取自己那一份，不新造第二套取数逻辑。

/** 一个被写入的位置（文档粒度：key 级差异由宿主重取时自行覆盖）。 */
export interface ConfigChangeRef {
  dataId: string;
  group: string;
}

/** 一次真实写入的失效通知：目标连接 + 命名空间 + 被碰过的位置。 */
export interface ConfigChangeNotice {
  connectionId: string;
  namespace: string;
  refs: ConfigChangeRef[];
}

type Handler = (notice: ConfigChangeNotice) => void;

const handlers = new Set<Handler>();

/** 订阅写后失效，返回取消注册函数。 */
export function subscribeConfigChanges(handler: Handler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/** 广播一次真实写入。没有订阅者时是 no-op（纯单测环境同样安全）。 */
export function publishConfigChange(notice: ConfigChangeNotice): void {
  if (!notice.refs.length) return;
  // 复制一份再遍历：回调里可能触发重渲染并同步取消注册，直接遍历 Set 会被改坏（同 popoverBus）。
  for (const handler of [...handlers]) handler(notice);
}

/**
 * 命名空间归一：浏览页把 public 存成空串，计划侧的 ref 用 "public"。
 * 两边不归一会导致「明明写了同一份配置，视图却认为与己无关」——最难查的那种失效失败。
 */
export function normalizeNamespace(namespace: string | null | undefined): string {
  const value = (namespace ?? "").trim();
  return value === "" ? "public" : value;
}

/** group 归一：Nacos 的空 group 语义就是 DEFAULT_GROUP（与 ConfigBrowser 的 selectedGroup 同口径）。 */
export function normalizeGroup(group: string | null | undefined): string {
  const value = (group ?? "").trim();
  return value === "" ? "DEFAULT_GROUP" : value;
}

/** 这次写入是否落在某个视图当前盯着的连接 + 命名空间里。 */
export function changeTouchesNamespace(
  notice: ConfigChangeNotice,
  connectionId: string | null | undefined,
  namespace: string | null | undefined
): boolean {
  if (!connectionId) return false;
  return notice.connectionId === connectionId && normalizeNamespace(notice.namespace) === normalizeNamespace(namespace);
}

/** 这次写入是否具体碰过了某个位置（正文级失效用它，列表级失效用上面的命名空间判据）。 */
export function changeTouchesConfig(
  notice: ConfigChangeNotice,
  target: { connectionId: string | null | undefined; namespace: string | null | undefined; dataId: string; group: string }
): boolean {
  if (!changeTouchesNamespace(notice, target.connectionId, target.namespace)) return false;
  const dataId = (target.dataId ?? "").trim();
  const group = normalizeGroup(target.group);
  return notice.refs.some((ref) => (ref.dataId ?? "").trim() === dataId && normalizeGroup(ref.group) === group);
}
