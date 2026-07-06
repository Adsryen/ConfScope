/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from "./test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "./i18n";
import type { Connection } from "./store/connections";
import type { BackupDiffJumpParams } from "./components/BackupView";
import type { DiffJumpParams } from "./components/AuditView";
import type { ApplyEntryPayload } from "./lib/applyEntry";
import App from "./App";
import { reportError, reportMessage } from "./lib/errorCenter";
import { toast } from "./lib/toast";
import { loadSettings } from "./store/settings";
import { loadOperationHistory } from "./store/operationHistory";

const apiMocks = vi.hoisted(() => ({
  listNamespaces: vi.fn(),
  checkForUpdates: vi.fn(),
  getAppInfo: vi.fn(),
}));

const viewMocks = vi.hoisted(() => ({
  diffProps: [] as Array<{
    connections: Connection[];
    initialParams: DiffJumpParams | null;
  }>,
  applyProps: [] as Array<{
    entry: ApplyEntryPayload | null;
    connections: Connection[];
  }>,
  makeApplyPayload: (mode: "audit" | "diff" | "backup"): ApplyEntryPayload => ({
    sourceType: mode,
    scope: mode === "audit" ? "key" : "config",
    source: {
      provider: mode === "backup" ? "local" : "nacos",
      connectionId: `${mode}-source`,
      connectionName: `${mode}-source`,
      namespace: "",
      label: "entry-source / public",
    },
    target: {
      provider: "nacos",
      connectionId: `${mode}-target`,
      connectionName: `${mode}-target`,
      namespace: "",
      label: "entry-target / public",
    },
    items: [
      {
        provider: "nacos",
        connectionId: `${mode}-target`,
        namespace: "",
        group: "DEFAULT_GROUP",
        dataId: `${mode}.yaml`,
        key: mode === "audit" ? "server.port" : "__document",
      },
    ],
    rangeSummary: {
      count: 1,
      skippedCount: 0,
      riskLevel: "low",
      riskReasons: [],
    },
    origin: {
      mode,
      returnMode: mode,
    },
  }),
}));

vi.mock("./api/nacos", async () => {
  const actual = await vi.importActual<typeof import("./api/nacos")>("./api/nacos");
  return {
    ...actual,
    listNamespaces: apiMocks.listNamespaces,
  };
});

vi.mock("./api/app", () => ({
  checkForUpdates: apiMocks.checkForUpdates,
  getAppInfo: apiMocks.getAppInfo,
}));

vi.mock("./lib/errorCenter", () => ({
  reportError: vi.fn(),
  reportMessage: vi.fn(),
}));

vi.mock("./lib/toast", () => ({
  toast: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}));

vi.mock("./components/ConnectionManager", () => ({ default: () => <div data-testid="connection-manager" /> }));
vi.mock("./components/ConfigBrowser", () => ({ default: () => <div data-testid="config-browser" /> }));
vi.mock("./components/About", () => ({ default: () => <div data-testid="about" /> }));
vi.mock("./components/SettingsView", () => ({ default: () => <div data-testid="settings" /> }));
vi.mock("./components/SSHManagerView", () => ({ default: () => <div data-testid="ssh" /> }));
vi.mock("./components/ErrorDialog", () => ({ default: () => <div data-testid="error-dialog" /> }));
vi.mock("./components/MessageCenter", () => ({ default: () => <div data-testid="message-center" /> }));
vi.mock("./components/TaskCenter", () => ({ default: () => <div data-testid="tasks" /> }));
vi.mock("./components/AuditView", () => ({
  default: ({ onStartApply }: { onStartApply?: (payload: ApplyEntryPayload) => void }) => (
    <div data-testid="audit">
      <button type="button" onClick={() => onStartApply?.(viewMocks.makeApplyPayload("audit"))}>
        Mock audit apply
      </button>
    </div>
  ),
}));
vi.mock("./components/OperationHistoryView", () => ({ default: () => <div data-testid="history" /> }));
vi.mock("./components/ApplyPlanView", () => ({
  default: ({
    entry,
    connections,
    onBack,
  }: {
    entry: ApplyEntryPayload | null;
    connections: Connection[];
    onBack: () => void;
  }) => {
    viewMocks.applyProps.push({ entry, connections });
    return (
      <section aria-label="apply-plan-workbench">
        <h3>Apply Plan Workbench</h3>
        <div>{entry?.source.label}</div>
        <div>{entry?.target.label}</div>
        <button type="button" onClick={onBack}>
          Mock ApplyPlanView back
        </button>
      </section>
    );
  },
}));

