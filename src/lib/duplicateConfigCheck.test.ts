/**
 * 跨配置重复检查（r110 第一版）纯函数测试。
 *
 * 表驱动：每个向量同时给「应判重复」与「不该报」两侧，防误报与漏报各占一半。
 * 口径钉子：
 * - 「不同配置」= 归一化 group|dataId 身份（与 audit.rowId 同口径，不含 namespace）；
 * - 同一配置跨环境的值漂移不报（归审计矩阵 status 职责）；
 * - 忽略清单只作用于 ①（keyDup），②（exactBody）是全文判据不受影响。
 */
import { describe, expect, it } from "vitest";
import { checkDuplicateConfigs } from "./duplicateConfigCheck";
import type { AuditSource } from "./audit";
import type { ConfigEntry } from "./normalize";

function entry(key: string, value: string, parseStatus: ConfigEntry["parseStatus"] = "ok"): ConfigEntry {
  return {
    key,
    value,
    valueType: "string",
    sourcePath: key,
    parseStatus,
    ...(parseStatus === "error" ? { parseError: "boom" } : {}),
  };
}

function source(envId: string, dataId: string, entries: ConfigEntry[], overrides: Partial<AuditSource> = {}): AuditSource {
  return {
    envId,
    label: envId,
    providerType: "nacos",
    namespace: "public",
    group: "DEFAULT_GROUP",
    dataId,
    entries,
    ...overrides,
  };
}

describe("checkDuplicateConfigs ① keyDup", () => {
  it("同 key 两个配置、值相同 → sameValue 组", () => {
    const result = checkDuplicateConfigs([
      source("c1:ns", "a.yaml", [entry("db.host", "1.1.1.1"), entry("only.a", "1")]),
      source("c2:ns", "b.yaml", [entry("db.host", "1.1.1.1"), entry("only.b", "2")]),
    ]);
    expect(result.groups).toHaveLength(1);
    const [g] = result.groups;
    expect(g.criterion).toBe("keyDup");
    expect(g.tier).toBe("sameValue");
    expect(g.key).toBe("db.host");
    expect(g.configCount).toBe(2);
    expect(g.locations.map((l) => l.envId)).toEqual(["c1:ns", "c2:ns"]);
    expect(result.checkedKeys).toBe(3); // db.host / only.a / only.b 都参与比较
    expect(result.checkedSources).toBe(2);
  });

  it("同 key 两个配置、值不同 → diffValue 组，且排在 sameValue 组之前", () => {
    const result = checkDuplicateConfigs([
      source("c1:ns", "a.yaml", [entry("db.host", "1.1.1.1"), entry("app.name", "svc-a")]),
      source("c2:ns", "b.yaml", [entry("db.host", "2.2.2.2"), entry("app.name", "svc-a")]),
    ]);
    expect(result.groups.map((g) => [g.key, g.tier])).toEqual([
      ["db.host", "diffValue"],
      ["app.name", "sameValue"],
    ]);
  });

  it("同 key 三个配置（两同值一异值）→ diffValue 且 configCount=3", () => {
    const result = checkDuplicateConfigs([
      source("c1:ns", "a.yaml", [entry("db.host", "1.1.1.1"), entry("only.a", "1")]),
      source("c2:ns", "b.yaml", [entry("db.host", "1.1.1.1"), entry("only.b", "2")]),
      source("c3:ns", "c.yaml", [entry("db.host", "9.9.9.9"), entry("only.c", "3")]),
    ]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].tier).toBe("diffValue");
    expect(result.groups[0].configCount).toBe(3);
    expect(result.groups[0].locations).toHaveLength(3);
  });

  it("同一 dataId 跨两个环境（含不同 namespace）→ 不报：那是审计的 inconsistent", () => {
    const result = checkDuplicateConfigs([
      source("c1:ns-a", "a.yaml", [entry("db.host", "1.1.1.1")], { namespace: "ns-a" }),
      source("c2:ns-b", "a.yaml", [entry("db.host", "2.2.2.2")], { namespace: "ns-b" }),
    ]);
    expect(result.groups).toHaveLength(0);
  });

  it("同 key 只在一个配置里 → 不报", () => {
    const result = checkDuplicateConfigs([
      source("c1:ns", "a.yaml", [entry("db.host", "1.1.1.1")]),
      source("c2:ns", "b.yaml", [entry("other.key", "x")]),
    ]);
    expect(result.groups).toHaveLength(0);
  });

  it("忽略通配模式排除该 key，且不计入 checkedKeys；② 不受忽略清单影响", () => {
    const sources = [
      source("c1:ns", "a.yaml", [entry("db.host", "1.1.1.1"), entry("app.name", "svc")]),
      source("c2:ns", "b.yaml", [entry("db.host", "2.2.2.2"), entry("app.name", "svc-x")]),
    ];
    const result = checkDuplicateConfigs(sources, { ignoredKeyPatterns: ["db.*"] });
    expect(result.groups.map((g) => g.key)).toEqual(["app.name"]);
    expect(result.checkedKeys).toBe(1); // db.host 被忽略，只剩 app.name
  });

  it("normalizeName 把两个 dataId 归一成同一身份 → 不报（负向量：与矩阵「同一份配置」口径一致）", () => {
    const normalize = (name: string) => name.replace(/-(dev|prod)(?=\.(?:yaml|json|properties)$)/, "");
    const result = checkDuplicateConfigs(
      [source("c1:ns", "app-dev.yaml", [entry("db.host", "1.1.1.1")]), source("c2:ns", "app-prod.yaml", [entry("db.host", "2.2.2.2")])],
      { normalizeName: normalize }
    );
    expect(result.groups).toHaveLength(0);
  });
});

