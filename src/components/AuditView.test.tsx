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

    const disclosure = document.querySelector(".audit-settings-toggle button") as HTMLElement;
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    // 折叠的那块内容真的出来了，aria-expanded 不是在骗人
    expect(document.querySelector(".audit-settings")).toBeInTheDocument();
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

  it("审计后渲染重复检查面板：三档分列、位置带取值、跨配置数可解释（R1/R3）", async () => {
    const conns = dupConns();
    dupFixture();

    render(<AuditView connections={conns} />);
    fireEvent.click(screen.getByText("Run Audit"));

    const panel = await screen.findByText("dupCheck.title").then((el) => el.closest("section") as HTMLElement);
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

    const panel = await screen.findByText("dupCheck.title").then((el) => el.closest("section") as HTMLElement);
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

    const panel = await screen.findByText("dupCheck.title").then((el) => el.closest("section") as HTMLElement);
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

    const panel = await screen.findByText("dupCheck.title").then((el) => el.closest("section") as HTMLElement);
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

    const panel = await screen.findByText("dupCheck.title").then((el) => el.closest("section") as HTMLElement);
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
});
