import { describe, expect, it } from "vitest";
import { MAX_AUDIT_SEARCH_ROWS, MAX_RANGES_PER_CELL, buildAuditSearchTargets, clampAuditHitIndex, searchAuditRows } from "./auditSearch";
import type { AuditCell, AuditRow } from "./audit";
import { matchLiteral } from "./textMatch";

const DEV = "c_dev:ns1";
const PROD = "c_prod:ns1";
const ENVS = [DEV, PROD];

function cell(value: string | undefined): AuditCell {
  return value === undefined ? { exists: false } : { exists: true, value, valueType: "string", parseStatus: "ok" };
}

function row(id: string, dataId: string, key: string, values: Record<string, string | undefined>): AuditRow {
  return {
    id,
    providerType: "nacos",
    namespace: "ns1",
    group: "DEFAULT_GROUP",
    dataId,
    key,
    status: "consistent",
    values: { [DEV]: cell(values[DEV]), [PROD]: cell(values[PROD]) },
    originalDataIds: { [DEV]: dataId, [PROD]: dataId },
  };
}

describe("searchAuditRows · 基本命中", () => {
  it("空词与全空格词都不搜", () => {
    const rows = [row("r1", "a.yml", "server.port", { [DEV]: "8080", [PROD]: "8080" })];
    for (const term of ["", "   ", "\t"]) {
      const result = searchAuditRows(rows, ENVS, term, "all");
      expect(result.active).toBe(false);
      expect(result.matchedRowCount).toBe(0);
      expect(result.scannedRowCount).toBe(rows.length); // 没词也要把作用域说清
    }
  });

  it("值命中：只在 dev 出现的值只标 dev 列", () => {
    const rows = [row("r1", "a.yml", "redis.host", { [DEV]: "10.1.2.3", [PROD]: "10.9.9.9" })];
    const result = searchAuditRows(rows, ENVS, "10.1.2.3", "all");
    expect(result.matchedRowIds).toEqual(["r1"]);
    const hit = result.rowHits.get("r1")!;
    expect(hit.cells.map((c) => c.envId)).toEqual([DEV]);
    expect(hit.hitEnvIds).toEqual([DEV]);
    expect(result.perEnvCounts).toEqual({ [DEV]: 1 });
    expect(result.truncatedCells).toBe(0);
  });

  it("大小写不敏感，且与 matchLiteral 同一份口径", () => {
    const rows = [row("r1", "Gateway.yaml", "gateway.route", { [DEV]: "GateWay", [PROD]: "gateway" })];
    const result = searchAuditRows(rows, ENVS, "gateway", "all");
    // 同一词在 dataId / key / 两格各命中 1 处
    const hit = result.rowHits.get("r1")!;
    expect(hit.dataIdRanges.length).toBe(1);
    expect(hit.keyRanges.length).toBe(1);
    expect(hit.cells.length).toBe(2);
    expect(hit.count).toBe(4);
    expect(hit.cells[0].ranges).toEqual(matchLiteral("GateWay", "gateway"));
    expect(result.perEnvCounts[DEV]).toBe(1);
    expect(result.perEnvCounts[PROD]).toBe(1);
  });

  it("缺失的环境不参与命中（不拿 exists:false 的空串去匹配）", () => {
    const rows = [row("r1", "a.yml", "k", { [DEV]: "abc", [PROD]: undefined })];
    const result = searchAuditRows(rows, ENVS, "abc", "value");
    expect(result.rowHits.get("r1")!.cells.map((c) => c.envId)).toEqual([DEV]);
    expect(result.rowHits.get("r1")!.count).toBe(1);
  });
});