describe("checkDuplicateConfigs ② exactBody", () => {
  it("归一化条目集全等（顺序无关）→ exactBody 组（关 ① 隔离 ②：正文全等必然所有共享 key 同值）", () => {
    const result = checkDuplicateConfigs(
      [
        source("c1:ns", "a.yaml", [entry("db.host", "1.1.1.1"), entry("app.name", "svc")]),
        source("c2:ns", "b.yaml", [entry("app.name", "svc"), entry("db.host", "1.1.1.1")]),
      ],
      { criteria: { keyDup: false } }
    );
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].criterion).toBe("exactBody");
    expect(result.groups[0].configCount).toBe(2);
  });

  it("正文全等时 ①② 会同时命中（两个共享 key 各一个 sameValue 组 + 一个 exactBody 组）", () => {
    const result = checkDuplicateConfigs([
      source("c1:ns", "a.yaml", [entry("db.host", "1.1.1.1"), entry("app.name", "svc")]),
      source("c2:ns", "b.yaml", [entry("app.name", "svc"), entry("db.host", "1.1.1.1")]),
    ]);
    expect(result.groups.map((g) => (g.criterion === "exactBody" ? "exactBody" : `${g.key}:${g.tier}`)).sort()).toEqual([
      "app.name:sameValue",
      "db.host:sameValue",
      "exactBody",
    ]);
  });

  it("一个条目不同 → ② 不报，① 只报那个值不同的共享 key", () => {
    const result = checkDuplicateConfigs([
      source("c1:ns", "a.yaml", [entry("db.host", "1.1.1.1"), entry("only.a", "x")]),
      source("c2:ns", "b.yaml", [entry("db.host", "2.2.2.2"), entry("only.b", "y")]),
    ]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].criterion).toBe("keyDup");
    expect(result.groups[0].key).toBe("db.host");
    expect(result.groups[0].tier).toBe("diffValue");
  });

  it("空配置（0 条目）不参与，两个空配置互不重复", () => {
    const result = checkDuplicateConfigs([source("c1:ns", "a.yaml", []), source("c2:ns", "b.yaml", [])]);
    expect(result.groups).toHaveLength(0);
  });

  it("解析失败的来源被 ② 跳过并计数；其余来源照常成组", () => {
    const result = checkDuplicateConfigs([
      source("c1:ns", "broken.yaml", [entry("__parse__", "Config Load Failed", "error")]),
      source("c2:ns", "a.yaml", [entry("db.host", "1.1.1.1")]),
      source("c3:ns", "b.yaml", [entry("db.host", "1.1.1.1")]),
    ]);
    expect(result.parseSkippedSources).toBe(1);
    const bodyGroups = result.groups.filter((g) => g.criterion === "exactBody");
    expect(bodyGroups).toHaveLength(1);
    expect(bodyGroups[0].locations.map((l) => l.envId).sort()).toEqual(["c2:ns", "c3:ns"]);
  });

  it("同一配置身份跨环境正文相同 → 不报（身份只有一个）", () => {
    const result = checkDuplicateConfigs([
      source("c1:ns-a", "a.yaml", [entry("db.host", "1.1.1.1")], { namespace: "ns-a" }),
      source("c2:ns-b", "a.yaml", [entry("db.host", "1.1.1.1")], { namespace: "ns-b" }),
    ]);
    expect(result.groups).toHaveLength(0);
  });
});

