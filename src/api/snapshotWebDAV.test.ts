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
};

describe("snapshotWebDAV api", () => {
  beforeEach(() => {
    Object.values(goApp).forEach((fn) => fn.mockReset());
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
});
