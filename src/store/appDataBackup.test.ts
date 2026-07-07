import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAppDataBackupActivities,
  loadAppDataBackupState,
  recordAppDataBackupActivity,
  saveAppDataBackupState,
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