describe("searchAuditRows · 匹配范围三档", () => {
  const rows = [row("r1", "timeout.yml", "connect.timeout", { [DEV]: "3000", [PROD]: "timeout=1" })];

  it("仅名称：值里的词不命中，dataId/key 命中", () => {
    const result = searchAuditRows(rows, ENVS, "timeout", "name");
    expect(result.matchedRowIds).toEqual(["r1"]);
    const hit = result.rowHits.get("r1")!;
    expect(hit.cells).toHaveLength(0);
    expect(hit.dataIdRanges.length).toBe(1);
    expect(hit.keyRanges.length).toBe(1);
    expect(hit.count).toBe(2);
  });

  it("仅值：名称里的词不命中，格子里的词命中", () => {
    const nameOnly = searchAuditRows(rows, ENVS, "timeout", "value");
    expect(nameOnly.rowHits.get("r1")!.dataIdRanges).toHaveLength(0);
    expect(nameOnly.rowHits.get("r1")!.cells.map((c) => c.envId)).toEqual([PROD]);
    expect(nameOnly.matchedRowCount).toBe(1);
  });

  it("仅名称时，只有值命中的行不进结果", () => {
    const valueOnly = [row("r2", "a.yml", "k", { [DEV]: "10.1.2.3" })];
    expect(searchAuditRows(valueOnly, ENVS, "10.1.2.3", "name").matchedRowCount).toBe(0);
    expect(searchAuditRows(valueOnly, ENVS, "10.1.2.3", "all").matchedRowCount).toBe(1);
  });
});

describe("searchAuditRows · 行序与作用域", () => {
  const rows = [row("r3", "z.yml", "k", { [DEV]: "x" }), row("r1", "a.yml", "k", { [DEV]: "x" }), row("r2", "m.yml", "k", { [DEV]: "y" })];

  it("matchedRowIds 跟随传入行序（排序变了导航序跟着变，不在搜索层重排）", () => {
    expect(searchAuditRows(rows, ENVS, "x", "all").matchedRowIds).toEqual(["r3", "r1"]);
    const reversed = [...rows].reverse();
    expect(searchAuditRows(reversed, ENVS, "x", "all").matchedRowIds).toEqual(["r1", "r3"]);
  });

  it("scannedRowCount 与 scopeRowCount 一致（未触顶时）", () => {
    const result = searchAuditRows(rows, ENVS, "x", "all");
    expect(result.scannedRowCount).toBe(3);
    expect(result.scopeRowCount).toBe(3);
    expect(result.capped).toBe(false);
  });

  it("触顶：只扫前 MAX_AUDIT_SEARCH_ROWS 行，capped 说真话", () => {
    const many = Array.from({ length: MAX_AUDIT_SEARCH_ROWS + 10 }, (_, i) =>
      row(`r${i}`, `a${i}.yml`, "k", { [DEV]: i === MAX_AUDIT_SEARCH_ROWS + 5 ? "needle" : "x" })
    );
    const result = searchAuditRows(many, ENVS, "needle", "all");
    expect(result.capped).toBe(true);
    expect(result.scannedRowCount).toBe(MAX_AUDIT_SEARCH_ROWS);
    expect(result.scopeRowCount).toBe(many.length);
    expect(result.matchedRowCount).toBe(0); // 唯一命中在窗口外，必须扫不到而不是假装扫过
  });

  it("5000 行 × 6 列的规模单次搜索不成卡顿（回归防线，不是刷指标）", () => {
    const envs = Array.from({ length: 6 }, (_, i) => `c${i}:ns`);
    const wide: AuditRow[] = Array.from({ length: MAX_AUDIT_SEARCH_ROWS }, (_, i) => ({
      id: `r${i}`,
      providerType: "nacos",
      namespace: "ns",
      group: "DEFAULT_GROUP",
      dataId: `svc-${i}.yml`,
      key: `server.port.${i % 40}`,
      status: "consistent",
      values: Object.fromEntries(envs.map((e, k) => [e, cell(`${10000 + i + k}.value.text`)])),
      originalDataIds: Object.fromEntries(envs.map((e) => [e, `svc-${i}.yml`])),
    }));
    const started = performance.now();
    const result = searchAuditRows(wide, envs, "value", "all");
    const elapsed = performance.now() - started;
    expect(result.matchedRowCount).toBe(MAX_AUDIT_SEARCH_ROWS);
    expect(elapsed).toBeLessThan(1500);
  });
});

