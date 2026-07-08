/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  importSnapshotWebDAVPackage,
  listSnapshotWebDAVPackages,
  testSnapshotWebDAV,
  uploadSnapshotWebDAVPackage,
} from "./snapshotWebDAV";

const goApp = {
  TestSnapshotWebDAV: vi.fn(),
  ListSnapshotWebDAVPackages: vi.fn(),
  UploadSnapshotWebDAVPackage: vi.fn(),
  ImportSnapshotWebDAVPackage: vi.fn(),
  TestAppDataWebDAV: vi.fn(),
  ListAppDataWebDAVBackups: vi.fn(),
  UploadAppDataWebDAVBackup: vi.fn(),
  DownloadAppDataWebDAVBackup: vi.fn(),
  ReadSecureSecret: vi.fn(),
};

describe("snapshotWebDAV api", () => {
  beforeEach(() => {
    Object.values(goApp).forEach((fn) => fn.mockReset());
    goApp.ReadSecureSecret.mockResolvedValue("stored-snapshot-webdav-password");
    vi.stubGlobal("go", {
      main: {
        App: goApp,
      },
    });
  });

  it("uses dedicated Wails bindings for config snapshot WebDAV operations", async () => {
    const target = { enabled: true, url: "https://dav.example.com", username: "ops", password: "secret", rootPath: "/confscope/snapshots" };
    goApp.TestSnapshotWebDAV.mockResolvedValue(undefined);
    goApp.ListSnapshotWebDAVPackages.mockResolvedValue([
      { name: "snap.cssnapshot", path: "/confscope/snapshots/snap.cssnapshot", snapshotId: "snap-1", size: 10 },
    ]);
    goApp.UploadSnapshotWebDAVPackage.mockResolvedValue({
      name: "snap.cssnapshot",
      path: "/confscope/snapshots/snap.cssnapshot",
      snapshotId: "snap-1",
      size: 10,
    });
    goApp.ImportSnapshotWebDAVPackage.mockResolvedValue({ id: "snap-imported", remoteSnapshotId: "snap-1" });

    await expect(testSnapshotWebDAV(target)).resolves.toBeUndefined();
    await expect(listSnapshotWebDAVPackages(target)).resolves.toHaveLength(1);
    await expect(uploadSnapshotWebDAVPackage(target, "snap-1", "package-pass")).resolves.toMatchObject({ snapshotId: "snap-1" });
    await expect(importSnapshotWebDAVPackage(target, "/confscope/snapshots/snap.cssnapshot", "package-pass")).resolves.toMatchObject({
      remoteSnapshotId: "snap-1",
    });

    expect(goApp.TestSnapshotWebDAV).toHaveBeenCalledWith(target);
    expect(goApp.ListSnapshotWebDAVPackages).toHaveBeenCalledWith(target);
    expect(goApp.UploadSnapshotWebDAVPackage).toHaveBeenCalledWith(target, "snap-1", "package-pass");
    expect(goApp.ImportSnapshotWebDAVPackage).toHaveBeenCalledWith(target, "/confscope/snapshots/snap.cssnapshot", "package-pass");
    expect(goApp.UploadAppDataWebDAVBackup).not.toHaveBeenCalled();
    expect(goApp.DownloadAppDataWebDAVBackup).not.toHaveBeenCalled();
  });

  it("hydrates migrated WebDAV passwords before calling native bindings", async () => {
    const target = {
      enabled: true,
      url: "https://dav.example.com",
      username: "ops",
      password: "",
      rootPath: "/confscope/snapshots",
      passwordSecretRef: {
        ref: "snapshot-webdav.default.password",
        namespace: "snapshot-webdav" as const,
        ownerId: "default",
        field: "password",
        migratedAt: "2026-07-08T00:00:00.000Z",
        status: "stored" as const,
      },
    };
    goApp.TestSnapshotWebDAV.mockResolvedValue(undefined);
    goApp.ListSnapshotWebDAVPackages.mockResolvedValue([]);
    goApp.UploadSnapshotWebDAVPackage.mockResolvedValue({
      name: "snap.cssnapshot",
      path: "/confscope/snapshots/snap.cssnapshot",
      snapshotId: "snap-1",
      size: 10,
    });
    goApp.ImportSnapshotWebDAVPackage.mockResolvedValue({ id: "snap-imported", remoteSnapshotId: "snap-1" });

    await expect(testSnapshotWebDAV(target)).resolves.toBeUndefined();
    await expect(listSnapshotWebDAVPackages(target)).resolves.toEqual([]);
    await expect(uploadSnapshotWebDAVPackage(target, "snap-1", "package-pass")).resolves.toMatchObject({ snapshotId: "snap-1" });
    await expect(importSnapshotWebDAVPackage(target, "/confscope/snapshots/snap.cssnapshot", "package-pass")).resolves.toMatchObject({
      remoteSnapshotId: "snap-1",
    });

    const hydrated = { ...target, password: "stored-snapshot-webdav-password" };
    expect(goApp.TestSnapshotWebDAV).toHaveBeenCalledWith(hydrated);
    expect(goApp.ListSnapshotWebDAVPackages).toHaveBeenCalledWith(hydrated);
    expect(goApp.UploadSnapshotWebDAVPackage).toHaveBeenCalledWith(hydrated, "snap-1", "package-pass");
    expect(goApp.ImportSnapshotWebDAVPackage).toHaveBeenCalledWith(hydrated, "/confscope/snapshots/snap.cssnapshot", "package-pass");
  });
});
