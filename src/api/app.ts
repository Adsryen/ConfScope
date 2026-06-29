import {
  CheckForUpdates,
  GetAppInfo,
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

export function selectLocalSnapshotDirectory(): Promise<string> {
  return SelectLocalSnapshotDirectory();
}

export function validateLocalSnapshotDirectory(path: string): Promise<LocalSnapshotValidation> {
  return ValidateLocalSnapshotDirectory(path);
}
