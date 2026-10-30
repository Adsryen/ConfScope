// 配置矩阵的项目级跨环境内容搜索（r139 P1）。
//
// 为什么单独一个 lib 而不是复用 configContentSearch / diffContentSearch：
// 那两边的输入形状是「一个环境的一批正文」和「一对环境的正文」，都要自己管取数；
// 这边的数据早就在内存里（执行一轮审计已经付过 环境数 × 配置数 次请求），
// 要的只是「这批矩阵行里，哪一行在哪个环境的格子里写着这个词」。
// 三边共用同一套匹配口径（lib/textMatch 的 matchLiteral），所以不会出现
// 「列表说命中了、格子里标不出来」的老偏差（同一事故在 diffContentSearch 头部记过）。
import { matchLiteral, type MatchRange } from "./textMatch";
import type { AuditRow } from "./audit";

/** 匹配范围：全部 / 仅名称（dataId + key）/ 仅值（各环境格子里的内容）。 */
export type AuditSearchScope = "all" | "name" | "value";

/** 单格最多画多少处红底。计数仍报真实处数，只是不再为第 21 处之后生成节点：
 *  一个 100KB 的正文行（TEXT 配置的 __document）命中上百处时，节点数会压垮窗口化渲染。 */
export const MAX_RANGES_PER_CELL = 20;

/** 参与匹配的行数上限。截断发生在扫描循环里（攒够就 break），不是扫完再 slice——
 *  后者一毫秒都省不下。capped 必须落到可见文案，别让用户把「前 5000 行」读成「一共 5000 行」。 */
export const MAX_AUDIT_SEARCH_ROWS = 5000;

export interface AuditCellHit {
  envId: string;
  /** 该格真实命中总数，可大于 ranges 长度（受 MAX_RANGES_PER_CELL 限制只画前若干处）。
   *  只用于 title 与「部分未标出」的文案，不参与任何计数。 */
  count: number;
  /** 用于画红底的区间，最多 MAX_RANGES_PER_CELL 段。**编号一律以它为准**：
   *  列头徽标、导航序号、摘要 hits 都数这个，同一页不许出现两套「处」。 */
  ranges: MatchRange[];
  /** 是否因上限只画了前若干处（count > ranges.length）。 */
  truncated: boolean;
}

export interface AuditRowHit {
  rowId: string;
  dataIdRanges: MatchRange[];
  keyRanges: MatchRange[];
  /** 只含命中的环境列，顺序 = 传入的 envIds 顺序（列头徽标与渲染都按它走）。 */
  cells: AuditCellHit[];
  /** 该行真实命中处数之和（名称 + 所有格子，格子按真实总数计）。
   *  与可导航的 target 数可以不等——差额就是被 MAX_RANGES_PER_CELL 折掉的那些。 */
  count: number;
  /** 命中的环境 id 列表，供「这值散在哪几个环境」直接读。 */
  hitEnvIds: string[];
}

export interface AuditSearchResult {
  /** 真正参与匹配的搜索词（已 trim）。空串表示没在搜。 */
  term: string;
  scope: AuditSearchScope;
  /** 是否处于搜索态（有词即为真）。渲染层用它决定要不要走命中分支。 */
  active: boolean;
  /** 命中行索引，只含命中行。 */
  rowHits: Map<string, AuditRowHit>;
  /** 命中行的 id，按**传入行的顺序**（即当前排序后的可见行序）——导航按它走。 */
  matchedRowIds: string[];
  /** 每个环境**画得出来的红底数**之和（列头徽标 = 该列格子里可数的 mark 数）。
   *  故意用 ranges 而不是真实总数：徽标写 20、格子里只有 18 个红底是自相矛盾，
   *  超出上限的那些由 truncatedCells 单独说清。无命中的环境不出现在里面。 */
  perEnvCounts: Record<string, number>;
  matchedRowCount: number;
  /** 真正参与匹配的行数 = 作用域，文案要说清「在多少行里搜」。 */
  scannedRowCount: number;
  /** 传入的行总数（筛选后的可见行数），与 scannedRowCount 在触顶时不相等。 */
  scopeRowCount: number;
  /** 是否因行数上限被动停止扫描。 */
  capped: boolean;
  /** 有多少格只画了前若干处命中（区间截断），文案要说「部分命中未标出」。 */
  truncatedCells: number;
}

const EMPTY_RESULT: AuditSearchResult = {
  term: "",
  scope: "all",
  active: false,
  rowHits: new Map(),
  matchedRowIds: [],
  perEnvCounts: {},
  matchedRowCount: 0,
  scannedRowCount: 0,
  scopeRowCount: 0,
  capped: false,
  truncatedCells: 0,
};

function toCellHit(envId: string, text: string, term: string): AuditCellHit | null {
  const all = matchLiteral(text, term);
  if (all.length === 0) return null;
  const ranges = all.slice(0, MAX_RANGES_PER_CELL);
  return { envId, count: all.length, ranges, truncated: all.length > ranges.length };
}

