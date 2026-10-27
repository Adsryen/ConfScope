/**
 * @vitest-environment jsdom
 *
 * r111 审计矩阵大数据：量化判据的常驻测试。
 *
 * 判据来源：.trellis/tasks/10-27-r111-audit-matrix-large-data/prd.md「量化判据（测量前定死）」。
 * 本文件承载其中可在单测环境复现的部分：
 *   - C3 DOM 节点数上限（DOM 树与环境无关，jsdom 与真浏览器同值，交叉核对用）；
 *   - R6 定性守卫：滚动不重算矩阵、排序只重算一次（spy 调用计数）；
 *   - 大数据下的行定位 / 排序正确性 / 滚动位置记忆 / 悬停全文（历史行为不许回归）。
 * 首屏耗时（C1）、更新耗时（C2）、堆（C4）、掉帧（C5）是真浏览器指标，
 * 由 research/browser/ 的 harness 量出（c 复跑确认）；jsdom 没有布局引擎，不在这里假装有耗时。
 *
 * 规模档位（行 × 列）：S1 = 500 行 × 4 列；S2' = 2000 行 × 6 列（前端环境列数硬上限 6）。
 */
import { fireEvent, render, screen, waitFor } from "../../src/test/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import AuditView from "../../src/components/AuditView";
import { clearViewState, writeViewState } from "../../src/lib/viewState";
import type { AuditSource } from "../../src/lib/audit";
import type { Connection } from "../../src/store/connections";

// ── mock 边界：只替 API 与审计聚合（打 spy），其余走真实实现 ──
const apiMocks = vi.hoisted(() => ({
  listAllConfigs: vi.fn(),
  getConfig: vi.fn(),
}));

const auditLibMocks = vi.hoisted(() => ({
  buildAuditMatrix: vi.fn(),
}));

vi.mock("../../src/api/nacos", async () => {
  const actual = await vi.importActual<typeof import("../../src/api/nacos")>("../../src/api/nacos");
  return { ...actual, listAllConfigs: apiMocks.listAllConfigs, getConfig: apiMocks.getConfig };
});

vi.mock("../../src/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/audit")>();
  return { ...actual, buildAuditMatrix: auditLibMocks.buildAuditMatrix };
});

// 真实现延迟解析（vi.mock 生效后，本文件的直接导入会拿到 spy，真函数只能走 importActual）
let realBuildAuditMatrix: (typeof import("../../src/lib/audit"))["buildAuditMatrix"];
beforeAll(async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/audit")>("../../src/lib/audit");
  realBuildAuditMatrix = actual.buildAuditMatrix;
});

// mock i18n（与 AuditView.test.tsx 同一张映射表，测量断言不依赖文案细节）
vi.mock("../../src/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const map: Record<string, string> = {
        "audit.runAudit": "Run Audit",
        "audit.atLeastTwo": "At least 2 environments required",
        "audit.noData": "No config data retrieved",
        "audit.partialError": "Some configs failed to load",
        "audit.configLoadFailedValue": "Config Load Failed",
        "audit.totalConfigs": `${params?.count ?? 0} items`,
        "audit.filter": "Filter",
        "audit.configItem": "Config Item",
        "audit.selectHint": "Select envs and run.",
        "audit.statusConsistent": "Consistent",
        "audit.statusPartial": "Partial",
        "audit.statusInconsistent": "Inconsistent",
        "audit.statusMissing": "Missing",
        "audit.statusParseError": "Parse Error",
        "audit.statusIgnored": "Ignored",
        "audit.addEnv": "+ Env",
        "audit.setBaseline": "Set as baseline",
        "audit.close": "Close",
        "audit.detailMissing": "(Missing)",
        "audit.jumpToDiff": "Jump to Diff",
        "app.audit": "Audit Matrix",
        "app.auditPlanned": "Planned for multi-environment consistency matrix.",
        "app.namespace": "Namespace",
        "diff.noConnection": "No connections",
        "connection.project": "Project",
        "common.delete": "Delete",
        "common.loading": "Loading...",
        "common.copyError": "Copy Error",
        "audit.scanning": "Scanning... {count} loaded",
      };
      const text = map[key] ?? key;
      if (!params) return text;
      return Object.entries(params).reduce((acc, [name, value]) => acc.replace(new RegExp(`\\{${name}\\}`, "g"), String(value)), text);
    },
  }),
}));