vi.mock("./components/BackupView", () => ({
  default: ({
    onNavigateToDiff,
    onStartApply,
  }: {
    onNavigateToDiff?: (params: BackupDiffJumpParams) => void;
    onStartApply?: (payload: ApplyEntryPayload) => void;
  }) => {
    const config = {
      dataId: "app.yaml",
      group: "DEFAULT_GROUP",
      content: "server:\n  port: 8080",
      configType: "yaml",
      updateTime: "2026-07-04T00:00:00Z",
    };
    const snapshot = {
      id: "snap-1",
      path: "C:\\backups\\snap-1",
      name: "dev_snapshot",
      description: "",
      createdAt: "2026-07-04T00:00:00Z",
      updatedAt: "2026-07-04T00:00:00Z",
      source: {
        connectionId: "conn-1",
        connectionName: "dev",
        namespace: "public",
        namespaceId: "public",
      },
      configs: [config],
    };
    const makeParams = (overrides: Partial<BackupDiffJumpParams> = {}): BackupDiffJumpParams => ({
      snapshot,
      config,
      sourceConnectionId: "conn-1",
      sourceConnectionName: "dev",
      snapshotPath: "C:\\backups\\snap-1",
      namespace: "",
      group: "DEFAULT_GROUP",
      dataId: "app.yaml",
      ...overrides,
    });

    return (
      <div>
        <button type="button" onClick={() => onNavigateToDiff?.(makeParams())}>
          Mock compare snapshot
        </button>
        <button
          type="button"
          onClick={() =>
            onNavigateToDiff?.(
              makeParams({
                snapshot: {
                  ...snapshot,
                  id: "snap-missing-source",
                  name: "missing_source_snapshot",
                  source: {
                    ...snapshot.source,
                    connectionId: "missing-conn",
                    connectionName: "missing-dev",
                  },
                },
                sourceConnectionId: "missing-conn",
                sourceConnectionName: "missing-dev",
              })
            )
          }
        >
          Mock compare missing source
        </button>
        <button
          type="button"
          onClick={() =>
            onNavigateToDiff?.(
              makeParams({
                snapshot: {
                  ...snapshot,
                  id: "snap-missing-path",
                  path: "",
                  name: "missing_path_snapshot",
                },
                snapshotPath: "",
              })
            )
          }
        >
          Mock compare missing path
        </button>
        <button type="button" onClick={() => onStartApply?.(viewMocks.makeApplyPayload("backup"))}>
          Mock backup apply
        </button>
      </div>
    );
  },
}));

vi.mock("./components/DiffView", () => ({
  default: ({
    connections,
    initialParams,
    onStartApply,
  }: {
    connections: Connection[];
    initialParams: DiffJumpParams | null;
    onStartApply?: (payload: ApplyEntryPayload) => void;
  }) => {
    viewMocks.diffProps.push({ connections, initialParams });
    return (
      <div data-testid="diff-view">
        Diff View
        <button type="button" onClick={() => onStartApply?.(viewMocks.makeApplyPayload("diff"))}>
          Mock diff apply
        </button>
      </div>
    );
  },
}));

const sourceConnection: Connection = {
  id: "conn-1",
  name: "dev",
  projectName: "Order",
  environmentName: "Development",
  sourceName: "Cloud",
  sourceType: "nacos",
  provider: "nacos",
  distribution: "opensource",
  authType: "nacos-password",
  baseUrl: "http://dev.example.com/nacos",
  username: "nacos",
  password: "secret",
  defaultNamespace: "",
};