describe("checkDuplicateConfigs 组合行为", () => {
  it("criteria.keyDup=false → 只跑 ②，checkedKeys 为 0", () => {
    const result = checkDuplicateConfigs(
      [
        source("c1:ns", "a.yaml", [entry("db.host", "1.1.1.1"), entry("app.name", "svc")]),
        source("c2:ns", "b.yaml", [entry("app.name", "svc"), entry("db.host", "1.1.1.1")]),
      ],
      { criteria: { keyDup: false } }
    );
    expect(result.groups.map((g) => g.criterion)).toEqual(["exactBody"]);
    expect(result.checkedKeys).toBe(0);
  });

  it("排序：diffValue → sameValue → exactBody；同档 configCount 降序；重跑 id 稳定", () => {
    const sources = [
      source("c1:ns", "a.yaml", [entry("k.shared", "1"), entry("k.diff", "a"), entry("k.same", "x")]),
      source("c2:ns", "b.yaml", [entry("k.shared", "2"), entry("k.diff", "b"), entry("k.same", "x")]),
      source("c3:ns", "c.yaml", [entry("k.shared", "3"), entry("k.same", "x"), entry("body.key", "body")]),
      source("c4:ns", "d.yaml", [entry("k.same", "x"), entry("body.key", "body")]),
    ];
    const first = checkDuplicateConfigs(sources);
    // k.shared 三配置异值 → diffValue(3)；k.diff 两配置异值 → diffValue(2)；
    // k.same 四配置同值 → sameValue(4)；body.key 两配置同值 → sameValue(2)。
    // 同档按 configCount 降序；c3/c4 正文不同，② 不命中。
    expect(first.groups.map((g) => (g.criterion === "exactBody" ? "exactBody" : g.key))).toEqual([
      "k.shared",
      "k.diff",
      "k.same",
      "body.key",
    ]);
    expect(first.groups.map((g) => (g.criterion === "exactBody" ? "exactBody" : g.tier))).toEqual([
      "diffValue",
      "diffValue",
      "sameValue",
      "sameValue",
    ]);
    const second = checkDuplicateConfigs(sources);
    expect(second.groups.map((g) => g.id)).toEqual(first.groups.map((g) => g.id));
  });

  it("location 携带出口所需字段：connId / 原始 dataId / value（①）", () => {
    const result = checkDuplicateConfigs([
      source("c1:ns", "raw-a.yaml", [entry("db.host", "1.1.1.1")]),
      source("c2:ns", "raw-b.yaml", [entry("db.host", "2.2.2.2")]),
    ]);
    const [g] = result.groups;
    expect(g.locations[0]).toMatchObject({
      connId: "c1",
      envId: "c1:ns",
      namespace: "public",
      group: "DEFAULT_GROUP",
      dataId: "raw-a.yaml",
      value: "1.1.1.1",
    });
    expect(g.locations.every((l) => typeof l.sourceIndex === "number" && l.locKey.length > 0)).toBe(true);
  });

  it("durationMs 是有限非负数", () => {
    const result = checkDuplicateConfigs([source("c1:ns", "a.yaml", [entry("k", "1")]), source("c2:ns", "b.yaml", [entry("k", "2")])]);
    expect(Number.isFinite(result.durationMs)).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("checkDuplicateConfigs R5 规模（纯计算口径）", () => {
  // 取数耗时是 r109 的边界；这里只钉「拿到全量来源后的纯计算」不随规模劣化到不可同帧。
  // 断言是宽松上限（防 3 个数量级退化），精确读数归档在 r110 PRD「实测结论」。
  function makeScale(configs: number, envs: number): AuditSource[] {
    const sources: AuditSource[] = [];
    for (let e = 0; e < envs; e++) {
      for (let c = 0; c < configs; c++) {
        sources.push(
          source(`conn${e}:ns`, `cfg-${c}.yaml`, [
            entry("k.shared1", `v${e}`), // 跨所有配置、值随环境变 → diffValue 大组
            entry("k.shared2", "const"),
            entry(`k.only.c${c}`, `v${c}`),
          ])
        );
      }
    }
    return sources;
  }

  it("500 配置 × 4 环境（2000 来源）：毫秒~秒级完成，大组完整", () => {
    const result = checkDuplicateConfigs(makeScale(500, 4));
    expect(result.checkedSources).toBe(2000);
    const big = result.groups.find((g) => g.key === "k.shared1");
    expect(big).toBeTruthy();
    expect(big!.configCount).toBe(500);
    expect(big!.locations).toHaveLength(2000);
    expect(result.durationMs).toBeLessThan(5000);
  });

  it("2000 配置 × 6 环境（12000 来源）：仍在同帧可完成的上限内", () => {
    const result = checkDuplicateConfigs(makeScale(2000, 6));
    expect(result.checkedSources).toBe(12000);
    const big = result.groups.find((g) => g.key === "k.shared1");
    expect(big).toBeTruthy();
    expect(big!.configCount).toBe(2000);
    expect(result.durationMs).toBeLessThan(5000);
  });
});
