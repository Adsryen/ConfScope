// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import BackupView from "./BackupView";
import { I18nProvider } from "../i18n";

// 模拟 API
vi.mock("../api/snapshot", () => ({
  listSnapshots: vi.fn(),
  deleteSnapshot: vi.fn(),
}));

// 模拟工具库
vi.mock("../lib/snapshot", () => ({
  getSnapshotStats: vi.fn(() => ({ totalConfigs: 2, totalGroups: 1, totalNamespaces: 1, latestUpdateTime: null })),
  formatSnapshotName: vi.fn((snap) => snap.name),
  formatTime: vi.fn((t) => t),
}));

// 模拟错误中心
vi.mock("../lib/errorCenter", () => ({
  reportError: vi.fn(),
}));

// 模拟 toast
vi.mock("../lib/toast", () => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
  },
}));

describe("BackupView", () => {
  const mockSnapshots = [
    {
      id: "snap-1",
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
    const { listSnapshots } = await import("../api/snapshot");
    (listSnapshots as any).mockResolvedValue(mockSnapshots);
  });

  it("renders loading state", () => {
    renderWithI18n(<BackupView />);
    expect(screen.getByText("加载中...")).toBeDefined();
  });

  it("renders snapshots list after loading", async () => {
    renderWithI18n(<BackupView />);
    await waitFor(() => {
      expect(screen.queryByText("加载中...")).toBeNull();
    });
    // 快照名称出现在列表和详情中
    const nameElements = screen.getAllByText("dev-nacos_public_20240101");
    expect(nameElements.length).toBeGreaterThan(0);
  });

  it("shows empty state when no snapshots", async () => {
    const { listSnapshots } = await import("../api/snapshot");
    (listSnapshots as any).mockResolvedValue([]);

    renderWithI18n(<BackupView />);
    await waitFor(() => {
      expect(screen.getByText("暂无本地备份")).toBeDefined();
    });
  });

  it("shows snapshot detail when clicked", async () => {
    renderWithI18n(<BackupView />);
    await waitFor(() => {
      expect(screen.queryByText("加载中...")).toBeNull();
    });

    // 点击第一个快照项
    const items = screen.getAllByText("dev-nacos_public_20240101");
    items[0].click();

    await waitFor(() => {
      expect(screen.getByText("配置列表")).toBeDefined();
    });
    expect(screen.getByText("app.yaml")).toBeDefined();
  });

  it("shows error state on load failure", async () => {
    const { listSnapshots } = await import("../api/snapshot");
    (listSnapshots as any).mockRejectedValue(new Error("网络错误"));

    renderWithI18n(<BackupView />);
    await waitFor(() => {
      expect(screen.getByText("加载失败")).toBeDefined();
    });
  });
});