vi.mock("../../src/lib/errorCenter", () => ({
  reportError: vi.fn(),
}));

vi.mock("../../src/lib/export", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/export")>("../../src/lib/export");
  return {
    ...actual,
    exportAuditCSV: vi.fn(),
    exportAuditJSON: vi.fn(),
    downloadFile: vi.fn(),
  };
});

// ── 数据夹具（与 research/seed.mjs、research/browser/measure-main.tsx 同一生成规则）──
const S1 = { configs: 500, envs: 4, prefix: "r111-a" } as const;
const S2 = { configs: 2000, envs: 6, prefix: "r111-b" } as const; // S2'：UI 列数上限 6

const pad = (n: number) => String(n).padStart(4, "0");
const dataIdFor = (prefix: string, i: number) => `${prefix}-${pad(i)}.properties`;
const keyFor = (i: number) => `key-${pad(i)}`;
function valueFor(i: number, envIdx: number): number {
  // 与造数脚本一致：(i + j) % 7 == 0 时值不同 → 该行为 inconsistent
  return (i + envIdx) % 7 === 0 ? 9000 + i : 8000 + i;
}

function makeSources(scale: { configs: number; envs: number; prefix: string }): AuditSource[] {
  const sources: AuditSource[] = [];
  for (let j = 1; j <= scale.envs; j += 1) {
    for (let i = 1; i <= scale.configs; i += 1) {
      sources.push({
        envId: `env-${j}:${scale.prefix}-${j}`,
        label: `环境${j}`,
        providerType: "nacos",
        namespace: `${scale.prefix}-${j}`,
        group: "DEFAULT_GROUP",
        dataId: dataIdFor(scale.prefix, i),
        entries: [
          {
            key: keyFor(i),
            value: String(valueFor(i, j)),
            valueType: "number" as const,
            sourcePath: keyFor(i),
            parseStatus: "ok" as const,
          },
        ],
      });
    }
  }
  return sources;
}

function makeConnections(scale: { envs: number; prefix: string }): Connection[] {
  return Array.from(
    { length: scale.envs },
    (_, k) =>
      ({
        id: `r111-env-${k + 1}`,
        name: `env-${k + 1}`,
        baseUrl: "http://localhost:8848",
        provider: "nacos",
        // sourceType 只有 "nacos | local-snapshot" 两个取值（src/store/connections.ts:31），
        // 早先写的 "nacos-online" 能跑是因为类型在运行时被抹掉，tsc -p tsconfig.tests.json 会判红。
        sourceType: "nacos",
        projectName: "r111-proj",
        environmentName: `环境${k + 1}`,
        sourceName: "fixture",
        defaultNamespace: `${scale.prefix}-${k + 1}`,
        authType: "none",
        username: "",
        password: "",
      }) as Connection
  );
}

function wireFixtures(scale: { configs: number; envs: number; prefix: string }): void {
  apiMocks.listAllConfigs.mockImplementation(async (_conn, _ns, _dataId, _group) => {
    const items = Array.from({ length: scale.configs }, (_, i) => ({
      dataId: dataIdFor(scale.prefix, i + 1),
      group: "DEFAULT_GROUP",
      content: "",
      configType: "properties",
    }));
    const pages = Math.ceil(scale.configs / 500);
    return { items, pagesAvailable: pages, loadedPages: pages, failedPages: [], truncated: false };
  });
  apiMocks.getConfig.mockImplementation(async (_conn, ns: string, dataId: string) => {
    const i = Number(dataId.match(/(\d+)\.properties$/)?.[1] ?? 0);
    const j = Number(ns.match(/-(\d+)$/)?.[1] ?? 1);
    return `${keyFor(i)}=${valueFor(i, j)}\n`;
  });
}

function matrixBody(): HTMLElement {
  const el = document.querySelector<HTMLElement>(".audit-matrix-body");
  if (!el) throw new Error("矩阵容器不存在");
  return el;
}

