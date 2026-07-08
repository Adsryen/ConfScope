// 应用数据备份设置与活动记录的本地持久化。

import type { StoredSecretPointer } from "../lib/credentialSecrets";

export type AppDataBackupActivityType = "local_export" | "local_restore" | "webdav_upload" | "webdav_restore" | "recovery_point";
export type AppDataBackupActivityStatus = "success" | "failure";

export interface AppDataWebDAVSettings {
  enabled: boolean;
  url: string;
  username: string;
  password: string;
  rootPath: string;
  passwordSecretRef?: StoredSecretPointer;
}

export interface AppDataBackupActivity {
  id: string;
  type: AppDataBackupActivityType;
  status: AppDataBackupActivityStatus;
  target: string;
  message: string;
  createdAt: string;
}

export interface AppDataBackupState {
  webdav: AppDataWebDAVSettings;
  activities: AppDataBackupActivity[];
}

export type AppDataBackupActivityInput = Omit<AppDataBackupActivity, "id" | "createdAt">;

const KEY = "cs.appDataBackup";
const MAX_ACTIVITIES = 50;

const DEFAULT_WEBDAV: AppDataWebDAVSettings = {
  enabled: false,
  url: "",
  username: "",
  password: "",
  rootPath: "/confscope",
};

function genId(): string {
  return `app_backup_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function booleanValue(value: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeSecretPointer(value: unknown): StoredSecretPointer | undefined {
  if (!isObjectRecord(value)) return undefined;
  const status = value.status;
  if (status !== "stored" && status !== "missing" && status !== "unsupported") return undefined;
  const ref = stringValue(value.ref);
  const namespace = stringValue(value.namespace);
  const ownerId = stringValue(value.ownerId);
  const field = stringValue(value.field);
  const migratedAt = stringValue(value.migratedAt);
  if (!ref || !namespace || !ownerId || !field || !migratedAt) return undefined;
  if (namespace !== "app-data-webdav") return undefined;
  return {
    ref,
    namespace: namespace as StoredSecretPointer["namespace"],
    ownerId,
    field,
    migratedAt,
    status,
  };
}

function normalizeRootPath(value: unknown): string {
  const raw = stringValue(value).trim();
  if (!raw) return DEFAULT_WEBDAV.rootPath;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function normalizeWebDAV(value: unknown): AppDataWebDAVSettings {
  if (!value || typeof value !== "object") return { ...DEFAULT_WEBDAV };
  const raw = value as Partial<AppDataWebDAVSettings>;
  return {
    enabled: booleanValue(raw.enabled),
    url: stringValue(raw.url).trim(),
    username: stringValue(raw.username).trim(),
    password: stringValue(raw.password),
    rootPath: normalizeRootPath(raw.rootPath),
    passwordSecretRef: normalizeSecretPointer(raw.passwordSecretRef),
  };
}

function normalizeActivityType(value: unknown): AppDataBackupActivityType | null {
  return value === "local_export" ||
    value === "local_restore" ||
    value === "webdav_upload" ||
    value === "webdav_restore" ||
    value === "recovery_point"
    ? value
    : null;
}

function normalizeActivityStatus(value: unknown): AppDataBackupActivityStatus | null {
  return value === "success" || value === "failure" ? value : null;
}

function activityTime(activity: AppDataBackupActivity): number {
  const time = new Date(activity.createdAt).getTime();
  return Number.isFinite(time) ? time : 0;
}

function sortActivities(activities: AppDataBackupActivity[]): AppDataBackupActivity[] {
  return [...activities].sort((a, b) => activityTime(b) - activityTime(a));
}

function normalizeActivity(value: unknown): AppDataBackupActivity | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<AppDataBackupActivity>;
  const id = stringValue(raw.id);
  const type = normalizeActivityType(raw.type);
  const status = normalizeActivityStatus(raw.status);
  const createdAt = stringValue(raw.createdAt);
  if (!id || !type || !status || !createdAt) return null;
  return {
    id,
    type,
    status,
    target: stringValue(raw.target),
    message: stringValue(raw.message),
    createdAt,
  };
}

function normalizeState(value: unknown): AppDataBackupState {
  if (!value || typeof value !== "object") {
    return { webdav: { ...DEFAULT_WEBDAV }, activities: [] };
  }
  const raw = value as Partial<AppDataBackupState>;
  const activities = Array.isArray(raw.activities)
    ? raw.activities.map(normalizeActivity).filter((item): item is AppDataBackupActivity => item !== null)
    : [];
  return {
    webdav: normalizeWebDAV(raw.webdav),
    activities: sortActivities(activities).slice(0, MAX_ACTIVITIES),
  };
}

export function loadAppDataBackupState(): AppDataBackupState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { webdav: { ...DEFAULT_WEBDAV }, activities: [] };
    return normalizeState(JSON.parse(raw));
  } catch {
    return { webdav: { ...DEFAULT_WEBDAV }, activities: [] };
  }
}

export function saveAppDataBackupState(state: AppDataBackupState): AppDataBackupState {
  const normalized = normalizeState(state);
  localStorage.setItem(KEY, JSON.stringify(normalized));
  return normalized;
}

export function updateAppDataWebDAVSettings(patch: Partial<AppDataWebDAVSettings>): AppDataBackupState {
  const current = loadAppDataBackupState();
  return saveAppDataBackupState({
    ...current,
    webdav: {
      ...current.webdav,
      ...patch,
    },
  });
}

export function recordAppDataBackupActivity(input: AppDataBackupActivityInput): AppDataBackupActivity {
  const activity: AppDataBackupActivity = {
    ...input,
    id: genId(),
    createdAt: new Date().toISOString(),
  };
  const current = loadAppDataBackupState();
  saveAppDataBackupState({
    ...current,
    activities: [activity, ...current.activities],
  });
  return activity;
}

export function clearAppDataBackupActivities(): void {
  const current = loadAppDataBackupState();
  saveAppDataBackupState({ ...current, activities: [] });
}
