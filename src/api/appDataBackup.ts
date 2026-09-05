import {
  DownloadAppDataWebDAVBackup,
  CreateAppDataRecoveryPoint,
  ListAppDataSnapshotFiles,
  ListAppDataWebDAVBackups,
  ReadAppDataBackupFile,
  RestoreAppDataSnapshotFiles,
  SelectAppDataBackupOpenFile,
  SelectAppDataBackupSaveFile,
  TestAppDataWebDAV,
  UploadAppDataWebDAVBackup,
  WriteAppDataBackupFile,
} from "../../wailsjs/go/app/App";
import type { AppDataWebDAVSettings } from "../store/appDataBackup";
import { hydrateAppDataWebDAVSettings } from "../lib/credentialSecrets";

export interface AppDataBackupPackageMeta {
  appVersion: string;
  sourcePlatform: string;
  createdAt: string;
}

export interface AppDataBackupPackageSummary {
  format: string;
  schemaVersion: number;
  appVersion: string;
  sourcePlatform: string;
  createdAt: string;
  size: number;
}

export interface DecryptedAppDataBackupPackage {
  plaintextJson: string;
  summary: AppDataBackupPackageSummary;
}

export interface RemoteAppDataBackup {
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
}

export interface AppDataSnapshotFile {
  path: string;
  contentBase64: string;
  mode?: number;
}

export function selectAppDataBackupSaveFile(defaultName: string): Promise<string> {
  return SelectAppDataBackupSaveFile(defaultName);
}

export function selectAppDataBackupOpenFile(): Promise<string> {
  return SelectAppDataBackupOpenFile();
}

export function writeAppDataBackupFile(
  path: string,
  plaintextJson: string,
  password: string,
  meta: AppDataBackupPackageMeta
): Promise<AppDataBackupPackageSummary> {
  return WriteAppDataBackupFile(path, plaintextJson, password, meta) as Promise<AppDataBackupPackageSummary>;
}

export function readAppDataBackupFile(path: string, password: string): Promise<DecryptedAppDataBackupPackage> {
  return ReadAppDataBackupFile(path, password) as Promise<DecryptedAppDataBackupPackage>;
}

export function createAppDataRecoveryPoint(
  plaintextJson: string,
  password: string,
  meta: AppDataBackupPackageMeta
): Promise<AppDataBackupPackageSummary> {
  return CreateAppDataRecoveryPoint(plaintextJson, password, meta) as Promise<AppDataBackupPackageSummary>;
}

export async function listAppDataSnapshotFiles(): Promise<AppDataSnapshotFile[]> {
  const result: unknown = await ListAppDataSnapshotFiles();
  return Array.isArray(result) ? (result as AppDataSnapshotFile[]) : [];
}

export function restoreAppDataSnapshotFiles(files: AppDataSnapshotFile[]): Promise<void> {
  return RestoreAppDataSnapshotFiles(files);
}

export async function testAppDataWebDAV(target: AppDataWebDAVSettings): Promise<void> {
  return TestAppDataWebDAV(await hydrateAppDataWebDAVSettings(target));
}

export async function listAppDataWebDAVBackups(target: AppDataWebDAVSettings): Promise<RemoteAppDataBackup[]> {
  const result: unknown = await ListAppDataWebDAVBackups(await hydrateAppDataWebDAVSettings(target));
  return Array.isArray(result) ? (result as RemoteAppDataBackup[]) : [];
}

export async function uploadAppDataWebDAVBackup(
  target: AppDataWebDAVSettings,
  plaintextJson: string,
  password: string,
  meta: AppDataBackupPackageMeta
): Promise<RemoteAppDataBackup> {
  return UploadAppDataWebDAVBackup(await hydrateAppDataWebDAVSettings(target), plaintextJson, password, meta) as Promise<RemoteAppDataBackup>;
}

export async function downloadAppDataWebDAVBackup(
  target: AppDataWebDAVSettings,
  remotePath: string,
  password: string
): Promise<DecryptedAppDataBackupPackage> {
  return DownloadAppDataWebDAVBackup(await hydrateAppDataWebDAVSettings(target), remotePath, password) as Promise<DecryptedAppDataBackupPackage>;
}