function renderedRowKeys(): string[] {
  return Array.from(document.querySelectorAll(".audit-matrix-body .audit-matrix-row .audit-key")).map((el) => el.textContent ?? "");
}

async function runAuditAndWaitRows(): Promise<void> {
  fireEvent.click(screen.getByText("Run Audit"));
  await waitFor(
    () => {
      expect(document.querySelector(".audit-matrix-body .audit-matrix-row")).toBeTruthy();
    },
    { timeout: 30000 }
  );
}

function clickSort(key: "key" | "dataId" | "status"): void {
  const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === key);
  if (!btn) throw new Error(`排序按钮 ${key} 找不到`);
  fireEvent.click(btn);
}

const countMatrixDom = () => document.querySelectorAll(".audit-matrix *").length;

beforeEach(async () => {
  clearViewState();
  apiMocks.listAllConfigs.mockReset();
  apiMocks.getConfig.mockReset();
  auditLibMocks.buildAuditMatrix.mockReset();
  auditLibMocks.buildAuditMatrix.mockImplementation(realBuildAuditMatrix);
});

describe("r111 审计矩阵大数据 · 聚合层（lib，node 读数）", () => {
  it("两档规模行数不丢不漏，并给出 buildAuditMatrix 耗时读数", () => {
    for (const [label, configs, envs] of [
      ["S1 500×4", 500, 4],
      ["S2 2000×8", 2000, 8],
    ] as const) {
      const sources = makeSources({ configs, envs, prefix: "r111-x" });
      const rows = realBuildAuditMatrix(sources);
      expect(rows.length).toBe(configs);
      expect(new Set(rows.map((r) => r.dataId)).size).toBe(configs);

      // 耗时读数：1 次热身 + 3 次取中位（判据不设 lib 层时间线，只留可复现读数）
      realBuildAuditMatrix(sources);
      const times = [1, 2, 3].map(() => {
        const t0 = performance.now();
        realBuildAuditMatrix(sources);
        return performance.now() - t0;
      });
      const median = [...times].sort((a, b) => a - b)[1];
      console.log(`[r111] buildAuditMatrix ${label}: 中位 ${median.toFixed(1)} ms（${times.map((t) => t.toFixed(1)).join(" / ")}）`);
      expect(median).toBeGreaterThan(0);
    }
  });
});

describe("r111 审计矩阵大数据 · S1（500 行 × 4 列）", () => {
  it("C3：矩阵区 DOM 节点数 ≤ 12000", async () => {
    wireFixtures(S1);
    render(<AuditView connections={makeConnections(S1)} />);
    await runAuditAndWaitRows();
    const nodes = countMatrixDom();
    console.log(`[r111] C3 S1: 矩阵区 DOM 节点 ${nodes}`);
    expect(nodes).toBeLessThanOrEqual(12000);
  });
});