describe("searchAuditRows · 单格区间上限", () => {
  it("200 处命中只画前 20 段，计数仍为 200，truncatedCells 记数", () => {
    const big = "ab ".repeat(200).trim(); // 200 处 "ab"
    const rows = [row("r1", "big.txt", "__document", { [DEV]: big, [PROD]: "none" })];
    const result = searchAuditRows(rows, ENVS, "ab", "value");
    const hit = result.rowHits.get("r1")!;
    const devCell = hit.cells.find((c) => c.envId === DEV)!;
    expect(devCell.count).toBe(200);
    expect(devCell.ranges).toHaveLength(MAX_RANGES_PER_CELL);
    expect(devCell.truncated).toBe(true);
    expect(result.truncatedCells).toBe(1);
    // 徽标读的是「这一列画得出多少个红底」，不是真实总数：写 200 而格子里只有 20 段是自相矛盾。
    // 真实总数仍留在 cell.count（title 与「每格只标前 20 处」的文案靠它）。
    expect(result.perEnvCounts[DEV]).toBe(MAX_RANGES_PER_CELL);
    expect(result.perEnvCounts[PROD]).toBeUndefined();
  });

  it("处数只有一个来源：徽标之和 + 名称命中 = 可导航的 target 数", () => {
    // 与界面夹具同源：同一格出现两次、另一格一次，过去这里会同时报「3 处」和「1/2」
    const rows = [row("r1", "app.yaml", "server.token", { [DEV]: "alpha alpha", [PROD]: "alpha" })];
    const result = searchAuditRows(rows, ENVS, "alpha", "all");
    const targets = buildAuditSearchTargets(result, ENVS);
    expect(Object.values(result.perEnvCounts).reduce((a, b) => a + b, 0)).toBe(targets.length);
    expect(targets).toHaveLength(3);
    expect(result.matchedRowCount).toBe(1);
  });
});

describe("buildAuditSearchTargets · 导航序列", () => {
  it("行内顺序 = dataId → key → 各格子（按列序），跨行按命中行序", () => {
    // r1 只有格子命中（dataId/key 里没有 n1）；r2 名称与值都命中，DEV 缺行不参与
    const rows = [row("r1", "svc.yml", "k", { [DEV]: "n1", [PROD]: "n1" }), row("r2", "n1.yml", "n1", { [DEV]: undefined, [PROD]: "n1x" })];
    const result = searchAuditRows(rows, ENVS, "n1", "all");
    const targets = buildAuditSearchTargets(result, ENVS);
    expect(targets).toEqual([
      { rowId: "r1", envId: DEV, kind: "cell", rangeIndex: 0 },
      { rowId: "r1", envId: PROD, kind: "cell", rangeIndex: 0 },
      { rowId: "r2", envId: null, kind: "dataId", rangeIndex: 0 },
      { rowId: "r2", envId: null, kind: "key", rangeIndex: 0 },
      { rowId: "r2", envId: PROD, kind: "cell", rangeIndex: 0 },
    ]);
  });

  it("一个位置内多次命中逐处展开：格内按区间序，不是一格一条", () => {
    const rows = [row("r1", "a.yml", "k.k", { [DEV]: "nu nu nu", [PROD]: "nu" })];
    const result = searchAuditRows(rows, ENVS, "nu", "value");
    expect(buildAuditSearchTargets(result, ENVS)).toEqual([
      { rowId: "r1", envId: DEV, kind: "cell", rangeIndex: 0 },
      { rowId: "r1", envId: DEV, kind: "cell", rangeIndex: 1 },
      { rowId: "r1", envId: DEV, kind: "cell", rangeIndex: 2 },
      { rowId: "r1", envId: PROD, kind: "cell", rangeIndex: 0 },
    ]);
  });

  it("名称列也逐处：一个 dataId 里两处命中就是两个停靠位", () => {
    const rows = [row("r1", "nu.nu.yml", "k", { [DEV]: "x" })];
    const result = searchAuditRows(rows, ENVS, "nu", "name");
    expect(buildAuditSearchTargets(result, ENVS)).toEqual([
      { rowId: "r1", envId: null, kind: "dataId", rangeIndex: 0 },
      { rowId: "r1", envId: null, kind: "dataId", rangeIndex: 1 },
    ]);
  });

  it("未搜索时没有目标", () => {
    expect(buildAuditSearchTargets(searchAuditRows([], ENVS, "", "all"), ENVS)).toEqual([]);
  });
});

describe("clampAuditHitIndex", () => {
  it("空集合返回 -1；越界回绕；负数从尾算", () => {
    expect(clampAuditHitIndex(0, 0)).toBe(-1);
    expect(clampAuditHitIndex(7, 3)).toBe(1);
    expect(clampAuditHitIndex(-1, 3)).toBe(2);
    expect(clampAuditHitIndex(2, 3)).toBe(2);
  });
});
