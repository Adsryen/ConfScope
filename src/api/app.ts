import {
  CheckForUpdates,
  DownloadUpdate,
  GetAppInfo,
  GetCurrentPlatform,
  GetDownloadProgress,
  InstallAndRestart,
  ExportConfigSourceFiles,
  SelectConfigSourceExportDirectory,
  SelectLocalSnapshotDirectory,
  ValidateLocalSnapshotDirectory,
} from "../../wailsjs/go/main/App";
import type { ProxySettings } from "../store/settings";
import type { ConfigItem } from "./nacos";

export interface UpdateSource {
  name: string;
  url: string;
}

export interface AppInfo {
  name: string;
  version: string;
  updateSources: UpdateSource[];
}

export interface CheckUpdatesRequest {
  currentVersion: string;
  sources: UpdateSource[];
  proxy: ProxySettings;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  sourceName: string;
  sourceUrl: string;
  downloadUrl: string;
  releaseNotes: string;
  publishedAt: string;
  sha256: string;
  mandatory: boolean;
  checkedAt: string;
  error: string;
}

export interface DownloadProgress {
  downloaded: number;
  total: number;
  percent: number;
  done: boolean;
  error: string;
}

export interface LocalSnapshotValidation {
  valid: boolean;
  path: string;
  code: string;
  message: string;
  configCount: number;
  hasManifest: boolean;
  matchedMarkers: string[];
  schemaVersion: number;
  layout: string;
  legacy: boolean;
  checkedAt: string;
}

export interface ConfigSourceExportSource {
  provider?: string;
  connectionId: string;
  connectionName: string;
  namespace: string;
  namespaceId: string;
}

export interface ConfigSourceExportItem extends ConfigItem {
  namespace?: string;
  contentType?: string;
  updateTime?: string;
}

export interface ConfigSourceExportResult {
  path: string;
  configCount: number;
  manifest: string;
}

export function getAppInfo(): Promise<AppInfo> {
  return GetAppInfo();
}

export function checkForUpdates(request: CheckUpdatesRequest): Promise<UpdateCheckResult> {
  return CheckForUpdates(request);
}

export function downloadUpdate(downloadURL: string, sha256: string): Promise<string> {
  return DownloadUpdate(downloadURL, sha256);
}

export function getDownloadProgress(): Promise<DownloadProgress> {
  return GetDownloadProgress();
}

export function installAndRestart(downloadedFile: string): Promise<void> {
  return InstallAndRestart(downloadedFile);
}

export function getCurrentPlatform(): Promise<string> {
  return GetCurrentPlatform();
}

export function selectLocalSnapshotDirectory(): Promise<string> {
  return SelectLocalSnapshotDirectory();
}

export function validateLocalSnapshotDirectory(path: string): Promise<LocalSnapshotValidation> {
  return ValidateLocalSnapshotDirectory(path);
}

export function selectConfigSourceExportDirectory(): Promise<string> {
  return SelectConfigSourceExportDirectory();
}

export function exportConfigSourceFiles(
  targetDir: string,
  source: ConfigSourceExportSource,
  configs: ConfigSourceExportItem[]
): Promise<ConfigSourceExportResult> {
  return ExportConfigSourceFiles(targetDir, source, configs) as Promise<ConfigSourceExportResult>;
}
