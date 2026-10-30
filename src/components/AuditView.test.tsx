/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AuditView from "./AuditView";
import { clearViewState, readViewState, writeViewState } from "../lib/viewState";
import { listAllConfigsBridge } from "../test/listAllConfigsBridge";
import type { Connection } from "../store/connections";

// mock API 模块
const apiMocks = vi.hoisted(() => ({
  listConfigs: vi.fn(),
  listAllConfigs: vi.fn(),
  getConfig: vi.fn(),
}));

const exportMocks = vi.hoisted(() => ({
  exportAuditCSV: vi.fn(),
  exportAuditJSON: vi.fn(),
  downloadFile: vi.fn(),
}));

vi.mock("../api/nacos", async () => {
  const actual = await vi.importActual<typeof import("../api/nacos")>("../api/nacos");
  return { ...actual, listConfigs: apiMocks.listConfigs, listAllConfigs: apiMocks.listAllConfigs, getConfig: apiMocks.getConfig };
});

vi.mock("../lib/export", async () => {
  const actual = await vi.importActual<typeof import("../lib/export")>("../lib/export");
  exportMocks.exportAuditCSV.mockImplementation(actual.exportAuditCSV);
  exportMocks.exportAuditJSON.mockImplementation(actual.exportAuditJSON);
  return {
    ...actual,
    exportAuditCSV: exportMocks.exportAuditCSV,
    exportAuditJSON: exportMocks.exportAuditJSON,
    downloadFile: exportMocks.downloadFile,
  };
});

// mock i18n
vi.mock("../i18n", () => ({
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
        "audit.allConfigs": "All configs",
        "audit.configItem": "Config Item",
        "audit.selectHint": "Select a project, configure environment sources, then click Run Audit.",
        "audit.statusConsistent": "Consistent",
        "audit.statusPartial": "Partial",
        "audit.statusInconsistent": "Inconsistent",
        "audit.statusMissing": "Missing",
        "audit.statusParseError": "Parse Error",
        "audit.statusIgnored": "Ignored",
        "audit.addEnv": "+ Env",
        "audit.settingsToggle": "Ignore Rules · Name Normalization",
        "audit.condExpand": "Show audit conditions",
        "audit.condCollapse": "Hide audit conditions",
        "audit.condSummaryAria": "Current audit conditions",
        "audit.condProject": "Project: {name}",
        "audit.condEnvs": "{count} environments",
        "audit.condIgnores": "{count} ignore rules",
        "audit.ignoreThis": "Ignore this item",
        "audit.ignoreThisShort": "Ignore",
        "audit.ignoredAdded": "Ignored {dataId} / {key}",
        "audit.ignoredAlready": "Already ignored",
        "audit.undo": "Undo",
        "audit.wrapCells": "Wrap cell text",
        "audit.ignoreRulesTitle": "Ignore Rules",
        "audit.ignoreRuleAll": "All",
        "audit.ignoreReasonPlaceholder": "Ignore reason",
        "audit.ignoreDataIdPlaceholder": "dataId filter (optional)",
        "audit.ignoreKeyPlaceholder": "key filter (optional)",
        "audit.addRule": "Add",
        "audit.normalizeTitle": "Name Normalization",
        "audit.normalizeEnabledLabel": "Enable name normalization",
        "audit.normalizePrefix": "Prefix Trim",
        "audit.normalizeSuffix": "Suffix Trim",
        "audit.normalizeReplace": "Exact Replace",
        "audit.normalizeDeleteHint": "delete",
        "audit.matchPattern": "Match pattern",
        "audit.replaceTo": "Replace with (leave empty to delete)",
        "audit.caseSensitive": "Case sensitive",
        "audit.addNormalizeRule": "Add Rule",
        "audit.jumpToDiff": "Jump to Diff",
        "audit.startApply": "Generate Change Plan",
        "audit.setBaseline": "Set as baseline",
        "audit.close": "Close",
        "audit.detailMissing": "(Missing)",
        "audit.export": "Export",
        "audit.exportCSV": "Export CSV",
        "audit.exportJSON": "Export JSON",
        "audit.sanitizeToggle": "Sanitize export",
        "app.audit": "Audit Matrix",
        "app.auditPlanned": "Planned for multi-environment consistency matrix.",
        "app.namespace": "Namespace",
        "diff.noConnection": "No connections",
        "connection.project": "Project",
        "common.delete": "Delete",
        "common.loading": "Loading...",
        "common.copyError": "Copy Error",
        "common.configListTruncated": "Scan cap reached: only the first {count} entries were fetched, results may be incomplete",
        "common.configListPartial": "Config list page(s) {pages} failed to load: only {count} entries fetched, results are incomplete",
        "audit.scanning": "Scanning... {count} loaded",
        // r139 跨环境内容搜索
        "audit.searchGroupAria": "Matrix content search",
        "audit.searchScopeGroupAria": "Search scope",
        "audit.searchScopeAll": "ScopeAll",
        "audit.searchScopeName": "ScopeName",
        "audit.searchScopeValue": "ScopeValue",
        "audit.searchPlaceholder": "Search matrix (Ctrl+F)",
        "audit.searchAriaLabel": "Search matrix content",
        "audit.searchPrev": "Previous match",
        "audit.searchNext": "Next match",
        "audit.searchNoHit": "No matches",
        "audit.searchRunAndSearch": "Run and search",
        "audit.searchNeedsAudit": "No audit run yet",
        "audit.searchHitsSummary": "{hits} hits in {total} rows across {envs} envs",
        "audit.searchOnlyHits": "Matching rows only",
        "audit.searchCapped": "capped at {max}, {rest} rows not searched",
        "audit.searchRangesTruncated": "{count} cells over {max} marks",
        "audit.searchScopeIncomplete": "scope incomplete",
        "audit.searchEnvCount": "{env}: {count} hits",
        "audit.searchHitSuffix": "{count} hits total",
        "audit.searchNoHitInScope": 'No "{term}" in {total} rows across {envs} envs',
      };
      const text = map[key] ?? key;
      if (!params) return text;
      return Object.entries(params).reduce((acc, [name, value]) => acc.replace(new RegExp(`\\{${name}\\}`, "g"), String(value)), text);
    },
  }),
}));

// mock errorCenter
vi.mock("../lib/errorCenter", () => ({
  reportError: vi.fn(),
}));

// 生成测试用连接
function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn-1",
    name: "dev-conn",
    baseUrl: "http://localhost:8848",
    provider: "nacos",
    sourceType: "nacos-online",
    projectName: "test-proj",
    environmentName: "开发",
    sourceName: "company-lan",
    defaultNamespace: "public",
    authType: "none",
    ...overrides,
  } as Connection;
}

