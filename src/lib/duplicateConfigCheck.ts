// 跨配置重复检查（r110 第一版）：纯函数、只读，输入是审计/浏览侧已经归一化好的
// AuditSource[]（normalize.ts 的产物），不发起任何取数、不写任何配置。
//
// 两条判据（第三条「正文近似」需要相似度算法选型，本版不做）：
//   ① keyDup    同 key 出现在 ≥2 个不同配置里，值相同/值不同分两档（值不同更值得看，排前）
//   ② exactBody 两份不同配置的归一化条目集完全相等
//
// 「不同配置」的口径与 lib/audit 的行身份一致：归一化 group|dataId（不含 namespace——
// 同一 dataId 组在不同命名空间下属于同一配置项）。同一配置在不同环境里的值漂移
// 是审计矩阵的 status 职责，这里不重复报。
//
// 忽略清单（R2）：支持 * 通配（与 audit 的 wildcardMatch 同一出处），命中忽略 key
// 的条目不参与 ①；② 是全文判据，忽略清单不影响它（v1 边界，写进 PRD）。
import type { AuditSource } from "./audit";
import type { ConfigEntry } from "./normalize";
import { wildcardMatch } from "./audit";

export type DuplicateCriterion = "keyDup" | "exactBody";
export type DuplicateTier = "sameValue" | "diffValue";

export interface DuplicateCheckCriteria {
  keyDup: boolean;
  exactBody: boolean;
}

export interface DuplicateCheckOptions {
  /** 缺省两个判据都开（PRD R1：默认只开前两种）。 */
  criteria?: Partial<DuplicateCheckCriteria>;
  /** 忽略的 key 模式，支持 * 通配。 */
  ignoredKeyPatterns?: string[];
  /** dataId 归一化（与审计矩阵同一个 normalizeName，保证「同一份配置」口径一致）。 */
  normalizeName?: (name: string) => string;
}

/** 重复组里的一处出现。envId 形状与 AuditSource.envId 一致（connId:namespace）。 */
export interface DuplicateLocation {
  /** 组内唯一的位置键（sourceIndex 派生）。envId 在组内不保证唯一——
   * 归一化后不同 dataId 可并入同一身份、同环境两份来源 envId 相同，勾选/列表 key 都按它。 */
  locKey: string;
  envId: string;
  /** 从 envId 前缀拆出，供「送去对比/生成回退计划」两个出口直接取连接。 */
  connId: string;
  /** 来源展示名（环境标签）。 */
  label: string;
  providerType: string;
  namespace: string;
  group: string;
  /** 原始 dataId（跳转/写计划必须用未归一化的名字）。 */
  dataId: string;
  /** ① 判据命中 key 在该处的取值。 */
  value?: string;
  /** 对应 AuditSource 在输入数组里的下标（出口按它取回完整来源）。 */
  sourceIndex: number;
}

export interface DuplicateGroup {
  /** 稳定 id：判据 + key/正文签名 + 配置身份集，重跑不跳。 */
  id: string;
  criterion: DuplicateCriterion;
  /** ① 判据的档：值相同 / 值不同。 */
  tier?: DuplicateTier;
  /** ① 判据命中的 key。 */
  key?: string;
  /** ≥2 处出现（≥2 个不同配置身份）。 */
  locations: DuplicateLocation[];
  /** 跨了多少个不同配置（归一化 group|dataId 计数）。 */
  configCount: number;
}

export interface DuplicateCheckResult {
  groups: DuplicateGroup[];
  /** 参与检查的配置来源数。 */
  checkedSources: number;
  /** ① 判据实际比较的 key 数（排除忽略与解析失败后的去重 key）。 */
  checkedKeys: number;
  /** 解析失败被 ② 判据排除的配置来源数（可解释性：让用户知道漏了谁）。 */
  parseSkippedSources: number;
  /** 纯计算耗时（ms），供 R5 规模判读；不做判据线。 */
  durationMs: number;
}

/** 配置身份：归一化 group|dataId（与 audit.rowId 同口径，不含 namespace）。 */
function configIdentity(group: string, dataId: string, normalizeName: (name: string) => string): string {
  return `${group}|${normalizeName(dataId)}`;
}

/** 解析失败的来源不参与 ②（正文不可信），① 只排除 __parse__ 占位条目。 */
function hasParseError(entries: ConfigEntry[]): boolean {
  return entries.some((entry) => entry.parseStatus === "error");
}

function keyOfLocation(source: AuditSource, index: number, group: string, dataId: string, value: string | undefined): DuplicateLocation {
  const connId = source.envId.split(":")[0];
  return {
    locKey: `s${index}`,
    envId: source.envId,
    connId,
    label: source.label,
    providerType: source.providerType,
    namespace: source.namespace,
    group,
    dataId,
    value,
    sourceIndex: index,
  };
}

/**
 * ① 同 key 跨配置。同一配置身份只取首见值参与分档——同一 dataId 在两个环境值不同
 * 属于审计的 inconsistent，不在这里重复报。
 */
