/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor, within } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import AppDataBackupPanel from "./AppDataBackupPanel";

const appDataBackupApi = vi.hoisted(() => ({
  selectAppDataBackupSaveFile: vi.fn(),
  selectAppDataBackupOpenFile: vi.fn(),
  writeAppDataBackupFile: vi.fn(),
  readAppDataBackupFile: vi.fn(),
  createAppDataRecoveryPoint: vi.fn(),
  listAppDataSnapshotFiles: vi.fn(),
  restoreAppDataSnapshotFiles: vi.fn(),
  testAppDataWebDAV: vi.fn(),
  listAppDataWebDAVBackups: vi.fn(),
  uploadAppDataWebDAVBackup: vi.fn(),
  downloadAppDataWebDAVBackup: vi.fn(),
}));

const appApi = vi.hoisted(() => ({
  getAppInfo: vi.fn(),
  getCurrentPlatform: vi.fn(),
}));

vi.mock("../api/appDataBackup", () => appDataBackupApi);
vi.mock("../api/app", () => appApi);
vi.mock("../lib/toast", () => ({ toast: vi.fn() }));

class MemoryStorage {
  private values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  clear() {
    this.values.clear();
  }
}

function backupPayload(connectionId = "restored-conn") {
  return {
    schemaVersion: 1,
    createdAt: "2026-07-07T08:00:00.000Z",
    appVersion: "1.4.2",
    sourcePlatform: "windows",
    data: {
      connections: [{ id: connectionId, name: "Restored", baseUrl: "http://nacos", password: "secret" }],
      sshProfiles: [],
      settings: { proxy: {}, compare: {}, update: {}, startup: {} },
      operationHistory: [],
      applyPlans: [],
      applyVerifications: [],
      snapshots: [] as Array<{ path: string; contentBase64: string; mode?: number }>,
      ui: { mode: "settings" },
      locale: "en-US",
      appDataBackup: { webdav: { enabled: false, url: "", username: "", password: "", rootPath: "/confscope" }, activities: [] },
      snapshotWebDAV: { webdav: { enabled: false, url: "", username: "", password: "", rootPath: "/confscope/snapshots" }, activities: [] },
    },
  };
}

function renderPanel(props: Partial<Parameters<typeof AppDataBackupPanel>[0]> = {}, seedStorage?: () => void) {
  vi.stubGlobal("localStorage", new MemoryStorage());
  localStorage.setItem("locale", "en-US");
  localStorage.setItem("cs.connections", JSON.stringify([{ id: "current-conn", name: "Current", baseUrl: "http://current", password: "local-secret" }]));
  seedStorage?.();
  appApi.getAppInfo.mockResolvedValue({ name: "ConfScope", version: "1.4.2", updateSources: [] });
  appApi.getCurrentPlatform.mockResolvedValue("windows");
  appDataBackupApi.listAppDataSnapshotFiles.mockResolvedValue([]);
  appDataBackupApi.restoreAppDataSnapshotFiles.mockResolvedValue(undefined);
  return render(
    <I18nProvider>
      <AppDataBackupPanel {...props} />
    </I18nProvider>
  );
}

