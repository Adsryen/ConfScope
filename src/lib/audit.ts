import type { ConfigEntry, ParseStatus } from "./normalize";

export type AuditStatus = "consistent" | "partial" | "inconsistent" | "missing" | "parse_error" | "ignored";

export interface AuditSource {
  envId: string;
  label: string;
  providerType: string;
  namespace: string;
  group: string;
  dataId: string;
  entries: ConfigEntry[];
  updatedAt?: string;
}

export interface IgnoreRule {
  providerType?: string;
  namespace?: string;
  group?: string;
  dataId?: string;
  key?: string;
  reason: string;
}

export interface AuditCell {
  exists: boolean;
  value?: string;
  valueType?: ConfigEntry["valueType"];
  parseStatus?: ParseStatus;
  parseError?: string;
  updatedAt?: string;
  /** 该环境配置实际所在命名空间（跨命名空间审计时各行可能不同）。 */
  namespace?: string;
}

export interface AuditRow {
  id: string;
  providerType: string;
  namespace: string;
  group: string;
  dataId: string;
  key: string;
  status: AuditStatus;
  values: Record<string, AuditCell>;
  originalDataIds: Record<string, string>;
  ignoreReason?: string;
}

export interface BuildAuditMatrixOptions {
  ignoreRules?: IgnoreRule[];
  normalizeName?: (name: string) => string;
}

interface RowBucket {
  providerType: string;
  namespace: string;
  group: string;
  dataId: string;
  key: string;
  values: Record<string, AuditCell>;
  originalDataIds: Record<string, string>;
}

/** 行唯一键：group|dataId|key（不含 namespace——同一 dataId 组在不同命名空间下
 * 属于同一配置项，跨命名空间审计需对齐到同一行；各环境实际命名空间
 * 记录在 row.namespace（首见环境）与 AuditCell，供跳转/导出使用。 */
function rowId(group: string, dataId: string, key: string): string {
  return [group, dataId, key].join("|");
}

function wildcardMatch(pattern: string | undefined, value: string): boolean {
  if (!pattern) return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function matchingIgnoreRule(row: RowBucket, rules: IgnoreRule[]): IgnoreRule | undefined {
  return rules.find(
    (rule) =>
      wildcardMatch(rule.providerType, row.providerType) &&
      wildcardMatch(rule.namespace, row.namespace) &&
      wildcardMatch(rule.group, row.group) &&
      wildcardMatch(rule.dataId, row.dataId) &&
      wildcardMatch(rule.key, row.key)
  );
}

function statusOf(row: RowBucket, envIds: string[], ignoreRule?: IgnoreRule): AuditStatus {
  if (ignoreRule) return "ignored";

  const cells = envIds.map((envId) => row.values[envId] ?? { exists: false });
  if (cells.some((cell) => cell.exists && cell.parseStatus === "error")) return "parse_error";
  if (cells.some((cell) => !cell.exists)) return "missing";

  const counts = new Map<string, number>();
  for (const cell of cells) {
    counts.set(cell.value ?? "", (counts.get(cell.value ?? "") ?? 0) + 1);
  }
  if (counts.size <= 1) return "consistent";
  if (Array.from(counts.values()).some((count) => count > 1)) return "partial";
  return "inconsistent";
}

export function buildAuditMatrix(
  sources: AuditSource[],
  options: BuildAuditMatrixOptions = {}
): AuditRow[] {
  const normalizeName = options.normalizeName ?? ((name: string) => name);
  const envIds = Array.from(new Set(sources.map((source) => source.envId)));
  const buckets = new Map<string, RowBucket>();

  for (const source of sources) {
    const dataId = normalizeName(source.dataId);
    for (const entry of source.entries) {
      const id = rowId(source.group, dataId, entry.key);
      const existing = buckets.get(id);
      const bucket =
        existing ??
        ({
          providerType: source.providerType,
          namespace: source.namespace,
          group: source.group,
          dataId,
          key: entry.key,
          values: {},
          originalDataIds: {},
        } satisfies RowBucket);

      bucket.values[source.envId] = {
        exists: true,
        value: entry.value,
        valueType: entry.valueType,
        parseStatus: entry.parseStatus,
        parseError: entry.parseError,
        updatedAt: source.updatedAt,
        namespace: source.namespace,
      };
      bucket.originalDataIds[source.envId] = source.dataId;
      buckets.set(id, bucket);
    }
  }

  return Array.from(buckets.values())
    .map((bucket) => {
      const values: Record<string, AuditCell> = {};
      for (const envId of envIds) values[envId] = bucket.values[envId] ?? { exists: false };

      const ignoreRule = matchingIgnoreRule(bucket, options.ignoreRules ?? []);
      return {
        id: rowId(bucket.group, bucket.dataId, bucket.key),
        providerType: bucket.providerType,
        namespace: bucket.namespace,
        group: bucket.group,
        dataId: bucket.dataId,
        key: bucket.key,
        status: statusOf({ ...bucket, values }, envIds, ignoreRule),
        values,
        originalDataIds: bucket.originalDataIds,
        ...(ignoreRule ? { ignoreReason: ignoreRule.reason } : {}),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
