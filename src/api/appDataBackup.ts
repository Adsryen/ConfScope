import {
  DownloadAppDataWebDAVBackup,
  CreateAppDataRecoveryPoint,
  ListAppDataWebDAVBackups,
  ReadAppDataBackupFile,
  SelectAppDataBackupOpenFile,
  SelectAppDataBackupSaveFile,
  TestAppDataWebDAV,
  UploadAppDataWebDAVBackup,
  WriteAppDataBackupFile,
} from "../../wailsjs/go/main/App";
import type { AppDataWebDAVSettings } from "../store/appDataBackup";

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

export function testAppDataWebDAV(target: AppDataWebDAVSettings): Promise<void> {
  return TestAppDataWebDAV(target);
}

export function listAppDataWebDAVBackups(target: AppDataWebDAVSettings): Promise<RemoteAppDataBackup[]> {
  return ListAppDataWebDAVBackups(target) as Promise<RemoteAppDataBackup[]>;
}

export function uploadAppDataWebDAVBackup(
  target: AppDataWebDAVSettings,
  plaintextJson: string,
  password: string,
  meta: AppDataBackupPackageMeta
): Promise<RemoteAppDataBackup> {
  return UploadAppDataWebDAVBackup(target, plaintextJson, password, meta) as Promise<RemoteAppDataBackup>;
}

export function downloadAppDataWebDAVBackup(
  target: AppDataWebDAVSettings,
  remotePath: string,
  password: string
): Promise<DecryptedAppDataBackupPackage> {
  return DownloadAppDataWebDAVBackup(target, remotePath, password) as Promise<DecryptedAppDataBackupPackage>;
}