function findKeyDupGroups(
  sources: AuditSource[],
  isIgnored: (key: string) => boolean,
  normalizeName: (name: string) => string
): { groups: DuplicateGroup[]; checkedKeys: number } {
  // key → 配置身份 → { 首见值, 各处出现 }
  const byKey = new Map<string, Map<string, { value: string; locations: DuplicateLocation[] }>>();
  const keySet = new Set<string>();

  sources.forEach((source, sourceIndex) => {
    for (const entry of source.entries) {
      if (entry.parseStatus === "error") continue;
      if (isIgnored(entry.key)) continue;
      keySet.add(entry.key);
      const identity = configIdentity(source.group, source.dataId, normalizeName);
      const perIdentity = byKey.get(entry.key) ?? new Map<string, { value: string; locations: DuplicateLocation[] }>();
      const slot = perIdentity.get(identity) ?? { value: entry.value, locations: [] };
      slot.locations.push(keyOfLocation(source, sourceIndex, source.group, source.dataId, entry.value));
      perIdentity.set(identity, slot);
      byKey.set(entry.key, perIdentity);
    }
  });

  const groups: DuplicateGroup[] = [];
  for (const [key, perIdentity] of byKey) {
    if (perIdentity.size < 2) continue;
    const values = [...perIdentity.values()].map((slot) => slot.value);
    const tier: DuplicateTier = values.every((v) => v === values[0]) ? "sameValue" : "diffValue";
    const locations = [...perIdentity.values()].flatMap((slot) => slot.locations).sort((a, b) => a.label.localeCompare(b.label));
    groups.push({
      id: `keyDup:${tier}:${key}:${[...perIdentity.keys()].sort().join("\u0000")}`,
      criterion: "keyDup",
      tier,
      key,
      locations,
      configCount: perIdentity.size,
    });
  }
  return { groups, checkedKeys: keySet.size };
}

/**
 * ② 正文归一化后全等。签名 = 条目（key+value）排序拼接——条目集来自 normalize.ts，
 * 不新写归一化。空配置（0 条目）不参与，避免一堆空壳被判成互相重复。
 */
function findExactBodyGroups(
  sources: AuditSource[],
  normalizeName: (name: string) => string
): { groups: DuplicateGroup[]; parseSkippedSources: number } {
  // 正文签名 → 配置身份 → 各处出现
  const byBody = new Map<string, Map<string, DuplicateLocation[]>>();
  let parseSkippedSources = 0;

  sources.forEach((source, sourceIndex) => {
    if (hasParseError(source.entries)) {
      parseSkippedSources += 1;
      return;
    }
    if (source.entries.length === 0) return;
    const signature = source.entries
      .map((entry) => `${entry.key}\u0001${entry.value}`)
      .sort()
      .join("\u0000");
    const identity = configIdentity(source.group, source.dataId, normalizeName);
    const perIdentity = byBody.get(signature) ?? new Map<string, DuplicateLocation[]>();
    perIdentity.set(identity, [
      ...(perIdentity.get(identity) ?? []),
      keyOfLocation(source, sourceIndex, source.group, source.dataId, undefined),
    ]);
    byBody.set(signature, perIdentity);
  });

  const groups: DuplicateGroup[] = [];
  for (const [signature, perIdentity] of byBody) {
    if (perIdentity.size < 2) continue;
    const locations = [...perIdentity.values()].flat().sort((a, b) => a.label.localeCompare(b.label));
    groups.push({
      id: `exactBody:${signature.slice(0, 16)}:${[...perIdentity.keys()].sort().join("\u0000")}`,
      criterion: "exactBody",
      locations,
      configCount: perIdentity.size,
    });
  }
  return { groups, parseSkippedSources };
}

/**
 * 跨配置重复检查主入口。纯计算、无副作用（R6 只读）。
 * 排序：值不同（最该看）→ 值相同 → 正文全等；同档按跨配置数降序、再按 id 稳定序。
 */
export function checkDuplicateConfigs(sources: AuditSource[], options: DuplicateCheckOptions = {}): DuplicateCheckResult {
  const started = performance.now();
  const normalizeName = options.normalizeName ?? ((name: string) => name);
  const criteria = {
    keyDup: options.criteria?.keyDup ?? true,
    exactBody: options.criteria?.exactBody ?? true,
  };
  const patterns = (options.ignoredKeyPatterns ?? []).filter((p) => p.length > 0);
  const isIgnored = (key: string) => patterns.some((pattern) => wildcardMatch(pattern, key));

  const groups: DuplicateGroup[] = [];
  let checkedKeys = 0;
  let parseSkippedSources = 0;

  if (criteria.keyDup) {
    const { groups: keyGroups, checkedKeys: keys } = findKeyDupGroups(sources, isIgnored, normalizeName);
    groups.push(...keyGroups);
    checkedKeys = keys;
  }
  if (criteria.exactBody) {
    const { groups: bodyGroups, parseSkippedSources: skipped } = findExactBodyGroups(sources, normalizeName);
    groups.push(...bodyGroups);
    parseSkippedSources = skipped;
  }

  const rank = (group: DuplicateGroup): number => (group.criterion === "keyDup" ? (group.tier === "diffValue" ? 0 : 1) : 2);
  groups.sort((a, b) => rank(a) - rank(b) || b.configCount - a.configCount || a.id.localeCompare(b.id));

  return {
    groups,
    checkedSources: sources.length,
    checkedKeys,
    parseSkippedSources,
    durationMs: performance.now() - started,
  };
}
