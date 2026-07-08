/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  downloadAppDataWebDAVBackup,
  createAppDataRecoveryPoint,
  listAppDataWebDAVBackups,
  readAppDataBackupFile,
  selectAppDataBackupOpenFile,
  selectAppDataBackupSaveFile,
  testAppDataWebDAV,
  uploadAppDataWebDAVBackup,
  writeAppDataBackupFile,
} from "./appDataBackup";

const goApp = {
  SelectAppDataBackupSaveFile: vi.fn(),
  SelectAppDataBackupOpenFile: vi.fn(),
  WriteAppDataBackupFile: vi.fn(),
  ReadAppDataBackupFile: vi.fn(),
  CreateAppDataRecoveryPoint: vi.fn(),
  TestAppDataWebDAV: vi.fn(),
  ListAppDataWebDAVBackups: vi.fn(),
  UploadAppDataWebDAVBackup: vi.fn(),
  DownloadAppDataWebDAVBackup: vi.fn(),
  ReadSecureSecret: vi.fn(),
};

describe("appDataBackup api", () => {
  beforeEach(() => {
    Object.values(goApp).forEach((fn) => fn.mockReset());
    goApp.ReadSecureSecret.mockResolvedValue("stored-webdav-password");
    vi.stubGlobal("go", {
      main: {
        App: goApp,
      },
    });
  });

  it("uses Wails bindings for local backup file selection and crypto I/O", async () => {
    const meta = { appVersion: "1.4.2", sourcePlatform: "windows", createdAt: "2026-07-07T08:00:00.000Z" };
    goApp.SelectAppDataBackupSaveFile.mockResolvedValue("C:\\backups\\app.csbackup");
    goApp.SelectAppDataBackupOpenFile.mockResolvedValue("C:\\backups\\app.csbackup");
    goApp.WriteAppDataBackupFile.mockResolvedValue({ schemaVersion: 1, appVersion: "1.4.2" });
    goApp.ReadAppDataBackupFile.mockResolvedValue({ plaintextJson: "{\"schemaVersion\":1}", summary: { schemaVersion: 1 } });
    goApp.CreateAppDataRecoveryPoint.mockResolvedValue({ schemaVersion: 1, appVersion: "1.4.2" });

    await expect(selectAppDataBackupSaveFile("app.csbackup")).resolves.toBe("C:\\backups\\app.csbackup");
    await expect(selectAppDataBackupOpenFile()).resolves.toBe("C:\\backups\\app.csbackup");
    await expect(writeAppDataBackupFile("C:\\backups\\app.csbackup", "{\"ok\":true}", "pass", meta)).resolves.toMatchObject({
      schemaVersion: 1,
    });
    await expect(readAppDataBackupFile("C:\\backups\\app.csbackup", "pass")).resolves.toMatchObject({
      plaintextJson: "{\"schemaVersion\":1}",
    });
    await expect(createAppDataRecoveryPoint("{\"ok\":true}", "pass", meta)).resolves.toMatchObject({
      schemaVersion: 1,
    });

    expect(goApp.SelectAppDataBackupSaveFile).toHaveBeenCalledWith("app.csbackup");
    expect(goApp.WriteAppDataBackupFile).toHaveBeenCalledWith("C:\\backups\\app.csbackup", "{\"ok\":true}", "pass", meta);
    expect(goApp.ReadAppDataBackupFile).toHaveBeenCalledWith("C:\\backups\\app.csbackup", "pass");
    expect(goApp.CreateAppDataRecoveryPoint).toHaveBeenCalledWith("{\"ok\":true}", "pass", meta);
  });

  it("uses Wails bindings for single-target WebDAV operations", async () => {
    const target = { enabled: true, url: "https://dav.example.com", username: "ops", password: "secret", rootPath: "/confscope" };
    const meta = { appVersion: "1.4.2", sourcePlatform: "windows", createdAt: "2026-07-07T08:00:00.000Z" };
    goApp.TestAppDataWebDAV.mockResolvedValue(undefined);
    goApp.ListAppDataWebDAVBackups.mockResolvedValue([{ name: "app.csbackup", path: "/confscope/app.csbackup", size: 10 }]);
    goApp.UploadAppDataWebDAVBackup.mockResolvedValue({ name: "app.csbackup", path: "/confscope/app.csbackup", size: 10 });
    goApp.DownloadAppDataWebDAVBackup.mockResolvedValue({ plaintextJson: "{\"schemaVersion\":1}", summary: { schemaVersion: 1 } });

    await expect(testAppDataWebDAV(target)).resolves.toBeUndefined();
    await expect(listAppDataWebDAVBackups(target)).resolves.toHaveLength(1);
    await expect(uploadAppDataWebDAVBackup(target, "{\"ok\":true}", "pass", meta)).resolves.toMatchObject({ name: "app.csbackup" });
    await expect(downloadAppDataWebDAVBackup(target, "/confscope/app.csbackup", "pass")).resolves.toMatchObject({
      plaintextJson: "{\"schemaVersion\":1}",
    });

    expect(goApp.TestAppDataWebDAV).toHaveBeenCalledWith(target);
    expect(goApp.ListAppDataWebDAVBackups).toHaveBeenCalledWith(target);
    expect(goApp.UploadAppDataWebDAVBackup).toHaveBeenCalledWith(target, "{\"ok\":true}", "pass", meta);
    expect(goApp.DownloadAppDataWebDAVBackup).toHaveBeenCalledWith(target, "/confscope/app.csbackup", "pass");
  });

  it("normalizes a null WebDAV backup list from native bindings to an empty array", async () => {
    const target = { enabled: true, url: "https://dav.example.com", username: "ops", password: "secret", rootPath: "/confscope" };
    goApp.ListAppDataWebDAVBackups.mockResolvedValue(null);

    await expect(listAppDataWebDAVBackups(target)).resolves.toEqual([]);
  });

  it("hydrates migrated WebDAV passwords before calling native bindings", async () => {
    const target = {
      enabled: true,
      url: "https://dav.example.com",
      username: "ops",
      password: "",
      rootPath: "/confscope",
      passwordSecretRef: {
        ref: "app-data-webdav.default.password",
        namespace: "app-data-webdav" as const,
        ownerId: "default",
        field: "password",
        migratedAt: "2026-07-08T00:00:00.000Z",
        status: "stored" as const,
      },
    };
    const meta = { appVersion: "1.4.2", sourcePlatform: "windows", createdAt: "2026-07-07T08:00:00.000Z" };
    goApp.TestAppDataWebDAV.mockResolvedValue(undefined);
    goApp.ListAppDataWebDAVBackups.mockResolvedValue([]);
    goApp.UploadAppDataWebDAVBackup.mockResolvedValue({ name: "app.csbackup", path: "/confscope/app.csbackup", size: 10 });
    goApp.DownloadAppDataWebDAVBackup.mockResolvedValue({ plaintextJson: "{\"schemaVersion\":1}", summary: { schemaVersion: 1 } });

    await expect(testAppDataWebDAV(target)).resolves.toBeUndefined();
    await expect(listAppDataWebDAVBackups(target)).resolves.toEqual([]);
    await expect(uploadAppDataWebDAVBackup(target, "{\"ok\":true}", "package-pass", meta)).resolves.toMatchObject({ name: "app.csbackup" });
    await expect(downloadAppDataWebDAVBackup(target, "/confscope/app.csbackup", "package-pass")).resolves.toMatchObject({
      plaintextJson: "{\"schemaVersion\":1}",
    });

    const hydrated = { ...target, password: "stored-webdav-password" };
    expect(goApp.TestAppDataWebDAV).toHaveBeenCalledWith(hydrated);
    expect(goApp.ListAppDataWebDAVBackups).toHaveBeenCalledWith(hydrated);
    expect(goApp.UploadAppDataWebDAVBackup).toHaveBeenCalledWith(hydrated, "{\"ok\":true}", "package-pass", meta);
    expect(goApp.DownloadAppDataWebDAVBackup).toHaveBeenCalledWith(hydrated, "/confscope/app.csbackup", "package-pass");
  });
});
