import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSnapshotWebDAVActivities,
  loadSnapshotWebDAVState,
  recordSnapshotWebDAVActivity,
  updateSnapshotWebDAVSettings,
} from "./snapshotWebDAV";

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

describe("snapshotWebDAV store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-08T08:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.222222);
    vi.stubGlobal("localStorage", new MemoryStorage());
  });

  it("uses an independent default WebDAV target for config snapshots", () => {
    expect(loadSnapshotWebDAVState()).toEqual({
      webdav: {
        enabled: false,
        url: "",
        username: "",
        password: "",
        rootPath: "/confscope/snapshots",
      },
      activities: [],
    });

    localStorage.setItem("cs.snapshotWebDAV", "{bad json");

    expect(loadSnapshotWebDAVState().webdav.rootPath).toBe("/confscope/snapshots");
  });

  it("persists only the WebDAV credential and never stores the package password", () => {
    localStorage.setItem(
      "cs.appDataBackup",
      JSON.stringify({ webdav: { url: "https://app-backup.example.com", rootPath: "/confscope" }, activities: [] })
    );

    const next = updateSnapshotWebDAVSettings({
      enabled: true,
      url: " https://dav.example.com ",
      username: "ops",
      password: "dav-secret",
      rootPath: " remote/snapshots ",
      packagePassword: "must-not-persist",
    } as Partial<ReturnType<typeof loadSnapshotWebDAVState>["webdav"]> & { packagePassword: string });

    expect(next.webdav).toEqual({
      enabled: true,
      url: "https://dav.example.com",
      username: "ops",
      password: "dav-secret",
      rootPath: "/remote/snapshots",
    });
    expect(localStorage.getItem("cs.snapshotWebDAV")).not.toContain("must-not-persist");
    expect(localStorage.getItem("cs.appDataBackup")).toContain("https://app-backup.example.com");
  });

  it("preserves migrated WebDAV password secret refs", () => {
    localStorage.setItem(
      "cs.snapshotWebDAV",
      JSON.stringify({
        webdav: {
          enabled: true,
          url: "https://dav.example.com",
          username: "ops",
          password: "",
          rootPath: "/confscope/snapshots",
          passwordSecretRef: {
            ref: "snapshot-webdav.default.password",
            namespace: "snapshot-webdav",
            ownerId: "default",
            field: "password",
            migratedAt: "2026-07-08T00:00:00.000Z",
            status: "stored",
          },
        },
        activities: [],
      })
    );

    expect(loadSnapshotWebDAVState().webdav.passwordSecretRef).toEqual({
      ref: "snapshot-webdav.default.password",
      namespace: "snapshot-webdav",
      ownerId: "default",
      field: "password",
      migratedAt: "2026-07-08T00:00:00.000Z",
      status: "stored",
    });
  });

  it("drops WebDAV password secret refs with an invalid namespace", () => {
    localStorage.setItem(
      "cs.snapshotWebDAV",
      JSON.stringify({
        webdav: {
          enabled: true,
          url: "https://dav.example.com",
          username: "ops",
          password: "",
          rootPath: "/confscope/snapshots",
          passwordSecretRef: {
            ref: "snapshot-webdav.default.password",
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

    expect(loadSnapshotWebDAVState().webdav.passwordSecretRef).toBeUndefined();
  });

  it("records sync activities newest first and clears them without deleting the target", () => {
    updateSnapshotWebDAVSettings({ enabled: true, url: "https://dav.example.com", rootPath: "/remote/snapshots" });

    const first = recordSnapshotWebDAVActivity({
      type: "upload",
      status: "success",
      target: "/remote/snapshots/one.cssnapshot",
      message: "uploaded",
    });
    vi.setSystemTime(new Date("2026-07-08T09:00:00.000Z"));
    vi.mocked(Math.random).mockReturnValueOnce(0.333333);
    const second = recordSnapshotWebDAVActivity({
      type: "import",
      status: "failure",
      target: "/remote/snapshots/two.cssnapshot",
      message: "bad password",
    });

    expect(loadSnapshotWebDAVState().activities).toEqual([second, first]);

    clearSnapshotWebDAVActivities();

    expect(loadSnapshotWebDAVState()).toMatchObject({
      webdav: { enabled: true, url: "https://dav.example.com", rootPath: "/remote/snapshots" },
      activities: [],
    });
  });
});