describe("r111 审计矩阵大数据 · S2'（2000 行 × 6 列）", () => {
  it("C3：矩阵区 DOM 节点数 ≤ 16000", async () => {
    wireFixtures(S2);
    render(<AuditView connections={makeConnections(S2)} />);
    // 默认只挂 4 个环境，补齐到 6（前端列数上限）
    fireEvent.click(screen.getByText("+ Env"));
    fireEvent.click(screen.getByText("+ Env"));
    await waitFor(() => {
      expect(document.querySelectorAll(".audit-env-card").length).toBe(6);
    });
    await runAuditAndWaitRows();
    const nodes = countMatrixDom();
    console.log(`[r111] C3 S2': 矩阵区 DOM 节点 ${nodes}（逻辑行 2000）`);
    expect(nodes).toBeLessThanOrEqual(16000);
  });

  it("任意逻辑行都能按滚动定位（顶部 / 中部 / 底部），值格保留悬停全文", async () => {
    wireFixtures(S2);
    render(<AuditView connections={makeConnections(S2)} />);
    fireEvent.click(screen.getByText("+ Env"));
    fireEvent.click(screen.getByText("+ Env"));
    await runAuditAndWaitRows();
    const body = matrixBody();

    for (const idx of [0, 1000, 1999]) {
      body.scrollTop = Math.max(0, idx * 48 - 96); // 行高 48px（styles.css 轮34 实测口径）
      fireEvent.scroll(body);
      await waitFor(
        () => {
          expect(renderedRowKeys()).toContain(keyFor(idx + 1));
        },
        { timeout: 10000 }
      );
    }

    // 悬停全文守卫：每个值格都有 title（历史轮次钉过的行为，大数据下不许丢）
    for (const cell of document.querySelectorAll(".audit-matrix-body .audit-cell.value")) {
      expect(cell.hasAttribute("title")).toBe(true);
    }
  });

  it("R6：审计完成后 100 次滚动不重算矩阵，一次排序不重新取数", async () => {
    wireFixtures(S2);
    render(<AuditView connections={makeConnections(S2)} />);
    fireEvent.click(screen.getByText("+ Env"));
    fireEvent.click(screen.getByText("+ Env"));
    await runAuditAndWaitRows();

    expect(auditLibMocks.buildAuditMatrix).toHaveBeenCalledTimes(1);
    const listCallsAfterAudit = apiMocks.listAllConfigs.mock.calls.length;

    const body = matrixBody();
    for (let i = 0; i < 100; i += 1) {
      body.scrollTop = (body.scrollTop + 37) % 8000;
      fireEvent.scroll(body);
    }
    expect(auditLibMocks.buildAuditMatrix).toHaveBeenCalledTimes(1);

    // 断言「排序后首行」前先把窗口移回顶部：窗口化渲染只挂可见行，DOM 首行 = 窗口首行，
    // 上面 100 次滚动把 scrollTop 留在了 3700，不移回顶部看到的就是第 68 行。
    body.scrollTop = 0;
    fireEvent.scroll(body);

    const t0 = performance.now();
    clickSort("key");
    await waitFor(
      () => {
        expect(renderedRowKeys()[0]).toBe(keyFor(1));
      },
      { timeout: 15000 }
    );
    const sortMs = performance.now() - t0;
    console.log(`[r111] C2 参考值（jsdom，非真浏览器口径）：排序 ${sortMs.toFixed(0)} ms`);
    expect(auditLibMocks.buildAuditMatrix).toHaveBeenCalledTimes(1);
    expect(apiMocks.listAllConfigs.mock.calls.length).toBe(listCallsAfterAudit);
    // 本用例是 spy 计数断言，不是耗时断言（真浏览器 C2 由 research/browser/ 单独量）。
    // jsdom 里首次 localeCompare 要拉起 ICU，2000 行排序实测 ~4.5s（真机同规模 ~55ms），
    // 5s 默认预算扣掉热身渲染后不够，显式放宽到 20s，断言本身不收口。
  }, 20000);

  it("排序正确性：key 升序首行为 key-0001，dataId 升序首行为最小 dataId", async () => {
    wireFixtures(S2);
    render(<AuditView connections={makeConnections(S2)} />);
    fireEvent.click(screen.getByText("+ Env"));
    fireEvent.click(screen.getByText("+ Env"));
    await runAuditAndWaitRows();

    clickSort("key");
    await waitFor(
      () => {
        expect(renderedRowKeys()[0]).toBe(keyFor(1));
      },
      { timeout: 15000 }
    );

    clickSort("dataId");
    await waitFor(
      () => {
        const first = document.querySelector(".audit-matrix-body .audit-matrix-row .audit-dataid");
        expect(first?.textContent).toBe(dataIdFor("r111-b", 1));
      },
      { timeout: 15000 }
    );
  });

  it("滚动位置记忆在大数据下仍按像素恢复", async () => {
    wireFixtures(S2);
    writeViewState("audit.scroll.matrix", 9600); // 第 200 行位置（48px/行）
    render(<AuditView connections={makeConnections(S2)} />);
    fireEvent.click(screen.getByText("+ Env"));
    fireEvent.click(screen.getByText("+ Env"));
    await runAuditAndWaitRows();

    const body = matrixBody();
    await waitFor(
      () => {
        expect(body.scrollTop).toBe(9600);
      },
      { timeout: 3000 }
    );
  });
});