describe("App", () => {
  beforeEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    localStorage.setItem("locale", "en-US");
    localStorage.setItem("cs.connections", JSON.stringify([sourceConnection]));
    localStorage.setItem("cs.ui", JSON.stringify({ mode: "backup", connId: "conn-1" }));
    localStorage.setItem(
      "cs.settings",
      JSON.stringify({
        startup: { lastOpenedVersion: "1.3.0", lastShownWelcomeVersion: "", lastShownChangelogVersion: "1.3.0" },
      })
    );
    viewMocks.diffProps.length = 0;
    viewMocks.applyProps.length = 0;
    apiMocks.listNamespaces.mockResolvedValue([]);
    apiMocks.getAppInfo.mockResolvedValue({ name: "ConfScope", version: "1.3.0", updateSources: [] });
    apiMocks.checkForUpdates.mockResolvedValue({ hasUpdate: false, latestVersion: "", releaseNotes: "" });
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      fillStyle: "",
    } as unknown as CanvasRenderingContext2D);
    vi.mocked(reportError).mockClear();
    vi.mocked(reportMessage).mockClear();
    vi.mocked(toast).mockClear();
  });

  it("shows the fresh-install welcome dialog once and records dismissal", async () => {
    localStorage.clear();
    localStorage.setItem("locale", "en-US");

    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    expect(await screen.findByRole("dialog", { name: "Welcome to ConfScope" })).toBeInTheDocument();
    expect(screen.getByTestId("startup-fireworks")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Start using" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Welcome to ConfScope" })).not.toBeInTheDocument();
    });
    expect(loadSettings().startup).toEqual({
      lastOpenedVersion: "1.3.0",
      lastShownWelcomeVersion: "1.3.0",
      lastShownChangelogVersion: "",
    });
  });

  it("shows update notes once for an existing profile and records dismissal", async () => {
    localStorage.clear();
    localStorage.setItem("locale", "en-US");
    localStorage.setItem("cs.connections", JSON.stringify([sourceConnection]));
    apiMocks.getAppInfo.mockResolvedValueOnce({ name: "ConfScope", version: "1.3.1", updateSources: [] });

    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    expect(await screen.findByRole("dialog", { name: "Updated to v1.3.1" })).toBeInTheDocument();
    expect(screen.getByText("Fixed update checks and release metadata")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Updated to v1.3.1" })).not.toBeInTheDocument();
    });
    expect(loadSettings().startup).toEqual({
      lastOpenedVersion: "1.3.1",
      lastShownWelcomeVersion: "",
      lastShownChangelogVersion: "1.3.1",
    });
  });

  it("does not repeat a startup dialog already dismissed for the current version", async () => {
    localStorage.clear();
    localStorage.setItem("locale", "en-US");
    localStorage.setItem(
      "cs.settings",
      JSON.stringify({
        startup: { lastOpenedVersion: "1.3.0", lastShownWelcomeVersion: "1.3.0", lastShownChangelogVersion: "" },
      })
    );

    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitFor(() => {
      expect(apiMocks.getAppInfo).toHaveBeenCalled();
    });
    expect(screen.queryByRole("dialog", { name: "Welcome to ConfScope" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Updated to v1.3.0" })).not.toBeInTheDocument();
  });

  it("does not mark config navigation as planned when there are no connections", async () => {
    localStorage.clear();
    localStorage.setItem("locale", "en-US");
    localStorage.setItem(
      "cs.settings",
      JSON.stringify({
        startup: { lastOpenedVersion: "1.3.0", lastShownWelcomeVersion: "1.3.0", lastShownChangelogVersion: "" },
      })
    );

    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitFor(() => {
      expect(apiMocks.getAppInfo).toHaveBeenCalled();
    });
    expect(within(screen.getByRole("button", { name: /Config Browser/ })).queryByText("Planned")).not.toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /Config Compare/ })).queryByText("Planned")).not.toBeInTheDocument();
  });

  it("opens the about page even when there are no connections", async () => {
    localStorage.clear();
    localStorage.setItem("locale", "en-US");
    localStorage.setItem(
      "cs.settings",
      JSON.stringify({
        startup: { lastOpenedVersion: "1.3.0", lastShownWelcomeVersion: "1.3.0", lastShownChangelogVersion: "" },
      })
    );

    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitFor(() => {
      expect(apiMocks.getAppInfo).toHaveBeenCalled();
    });
    fireEvent.click(screen.getByRole("button", { name: /About/ }));

    expect(screen.getByTestId("about")).toBeInTheDocument();
    expect(screen.queryByText("No Nacos connections yet")).not.toBeInTheDocument();
  });

  it("opens DiffView with a runtime local snapshot source from BackupView", async () => {
    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Mock compare snapshot" }));

    expect(await screen.findByTestId("diff-view")).toBeInTheDocument();

    await waitFor(() => {
      expect(viewMocks.diffProps.length).toBeGreaterThan(0);
    });
    const latestProps = viewMocks.diffProps[viewMocks.diffProps.length - 1];
    expect(latestProps.initialParams).toEqual({
      leftConnId: "snapshot:snap-1",
      rightConnId: "conn-1",
      namespace: "",
      group: "DEFAULT_GROUP",
      dataId: "app.yaml",
      autoCompare: true,
    });
    expect(latestProps.connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "snapshot:snap-1",
          provider: "local",
          sourceType: "local-snapshot",
          localPath: "C:\\backups\\snap-1",
          defaultNamespace: "",
        }),
      ])
    );
    expect(toast).toHaveBeenCalledWith("Snapshot source loaded for compare", "info");
    expect(loadOperationHistory()[0]).toMatchObject({
      type: "snapshot_compare",
      result: "success",
      connectionId: "conn-1",
      connectionName: "dev",
      namespace: "public",
      group: "DEFAULT_GROUP",
      dataId: "app.yaml",
      resourceId: "snap-1",
      resourceName: "dev_snapshot",
      content: "C:\\backups\\snap-1",
      rollbackable: false,
      rollbackReason: "operationHistory.rollbackSnapshotOnly",
    });
  });

  it.each([
    { mode: "backup", buttonName: "Mock backup apply" },
    { mode: "audit", buttonName: "Mock audit apply" },
    { mode: "diff", buttonName: "Mock diff apply" },
  ] as const)("enters ApplyPlanView from $mode", async ({ mode, buttonName }) => {
    localStorage.setItem("cs.ui", JSON.stringify({ mode, connId: "conn-1" }));

    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: buttonName }));

    expect(screen.getByRole("heading", { name: "Apply Plan Workbench" })).toBeInTheDocument();
    expect(screen.getByText("entry-source / public")).toBeInTheDocument();
    expect(screen.getByText("entry-target / public")).toBeInTheDocument();
    expect(screen.queryByText("Plan preview placeholder")).not.toBeInTheDocument();
    expect(viewMocks.applyProps[viewMocks.applyProps.length - 1]).toMatchObject({
      entry: expect.objectContaining({ sourceType: mode }),
      connections: expect.arrayContaining([expect.objectContaining({ id: "conn-1" })]),
    });
    expect(screen.queryByRole("button", { name: /Execute|Publish|Delete|Apply Now/i })).not.toBeInTheDocument();
  });

  it("returns from ApplyPlanView to the originating entry", async () => {
    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "Mock backup apply" }));
    fireEvent.click(screen.getByRole("button", { name: "Mock ApplyPlanView back" }));

    expect(screen.getByRole("button", { name: "Mock backup apply" })).toBeInTheDocument();
  });

  it("records a failed snapshot compare when the source connection is missing", async () => {
    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Mock compare missing source" }));

    expect(screen.queryByTestId("diff-view")).not.toBeInTheDocument();
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Cannot open snapshot compare",
        source: "missing-dev",
        message: "The source connection for this snapshot no longer exists. Restore or recreate it first.",
      })
    );
    expect(loadOperationHistory()[0]).toMatchObject({
      type: "snapshot_compare",
      result: "failure",
      connectionId: "missing-conn",
      connectionName: "missing-dev",
      namespace: "public",
      group: "DEFAULT_GROUP",
      dataId: "app.yaml",
      resourceId: "snap-missing-source",
      resourceName: "missing_source_snapshot",
      content: "C:\\backups\\snap-1",
      error: "The source connection for this snapshot no longer exists. Restore or recreate it first.",
      rollbackable: false,
      rollbackReason: "operationHistory.rollbackSnapshotOnly",
    });
  });

  it("records a failed snapshot compare when the snapshot path is missing", async () => {
    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Mock compare missing path" }));

    expect(screen.queryByTestId("diff-view")).not.toBeInTheDocument();
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Cannot open snapshot compare",
        source: "missing_path_snapshot",
        message: "Snapshot local path is missing, so it cannot be used as a local compare source.",
      })
    );
    expect(loadOperationHistory()[0]).toMatchObject({
      type: "snapshot_compare",
      result: "failure",
      connectionId: "conn-1",
      connectionName: "dev",
      namespace: "public",
      group: "DEFAULT_GROUP",
      dataId: "app.yaml",
      resourceId: "snap-missing-path",
      resourceName: "missing_path_snapshot",
      content: "",
      error: "Snapshot local path is missing, so it cannot be used as a local compare source.",
      rollbackable: false,
      rollbackReason: "operationHistory.rollbackSnapshotOnly",
    });
  });

  it("reports namespace loading errors with localized message-center actions", async () => {
    apiMocks.listNamespaces.mockRejectedValueOnce(new Error("namespace denied"));

    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    await waitFor(() => {
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Failed to load namespaces",
          actionLabel: "Retry",
        })
      );
    });
  });

  it("reports background update notifications with localized message-center actions", async () => {
    vi.useFakeTimers();
    try {
      apiMocks.checkForUpdates.mockResolvedValueOnce({
        hasUpdate: true,
        latestVersion: "1.4.0",
        releaseNotes: "release notes",
        error: "",
        mandatory: false,
      });

      render(
        <I18nProvider>
          <App />
        </I18nProvider>
      );

      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
        await Promise.resolve();
      });

      expect(reportMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "New version v1.4.0 available",
          source: "App Updates",
          actionLabel: "Open Download Page",
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