/**
 * 在矩阵行里搜一个词。纯函数、不取数、不改行状态（一致性判定与 `status` 与搜索无关）。
 *
 * 行命中判定：名称命中或任一环境格子命中都算命中行；`仅名称` 只看 dataId/key，
 * `仅值` 只看格子——两档互斥而不是「值优先」，用户切档时看到的集合必须能解释。
 */
export function searchAuditRows(rows: AuditRow[], envIds: string[], term: string, scope: AuditSearchScope = "all"): AuditSearchResult {
  const query = term.trim();
  if (!query) return { ...EMPTY_RESULT, scope, scopeRowCount: rows.length, scannedRowCount: rows.length };

  const rowHits = new Map<string, AuditRowHit>();
  const matchedRowIds: string[] = [];
  const perEnvCounts: Record<string, number> = {};
  let scanned = 0;
  let truncatedCells = 0;
  let capped = false;

  const scanLimit = Math.min(rows.length, MAX_AUDIT_SEARCH_ROWS);
  for (let i = 0; i < scanLimit; i += 1) {
    const row = rows[i];
    scanned += 1;
    const dataIdRanges = scope === "value" ? [] : matchLiteral(row.dataId, query);
    const keyRanges = scope === "value" ? [] : matchLiteral(row.key, query);
    const cells: AuditCellHit[] = [];
    const hitEnvIds: string[] = [];
    let count = dataIdRanges.length + keyRanges.length;

    if (scope !== "name") {
      for (const envId of envIds) {
        const cell = row.values[envId];
        if (!cell || !cell.exists) continue;
        const hit = toCellHit(envId, cell.value ?? "", query);
        if (!hit) continue;
        cells.push(hit);
        hitEnvIds.push(envId);
        perEnvCounts[envId] = (perEnvCounts[envId] ?? 0) + hit.ranges.length;
        count += hit.count;
        if (hit.truncated) truncatedCells += 1;
      }
    }

    if (count === 0) continue;
    rowHits.set(row.id, {
      rowId: row.id,
      dataIdRanges,
      keyRanges,
      cells,
      count,
      hitEnvIds,
    });
    matchedRowIds.push(row.id);
  }

  if (rows.length > scanLimit) capped = true;

  return {
    term: query,
    scope,
    active: true,
    rowHits,
    matchedRowIds,
    perEnvCounts,
    matchedRowCount: matchedRowIds.length,
    scannedRowCount: scanned,
    scopeRowCount: rows.length,
    capped,
    truncatedCells,
  };
}

/**
 * 一次「命中」= 一个可定位的红底。Enter / ↑↓ 每按一次就走到下一个，
 * 所以 target 数就是界面上的「共几处」，也是徽标之和——三处同源，编号只有一个来源。
 *
 * 顺序 = 命中行顺序（当前可见行序）× 名称(dataId 逐处 → key 逐处) → 各格子（按 envIds 列序）
 * × 格内按区间序，与用户肉眼扫矩阵的方向一致。
 */
export interface AuditSearchTarget {
  rowId: string;
  /** null 表示命中的是名称列（dataId/key）。 */
  envId: string | null;
  /** dataId 命中 / key 命中 / 格子命中。 */
  kind: "dataId" | "key" | "cell";
  /** 命中的是 hit 里第几个区间：渲染层只给这一段吃实心高亮，其余仍是普通红底。 */
  rangeIndex: number;
}

function pushRanges(targets: AuditSearchTarget[], base: Omit<AuditSearchTarget, "rangeIndex">, total: number) {
  for (let i = 0; i < total; i += 1) targets.push({ ...base, rangeIndex: i });
}

export function buildAuditSearchTargets(result: AuditSearchResult, envIds: string[]): AuditSearchTarget[] {
  if (!result.active) return [];
  const targets: AuditSearchTarget[] = [];
  for (const rowId of result.matchedRowIds) {
    const hit = result.rowHits.get(rowId);
    if (!hit) continue;
    pushRanges(targets, { rowId, envId: null, kind: "dataId" }, hit.dataIdRanges.length);
    pushRanges(targets, { rowId, envId: null, kind: "key" }, hit.keyRanges.length);
    // 格子按传入的 envIds 顺序走，而不是按命中先后（列序 = 用户看到的顺序）
    for (const envId of envIds) {
      const cell = hit.cells.find((item) => item.envId === envId);
      if (!cell) continue;
      pushRanges(targets, { rowId, envId, kind: "cell" }, cell.ranges.length);
    }
  }
  return targets;
}

/** 序号夹取：越界回到范围内，负数从尾算（与 diffFind 的「一套编号语义」口径一致，别让调用方各自发明）。 */
export function clampAuditHitIndex(index: number, total: number): number {
  if (total <= 0) return -1;
  const wrapped = ((index % total) + total) % total;
  return wrapped;
}