describe("AuditView", () => {
  beforeEach(() => {
    // 视图状态存在模块内存里（R27）：用例之间必须隔离，否则上一条记住的项目/筛选会污染这一条
    clearViewState();
    // r110 重复检查的判据开关/忽略清单写 localStorage：用例之间清掉，避免跨用例污染
    localStorage.removeItem("cs.settings");
    apiMocks.listConfigs.mockReset();
    apiMocks.listAllConfigs.mockReset();
    apiMocks.getConfig.mockReset();
    // 组件已改用 listAllConfigs 聚合翻页：默认用单页 mock 桥接，保持既有分页夹具可用
    apiMocks.listAllConfigs.mockImplementation(listAllConfigsBridge(apiMocks.listConfigs));
    exportMocks.exportAuditCSV.mockClear();
    exportMocks.exportAuditJSON.mockClear();
    exportMocks.downloadFile.mockClear();
  });

  it("显示空状态提示当没有连接时", () => {
    render(<AuditView connections={[]} />);
    expect(screen.getByText("No connections")).toBeTruthy();
  });

  it("渲染环境选择卡片当有连接时", () => {
    const conns = [
      makeConnection({ id: "c1", name: "dev", environmentName: "开发" }),
      makeConnection({ id: "c2", name: "prod", environmentName: "生产" }),
    ];
    render(<AuditView connections={conns} />);
    expect(screen.getByText("Run Audit")).toBeTruthy();
    expect(screen.getByText("+ Env")).toBeTruthy();
  });

  it("显示错误当少于2个环境时点击执行审计", async () => {
    const conns = [makeConnection({ id: "c1", name: "dev" })];
    render(<AuditView connections={conns} />);
    fireEvent.click(screen.getByText("Run Audit"));
    await waitFor(() => {
      expect(screen.getByText("At least 2 environments required")).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "Copy Error" })).toBeTruthy();
  });

  it("渲染忽略规则设置区域", () => {
    const conns = [
      makeConnection({ id: "c1", name: "dev", environmentName: "开发" }),
      makeConnection({ id: "c2", name: "prod", environmentName: "生产" }),
    ];
    render(<AuditView connections={conns} />);
    // 点击设置展开 - 使用部分文本匹配
    const toggleBtn = screen.getByRole("button", { name: /Ignore Rules/i });
    fireEvent.click(toggleBtn);
    expect(screen.getByText("Ignore Rules")).toBeTruthy();
    expect(screen.getByText("Name Normalization")).toBeTruthy();
  });

  it("添加和删除忽略规则", () => {
    const conns = [
      makeConnection({ id: "c1", name: "dev", environmentName: "开发" }),
      makeConnection({ id: "c2", name: "prod", environmentName: "生产" }),
    ];
    render(<AuditView connections={conns} />);
    const toggleBtn = screen.getByRole("button", { name: /Ignore Rules/i });
    fireEvent.click(toggleBtn);

    // 添加忽略规则
    const reasonInput = screen.getByPlaceholderText("Ignore reason");
    fireEvent.change(reasonInput, { target: { value: "test reason" } });
    fireEvent.click(screen.getByText("Add"));
    expect(screen.getByText(/test reason/)).toBeTruthy();

    // 删除忽略规则
    const deleteButtons = screen.getAllByText("×");
    fireEvent.click(deleteButtons[deleteButtons.length - 1]);
    expect(screen.queryByText(/test reason/)).toBeNull();
  });

  it("添加和删除归一化规则", () => {
    const conns = [
      makeConnection({ id: "c1", name: "dev", environmentName: "开发" }),
      makeConnection({ id: "c2", name: "prod", environmentName: "生产" }),
    ];
    render(<AuditView connections={conns} />);
    const toggleBtn = screen.getByRole("button", { name: /Ignore Rules/i });
    fireEvent.click(toggleBtn);

    // 启用归一化
    fireEvent.click(screen.getByLabelText("Enable name normalization"));

    // 添加归一化规则
    const patternInput = screen.getByPlaceholderText("Match pattern");
    fireEvent.change(patternInput, { target: { value: "dev-" } });
    fireEvent.click(screen.getByText("Add Rule"));
    expect(screen.getByText(/dev-/)).toBeTruthy();
  });

  it("触发 onNavigateToDiff 回调当行被点击时", async () => {
    const onNavigate = vi.fn();
    const conns = [
      makeConnection({ id: "c1", name: "dev", environmentName: "开发" }),
      makeConnection({ id: "c2", name: "prod", environmentName: "生产" }),
    ];

    // mock API 返回配置
    apiMocks.listConfigs.mockResolvedValue({
      pageItems: [{ dataId: "app.yaml", group: "DEFAULT_GROUP", configType: "yaml" }],
      totalCount: 1,
    });
    apiMocks.getConfig.mockResolvedValue("server:\n  port: 8080");

    render(<AuditView connections={conns} onNavigateToDiff={onNavigate} />);
    fireEvent.click(screen.getByText("Run Audit"));

    await waitFor(() => {
      expect(screen.getByText("app.yaml")).toBeTruthy();
    });
  });

  it("starts an apply plan from a selected differing key", async () => {
    const onStartApply = vi.fn();
    const conns = [
      makeConnection({ id: "c1", name: "dev", environmentName: "Development", sourceName: "lan" }),
      makeConnection({ id: "c2", name: "prod", environmentName: "Production", sourceName: "cloud" }),
    ];

    apiMocks.listConfigs.mockResolvedValue({
      pageItems: [{ dataId: "app.yaml", group: "DEFAULT_GROUP", configType: "yaml" }],
      totalCount: 1,
    });
    apiMocks.getConfig.mockResolvedValueOnce("server:\n  port: 8080").mockResolvedValueOnce("server:\n  port: 9090");

    render(<AuditView connections={conns} onStartApply={onStartApply} />);
    fireEvent.click(screen.getByText("Run Audit"));

    fireEvent.click(await screen.findByText("server.port"));
    fireEvent.click(screen.getByRole("button", { name: "Generate Change Plan" }));

    expect(onStartApply).toHaveBeenCalledTimes(1);
    expect(onStartApply).toHaveBeenCalledWith({
      sourceType: "audit",
      scope: "key",
      source: {
        provider: "nacos",
        connectionId: "c1",
        connectionName: "dev",
        namespace: "public",
        label: "Development / dev / public",
      },
      target: {
        provider: "nacos",
        connectionId: "c2",
        connectionName: "prod",
        namespace: "public",
        label: "Production / prod / public",
      },
      items: [
        {
          provider: "nacos",
          connectionId: "c2",
          namespace: "public",
          group: "DEFAULT_GROUP",
          dataId: "app.yaml",
          key: "server.port",
          sourceRef: {
            provider: "nacos",
            connectionId: "c1",
            namespace: "public",
            group: "DEFAULT_GROUP",
            dataId: "app.yaml",
            key: "server.port",
          },
          targetRef: {
            provider: "nacos",
            connectionId: "c2",
            namespace: "public",
            group: "DEFAULT_GROUP",
            dataId: "app.yaml",
            key: "server.port",
          },
        },
      ],
      rangeSummary: {
        count: 1,
        skippedCount: 0,
        riskLevel: "low",
        riskReasons: [],
      },
      origin: {
        mode: "audit",
        returnMode: "audit",
      },
    });
  });

  it("keeps default Nacos namespace empty inside audit apply entries while labeling it as public", async () => {
    const onStartApply = vi.fn();
    const conns = [
      makeConnection({ id: "c1", name: "dev", environmentName: "Development", sourceName: "lan", defaultNamespace: "" }),
      makeConnection({ id: "c2", name: "prod", environmentName: "Production", sourceName: "cloud", defaultNamespace: "" }),
    ];

    apiMocks.listConfigs.mockResolvedValue({
      pageItems: [{ dataId: "app.yaml", group: "DEFAULT_GROUP", configType: "yaml" }],
      totalCount: 1,
    });
    apiMocks.getConfig.mockResolvedValueOnce("server:\n  port: 8080").mockResolvedValueOnce("server:\n  port: 9090");

    render(<AuditView connections={conns} onStartApply={onStartApply} />);
    fireEvent.click(screen.getByText("Run Audit"));

    fireEvent.click(await screen.findByText("server.port"));
    fireEvent.click(screen.getByRole("button", { name: "Generate Change Plan" }));

    expect(onStartApply).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          namespace: "",
          label: "Development / dev / public",
        }),
        target: expect.objectContaining({
          namespace: "",
          label: "Production / prod / public",
        }),
        items: [
          expect.objectContaining({
            namespace: "",
            sourceRef: expect.objectContaining({ namespace: "" }),
            targetRef: expect.objectContaining({ namespace: "" }),
          }),
        ],
      })
    );
  });

  it("preserves original source and target refs when normalized dataIds differ", async () => {
    const onStartApply = vi.fn();
    const conns = [
      makeConnection({ id: "c1", name: "dev", environmentName: "Development", sourceName: "lan" }),
      makeConnection({ id: "c2", name: "prod", environmentName: "Production", sourceName: "cloud" }),
    ];

    apiMocks.listConfigs
      .mockResolvedValueOnce({
        pageItems: [{ dataId: "dev-app.yaml", group: "DEFAULT_GROUP", configType: "yaml" }],
        totalCount: 1,
      })
      .mockResolvedValueOnce({
        pageItems: [{ dataId: "app.yaml", group: "DEFAULT_GROUP", configType: "yaml" }],
        totalCount: 1,
      });
    apiMocks.getConfig.mockResolvedValueOnce("server:\n  port: 8080").mockResolvedValueOnce("server:\n  port: 9090");

    render(<AuditView connections={conns} onStartApply={onStartApply} />);
    fireEvent.click(screen.getByRole("button", { name: /Ignore Rules/i }));
    fireEvent.click(screen.getByLabelText("Enable name normalization"));
    fireEvent.change(screen.getByPlaceholderText("Match pattern"), { target: { value: "dev-" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Rule" }));
    fireEvent.click(screen.getByText("Run Audit"));

    fireEvent.click(await screen.findByText("server.port"));
    fireEvent.click(screen.getByRole("button", { name: "Generate Change Plan" }));

    expect(onStartApply).toHaveBeenCalledTimes(1);
    const payload = onStartApply.mock.calls[0][0];
    expect(payload.items[0]).toMatchObject({
      provider: "nacos",
      connectionId: "c2",
      namespace: "public",
      group: "DEFAULT_GROUP",
      dataId: "app.yaml",
      key: "server.port",
      sourceRef: {
        provider: "nacos",
        connectionId: "c1",
        namespace: "public",
        group: "DEFAULT_GROUP",
        dataId: "dev-app.yaml",
        key: "server.port",
      },
      targetRef: {
        provider: "nacos",
        connectionId: "c2",
        namespace: "public",
        group: "DEFAULT_GROUP",
        dataId: "app.yaml",
        key: "server.port",
      },
    });
  });

  it("keeps the apply entry hidden without onStartApply and preserves Jump to Diff", async () => {
    const onNavigate = vi.fn();
    const conns = [
      makeConnection({ id: "c1", name: "dev", environmentName: "Development" }),
      makeConnection({ id: "c2", name: "prod", environmentName: "Production" }),
    ];

    apiMocks.listConfigs.mockResolvedValue({
      pageItems: [{ dataId: "app.yaml", group: "DEFAULT_GROUP", configType: "yaml" }],
      totalCount: 1,
    });
    apiMocks.getConfig.mockResolvedValueOnce("server:\n  port: 8080").mockResolvedValueOnce("server:\n  port: 9090");

    render(<AuditView connections={conns} onNavigateToDiff={onNavigate} />);
    fireEvent.click(screen.getByText("Run Audit"));

    fireEvent.click(await screen.findByText("server.port"));
    expect(screen.queryByRole("button", { name: "Generate Change Plan" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Jump to Diff" }));
    // 两侧独立携带各自的 namespace/group/dataId（右连接用其默认 namespace）
    expect(onNavigate).toHaveBeenCalledWith({
      leftConnId: "c1",
      rightConnId: "c2",
      left: { tenant: "public", group: "DEFAULT_GROUP", dataId: "app.yaml" },
      right: { tenant: "public", group: "DEFAULT_GROUP", dataId: "app.yaml" },
    });
  });

  it("localizes per-config load failure placeholder values", async () => {
    const conns = [
      makeConnection({ id: "c1", name: "dev", environmentName: "Development" }),
      makeConnection({ id: "c2", name: "prod", environmentName: "Production" }),
    ];

    apiMocks.listConfigs.mockResolvedValue({
      pageItems: [{ dataId: "app.yaml", group: "DEFAULT_GROUP" }],
      totalCount: 1,
    });
    apiMocks.getConfig.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("server:\n  port: 8080");

    render(<AuditView connections={conns} />);
    fireEvent.click(screen.getByText("Run Audit"));

    expect(await screen.findAllByText("Config Load Failed")).not.toHaveLength(0);
    expect(screen.queryByText("加载失败")).not.toBeInTheDocument();
  });

  it("审计按 pagesAvailable 取全多页条目，而不是只审第一页", async () => {
    const conns = [
      makeConnection({ id: "c1", name: "dev", environmentName: "Development" }),
      makeConnection({ id: "c2", name: "prod", environmentName: "Production" }),
    ];
    apiMocks.listConfigs.mockImplementation(async (_conn: Connection, _ns: string, _dataId: string, _group: string, pageNo: number) => ({
      pageItems: [{ dataId: `app-${pageNo}.yaml`, group: "DEFAULT_GROUP" }],
      totalCount: 1,
      pageNumber: pageNo,
      pagesAvailable: 3,
    }));
    apiMocks.getConfig.mockResolvedValue("server:\n  port: 8080");

    render(<AuditView connections={conns} />);
    fireEvent.click(screen.getByText("Run Audit"));

    await waitFor(() => {
      expect(apiMocks.listConfigs).toHaveBeenCalledWith(expect.anything(), "public", "", "", 3, 500);
    });
    // 第三页独有的条目也必须进入审计矩阵
    expect(await screen.findByText("app-3.yaml")).toBeInTheDocument();
  });

  it("列表命中安全上限时在界面显示不完整提示", async () => {
    const conns = [
      makeConnection({ id: "c1", name: "dev", environmentName: "Development" }),
      makeConnection({ id: "c2", name: "prod", environmentName: "Production" }),
    ];
    apiMocks.listAllConfigs.mockResolvedValue({
      items: [{ dataId: "app.yaml", group: "DEFAULT_GROUP" }],
      pagesAvailable: 60,
      loadedPages: 10,
      failedPages: [],
      truncated: true,
    });
    apiMocks.getConfig.mockResolvedValue("server:\n  port: 8080");

    render(<AuditView connections={conns} />);
    fireEvent.click(screen.getByText("Run Audit"));

    const warnings = await screen.findAllByText(/Scan cap reached: only the first 1 entries/);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByRole("button", { name: "Copy Error" }).length).toBeGreaterThanOrEqual(1);
  });

  it("列表少页时提示结果不完整而不是静默少数据", async () => {
    const conns = [
      makeConnection({ id: "c1", name: "dev", environmentName: "Development" }),
      makeConnection({ id: "c2", name: "prod", environmentName: "Production" }),
    ];
    apiMocks.listAllConfigs.mockResolvedValue({
      items: [{ dataId: "app.yaml", group: "DEFAULT_GROUP" }],
      pagesAvailable: 8,
      loadedPages: 2,
      failedPages: [3],
      truncated: false,
    });
    apiMocks.getConfig.mockResolvedValue("server:\n  port: 8080");

    render(<AuditView connections={conns} />);
    fireEvent.click(screen.getByText("Run Audit"));

    expect((await screen.findAllByText(/Config list page\(s\) 3 failed to load: only 1 entries fetched/)).length).toBeGreaterThanOrEqual(2);
  });

  it("默认以脱敏模式导出审计矩阵", async () => {
    const conns = [
      makeConnection({ id: "c1", name: "dev", environmentName: "Development" }),
      makeConnection({ id: "c2", name: "prod", environmentName: "Production" }),
    ];

    apiMocks.listConfigs.mockResolvedValue({
      pageItems: [{ dataId: "app.properties", group: "DEFAULT_GROUP" }],
      totalCount: 1,
    });
    apiMocks.getConfig.mockResolvedValue("db.password=secret123\nserver.port=8080");

    render(<AuditView connections={conns} />);
    fireEvent.click(screen.getByText("Run Audit"));

    const exportButton = await screen.findByRole("button", { name: "Export (CSV)" });
    fireEvent.click(exportButton);

    await waitFor(() => {
      expect(exportMocks.exportAuditCSV).toHaveBeenCalledWith(expect.any(Array), expect.any(Array), { sanitize: true });
    });
    const envSources = exportMocks.exportAuditCSV.mock.calls[0][1];
    expect(envSources[0].conn).toMatchObject({
      id: "c1",
      provider: "nacos",
      sourceName: "company-lan",
    });
    expect(envSources[0]).toMatchObject({
      namespace: "public",
      // 连接未配置默认 group → 留空（表示该命名空间全部 group）
      group: "",
    });
  });
  const twoEnvs = () => [
    makeConnection({ id: "c1", name: "dev", environmentName: "Development" }),
    makeConnection({ id: "c2", name: "prod", environmentName: "Production" }),
  ];

  const oneRowMatrix = () => {
    apiMocks.listAllConfigs.mockResolvedValue({
      items: [{ dataId: "app.yaml", group: "DEFAULT_GROUP", configType: "yaml" }],
      pagesAvailable: 1,
      loadedPages: 1,
      failedPages: [],
      truncated: false,
    });
    apiMocks.getConfig.mockResolvedValue("server:\n  port: 8080");
  };

  it("切走再回来：环境筛选、状态筛选与排序都还在，下一次审计按原参数请求（R27）", async () => {
    const conns = twoEnvs();
    oneRowMatrix();

    const first = render(<AuditView connections={conns} />);
    fireEvent.change(screen.getAllByPlaceholderText("public")[0], { target: { value: "ns-dev" } });
    fireEvent.change(screen.getAllByPlaceholderText("All configs")[0], { target: { value: "pay" } });
    fireEvent.click(screen.getByText("Run Audit"));
    await screen.findByText("server.port");
    fireEvent.click(screen.getByRole("button", { name: "Consistent" }));
    fireEvent.click(screen.getByRole("button", { name: "key" }));
    first.unmount();

    const second = render(<AuditView connections={conns} />);
    expect(screen.getAllByPlaceholderText("public")[0]).toHaveValue("ns-dev");
    expect(screen.getAllByPlaceholderText("All configs")[0]).toHaveValue("pay");

    // 审计结果本来就要手动跑一次（本任务不解决「重发请求」），跑完以后筛选与排序按原样生效
    apiMocks.listAllConfigs.mockClear();
    fireEvent.click(screen.getByText("Run Audit"));
    await waitFor(() =>
      expect(apiMocks.listAllConfigs).toHaveBeenCalledWith(expect.anything(), "ns-dev", "*pay*", expect.anything(), expect.anything())
    );
    await screen.findByText("server.port");
    expect(screen.getByRole("button", { name: "Consistent" }).className).toContain("btn-primary");
    expect(screen.getByRole("button", { name: "key ↑" }).className).toContain("btn-primary");
    // 状态筛选把一致项留下，矩阵不应被清成空
    expect(second.container.querySelectorAll(".audit-matrix-body .audit-matrix-row").length).toBeGreaterThan(0);
  });

  it("记住的项目被删掉后回落到可用项目，不留下空白页（R27）", () => {
    const conns = twoEnvs();
    const first = render(<AuditView connections={conns} />);
    first.unmount();

    writeViewState("audit.project", "已不存在的项目");
    render(<AuditView connections={conns} />);

    expect(readViewState<string>("audit.project")).toBe("test-proj");
    expect(screen.getAllByPlaceholderText("public")).toHaveLength(2);
  });

  it("矩阵滚动位置写回，重新挂载并重新出结果后恢复（R27）", async () => {
    const conns = twoEnvs();
    oneRowMatrix();

    const first = render(<AuditView connections={conns} />);
    fireEvent.click(screen.getByText("Run Audit"));
    await screen.findByText("server.port");

    const body = first.container.querySelector(".audit-matrix-body") as HTMLElement;
    body.scrollTop = 320;
    fireEvent.scroll(body);
    expect(readViewState<number>("audit.scroll.matrix")).toBe(320);
    first.unmount();

    // jsdom 没有布局引擎，挂载时不会被夹回 0；真实浏览器的夹回与二次恢复由 lib/viewState.test.tsx 的探针覆盖
    const second = render(<AuditView connections={conns} />);
    fireEvent.click(screen.getByText("Run Audit"));
    await screen.findByText("server.port");

    expect((second.container.querySelector(".audit-matrix-body") as HTMLElement).scrollTop).toBe(320);
  });
  it("筛选片、排序与设置折叠把自己的状态播报出来（R69）", async () => {
    oneRowMatrix();
    render(<AuditView connections={twoEnvs()} />);
    fireEvent.click(screen.getByText("Run Audit"));
    await screen.findByText("server.port");

    const chip = screen.getByRole("button", { name: "Consistent" });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");

    const sort = screen.getByRole("button", { name: /^key/ });
    expect(sort).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(sort);
    expect(sort).toHaveAttribute("aria-pressed", "true");

    // 轮142 A1：类名原本挂在包裹的 div 上，现在直接挂按钮（包裹层只是为了摆位置，白拿一层 DOM）。
    const disclosure = document.querySelector(".audit-settings-toggle") as HTMLElement;
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    // 折叠的那块内容真的出来了，aria-expanded 不是在骗人
    expect(document.querySelector(".audit-settings")).toBeInTheDocument();
  });

  // ── 轮142 A：条件区折叠 / 快速忽略 / 换行档 ────────────────────────────────
  it("A4：跑完审计自动收起条件区，摘要栏替它把条件留在视野，点折叠钮可再展开", async () => {
    oneRowMatrix();
    const { container } = render(<AuditView connections={twoEnvs()} />);
    // 审计前条件区必须展开（此时条件就是页面主体）
    expect(container.querySelectorAll(".audit-env-card")).toHaveLength(2);
    expect(container.querySelector(".audit-cond-toggle")).toBeNull();

    fireEvent.click(screen.getByText("Run Audit"));
    await screen.findByText("server.port");

    // 收起后环境卡片整体不在 DOM 里，摘要 chips 顶上
    expect(container.querySelector(".audit-env-card")).toBeNull();
    const toggle = container.querySelector(".audit-cond-toggle") as HTMLElement;
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector(".audit-cond-summary")).toBeTruthy();
    expect(container.querySelector(".audit-cond-chip")?.textContent).toBe("Project: test-proj");
    // 折叠态里设置面板也不许留着（R69 那条用例读的就是这个说谎风险）
    expect(container.querySelector(".audit-settings")).toBeNull();

    fireEvent.click(toggle);
    expect(container.querySelectorAll(".audit-env-card")).toHaveLength(2);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("A4：折叠态点「忽略规则与归一化」先把条件区展开，不让用户点了没反应", async () => {
    oneRowMatrix();
    const { container } = render(<AuditView connections={twoEnvs()} />);
    fireEvent.click(screen.getByText("Run Audit"));
    await screen.findByText("server.port");

    fireEvent.click(container.querySelector(".audit-settings-toggle") as HTMLElement);
    expect(container.querySelector(".audit-env-card")).toBeTruthy();
    expect(container.querySelector(".audit-settings")).toBeInTheDocument();
  });

  /** 矩阵第一行的状态徽标文本（状态筛选片也叫这个名字，所以必须限定在 body 里查）。 */
  const firstRowBadge = (container: HTMLElement) =>
    container.querySelector(".audit-matrix-body .audit-matrix-row .audit-status-badge")?.textContent;

  it("A2：行内「忽略」秒生效、可撤销，且一次都不许多取数", async () => {
    oneRowMatrix();
    const { container } = render(<AuditView connections={twoEnvs()} />);
    fireEvent.click(screen.getByText("Run Audit"));
    await screen.findByText("server.port");
    expect(firstRowBadge(container)).toBe("Consistent");

    const listCalls = apiMocks.listAllConfigs.mock.calls.length;
    const getCalls = apiMocks.getConfig.mock.calls.length;
    expect(listCalls).toBeGreaterThan(0);

    fireEvent.click(container.querySelector(".audit-ignore-inline") as HTMLElement);

    // 同一批数据里那一行改判成「已忽略」，纯本地重算，不多打一次网络
    await waitFor(() => expect(firstRowBadge(container)).toBe("Ignored"));
    expect(apiMocks.listAllConfigs).toHaveBeenCalledTimes(listCalls);
    expect(apiMocks.getConfig).toHaveBeenCalledTimes(getCalls);
    // 行改成忽略态后那颗钮自己退场（对已忽略的行再点一次没有意义）
    expect(container.querySelector(".audit-ignore-inline")).toBeNull();
    // 回执把规则内容念出来，并给出撤销入口
    expect(container.querySelector(".audit-action-note")?.textContent).toContain("Ignored app.yaml / server.port");

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(firstRowBadge(container)).toBe("Consistent"));
    expect(container.querySelector(".audit-action-note")).toBeNull();
    expect(apiMocks.listAllConfigs).toHaveBeenCalledTimes(listCalls);
    // 撤销只摘掉刚加的那一条，规则清单回到空
    expect(readViewState<unknown[]>("audit.ignoreRules")).toHaveLength(0);
  });

  it("A2：忽略→撤销→再忽略只留一条规则，全程不重新取数", async () => {
    oneRowMatrix();
    const { container } = render(<AuditView connections={twoEnvs()} />);
    fireEvent.click(screen.getByText("Run Audit"));
    await screen.findByText("server.port");

    fireEvent.click(container.querySelector(".audit-ignore-inline") as HTMLElement);
    await waitFor(() => expect(firstRowBadge(container)).toBe("Ignored"));
    expect(readViewState<unknown[]>("audit.ignoreRules")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(firstRowBadge(container)).toBe("Consistent"));

    fireEvent.click(container.querySelector(".audit-ignore-inline") as HTMLElement);
    await waitFor(() => expect(firstRowBadge(container)).toBe("Ignored"));
    expect(readViewState<unknown[]>("audit.ignoreRules")).toHaveLength(1);
    // 一轮审计 = 2 环境 × 1 配置；忽略/撤销来回三次都不许再碰一次网络
    expect(apiMocks.listAllConfigs).toHaveBeenCalledTimes(2);
    expect(apiMocks.getConfig).toHaveBeenCalledTimes(2);
  });

  it("A3：换行档只改行高档位，窗口化的 spacer 跟着换到 108px/行", async () => {
    oneRowMatrix();
    const { container } = render(<AuditView connections={twoEnvs()} />);
    fireEvent.click(screen.getByText("Run Audit"));
    await screen.findByText("server.port");

    expect(container.querySelector(".audit-matrix")).toHaveAttribute("data-wrap", "0");
    expect(container.querySelector(".audit-matrix-spacer")).toHaveStyle({ height: "48px" });

    fireEvent.click(screen.getByLabelText("Wrap cell text"));
    expect(container.querySelector(".audit-matrix")).toHaveAttribute("data-wrap", "1");
    expect(container.querySelector(".audit-matrix-spacer")).toHaveStyle({ height: "108px" });
    // 行高常量透传到位：revealIndex / 窗口切片都吃这个值，漏传就会在换行档下算错偏移
    expect(container.querySelector(".audit-matrix-window")).toHaveStyle({ transform: "translateY(0px)" });
  });

  // ── r110 跨配置重复检查 ─────────────────────────────────────────────────
  // 夹具：两环境，各两份配置（dataId 故意不对称，「同一配置」= 归一化 group|dataId，跨环境同 dataId 不报）。
  //   a.yaml：c1/c2 都有，db.host 值不同（1.1.1.1 / 3.3.3.3）
  //   b.yaml（c1）与 c.yaml（c2）：正文条目集完全相同（顺序无关）→ 正文全等
  // 期望三组：db.host 值不同档（跨 3 个配置、4 处位置）→ cache.ttl 值相同档（跨 2 个配置）→ 正文全等（跨 2 个配置）。
  const dupConns = () => [
    makeConnection({ id: "c1", name: "dev", environmentName: "Development", sourceName: "lan" }),
    makeConnection({ id: "c2", name: "prod", environmentName: "Production", sourceName: "cloud" }),
  ];

  const dupFixture = () => {
    apiMocks.listConfigs.mockImplementation((conn: Connection) => ({
      pageItems:
        conn.id === "c1"
          ? [
              { dataId: "a.yaml", group: "DEFAULT_GROUP", configType: "yaml" },
              { dataId: "b.yaml", group: "DEFAULT_GROUP", configType: "yaml" },
            ]
          : [
              { dataId: "a.yaml", group: "DEFAULT_GROUP", configType: "yaml" },
              { dataId: "c.yaml", group: "DEFAULT_GROUP", configType: "yaml" },
            ],
      totalCount: 2,
    }));
    apiMocks.getConfig.mockImplementation((conn: Connection, _ns: string, dataId: string) =>
      Promise.resolve(
        conn.id === "c1"
          ? dataId === "a.yaml"
            ? "db.host: 1.1.1.1"
            : "cache.ttl: 300\ndb.host: 2.2.2.2"
          : dataId === "a.yaml"
            ? "db.host: 3.3.3.3"
            : "db.host: 2.2.2.2\ncache.ttl: 300"
      )
    );
  };

  // 按「环境标签 + dataId」定位组内一处位置：同一 dataId 在多环境各出现一次，环境标签才是区分键
  const dupLocation = (panel: HTMLElement, env: string, dataId: string): HTMLLabelElement => {
    const hit = Array.from(panel.querySelectorAll("label.dup-check-loc")).find(
      (el) =>
        el.querySelector(".dup-check-loc-label")?.textContent === env &&
        el.querySelector(".dup-check-loc-ref")?.textContent === `public/DEFAULT_GROUP/${dataId}`
    ) as HTMLLabelElement | undefined;
    if (!hit) throw new Error(`location not found: ${env} / ${dataId}`);
    return hit;
  };

  const dupButton = (root: HTMLElement, text: string): HTMLButtonElement => {
    const hit = Array.from(root.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);
    if (!hit) throw new Error(`button not found: ${text}`);
    return hit as HTMLButtonElement;
  };

  const dupDupSettings = () => JSON.parse(localStorage.getItem("cs.settings") as string).duplicateCheck;

  // 面板默认收起（展开态那份清单会把 sticky;bottom:0 的详情条顶出视口，见 AuditView 里的位置注释），
  // 断言组内容前先展开——把「默认收起」显式写进用例，而不是靠组件恰好摊开。
  const openDupPanel = async (): Promise<HTMLElement> => {
    const panel = await screen.findByText("dupCheck.title").then((el) => el.closest("section") as HTMLElement);
    fireEvent.click(dupButton(panel, "dupCheck.expand"));
    return panel;
  };

  // 只取面板、不展开（断言收起态本身的行为用这个）
  const findDupPanel = (): Promise<HTMLElement> => screen.findByText("dupCheck.title").then((el) => el.closest("section") as HTMLElement);

  it("审计后渲染重复检查面板：三档分列、位置带取值、跨配置数可解释（R1/R3）", async () => {
    const conns = dupConns();
    dupFixture();

    render(<AuditView connections={conns} />);
    fireEvent.click(screen.getByText("Run Audit"));

    const panel = await openDupPanel();
    expect(panel.className).toBe("dup-check");

    // 三档各出一组，按「值不同 → 值相同 → 正文全等」排序
    const groups = Array.from(panel.querySelectorAll("li.dup-check-group")) as HTMLElement[];
    expect(groups).toHaveLength(3);
    expect(groups[0].querySelector(".dup-check-badge-diff")?.textContent).toBe("dupCheck.badgeKeyDupDiffValue");
    expect(groups[1].querySelector(".dup-check-badge-same")?.textContent).toBe("dupCheck.badgeKeyDupSameValue");
    expect(groups[2].querySelector(".dup-check-badge-body")?.textContent).toBe("dupCheck.badgeExactBody");
    expect(panel.querySelector(".dup-check-count")?.textContent).toBe("dupCheck.groupCount");

    // 值不同档：命中 key 可见；4 处位置按环境标签排序、各带该处取值
    expect(groups[0].querySelector(".dup-check-key code")?.textContent).toBe("db.host");
    const values = Array.from(groups[0].querySelectorAll("code.dup-check-loc-value")).map((el) => el.textContent);
    expect(values).toEqual(["1.1.1.1", "2.2.2.2", "3.3.3.3", "2.2.2.2"]);
    // 位置 ref 是 ns/group/dataId，title 带全文
    const firstRef = groups[0].querySelector("code.dup-check-loc-ref") as HTMLElement;
    expect(firstRef.textContent).toBe("public/DEFAULT_GROUP/a.yaml");
    expect(firstRef).toHaveAttribute("title", "public/DEFAULT_GROUP/a.yaml");
    expect(groups[0].querySelectorAll("label.dup-check-loc")).toHaveLength(4);
    // 三组都给出跨配置数；统计行报已检查配置数
    expect(panel.querySelectorAll(".dup-check-scope")).toHaveLength(3);
    expect(panel.querySelector(".dup-check-stat")?.textContent).toContain("dupCheck.checkedConfigs");

    // 值不同档有复制/忽略/对比/回退四个动作；正文全等组没有单 key，只有「送去对比」
    expect(groups[0].querySelectorAll("button")).toHaveLength(4);
    expect(groups[1].querySelectorAll("button")).toHaveLength(3);
    expect(groups[2].querySelectorAll("button")).toHaveLength(1);
    expect(groups[2].querySelectorAll("code.dup-check-loc-value")).toHaveLength(0);
    expect(dupButton(groups[0], "dupCheck.rollbackPlan")).toBeTruthy();
    expect(groups[1].textContent).not.toContain("dupCheck.rollbackPlan");
    expect(groups[2].textContent).not.toContain("dupCheck.rollbackPlan");
  });

  it("重复组勾选两个位置后「送去对比」按勾选顺序左右交给 DiffView（R4 出口一）", async () => {
    const onNavigate = vi.fn();
    const conns = dupConns();
    dupFixture();

    render(<AuditView connections={conns} onNavigateToDiff={onNavigate} />);
    fireEvent.click(screen.getByText("Run Audit"));

    const panel = await openDupPanel();
    const group = panel.querySelector("li.dup-check-group") as HTMLElement; // 值不同档在前
    const compareBtn = dupButton(group, "dupCheck.compare");
    expect(compareBtn.disabled).toBe(true);

    fireEvent.click(dupLocation(panel, "Development / dev / public", "a.yaml").querySelector("input") as HTMLInputElement);
    fireEvent.click(dupLocation(panel, "Production / prod / public", "a.yaml").querySelector("input") as HTMLInputElement);

    // 第 1 个勾选标来源、第 2 个标目标
    expect(group.querySelectorAll(".dup-check-loc-role")).toHaveLength(2);
    expect(group.querySelectorAll(".dup-check-loc-role")[0].textContent).toBe("dupCheck.sourceRole");
    expect(group.querySelectorAll(".dup-check-loc-role")[1].textContent).toBe("dupCheck.targetRole");
    expect(compareBtn.disabled).toBe(false);

    fireEvent.click(compareBtn);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith({
      leftConnId: "c1",
      rightConnId: "c2",
      left: { tenant: "public", group: "DEFAULT_GROUP", dataId: "a.yaml" },
      right: { tenant: "public", group: "DEFAULT_GROUP", dataId: "a.yaml" },
    });
  });

  it("值不同档勾选两个位置后「生成回退计划」复用 apply 通道，只出计划不写入（R4 出口二）", async () => {
    const onStartApply = vi.fn();
    const conns = dupConns();
    dupFixture();

    render(<AuditView connections={conns} onStartApply={onStartApply} />);
    fireEvent.click(screen.getByText("Run Audit"));

    const panel = await openDupPanel();
    const group = panel.querySelector("li.dup-check-group") as HTMLElement; // 值不同档在前

    fireEvent.click(dupLocation(panel, "Development / dev / public", "a.yaml").querySelector("input") as HTMLInputElement);
    fireEvent.click(dupLocation(panel, "Production / prod / public", "a.yaml").querySelector("input") as HTMLInputElement);

    fireEvent.click(dupButton(group, "dupCheck.rollbackPlan"));

    expect(onStartApply).toHaveBeenCalledTimes(1);
    expect(onStartApply).toHaveBeenCalledWith({
      sourceType: "audit",
      scope: "key",
      source: {
        provider: "nacos",
        connectionId: "c1",
        connectionName: "dev",
        namespace: "public",
        label: "Development / dev / public",
      },
      target: {
        provider: "nacos",
        connectionId: "c2",
        connectionName: "prod",
        namespace: "public",
        label: "Production / prod / public",
      },
      items: [
        {
          provider: "nacos",
          connectionId: "c2",
          namespace: "public",
          group: "DEFAULT_GROUP",
          dataId: "a.yaml",
          key: "db.host",
          sourceRef: {
            provider: "nacos",
            connectionId: "c1",
            namespace: "public",
            group: "DEFAULT_GROUP",
            dataId: "a.yaml",
            key: "db.host",
          },
          targetRef: {
            provider: "nacos",
            connectionId: "c2",
            namespace: "public",
            group: "DEFAULT_GROUP",
            dataId: "a.yaml",
            key: "db.host",
          },
        },
      ],
      rangeSummary: {
        count: 1,
        skippedCount: 0,
        riskLevel: "low",
        riskReasons: [],
      },
      origin: {
        mode: "audit",
        returnMode: "audit",
      },
    });
  });

  it("判据开关走设置通道持久化：关掉 keyDup 后两档组都消失、正文全等仍在（R1/R2）", async () => {
    const conns = dupConns();
    dupFixture();

    render(<AuditView connections={conns} />);
    fireEvent.click(screen.getByText("Run Audit"));

    const panel = await openDupPanel();
    expect(panel.querySelectorAll("li.dup-check-group")).toHaveLength(3);

    const keyDupToggle = panel.querySelector(".dup-check-bar label.check-row input") as HTMLInputElement;
    expect(keyDupToggle.checked).toBe(true);
    fireEvent.click(keyDupToggle);

    expect(panel.querySelectorAll("li.dup-check-group")).toHaveLength(1);
    expect(screen.queryByText("dupCheck.badgeKeyDupDiffValue")).toBeNull();
    expect(screen.queryByText("dupCheck.badgeKeyDupSameValue")).toBeNull();
    expect(screen.getByText("dupCheck.badgeExactBody")).toBeTruthy();
    expect(dupDupSettings().keyDupEnabled).toBe(false);
  });

  it("「忽略此 key」写入忽略清单并即时生效，× 移除后组恢复；忽略清单不影响正文判据（R2）", async () => {
    const conns = dupConns();
    dupFixture();

    render(<AuditView connections={conns} />);
    fireEvent.click(screen.getByText("Run Audit"));

    const panel = await openDupPanel();
    expect(screen.getByText("dupCheck.ignoreEmpty")).toBeTruthy();
    expect(panel.querySelectorAll("li.dup-check-group")).toHaveLength(3);

    const [dbGroup] = Array.from(panel.querySelectorAll("li.dup-check-group")) as HTMLElement[];
    fireEvent.click(dupButton(dbGroup, "dupCheck.ignoreThisKey"));

    // db.host 被忽略：值不同档消失；值相同档（cache.ttl）与正文全等档不受忽略清单影响
    expect(screen.queryByText("dupCheck.badgeKeyDupDiffValue")).toBeNull();
    expect(screen.getByText("dupCheck.badgeKeyDupSameValue")).toBeTruthy();
    expect(screen.getByText("dupCheck.badgeExactBody")).toBeTruthy();
    expect(panel.querySelectorAll("li.dup-check-group")).toHaveLength(2);
    // 忽略清单 chip 出现、带移除入口
    expect(panel.querySelector(".ignore-rule-text code")?.textContent).toBe("db.host");
    expect(dupDupSettings().ignoredKeyPatterns).toContain("db.host");

    fireEvent.click(screen.getByRole("button", { name: "dupCheck.ignoreRemoveAria" }));

    // 移除后组恢复、清单回空
    expect(screen.getByText("dupCheck.badgeKeyDupDiffValue")).toBeTruthy();
    expect(panel.querySelectorAll("li.dup-check-group")).toHaveLength(3);
    expect(dupDupSettings().ignoredKeyPatterns).toEqual([]);
  });

  it("重复检查面板默认收起、组数常显；无论清单长短都排在 sticky 详情条之前（1.10.0 回归）", async () => {
    const conns = dupConns();
    dupFixture();

    render(<AuditView connections={conns} />);
    fireEvent.click(screen.getByText("Run Audit"));

    const panel = await findDupPanel();
    // 收起态：组数还在——它是用户决定「要不要点开」的唯一依据；清单与忽略清单都不摊开
    expect(panel.querySelector(".dup-check-count")?.textContent).toBe("dupCheck.groupCount");
    expect(panel.querySelectorAll("li.dup-check-group")).toHaveLength(0);
    expect(panel.querySelector(".dup-check-ignores")).toBeNull();
    // 判据开关与统计留在面板头上：关掉某条判据不必先展开面板
    expect(panel.querySelector(".dup-check-bar")).toBeTruthy();
    expect(panel.querySelector(".dup-check-stat")?.textContent).toContain("dupCheck.checkedConfigs");
    const toggle = panel.querySelector(".dup-check-toggle") as HTMLButtonElement;
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    // 选中一行让详情条出现：它必须是 .audit-page 的最后一个元素，dup-check 在它之前
    fireEvent.click(document.querySelector(".audit-matrix-body .audit-matrix-row") as HTMLElement);
    const page = document.querySelector(".audit-page") as HTMLElement;
    const detail = await waitFor(() => {
      const el = page.querySelector(".audit-detail") as HTMLElement | null;
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(Array.from(page.children).indexOf(panel)).toBeLessThan(Array.from(page.children).indexOf(detail));

    // 展开之后次序不变、详情条后面依然没有任何兄弟节点（sticky;bottom:0 靠这个成立）
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(panel.querySelectorAll("li.dup-check-group")).toHaveLength(3);
    expect(detail.nextElementSibling).toBeNull();
    expect(Array.from(page.children).slice(-1)[0]).toBe(detail);

    // 再收起：清单消失但组数仍可见
    fireEvent.click(dupButton(panel, "dupCheck.collapse"));
    expect(panel.querySelectorAll("li.dup-check-group")).toHaveLength(0);
    expect(panel.querySelector(".dup-check-count")?.textContent).toBe("dupCheck.groupCount");
  });

  it("展开后每页只摊 10 组，「再显示」补足剩余组后按钮消失（清单再长也不把页面撑爆）", async () => {
    const conns = dupConns();
    // 12 个 shared.k* 在 4 份配置里同值复现 ⇒ 12 组「同 key · 值相同」；
    // 另给每份配置一个只属于自己的 key（不构成跨配置重复），四条正文互不全等 ⇒
    // 正文全等判据不会再加组，组数才是可断言的 12。
    apiMocks.listConfigs.mockImplementation(() => ({
      pageItems: [
        { dataId: "a.yaml", group: "DEFAULT_GROUP", configType: "yaml" },
        { dataId: "b.yaml", group: "DEFAULT_GROUP", configType: "yaml" },
      ],
      totalCount: 2,
    }));
    apiMocks.getConfig.mockImplementation((conn: Connection, _ns: string, dataId: string) =>
      Promise.resolve(
        [
          `own.${conn.id.replace(/-/g, "")}-${dataId.replace(/\./g, "")}: marker`,
          ...Array.from({ length: 12 }, (_, i) => `shared.k${i}: same`),
        ].join("\n")
      )
    );

    render(<AuditView connections={conns} />);
    fireEvent.click(screen.getByText("Run Audit"));

    const panel = await openDupPanel();
    expect(panel.querySelector(".dup-check-count")?.textContent).toBe("dupCheck.groupCount");
    expect(panel.querySelectorAll("li.dup-check-group")).toHaveLength(10);

    fireEvent.click(dupButton(panel, "dupCheck.showMore"));
    expect(panel.querySelectorAll("li.dup-check-group")).toHaveLength(12);
    expect(panel.querySelector(".dup-check-toggle")?.textContent).toBe("dupCheck.collapse");
    // 全摊开后不再有「再显示」
    expect(Array.from(panel.querySelectorAll("button")).some((b) => b.textContent?.trim() === "dupCheck.showMore")).toBe(false);
    // 换一批检查结果（关掉同 key 判据）就回到第一页，不带着旧页码
    fireEvent.click(panel.querySelector(".dup-check-bar label.check-row input") as HTMLInputElement);
    expect(panel.querySelectorAll("li.dup-check-group")).toHaveLength(0);
  });
});

describe("AuditView · r139 项目级跨环境内容搜索", () => {
  /**
   * 夹具：一份配置两个环境，server.token 在开发侧出现两次、生产侧一次。
   * 于是搜 alpha 应当是「命中 3 处 · 1 行 · 涉及 2 个环境 · 列头徽标 2 / 1」——
   * 徽标数、格内红底数、计数三处必须同源，这份夹具正好能把它们钉在一起。
   */
  const conns = [
    makeConnection({ id: "c1", name: "dev", environmentName: "Development", sourceName: "lan" }),
    makeConnection({ id: "c2", name: "prod", environmentName: "Production", sourceName: "cloud" }),
  ];

  beforeEach(() => {
    clearViewState();
    localStorage.removeItem("cs.settings");
    apiMocks.listConfigs.mockReset();
    apiMocks.listAllConfigs.mockReset();
    apiMocks.getConfig.mockReset();
    apiMocks.listAllConfigs.mockImplementation(listAllConfigsBridge(apiMocks.listConfigs));
    apiMocks.listConfigs.mockResolvedValue({
      pageItems: [{ dataId: "app.yaml", group: "DEFAULT_GROUP", configType: "yaml" }],
      totalCount: 1,
    });
    apiMocks.getConfig
      .mockResolvedValueOnce("server:\n  port: 8080\n  token: alpha alpha")
      .mockResolvedValueOnce("server:\n  port: 8080\n  token: alpha");
  });

  /** 跑完一轮审计并返回搜索框（两个环境都取完数才有矩阵行）。
   *  anchor = 等待出现的那一行：子夹具只喂一份不同正文时，等的那行可能已经被换掉。 */
  async function runAndMount(anchor = "server.port") {
    const view = render(<AuditView connections={conns} />);
    fireEvent.click(screen.getByText("Run Audit"));
    await screen.findByText(anchor);
    return view;
  }

  /** 轮142 A4：审计跑完后条件区自动收起；需要读环境卡片字段的用例先把它展开。 */
  function expandConditions() {
    const toggle = document.querySelector(".audit-cond-toggle") as HTMLElement | null;
    if (toggle && toggle.getAttribute("aria-expanded") === "false") fireEvent.click(toggle);
  }

  /** 输入并回车提交（走 runNow，不等 400ms 防抖，也不让半截输入当已生效条件）。 */
  function typeAndSubmit(input: HTMLElement, value: string) {
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: "Enter" });
  }

  it("默认只看命中行：未命中行折叠，取消勾选后回来", async () => {
    const { container } = await runAndMount();
    const search = screen.getByLabelText("Search matrix content");
    expect(container.querySelector(".audit-search")).toBeTruthy();
    typeAndSubmit(search, "alpha");

    expect(screen.queryByText("server.port")).toBeNull();
    expect(screen.getByText("server.token")).toBeTruthy();
    expect(container.querySelector(".audit-search-summary-main")?.textContent).toBe("3 hits in 2 rows across 2 envs");

    fireEvent.click(screen.getByLabelText("Matching rows only"));
    expect(screen.getByText("server.port")).toBeTruthy();
  });

  it("列头徽标数 = 该列格子里能数出来的红底数，当前停靠处只有一个实心高亮", async () => {
    const { container } = await runAndMount();
    typeAndSubmit(screen.getByLabelText("Search matrix content"), "alpha");

    const badges = Array.from(container.querySelectorAll(".audit-env-hit-badge")).map((el) => el.textContent);
    expect(badges).toEqual(["2", "1"]);
    const valueCells = container.querySelectorAll(".audit-matrix-body .audit-cell.value");
    expect(valueCells).toHaveLength(2);
    expect(valueCells[0].querySelectorAll("mark.search-hit")).toHaveLength(2);
    expect(valueCells[1].querySelectorAll("mark.search-hit")).toHaveLength(1);
    // 命中行只画左侧标记线，不铺整行背景：行背景被状态语义占用（矩阵的设计前提）
    const row = container.querySelector(".audit-matrix-body .audit-matrix-row.has-hit") as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.classList.contains("current-hit")).toBe(true);
    expect(container.querySelectorAll("mark.search-hit-current")).toHaveLength(1);
  });

  it("Enter 与 ↑↓ 逐处前进/后退，走到末尾再 Enter 回绕到第一处", async () => {
    const { container } = await runAndMount();
    const search = screen.getByLabelText("Search matrix content");
    typeAndSubmit(search, "alpha");
    const count = () => container.querySelector(".audit-search-count")?.textContent;
    expect(count()).toBe("1/3");

    fireEvent.keyDown(search, { key: "Enter" });
    expect(count()).toBe("2/3");
    fireEvent.keyDown(search, { key: "F3" });
    expect(count()).toBe("3/3");
    fireEvent.keyDown(search, { key: "Enter" });
    expect(count()).toBe("1/3");
    fireEvent.keyDown(search, { key: "F3", shiftKey: true });
    expect(count()).toBe("3/3");

    fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
    expect(count()).toBe("2/3");
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(count()).toBe("3/3");
  });

  it("Ctrl+F：焦点没有光标时聚焦搜索框，落在别人的输入框里就让位", async () => {
    const { container } = await runAndMount();
    const search = screen.getByLabelText("Search matrix content") as HTMLInputElement;

    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(document.activeElement).toBe(search);

    // ⌘F 同一口径（macOS）
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(document.activeElement).toBe(search);

    // 焦点在环境卡片的 dataId 输入框里：Ctrl+F 归那个框（原生查找），不许抢
    // 轮142 A4：跑完审计条件区自动收起，卡片不在 DOM 里 ⇒ 先展开（收起后也确实没有别人的输入框可抢）
    expandConditions();
    const other = container.querySelector("input.search-input.mono") as HTMLInputElement;
    other.focus();
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(document.activeElement).toBe(other);

    // 输入法组合态期间不劫持
    other.blur();
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(window, { key: "f", ctrlKey: true, isComposing: true });
    expect(document.activeElement).not.toBe(search);

    // Alt+F / 单独按 F 都不算
    fireEvent.keyDown(window, { key: "f", altKey: true });
    expect(document.activeElement).not.toBe(search);
  });

  it("0 命中把作用域念出来，不只说「没有结果」", async () => {
    const { container } = await runAndMount();
    typeAndSubmit(screen.getByLabelText("Search matrix content"), "zzz");
    expect(container.querySelector(".audit-search-nohit")?.textContent).toBe('No "zzz" in 2 rows across 2 envs');
    expect(container.querySelector(".audit-search-count")?.textContent).toBe("No matches");
  });

  it("仅名称 / 仅值 两档看到的集合必须能解释（互斥而不是值优先）", async () => {
    const { container } = await runAndMount();
    const search = screen.getByLabelText("Search matrix content");
    const tabs = container.querySelectorAll<HTMLButtonElement>(".audit-search .view-mode button");
    expect(Array.from(tabs).map((b) => b.textContent)).toEqual(["ScopeAll", "ScopeName", "ScopeValue"]);

    // server 只出现在 key 名称里
    typeAndSubmit(search, "server");
    expect(container.querySelector(".audit-search-summary-main")?.textContent).toBe("2 hits in 2 rows across 2 envs");

    fireEvent.click(tabs[2]);
    expect(container.querySelector(".audit-search-nohit")?.textContent).toBe('No "server" in 2 rows across 2 envs');

    fireEvent.click(tabs[1]);
    expect(container.querySelector(".audit-search-summary-main")?.textContent).toBe("2 hits in 2 rows across 2 envs");
  });

  it("还没跑过审计时「执行并搜索」一次搞定：取完数直接带着原词命中", async () => {
    const { container } = render(<AuditView connections={conns} />);
    const search = screen.getByLabelText("Search matrix content");
    fireEvent.change(search, { target: { value: "alpha" } });
    // 没提交 = 不是一套新的已生效条件，所以命中层不出现；提示挂在框的 title 上，按钮负责一次搞定
    expect(search).toHaveAttribute("title", "No audit run yet");
    expect(screen.getByRole("button", { name: "Run and search" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Run and search" }));
    await waitFor(() => expect(container.querySelector(".audit-search-summary-main")?.textContent).toBe("3 hits in 2 rows across 2 envs"));
    expect(apiMocks.listAllConfigs).toHaveBeenCalled();
    expect(container.querySelectorAll("mark.search-hit")).toHaveLength(3);
  });

  it("Esc 清空搜索词并撤掉整个命中层", async () => {
    const { container } = await runAndMount();
    const search = screen.getByLabelText("Search matrix content") as HTMLInputElement;
    typeAndSubmit(search, "alpha");
    expect(container.querySelectorAll("mark.search-hit")).toHaveLength(3);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(search.value).toBe("");
    expect(container.querySelectorAll("mark.search-hit")).toHaveLength(0);
    expect(screen.queryByText("server.port")).toBeTruthy();
  });

  it("命中片段用 React 节点切分：正文里的尖括号不会被当 HTML 解析", async () => {
    apiMocks.getConfig.mockReset();
    apiMocks.getConfig.mockResolvedValueOnce("server:\n  token: <b>alpha</b>").mockResolvedValueOnce("server:\n  token: alpha");
    const { container } = await runAndMount("server.token");
    typeAndSubmit(screen.getByLabelText("Search matrix content"), "alpha");

    const cell = container.querySelector(".audit-matrix-body .audit-cell.value") as HTMLElement;
    expect(cell.querySelector("b")).toBeNull();
    expect(cell.textContent).toContain("<b>alpha</b>");
    expect(cell.querySelectorAll("mark.search-hit")).toHaveLength(1);
  });

  it("搜索词只进视图状态，不写主数据文件", async () => {
    await runAndMount();
    typeAndSubmit(screen.getByLabelText("Search matrix content"), "alpha");
    expect(readViewState<string>("audit.searchTerm")).toBe("alpha");
    expect(localStorage.getItem("cs.settings")).toBeNull();
  });
});
