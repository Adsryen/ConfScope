/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "../test/react";
import BackupView from "./BackupView";
import { I18nProvider } from "../i18n";
import type { Snapshot } from "../api/snapshot";
import { loadOperationHistory } from "../store/operationHistory";

vi.mock("../api/snapshot", () => ({
  listSnapshots: vi.fn(),
  deleteSnapshot: vi.fn(),
}));

vi.mock("../lib/snapshot", () => ({
  getSnapshotStats: vi.fn((snap: Snapshot) => ({
    totalConfigs: snap.configs.length,
    totalGroups: 1,
    totalNamespaces: 1,
    latestUpdateTime: null,
  })),
  formatSnapshotName: vi.fn((snap: Snapshot) => snap.name),
  formatTime: vi.fn((time: string) => time),
}));

vi.mock("../lib/errorCenter", () => ({
  reportError: vi.fn(),
}));

vi.mock("../lib/toast", () => ({
  toast: vi.fn(),
}));

describe("BackupView", () => {
  const mockSnapshots: Snapshot[] = [
    {
      id: "snap-1",
      path: "C:\\Users\\tester\\.confscope\\backups\\snap-1",
      name: "dev-nacos_public_20240101",
      description: "",
      createdAt: "2024-01-01T10:00:00Z",
      updatedAt: "2024-01-01T10:00:00Z",
      source: {
        connectionId: "conn-1",
        connectionName: "dev-nacos",
        namespace: "public",
        namespaceId: "public",
      },
      configs: [
        {
          dataId: "app.yaml",
          group: "DEFAULT_GROUP",
          content: "server:\n  port: 8080",
          configType: "yaml",
          updateTime: "2024-01-01 10:00:00",
        },
      ],
    },
  ];

  const renderWithI18n = (ui: React.ReactElement) => {
    return render(<I18nProvider>{ui}</I18nProvider>);
  };

  beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem("locale", "zh-CN");
    vi.clearAllMocks();
    const { listSnapshots } = await import("../api/snapshot");
    vi.mocked(listSnapshots).mockResolvedValue(mockSnapshots);
  });

  it("renders loading state", () => {
    renderWithI18n(<BackupView />);
    expect(screen.getByText("加载中…")).toBeDefined();
  });

  it("renders snapshots list after loading", async () => {
    renderWithI18n(<BackupView />);
    await waitFor(() => {
      expect(screen.queryByText("加载中…")).toBeNull();
    });
    // 快照名称出现在列表和详情中
    const nameElements = screen.getAllByText("dev-nacos_public_20240101");
    expect(nameElements.length).toBeGreaterThan(0);
  });

  it("shows empty state when no snapshots", async () => {
    const { listSnapshots } = await import("../api/snapshot");
    vi.mocked(listSnapshots).mockResolvedValue([]);

    renderWithI18n(<BackupView />);
    await waitFor(() => {
      expect(screen.getByText("暂无本地备份")).toBeDefined();
    });
  });

  it("shows snapshot detail when clicked", async () => {
    renderWithI18n(<BackupView />);
    await waitFor(() => {
      expect(screen.queryByText("加载中…")).toBeNull();
    });

    // 点击第一个快照项
    const items = screen.getAllByText("dev-nacos_public_20240101");
    items[0].click();

    await waitFor(() => {
      expect(screen.getByText("配置列表")).toBeDefined();
    });
    expect(screen.getByText("app.yaml")).toBeDefined();
  });

  it("falls back source namespace display to namespaceId and then public", async () => {
    const { listSnapshots } = await import("../api/snapshot");
    vi.mocked(listSnapshots).mockResolvedValue([
      {
        ...mockSnapshots[0],
        id: "snap-namespace-id",
        name: "namespace-id-snapshot",
        source: {
          ...mockSnapshots[0].source,
          connectionName: "namespace-id-source",
          namespace: "",
          namespaceId: "tenant-a",
        },
      },
      {
        ...mockSnapshots[0],
        id: "snap-public",
        name: "public-fallback-snapshot",
        source: {
          ...mockSnapshots[0].source,
          connectionName: "public-source",
          namespace: "",
          namespaceId: "",
        },
      },
    ]);

    renderWithI18n(<BackupView />);

    expect((await screen.findAllByText("namespace-id-snapshot")).length).toBeGreaterThan(0);
    expect(screen.getAllByText((content) => content.includes("namespace-id-source") && content.includes("tenant-a")).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText("public-fallback-snapshot"));

    await waitFor(() => {
      expect(screen.getAllByText((content) => content.includes("public-source") && content.includes("public")).length).toBeGreaterThan(0);
    });
  });

  it("shows error state on load failure", async () => {
    const { listSnapshots } = await import("../api/snapshot");
    vi.mocked(listSnapshots).mockRejectedValue(new Error("网络错误"));

    renderWithI18n(<BackupView />);
    await waitFor(() => {
      expect(screen.getByText("加载失败")).toBeDefined();
    });
  });

  it("navigates a snapshot config to DiffView with local snapshot metadata", async () => {
    const onNavigateToDiff = vi.fn();

    renderWithI18n(<BackupView onNavigateToDiff={onNavigateToDiff} />);

    const configList = await screen.findByText("配置列表");
    const detail = configList.closest(".backup-detail") as HTMLElement;
    fireEvent.click(within(detail).getByRole("button", { name: "与云端对比" }));

    expect(onNavigateToDiff).toHaveBeenCalledWith({
      snapshot: mockSnapshots[0],
      config: mockSnapshots[0].configs[0],
      sourceConnectionId: "conn-1",
      sourceConnectionName: "dev-nacos",
      snapshotPath: "C:\\Users\\tester\\.confscope\\backups\\snap-1",
      namespace: "",
      group: "DEFAULT_GROUP",
      dataId: "app.yaml",
    });
  });

  it("starts an apply plan from a snapshot config", async () => {
    const onStartApply = vi.fn();
    localStorage.setItem("locale", "en-US");

    renderWithI18n(<BackupView onStartApply={onStartApply} />);

    const configList = await screen.findByText("Config list");
    const detail = configList.closest(".backup-detail") as HTMLElement;
    fireEvent.click(within(detail).getByRole("button", { name: "Generate Apply Plan" }));

    expect(onStartApply).toHaveBeenCalledWith({
      sourceType: "backup",
      scope: "config",
      source: {
        provider: "local",
        connectionId: "snapshot:snap-1",
        connectionName: "dev-nacos_public_20240101",
        namespace: "",
        label: "dev-nacos_public_20240101 / public",
      },
      target: {
        provider: "nacos",
        connectionId: "conn-1",
        connectionName: "dev-nacos",
        namespace: "",
        label: "dev-nacos / public",
      },
      items: [
        {
          provider: "nacos",
          connectionId: "conn-1",
          namespace: "",
          group: "DEFAULT_GROUP",
          dataId: "app.yaml",
          key: "__document",
          sourceRef: {
            provider: "local",
            connectionId: "snapshot:snap-1",
            namespace: "",
            group: "DEFAULT_GROUP",
            dataId: "app.yaml",
            key: "__document",
          },
          targetRef: {
            provider: "nacos",
            connectionId: "conn-1",
            namespace: "",
            group: "DEFAULT_GROUP",
            dataId: "app.yaml",
            key: "__document",
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
        mode: "backup",
        returnMode: "backup",
      },
    });
  });

  it("records snapshot delete as not rollbackable", async () => {
    const { deleteSnapshot } = await import("../api/snapshot");
    vi.mocked(deleteSnapshot).mockResolvedValue(undefined);

    renderWithI18n(<BackupView />);

    fireEvent.click(await screen.findByTitle("删除快照"));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() => {
      expect(deleteSnapshot).toHaveBeenCalledWith("snap-1");
    });

    expect(loadOperationHistory()[0]).toMatchObject({
      type: "snapshot_delete",
      result: "success",
      connectionId: "conn-1",
      connectionName: "dev-nacos",
      namespace: "public",
      group: "*",
      dataId: "*",
      rollbackable: false,
      rollbackReason: "operationHistory.rollbackSnapshotOnly",
      resourceId: "snap-1",
      resourceName: "dev-nacos_public_20240101",
    });
  });
});
