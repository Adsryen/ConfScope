/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "./test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "./i18n";
import type { Connection } from "./store/connections";
import type { BackupDiffJumpParams } from "./components/BackupView";
import type { DiffJumpParams } from "./components/AuditView";
import App from "./App";
import { toast } from "./lib/toast";

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
    localStorage.clear();
    localStorage.setItem("locale", "en-US");
    localStorage.setItem("cs.connections", JSON.stringify([sourceConnection]));
    localStorage.setItem("cs.ui", JSON.stringify({ mode: "backup", connId: "conn-1" }));
    viewMocks.diffProps.length = 0;
    apiMocks.listNamespaces.mockResolvedValue([]);
    apiMocks.getAppInfo.mockResolvedValue({ name: "ConfScope", version: "1.3.0", updateSources: [] });
    apiMocks.checkForUpdates.mockResolvedValue({ hasUpdate: false, latestVersion: "", releaseNotes: "" });
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
});
