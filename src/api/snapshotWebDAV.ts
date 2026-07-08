import {
  ImportSnapshotWebDAVPackage,
  ListSnapshotWebDAVPackages,
  TestSnapshotWebDAV,
  UploadSnapshotWebDAVPackage,
} from "../../wailsjs/go/main/App";
import type { Snapshot } from "./snapshot";
import type { SnapshotWebDAVSettings } from "../store/snapshotWebDAV";

export interface RemoteSnapshotWebDAVPackage {
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
  snapshotId: string;
  snapshotName: string;
  provider: string;
  connectionId: string;
  connectionName: string;
  configCount: number;
  createdAt: string;
}

export function testSnapshotWebDAV(target: SnapshotWebDAVSettings): Promise<void> {
  return TestSnapshotWebDAV(target);
}

export function listSnapshotWebDAVPackages(target: SnapshotWebDAVSettings): Promise<RemoteSnapshotWebDAVPackage[]> {
  return ListSnapshotWebDAVPackages(target) as Promise<RemoteSnapshotWebDAVPackage[]>;
}

export function uploadSnapshotWebDAVPackage(
  target: SnapshotWebDAVSettings,
  snapshotId: string,
  password: string
): Promise<RemoteSnapshotWebDAVPackage> {
  return UploadSnapshotWebDAVPackage(target, snapshotId, password) as Promise<RemoteSnapshotWebDAVPackage>;
}

export function importSnapshotWebDAVPackage(target: SnapshotWebDAVSettings, remotePath: string, password: string): Promise<Snapshot> {
  return ImportSnapshotWebDAVPackage(target, remotePath, password) as Promise<Snapshot>;
}
