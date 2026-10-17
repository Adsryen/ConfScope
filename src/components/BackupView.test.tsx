/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "../test/react";
import BackupView from "./BackupView";
import { clearViewState, readViewState, viewStateKeys } from "../lib/viewState";
import { I18nProvider } from "../i18n";
import type { Snapshot } from "../api/snapshot";
import { loadOperationHistory } from "../store/operationHistory";

vi.mock("../api/snapshot", () => ({
  listSnapshots: vi.fn(),
  deleteSnapshot: vi.fn(),
}));

vi.mock("../api/snapshotWebDAV", () => ({
  testSnapshotWebDAV: vi.fn(),
  listSnapshotWebDAVPackages: vi.fn(),
  uploadSnapshotWebDAVPackage: vi.fn(),
  importSnapshotWebDAVPackage: vi.fn(),
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
    // 视图状态存在模块内存里（R27）：用例之间必须隔离
    clearViewState();
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

  it("快照行键盘可达：Tab 停得住，Enter 等价于点这一行（R61）", async () => {
    const { container } = renderWithI18n(<BackupView />);
    await waitFor(() => {
      expect(screen.queryByText("加载中…")).toBeNull();
    });

    const row = container.querySelector(".backup-item") as HTMLElement;
    // 行内还嵌着删除按钮，所以是 group 而不是 button（button 的子树会被无障碍树当装饰隐藏）
    expect(row).toHaveAttribute("role", "group");
    expect(row).toHaveAttribute("tabindex", "0");

    fireEvent.keyDown(row, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByText("配置列表")).toBeDefined();
    });
    expect(row).toHaveAttribute("aria-current", "true");
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
    fireEvent.click(within(detail).getByRole("button", { name: "Generate Change Plan" }));

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

  it("saves and tests the independent snapshot WebDAV target", async () => {
    const snapshotWebDAV = await import("../api/snapshotWebDAV");
    vi.mocked(snapshotWebDAV.testSnapshotWebDAV).mockResolvedValue(undefined);
    localStorage.setItem("locale", "en-US");
    localStorage.setItem("cs.appDataBackup", JSON.stringify({ webdav: { url: "https://app.example.com" }, activities: [] }));

    renderWithI18n(<BackupView />);

    await screen.findByText("Config snapshot sync");
    fireEvent.change(screen.getByLabelText("WebDAV URL"), { target: { value: " https://dav.example.com " } });
    fireEvent.change(screen.getByLabelText("WebDAV username"), { target: { value: "ops" } });
    fireEvent.change(screen.getByLabelText("WebDAV password"), { target: { value: "dav-secret" } });
    fireEvent.change(screen.getByLabelText("Remote folder"), { target: { value: "snapshots" } });

    fireEvent.click(screen.getByRole("button", { name: "Save WebDAV target" }));
    fireEvent.click(screen.getByRole("button", { name: "Test WebDAV" }));

    await waitFor(() => expect(snapshotWebDAV.testSnapshotWebDAV).toHaveBeenCalled());
    expect(snapshotWebDAV.testSnapshotWebDAV).toHaveBeenCalledWith({
      enabled: true,
      url: "https://dav.example.com",
      username: "ops",
      password: "dav-secret",
      rootPath: "/snapshots",
    });
    expect(localStorage.getItem("cs.snapshotWebDAV")).toContain("dav-secret");
    expect(localStorage.getItem("cs.appDataBackup")).toContain("https://app.example.com");
  });

  it("clears migrated snapshot WebDAV password secret refs when a replacement password is saved", async () => {
    localStorage.setItem("locale", "en-US");
    localStorage.setItem(
      "cs.snapshotWebDAV",
      JSON.stringify({
        webdav: {
          enabled: true,
          url: "https://dav.example.com",
          username: "ops",
          password: "",
          rootPath: "/snapshots",
          passwordSecretRef: {
            namespace: "snapshot-webdav",
            ownerId: "default",
            field: "password",
            ref: "snapshot-webdav.default.password",
            migratedAt: "2026-07-08T00:00:00.000Z",
            status: "stored",
          },
        },
        activities: [],
      })
    );

    renderWithI18n(<BackupView />);

    await screen.findByText("Config snapshot sync");
    fireEvent.change(screen.getByLabelText("WebDAV password"), { target: { value: "replacement-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save WebDAV target" }));

    const stored = JSON.parse(localStorage.getItem("cs.snapshotWebDAV") || "{}");
    expect(stored.webdav.password).toBe("replacement-secret");
    expect(stored.webdav.passwordSecretRef).toBeUndefined();
  });

  it("uploads and imports encrypted config snapshot packages without persisting package passwords", async () => {
    const { listSnapshots } = await import("../api/snapshot");
    const snapshotWebDAV = await import("../api/snapshotWebDAV");
    vi.mocked(snapshotWebDAV.uploadSnapshotWebDAVPackage).mockResolvedValue({
      name: "snap.cssnapshot",
      path: "/snapshots/snap.cssnapshot",
      size: 120,
      modifiedAt: "2026-07-08T08:00:00Z",
      snapshotId: "snap-1",
      snapshotName: "dev-nacos_public_20240101",
      provider: "nacos",
      connectionId: "conn-1",
      connectionName: "dev-nacos",
      configCount: 1,
      createdAt: "2024-01-01T10:00:00Z",
    });
    vi.mocked(snapshotWebDAV.listSnapshotWebDAVPackages).mockResolvedValue([
      {
        name: "snap.cssnapshot",
        path: "/snapshots/snap.cssnapshot",
        size: 120,
        modifiedAt: "2026-07-08T08:00:00Z",
        snapshotId: "snap-1",
        snapshotName: "dev-nacos_public_20240101",
        provider: "nacos",
        connectionId: "conn-1",
        connectionName: "dev-nacos",
        configCount: 1,
        createdAt: "2024-01-01T10:00:00Z",
      },
      {
        name: "app.csbackup",
        path: "/snapshots/app.csbackup",
        size: 10,
        modifiedAt: "2026-07-08T08:00:00Z",
        snapshotId: "",
        snapshotName: "",
        provider: "",
        connectionId: "",
        connectionName: "",
        configCount: 0,
        createdAt: "",
      },
    ]);
    vi.mocked(snapshotWebDAV.importSnapshotWebDAVPackage).mockResolvedValue({
      ...mockSnapshots[0],
      id: "snap-imported",
      remoteSnapshotId: "snap-1",
    });
    localStorage.setItem("locale", "en-US");

    renderWithI18n(<BackupView />);

    await screen.findByText("Config snapshot sync");
    fireEvent.change(screen.getByLabelText("WebDAV URL"), { target: { value: "https://dav.example.com" } });
    fireEvent.change(screen.getByLabelText("Snapshot package password"), { target: { value: "package-pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Save WebDAV target" }));
    fireEvent.click(screen.getByRole("button", { name: "Upload selected snapshot" }));

    await waitFor(() => expect(snapshotWebDAV.uploadSnapshotWebDAVPackage).toHaveBeenCalledWith(expect.anything(), "snap-1", "package-pass"));
    expect(localStorage.getItem("cs.snapshotWebDAV")).not.toContain("package-pass");

    fireEvent.click(screen.getByRole("button", { name: "Refresh remote snapshots" }));
    expect(await screen.findByText("snap.cssnapshot")).toBeInTheDocument();
    expect(screen.queryByText("app.csbackup")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Import snap.cssnapshot" }));

    await waitFor(() =>
      expect(snapshotWebDAV.importSnapshotWebDAVPackage).toHaveBeenCalledWith(expect.anything(), "/snapshots/snap.cssnapshot", "package-pass")
    );
    expect(vi.mocked(listSnapshots).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("切走再回来：选中的快照与列表滚动位置都还在（R27）", async () => {
    const { listSnapshots } = await import("../api/snapshot");
    const secondSnapshot: Snapshot = {
      ...mockSnapshots[0],
      id: "snap-2",
      name: "dev-nacos_public_20240102",
      configs: [
        {
          dataId: "gateway.yaml",
          group: "DEFAULT_GROUP",
          content: "server:\n  port: 9090",
          configType: "yaml",
          updateTime: "2024-01-02 10:00:00",
        },
      ],
    };
    vi.mocked(listSnapshots).mockResolvedValue([mockSnapshots[0], secondSnapshot]);

    const first = renderWithI18n(<BackupView />);
    await first.findByText("dev-nacos_public_20240102");
    const items = Array.from(first.container.querySelectorAll<HTMLElement>(".backup-item"));
    fireEvent.click(items[1]);
    await screen.findByText("gateway.yaml");
    expect(items[1].className).toContain("active");

    const list = first.container.querySelector(".backup-list") as HTMLElement;
    list.scrollTop = 220;
    fireEvent.scroll(list);
    expect(readViewState<Snapshot>("backup.selectedSnapshot")?.id).toBe("snap-2");
    expect(readViewState<number>("backup.scroll.list")).toBe(220);
    first.unmount();

    const second = renderWithI18n(<BackupView />);
    await second.findByText("gateway.yaml");
    const restoredItems = Array.from(second.container.querySelectorAll<HTMLElement>(".backup-item"));
    expect(restoredItems[1].className).toContain("active");
    expect((second.container.querySelector(".backup-list") as HTMLElement).scrollTop).toBe(220);
  });

  it("快照包密码不进记忆层，切回来要重输（R27）", async () => {
    const first = renderWithI18n(<BackupView />);
    // 加载完成后会自动选中第一个快照，详情里的 WebDAV 面板随之出现
    const passwordInput = await screen.findByLabelText("快照包密码");
    fireEvent.change(passwordInput, { target: { value: "s3cret" } });
    expect(readViewState<Snapshot>("backup.selectedSnapshot")?.id).toBe("snap-1");

    const leaked = viewStateKeys().filter((key) => {
      const value = readViewState(key);
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return text.includes("s3cret");
    });
    expect(leaked).toEqual([]);
    first.unmount();

    const second = renderWithI18n(<BackupView />);
    await second.findByLabelText("快照包密码");
    expect((second.container.querySelector(".backup-item") as HTMLElement).className).toContain("active");
    expect((screen.getByLabelText("快照包密码") as HTMLInputElement).value).toBe("");
  });
});

