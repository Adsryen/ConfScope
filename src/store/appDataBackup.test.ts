import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAppDataBackupActivities,
  loadAppDataBackupState,
  recordAppDataBackupActivity,
  saveAppDataBackupState,
  updateAppDataBackupPasswordSecretRef,
  updateAppDataWebDAVSettings,
} from "./appDataBackup";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

describe("appDataBackup store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T08:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.123456);
    vi.stubGlobal("localStorage", new MemoryStorage());
  });

  it("returns safe defaults when storage is empty or malformed", () => {
    expect(loadAppDataBackupState()).toEqual({
      webdav: {
        enabled: false,
        url: "",
        username: "",
        password: "",
        rootPath: "/confscope",
      },
      activities: [],
    });

    localStorage.setItem("cs.appDataBackup", "{bad json");

    expect(loadAppDataBackupState()).toEqual({
      webdav: {
        enabled: false,
        url: "",
        username: "",
        password: "",
        rootPath: "/confscope",
      },
      activities: [],
    });
  });

  it("persists the single WebDAV backup target", () => {
    const next = updateAppDataWebDAVSettings({
      enabled: true,
      url: " https://dav.example.com/remote.php/dav/files/me ",
      username: "ops",
      password: "dav-secret",
      rootPath: " backups/confscope ",
    });

    expect(next.webdav).toEqual({
      enabled: true,
      url: "https://dav.example.com/remote.php/dav/files/me",
      username: "ops",
      password: "dav-secret",
      rootPath: "/backups/confscope",
    });
    expect(loadAppDataBackupState().webdav).toEqual(next.webdav);
  });

  it("preserves migrated WebDAV password secret refs", () => {
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
            ref: "app-data-webdav.default.password",
            namespace: "app-data-webdav",
            ownerId: "default",
            field: "password",
            migratedAt: "2026-07-08T00:00:00.000Z",
            status: "stored",
          },
        },
        activities: [],
      })
    );

    expect(loadAppDataBackupState().webdav.passwordSecretRef).toEqual({
      ref: "app-data-webdav.default.password",
      namespace: "app-data-webdav",
      ownerId: "default",
      field: "password",
      migratedAt: "2026-07-08T00:00:00.000Z",
      status: "stored",
    });
  });

  it("drops WebDAV password secret refs with an invalid namespace", () => {
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
            ref: "app-data-webdav.default.password",
            namespace: "connection",
            ownerId: "default",
            field: "password",
            migratedAt: "2026-07-08T00:00:00.000Z",
            status: "stored",
          },
        },
        activities: [],
      })
    );

    expect(loadAppDataBackupState().webdav.passwordSecretRef).toBeUndefined();
  });

  it("persists only the dedicated app-data backup password pointer", () => {
    const pointer = {
      ref: "app-data-backup.default.encryption-password",
      namespace: "app-data-backup" as const,
      ownerId: "default",
      field: "encryption-password",
      migratedAt: "2026-08-11T00:00:00.000Z",
      status: "stored" as const,
    };

    expect(updateAppDataBackupPasswordSecretRef(pointer).backupPasswordSecretRef).toEqual(pointer);
    expect(loadAppDataBackupState().backupPasswordSecretRef).toEqual(pointer);
    expect(updateAppDataBackupPasswordSecretRef().backupPasswordSecretRef).toBeUndefined();
  });

  it("drops app-data backup password pointers from another credential namespace", () => {
    localStorage.setItem(
      "cs.appDataBackup",
      JSON.stringify({
        webdav: {},
        backupPasswordSecretRef: {
          ref: "connection.conn-1.password",
          namespace: "connection",
          ownerId: "conn-1",
          field: "password",
          migratedAt: "2026-08-11T00:00:00.000Z",
          status: "stored",
        },
        activities: [],
      })
    );

    expect(loadAppDataBackupState().backupPasswordSecretRef).toBeUndefined();
  });

  it("records activities newest first and clears them without deleting WebDAV settings", () => {
    saveAppDataBackupState({
      webdav: {
        enabled: true,
        url: "https://dav.example.com",
        username: "ops",
        password: "secret",
        rootPath: "/confscope",
      },
      activities: [],
    });

    const first = recordAppDataBackupActivity({
      type: "local_export",
      status: "success",
      target: "C:\\backups\\one.csbackup",
      message: "created",
    });
    vi.setSystemTime(new Date("2026-07-07T09:00:00.000Z"));
    vi.mocked(Math.random).mockReturnValueOnce(0.654321);
    const second = recordAppDataBackupActivity({
      type: "webdav_restore",
      status: "failure",
      target: "/confscope/two.csbackup",
      message: "bad password",
    });

    expect(loadAppDataBackupState().activities).toEqual([second, first]);

    clearAppDataBackupActivities();

    expect(loadAppDataBackupState()).toEqual({
      webdav: {
        enabled: true,
        url: "https://dav.example.com",
        username: "ops",
        password: "secret",
        rootPath: "/confscope",
      },
      activities: [],
    });
  });
});
