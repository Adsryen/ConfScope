// 配置中心快照 WebDAV 同步设置与活动记录。

export type SnapshotWebDAVActivityType = "test" | "upload" | "list" | "import";
export type SnapshotWebDAVActivityStatus = "success" | "failure";

export interface SnapshotWebDAVSettings {
  enabled: boolean;
  url: string;
  username: string;
  password: string;
  rootPath: string;
}

export interface SnapshotWebDAVActivity {
  id: string;
  type: SnapshotWebDAVActivityType;
  status: SnapshotWebDAVActivityStatus;
  target: string;
  message: string;
  createdAt: string;
}

export interface SnapshotWebDAVState {
  webdav: SnapshotWebDAVSettings;
  activities: SnapshotWebDAVActivity[];
}

export type SnapshotWebDAVActivityInput = Omit<SnapshotWebDAVActivity, "id" | "createdAt">;

const KEY = "cs.snapshotWebDAV";
const MAX_ACTIVITIES = 50;

const DEFAULT_WEBDAV: SnapshotWebDAVSettings = {
  enabled: false,
  url: "",
  username: "",
  password: "",
  rootPath: "/confscope/snapshots",
};

function genId(): string {
  return `snapshot_webdav_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function booleanValue(value: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

function normalizeRootPath(value: unknown): string {
  const raw = stringValue(value).trim();
  if (!raw) return DEFAULT_WEBDAV.rootPath;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function normalizeWebDAV(value: unknown): SnapshotWebDAVSettings {
  if (!value || typeof value !== "object") return { ...DEFAULT_WEBDAV };
  const raw = value as Partial<SnapshotWebDAVSettings>;
  return {
    enabled: booleanValue(raw.enabled),
    url: stringValue(raw.url).trim(),
    username: stringValue(raw.username).trim(),
    password: stringValue(raw.password),
    rootPath: normalizeRootPath(raw.rootPath),
  };
}

function normalizeActivityType(value: unknown): SnapshotWebDAVActivityType | null {
  return value === "test" || value === "upload" || value === "list" || value === "import" ? value : null;
}

function normalizeActivityStatus(value: unknown): SnapshotWebDAVActivityStatus | null {
  return value === "success" || value === "failure" ? value : null;
}

function activityTime(activity: SnapshotWebDAVActivity): number {
  const time = new Date(activity.createdAt).getTime();
  return Number.isFinite(time) ? time : 0;
}

function sortActivities(activities: SnapshotWebDAVActivity[]): SnapshotWebDAVActivity[] {
  return [...activities].sort((a, b) => activityTime(b) - activityTime(a));
}

function normalizeActivity(value: unknown): SnapshotWebDAVActivity | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<SnapshotWebDAVActivity>;
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

function normalizeState(value: unknown): SnapshotWebDAVState {
  if (!value || typeof value !== "object") {
    return { webdav: { ...DEFAULT_WEBDAV }, activities: [] };
  }
  const raw = value as Partial<SnapshotWebDAVState>;
  const activities = Array.isArray(raw.activities)
    ? raw.activities.map(normalizeActivity).filter((item): item is SnapshotWebDAVActivity => item !== null)
    : [];
  return {
    webdav: normalizeWebDAV(raw.webdav),
    activities: sortActivities(activities).slice(0, MAX_ACTIVITIES),
  };
}

export function loadSnapshotWebDAVState(): SnapshotWebDAVState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { webdav: { ...DEFAULT_WEBDAV }, activities: [] };
    return normalizeState(JSON.parse(raw));
  } catch {
    return { webdav: { ...DEFAULT_WEBDAV }, activities: [] };
  }
}

export function saveSnapshotWebDAVState(state: SnapshotWebDAVState): SnapshotWebDAVState {
  const normalized = normalizeState(state);
  localStorage.setItem(KEY, JSON.stringify(normalized));
  return normalized;
}

export function updateSnapshotWebDAVSettings(patch: Partial<SnapshotWebDAVSettings>): SnapshotWebDAVState {
  const current = loadSnapshotWebDAVState();
  return saveSnapshotWebDAVState({
    ...current,
    webdav: {
      ...current.webdav,
      ...patch,
    },
  });
}

export function recordSnapshotWebDAVActivity(input: SnapshotWebDAVActivityInput): SnapshotWebDAVActivity {
  const activity: SnapshotWebDAVActivity = {
    ...input,
    id: genId(),
    createdAt: new Date().toISOString(),
  };
  const current = loadSnapshotWebDAVState();
  saveSnapshotWebDAVState({
    ...current,
    activities: [activity, ...current.activities],
  });
  return activity;
}

export function clearSnapshotWebDAVActivities(): void {
  const current = loadSnapshotWebDAVState();
  saveSnapshotWebDAVState({ ...current, activities: [] });
}
