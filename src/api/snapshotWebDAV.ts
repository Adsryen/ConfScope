import {
  ImportSnapshotWebDAVPackage,
  ListSnapshotWebDAVPackages,
  TestSnapshotWebDAV,
  UploadSnapshotWebDAVPackage,
} from "../../wailsjs/go/main/App";
import type { Snapshot } from "./snapshot";
import type { SnapshotWebDAVSettings } from "../store/snapshotWebDAV";
import { hydrateSnapshotWebDAVSettings } from "../lib/credentialSecrets";

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

export async function testSnapshotWebDAV(target: SnapshotWebDAVSettings): Promise<void> {
  return TestSnapshotWebDAV(await hydrateSnapshotWebDAVSettings(target));
}

export async function listSnapshotWebDAVPackages(target: SnapshotWebDAVSettings): Promise<RemoteSnapshotWebDAVPackage[]> {
  return ListSnapshotWebDAVPackages(await hydrateSnapshotWebDAVSettings(target)) as Promise<RemoteSnapshotWebDAVPackage[]>;
}

export async function uploadSnapshotWebDAVPackage(
  target: SnapshotWebDAVSettings,
  snapshotId: string,
  password: string
): Promise<RemoteSnapshotWebDAVPackage> {
  return UploadSnapshotWebDAVPackage(await hydrateSnapshotWebDAVSettings(target), snapshotId, password) as Promise<RemoteSnapshotWebDAVPackage>;
}

export async function importSnapshotWebDAVPackage(target: SnapshotWebDAVSettings, remotePath: string, password: string): Promise<Snapshot> {
  return ImportSnapshotWebDAVPackage(await hydrateSnapshotWebDAVSettings(target), remotePath, password) as Promise<Snapshot>;
}