describe("AppDataBackupPanel", () => {
  beforeEach(() => {
    Object.values(appDataBackupApi).forEach((fn) => fn.mockReset());
    Object.values(appApi).forEach((fn) => fn.mockReset());
  });

  it("separates local, cloud, restore, and activity work areas", async () => {
    const restored = backupPayload("layout-preview");
    appDataBackupApi.selectAppDataBackupOpenFile.mockResolvedValue("C:\\tmp\\restore.csbackup");
    appDataBackupApi.readAppDataBackupFile.mockResolvedValue({
      plaintextJson: JSON.stringify(restored),
      summary: { format: "confscope.app-data-backup", schemaVersion: 1, appVersion: "1.4.2", sourcePlatform: "windows", createdAt: restored.createdAt, size: 120 },
    });
    renderPanel();

    expect(screen.getByRole("region", { name: "Local backups" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Cloud backups" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Recent app backup activity" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Choose local backup" }));
    await waitFor(() => expect(screen.getByText("C:\\tmp\\restore.csbackup")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Restore password"), { target: { value: "restore-pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview local backup" }));

    expect(await screen.findByRole("region", { name: "Restore confirmation" })).toBeInTheDocument();
  });

  it("exports current app data to an encrypted local backup file", async () => {
    appDataBackupApi.selectAppDataBackupSaveFile.mockResolvedValue("C:\\tmp\\confscope.csbackup");
    appDataBackupApi.writeAppDataBackupFile.mockResolvedValue({
      format: "confscope.app-data-backup",
      schemaVersion: 1,
      appVersion: "1.4.2",
      sourcePlatform: "windows",
      createdAt: "2026-07-07T08:00:00.000Z",
      size: 120,
    });
    renderPanel();

    fireEvent.change(screen.getByLabelText("Local backup password"), { target: { value: "backup-pass" } });
    fireEvent.change(screen.getByLabelText("Confirm local backup password"), { target: { value: "backup-pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Export encrypted file" }));

    await waitFor(() => expect(appDataBackupApi.writeAppDataBackupFile).toHaveBeenCalled());
    const [, plaintextJson, password, meta] = appDataBackupApi.writeAppDataBackupFile.mock.calls[0];
    const payload = JSON.parse(String(plaintextJson));
    expect(appDataBackupApi.selectAppDataBackupSaveFile).toHaveBeenCalledWith(expect.stringMatching(/^confscope-app-data-/));
    expect(appDataBackupApi.listAppDataSnapshotFiles).toHaveBeenCalled();
    expect(password).toBe("backup-pass");
    expect(meta).toMatchObject({ appVersion: "1.4.2", sourcePlatform: "windows" });
    expect(payload.data.connections[0]).toMatchObject({ id: "current-conn", password: "local-secret" });
    expect(payload.data.snapshots).toEqual([]);
    expect(localStorage.getItem("cs.appDataBackup")).not.toContain("backup-pass");
    expect(within(document.querySelector(".test-msg") as HTMLElement).getByText("Local backup exported")).toBeInTheDocument();
  });

  it("blocks local export when backup passwords do not match", async () => {
    renderPanel();

    fireEvent.change(screen.getByLabelText("Local backup password"), { target: { value: "one-pass" } });
    fireEvent.change(screen.getByLabelText("Confirm local backup password"), { target: { value: "two-pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Export encrypted file" }));

    expect(appDataBackupApi.writeAppDataBackupFile).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Backup passwords do not match");
    expect(screen.getByRole("button", { name: "Copy Error" })).toBeInTheDocument();
  });

  it("previews a local backup and restores only after creating a recovery point", async () => {
    const restored = backupPayload("restored-conn");
    restored.data.snapshots = [{ path: "snap_1/metadata.json", contentBase64: "e30=" }];
    const onRestored = vi.fn();
    appDataBackupApi.selectAppDataBackupOpenFile.mockResolvedValue("C:\\tmp\\restore.csbackup");
    appDataBackupApi.readAppDataBackupFile.mockResolvedValue({
      plaintextJson: JSON.stringify(restored),
      summary: { format: "confscope.app-data-backup", schemaVersion: 1, appVersion: "1.4.2", sourcePlatform: "windows", createdAt: restored.createdAt, size: 120 },
    });
    appDataBackupApi.createAppDataRecoveryPoint.mockResolvedValue({ schemaVersion: 1, appVersion: "1.4.2" });
    renderPanel({ onRestored });

    fireEvent.click(screen.getByRole("button", { name: "Choose local backup" }));
    await waitFor(() => expect(screen.getByText("C:\\tmp\\restore.csbackup")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Restore password"), { target: { value: "restore-pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview local backup" }));
    await screen.findByText("Connections: 1");
    fireEvent.click(screen.getByRole("button", { name: "Restore this backup" }));

    await waitFor(() => expect(appDataBackupApi.createAppDataRecoveryPoint).toHaveBeenCalled());
    expect(JSON.parse(localStorage.getItem("cs.connections") || "[]")[0]).toMatchObject({ id: "restored-conn" });
    expect(appDataBackupApi.createAppDataRecoveryPoint.mock.calls[0][1]).toBe("restore-pass");
    expect(appDataBackupApi.restoreAppDataSnapshotFiles).toHaveBeenCalledWith([{ path: "snap_1/metadata.json", contentBase64: "e30=" }]);
    expect(onRestored).toHaveBeenCalled();
  });

  it("does not overwrite app data when recovery point creation fails", async () => {
    const restored = backupPayload("should-not-write");
    appDataBackupApi.selectAppDataBackupOpenFile.mockResolvedValue("C:\\tmp\\restore.csbackup");
    appDataBackupApi.readAppDataBackupFile.mockResolvedValue({
      plaintextJson: JSON.stringify(restored),
      summary: { format: "confscope.app-data-backup", schemaVersion: 1, appVersion: "1.4.2", sourcePlatform: "windows", createdAt: restored.createdAt, size: 120 },
    });
    appDataBackupApi.createAppDataRecoveryPoint.mockRejectedValue(new Error("disk full"));
    renderPanel({ onRestored: vi.fn() });

    fireEvent.click(screen.getByRole("button", { name: "Choose local backup" }));
    await waitFor(() => expect(screen.getByText("C:\\tmp\\restore.csbackup")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Restore password"), { target: { value: "restore-pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview local backup" }));
    await screen.findByText("Connections: 1");
    fireEvent.click(screen.getByRole("button", { name: "Restore this backup" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("disk full"));
    expect(JSON.parse(localStorage.getItem("cs.connections") || "[]")[0]).toMatchObject({ id: "current-conn" });
  });

  it("saves and tests the single WebDAV backup target", async () => {
    appDataBackupApi.testAppDataWebDAV.mockResolvedValue(undefined);
    renderPanel();

    fireEvent.change(screen.getByLabelText("WebDAV URL"), { target: { value: "https://dav.example.com" } });
    fireEvent.change(screen.getByLabelText("WebDAV username"), { target: { value: "ops" } });
    fireEvent.change(screen.getByLabelText("WebDAV password"), { target: { value: "dav-secret" } });
    fireEvent.change(screen.getByLabelText("Remote folder"), { target: { value: "confscope-backups" } });
    fireEvent.click(screen.getByRole("button", { name: "Save WebDAV target" }));
    fireEvent.click(screen.getByRole("button", { name: "Test WebDAV" }));

    await waitFor(() => expect(appDataBackupApi.testAppDataWebDAV).toHaveBeenCalled());
    expect(appDataBackupApi.testAppDataWebDAV).toHaveBeenCalledWith({
      enabled: true,
      url: "https://dav.example.com",
      username: "ops",
      password: "dav-secret",
      rootPath: "/confscope-backups",
    });
    expect(JSON.parse(localStorage.getItem("cs.appDataBackup") || "{}").webdav).toMatchObject({ rootPath: "/confscope-backups" });
  });

  it("uses migrated WebDAV password secret refs when the password field is blank", async () => {
    const passwordSecretRef = {
      namespace: "app-data-webdav",
      ownerId: "default",
      field: "password",
      ref: "app-data-webdav.default.password",
      migratedAt: "2026-07-08T00:00:00.000Z",
      status: "stored",
    };
    appDataBackupApi.testAppDataWebDAV.mockResolvedValue(undefined);
    renderPanel({}, () => {
      localStorage.setItem(
        "cs.appDataBackup",
        JSON.stringify({
          webdav: {
            enabled: true,
            url: " https://dav.example.com ",
            username: "ops",
            password: "",
            rootPath: "confscope-backups",
            passwordSecretRef,
          },
          activities: [],
        })
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Test WebDAV" }));

    await waitFor(() => expect(appDataBackupApi.testAppDataWebDAV).toHaveBeenCalled());
    expect(appDataBackupApi.testAppDataWebDAV).toHaveBeenCalledWith({
      enabled: true,
      url: "https://dav.example.com",
      username: "ops",
      password: "",
      rootPath: "/confscope-backups",
      passwordSecretRef,
    });
  });

  it("clears migrated WebDAV password secret refs when a replacement password is saved", async () => {
    renderPanel({}, () => {
      localStorage.setItem(
        "cs.appDataBackup",
        JSON.stringify({
          webdav: {
            enabled: true,
            url: "https://dav.example.com",
            username: "ops",
            password: "",
            rootPath: "/confscope",
            passwordSecretRef: {
              namespace: "app-data-webdav",
              ownerId: "default",
              field: "password",
              ref: "app-data-webdav.default.password",
              migratedAt: "2026-07-08T00:00:00.000Z",
              status: "stored",
            },
          },
          activities: [],
        })
      );
    });

    fireEvent.change(screen.getByLabelText("WebDAV password"), { target: { value: "replacement-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save WebDAV target" }));

    const stored = JSON.parse(localStorage.getItem("cs.appDataBackup") || "{}");
    expect(stored.webdav.password).toBe("replacement-secret");
    expect(stored.webdav.passwordSecretRef).toBeUndefined();
  });

  it("uploads current data, lists remote backups, downloads a remote backup, and restores it", async () => {
    const remotePayload = backupPayload("remote-restored");
    const onRestored = vi.fn();
    appDataBackupApi.uploadAppDataWebDAVBackup.mockResolvedValue({
      name: "remote.csbackup",
      path: "/confscope/remote.csbackup",
      size: 120,
      modifiedAt: "2026-07-07T08:00:00.000Z",
    });
    appDataBackupApi.listAppDataWebDAVBackups.mockResolvedValue([
      { name: "remote.csbackup", path: "/confscope/remote.csbackup", size: 120, modifiedAt: "2026-07-07T08:00:00.000Z" },
    ]);
    appDataBackupApi.downloadAppDataWebDAVBackup.mockResolvedValue({
      plaintextJson: JSON.stringify(remotePayload),
      summary: { format: "confscope.app-data-backup", schemaVersion: 1, appVersion: "1.4.2", sourcePlatform: "windows", createdAt: remotePayload.createdAt, size: 120 },
    });
    appDataBackupApi.createAppDataRecoveryPoint.mockResolvedValue({ schemaVersion: 1, appVersion: "1.4.2" });
    renderPanel({ onRestored });

    fireEvent.change(screen.getByLabelText("WebDAV URL"), { target: { value: "https://dav.example.com" } });
    fireEvent.change(screen.getByLabelText("WebDAV username"), { target: { value: "ops" } });
    fireEvent.change(screen.getByLabelText("WebDAV password"), { target: { value: "dav-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save WebDAV target" }));
    fireEvent.change(screen.getByLabelText("WebDAV backup password"), { target: { value: "remote-pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Upload current data" }));
    fireEvent.click(await screen.findByRole("button", { name: "Refresh remote list" }));
    fireEvent.change(screen.getByLabelText("Remote restore password"), { target: { value: "remote-pass" } });
    fireEvent.click(await screen.findByRole("button", { name: "Preview remote.csbackup" }));
    await screen.findByText("Connections: 1");
    fireEvent.click(screen.getByRole("button", { name: "Restore this backup" }));

    await waitFor(() => expect(appDataBackupApi.uploadAppDataWebDAVBackup).toHaveBeenCalled());
    expect(appDataBackupApi.downloadAppDataWebDAVBackup).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://dav.example.com" }),
      "/confscope/remote.csbackup",
      "remote-pass"
    );
    expect(JSON.parse(localStorage.getItem("cs.connections") || "[]")[0]).toMatchObject({ id: "remote-restored" });
    expect(onRestored).toHaveBeenCalled();
  });
});
