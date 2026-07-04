/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "./test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "./i18n";
import type { Connection } from "./store/connections";
import type { BackupDiffJumpParams } from "./components/BackupView";
import type { DiffJumpParams } from "./components/AuditView";
import App from "./App";
import { reportError, reportMessage } from "./lib/errorCenter";
import { toast } from "./lib/toast";
import { loadSettings } from "./store/settings";

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
vi.mock("./components/AuditView", () => ({ default: () => <div data-testid="audit" /> }));
vi.mock("./components/OperationHistoryView", () => ({ default: () => <div data-testid="history" /> }));

vi.mock("./components/BackupView", () => ({
  default: ({ onNavigateToDiff }: { onNavigateToDiff?: (params: BackupDiffJumpParams) => void }) => (
    <button
      type="button"
      onClick={() =>
        onNavigateToDiff?.({
          snapshot: {
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
            configs: [
              {
                dataId: "app.yaml",
                group: "DEFAULT_GROUP",
                content: "server:\n  port: 8080",
                configType: "yaml",
                updateTime: "2026-07-04T00:00:00Z",
              },
            ],
          },
          config: {
            dataId: "app.yaml",
            group: "DEFAULT_GROUP",
            content: "server:\n  port: 8080",
            configType: "yaml",
            updateTime: "2026-07-04T00:00:00Z",
          },
          sourceConnectionId: "conn-1",
          sourceConnectionName: "dev",
          snapshotPath: "C:\\backups\\snap-1",
          namespace: "",
          group: "DEFAULT_GROUP",
          dataId: "app.yaml",
        })
      }
    >
      Mock compare snapshot
    </button>
  ),
}));

vi.mock("./components/DiffView", () => ({
  default: ({ connections, initialParams }: { connections: Connection[]; initialParams: DiffJumpParams | null }) => {
    viewMocks.diffProps.push({ connections, initialParams });
    return <div data-testid="diff-view">Diff View</div>;
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

    render(
      <I18nProvider>
        <App />
      </I18nProvider>
    );

    expect(await screen.findByRole("dialog", { name: "Updated to v1.3.0" })).toBeInTheDocument();
    expect(screen.getByText("Added local snapshots and backup management")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Updated to v1.3.0" })).not.toBeInTheDocument();
    });
    expect(loadSettings().startup).toEqual({
      lastOpenedVersion: "1.3.0",
      lastShownWelcomeVersion: "",
      lastShownChangelogVersion: "1.3.0",
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
