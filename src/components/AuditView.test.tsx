/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AuditView from "./AuditView";
import type { Connection } from "../store/connections";

// mock API 模块
const apiMocks = vi.hoisted(() => ({
  listConfigs: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock("../api/nacos", async () => {
  const actual = await vi.importActual<typeof import("../api/nacos")>("../api/nacos");
  return { ...actual, listConfigs: apiMocks.listConfigs, getConfig: apiMocks.getConfig };
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
        "audit.matchPattern": "Match pattern",
        "audit.replaceTo": "Replace with (leave empty to delete)",
        "audit.caseSensitive": "Case sensitive",
        "audit.addNormalizeRule": "Add Rule",
        "audit.jumpToDiff": "Jump to Diff",
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
      };
      return map[key] ?? key;
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
    apiMocks.listConfigs.mockReset();
    apiMocks.getConfig.mockReset();
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
      pageItems: [{ dataId: "app.yaml", group: "DEFAULT_GROUP" }],
      totalCount: 1,
    });
    apiMocks.getConfig.mockResolvedValue("server:\n  port: 8080");

    render(<AuditView connections={conns} onNavigateToDiff={onNavigate} />);
    fireEvent.click(screen.getByText("Run Audit"));

    await waitFor(() => {
      expect(screen.getByText("app.yaml")).toBeTruthy();
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
});
