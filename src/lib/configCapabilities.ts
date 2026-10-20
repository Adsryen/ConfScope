/**
 * 配置中心能力口径（轮55 R55-E2/E3）。
 *
 * UI 入口与请求闸门从这里取，不在组件里散写 `provider === "nacos"` 之类的判断。
 * 判定依据是真机取证（见 .trellis/tasks/10-21-ui-ux-55-apply-safety-history/
 * research/nacos-history-probe-2026-10-21.md），不是猜的：
 *
 * - 版本级历史（某配置的历史列表 + 单版本正文）：Nacos v1 `cs/history` 两段式
 *   在 nacos-server:v2.5.2 实测可用；aliyun-mse 发行版走 Nacos 兼容协议，同一口径。
 *   Apollo/Consul 的 ListHistory 在 Go 侧直接返回「当前为只读模式」错误——入口
 *   留着只会让用户点进一句和「历史」无关的报错。本地快照没有服务端历史。
 *
 * - 命名空间级「中心历史」（操作历史页按连接拉全量）：现有 provider 全部拿不到——
 *   v1 `search=accurate` 空查询恒返回 0 行且不报错（静默假空，用户以为记录丢了），
 *   `search=blur` 直接 HTTP 500。将来 MSE 若接阿里云 POP ListHistoryVersions，
 *   在这张表上把 nacos 的 center 翻成 true 即可，调用侧不用改。
 */
import type { Connection, ProviderType } from "../store/connections";

/**
 * 连接的有效 provider：本地快照一律按 "local" 收口，其余取 provider 字段。
 *
 * 与 api/nacos.ts 的历史口径一致；该处已改为委托本函数，保持单一事实源。
 */
export function effectiveProvider(conn: Connection): ProviderType {
  if (conn.sourceType === "local-snapshot") return "local";
  return conn.provider ?? "nacos";
}

interface HistoryCapability {
  /** 配置浏览「历史变更」tab：版本列表 + 单版本正文。 */
  version: boolean;
  /** 操作历史页的命名空间级中心历史拉取。 */
  center: boolean;
}

const HISTORY_CAPABILITY: Record<ProviderType, HistoryCapability> = {
  nacos: { version: true, center: false },
  apollo: { version: false, center: false },
  consul: { version: false, center: false },
  local: { version: false, center: false },
};

/** 该连接能否在配置浏览里看版本级历史（决定「历史变更」tab 是否出现）。 */
export function supportsConfigHistory(conn: Connection): boolean {
  return HISTORY_CAPABILITY[effectiveProvider(conn)].version;
}

/** 该连接能否按命名空间拉中心历史（决定操作历史页要不要发这个请求）。 */
export function supportsCenterHistory(conn: Connection): boolean {
  return HISTORY_CAPABILITY[effectiveProvider(conn)].center;
}
