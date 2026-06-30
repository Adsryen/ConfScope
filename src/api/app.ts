import {
  CheckForUpdates,
  DownloadUpdate,
  GetAppInfo,
  GetCurrentPlatform,
  GetDownloadProgress,
  InstallAndRestart,
  SelectLocalSnapshotDirectory,
  ValidateLocalSnapshotDirectory,
} from "../../wailsjs/go/main/App";
import type { ProxySettings } from "../store/settings";

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
  message: string;
  configCount: number;
  hasManifest: boolean;
  matchedMarkers: string[];
  checkedAt: string;
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
