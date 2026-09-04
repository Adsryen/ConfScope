// 主数据文档（Go 侧 [数据根]/app-data/confscope-data.json）前端读写层。
//
// 分工：
//   - 数据文件是数据唯一事实源，由 Go 侧原子写（临时文件 + 读回校验 + rename）；
//   - WebView localStorage 仅作热缓存：启动时从文件水合，store 变更后 debounce 推送文件；
//   - 数据文件损坏/版本不兼容时由 Go 侧隔离保留，前端回退 localStorage 缓存并给 UI 提示。
//
// 本模块是前端读写数据文件的唯一入口；store 内部实现不感知数据文件，
// 仅在 loader 层通过水合/推送切换数据来源。

import { reportError } from "./errorCenter";

export const APP_DATA_DOC_SCHEMA_VERSION = 2;
export const APP_DATA_DOC_FILE_NAME = "confscope-data.json";
export const APP_DATA_LAST_WRITE_KEY = "cs.doc.lastWrite";

/** 参与数据文档的 localStorage 键（与 .csbackup 数据分区同集，另加 diff 视图偏好）。 */
export const APP_DATA_DOC_KEYS = [
  "cs.connections",
  "cs.sshProfiles",
  "cs.settings",
  "cs.operationHistory",
  "cs.applyPlans",
  "cs.applyVerifications",
  "cs.diffViewPreferences",
  "cs.ui",
  "locale",
  "cs.appDataBackup",
  "cs.snapshotWebDAV",
] as const;

export type AppDataDocKey = (typeof APP_DATA_DOC_KEYS)[number];

export interface AppDataDocData {
  connections: unknown[];
  sshProfiles: unknown[];
  settings: unknown;
  operationHistory: unknown[];
  applyPlans: unknown[];
  applyVerifications: unknown[];
  diffViewPreferences: unknown;
  ui: unknown;
  locale: string;
  appDataBackup: unknown;
  snapshotWebDAV: unknown;
}

export interface AppDataDocument {
  schemaVersion: typeof APP_DATA_DOC_SCHEMA_VERSION;
  savedAt: string;
  appVersion: string;
  data: AppDataDocData;
}

/** Go 侧 AppDataDocumentStatus 的镜像（wails 绑定返回 JSON 对象）。 */
export interface AppDataDocumentStatus {
  exists: boolean;
  valid: boolean;
  path: string;
  schemaVersion: number;
  savedAt: string;
  appVersion: string;
  sizeBytes: number;
  corruptFile: string;
  document: AppDataDocument | null;
  error: string;
}

export type AppDataDocNoticeKind = "imported-from-storage" | "restored-from-file" | "corrupt-fallback";

export interface AppDataDocNotice {
  kind: AppDataDocNoticeKind;
  connections: number;
  detail: string;
}

const BOOTSTRAP_READ_TIMEOUT_MS = 3000;
const SAVE_TIMEOUT_MS = 15000;
const PUSH_DEBOUNCE_MS = 2000;
const PUSH_RETRY_DELAYS_MS = [2000, 5000, 10000];

let pendingNotice: AppDataDocNotice | null = null;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pushInFlight = false;
let patchedStorage: Storage | null = null;
let originalSetItemRef: ((key: string, value: string) => void) | null = null;

interface DocBindings {
  GetAppDataDocument(): Promise<unknown>;
  SaveAppDataDocument(document: AppDataDocument): Promise<unknown>;
}

function storage(): Storage | null {
  const g = globalThis as { localStorage?: Storage };
  return g.localStorage ?? null;
}

function appBindings(): DocBindings | null {
  const g = globalThis as { go?: { main?: { App?: DocBindings } } };
  const app = g.go?.main?.App;
  if (!app || typeof app.GetAppDataDocument !== "function" || typeof app.SaveAppDataDocument !== "function") {
    return null;
  }
  return app;
}

function isDocKey(key: string): key is AppDataDocKey {
  return (APP_DATA_DOC_KEYS as readonly string[]).includes(key);
}

function readJson(key: string, fallback: unknown): unknown {
  const st = storage();
  if (!st) return fallback;
  try {
    const raw = st.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function localeValue(value: unknown): string {
  return value === "en-US" || value === "zh-CN" ? value : "zh-CN";
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("app data doc operation timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseIsoMs(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction = ""] = match;
  const millis = Number(fraction.slice(0, 3).padEnd(3, "0"));
  const timestamp = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number.isFinite(millis) ? millis : 0
  );
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizeStatus(raw: unknown): AppDataDocumentStatus {
  const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const doc = record.document && typeof record.document === "object" ? (record.document as AppDataDocument) : null;
  return {
    exists: record.exists === true,
    valid: record.valid === true,
    path: typeof record.path === "string" ? record.path : "",
    schemaVersion: typeof record.schemaVersion === "number" ? record.schemaVersion : 0,
    savedAt: typeof record.savedAt === "string" ? record.savedAt : "",
    appVersion: typeof record.appVersion === "string" ? record.appVersion : "",
    sizeBytes: typeof record.sizeBytes === "number" ? record.sizeBytes : 0,
    corruptFile: typeof record.corruptFile === "string" ? record.corruptFile : "",
    document: doc && doc.data ? doc : null,
    error: typeof record.error === "string" ? record.error : "",
  };
}

/** 从当前 localStorage 收集一份 v2 数据文档（appVersion 留空，由 Go 侧填构建版本）。 */
export function collectAppDataDocument(): AppDataDocument {
  return {
    schemaVersion: APP_DATA_DOC_SCHEMA_VERSION,
    savedAt: "",
    appVersion: "",
    data: {
      connections: asArray(readJson("cs.connections", [])),
      sshProfiles: asArray(readJson("cs.sshProfiles", [])),
      settings: readJson("cs.settings", {}),
      operationHistory: asArray(readJson("cs.operationHistory", [])),
      applyPlans: asArray(readJson("cs.applyPlans", [])),
      applyVerifications: asArray(readJson("cs.applyVerifications", [])),
      diffViewPreferences: readJson("cs.diffViewPreferences", {}),
      ui: readJson("cs.ui", {}),
      locale: localeValue(storage()?.getItem("locale")),
      appDataBackup: readJson("cs.appDataBackup", {}),
      snapshotWebDAV: readJson("cs.snapshotWebDAV", {}),
    },
  };
}

function rawSetItem(key: string, value: string): void {
  const st = storage();
  if (!st) return;
  if (originalSetItemRef) {
    originalSetItemRef(key, value);
  } else {
    st.setItem(key, value);
  }
}

/** 用数据文档水合 localStorage 缓存（直写原始 setItem，避免触发变更同步拦截）。 */
export function hydrateStorageFromDocument(document: AppDataDocument): void {
  const st = storage();
  if (!st) return;
  const d = document.data;
  rawSetItem("cs.connections", JSON.stringify(asArray(d.connections)));
  rawSetItem("cs.sshProfiles", JSON.stringify(asArray(d.sshProfiles)));
  rawSetItem("cs.settings", JSON.stringify(d.settings ?? {}));
  rawSetItem("cs.operationHistory", JSON.stringify(asArray(d.operationHistory)));
  rawSetItem("cs.applyPlans", JSON.stringify(asArray(d.applyPlans)));
  rawSetItem("cs.applyVerifications", JSON.stringify(asArray(d.applyVerifications)));
  rawSetItem("cs.diffViewPreferences", JSON.stringify(d.diffViewPreferences ?? {}));
  rawSetItem("cs.ui", JSON.stringify(d.ui ?? {}));
  rawSetItem("locale", localeValue(d.locale));
  rawSetItem("cs.appDataBackup", JSON.stringify(d.appDataBackup ?? {}));
  rawSetItem("cs.snapshotWebDAV", JSON.stringify(d.snapshotWebDAV ?? {}));
  const times: Record<string, string> = {};
  for (const key of APP_DATA_DOC_KEYS) {
    times[key] = document.savedAt;
  }
  rawSetItem(APP_DATA_LAST_WRITE_KEY, JSON.stringify(times));
}

export function readLocalWriteTimes(): Record<string, string> {
  const value = readJson(APP_DATA_LAST_WRITE_KEY, {});
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, string>) : {};
}

export function recordLocalWrite(key: AppDataDocKey): void {
  const times = readLocalWriteTimes();
  times[key] = new Date().toISOString();
  rawSetItem(APP_DATA_LAST_WRITE_KEY, JSON.stringify(times));
}

/** 是否存在比数据文件更新的 localStorage 写入（覆盖“上次退出前写文件失败”的场景）。 */
export function localWriteNewerThan(savedAt: string): boolean {
  const savedMs = parseIsoMs(savedAt);
  if (savedMs == null) return false;
  const times = readLocalWriteTimes();
  return APP_DATA_DOC_KEYS.some((key) => {
    const ms = parseIsoMs(times[key] ?? "");
    return ms != null && ms > savedMs;
  });
}

export function hasAnyStorageData(): boolean {
  const st = storage();
  if (!st) return false;
  return APP_DATA_DOC_KEYS.some((key) => st.getItem(key) !== null);
}

export function consumeAppDataDocNotice(): AppDataDocNotice | null {
  const notice = pendingNotice;
  pendingNotice = null;
  return notice;
}

/** 推送当前 localStorage 状态到数据文件；失败按 2s/5s/10s 重试，仍失败则报错误中心。 */
export async function pushAppDataDocument(options: { report?: boolean } = {}): Promise<boolean> {
  const report = options.report ?? true;
  if (pushInFlight) return false;
  pushInFlight = true;
  try {
    const bindings = appBindings();
    if (!bindings) return false;
    let lastError = "";
    for (let attempt = 0; attempt <= PUSH_RETRY_DELAYS_MS.length; attempt++) {
      const document = collectAppDataDocument();
      try {
        const raw = await withTimeout(bindings.SaveAppDataDocument(document), SAVE_TIMEOUT_MS);
        const status = normalizeStatus(raw);
        if (!status.error && status.valid) return true;
        lastError = status.error || "unknown save failure";
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      if (attempt < PUSH_RETRY_DELAYS_MS.length) {
        await sleep(PUSH_RETRY_DELAYS_MS[attempt]);
      }
    }
    if (report) reportDocSaveError(lastError);
    return false;
  } finally {
    pushInFlight = false;
  }
}

function reportDocSaveError(message: string): void {
  try {
    reportError({
      title: "本地数据文件保存失败",
      source: "本地数据",
      message,
      detail: message,
    });
  } catch {
    // 错误中心不可用（极早启动阶段）：忽略
  }
}

function scheduleAppDataDocPush(): void {
  if (pushTimer != null) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void pushAppDataDocument({ report: true });
  }, PUSH_DEBOUNCE_MS);
}

/**
 * 启动引导：读数据文件 → 有效则水合 localStorage（缓存为空时给出恢复提示）；
 * 缓存比文件新则回写文件；文件缺失则把 localStorage 一次性迁移进文件；
 * 文件损坏则回退缓存并给出隔离提示。返回 { mode, status } 供诊断。
 */
export async function bootstrapAppDataDoc(): Promise<{ mode: "native" | "web"; status: AppDataDocumentStatus | null }> {
  const bindings = appBindings();
  if (!bindings) return { mode: "web", status: null };

  let status: AppDataDocumentStatus;
  try {
    status = normalizeStatus(await withTimeout(bindings.GetAppDataDocument(), BOOTSTRAP_READ_TIMEOUT_MS));
  } catch {
    return { mode: "native", status: null };
  }

  if (status.valid && status.document) {
    const document = status.document;
    const st = storage();
    const storageEmpty = st ? APP_DATA_DOC_KEYS.every((key) => st.getItem(key) === null) : true;
    if (localWriteNewerThan(document.savedAt)) {
      await pushAppDataDocument({ report: false });
      return { mode: "native", status };
    }
    hydrateStorageFromDocument(document);
    if (storageEmpty && document.data.connections.length > 0) {
      pendingNotice = { kind: "restored-from-file", connections: document.data.connections.length, detail: status.path };
    }
    return { mode: "native", status };
  }

  if (status.exists && !status.valid) {
    pendingNotice = {
      kind: "corrupt-fallback",
      connections: asArray(readJson("cs.connections", [])).length,
      detail: status.corruptFile || status.path,
    };
    return { mode: "native", status };
  }

  if (hasAnyStorageData()) {
    const ok = await pushAppDataDocument({ report: false });
    if (ok) {
      pendingNotice = {
        kind: "imported-from-storage",
        connections: asArray(readJson("cs.connections", [])).length,
        detail: status.path,
      };
    }
  }
  return { mode: "native", status };
}

/** 安装 localStorage 变更拦截：数据键写入后 debounce 推送数据文件；窗口关闭时尽力落盘。 */
export function installAppDataDocSync(): void {
  const st = storage();
  if (!st || patchedStorage === st) return;
  patchedStorage = st;
  originalSetItemRef = st.setItem.bind(st);
  const patchedSetItem = function (key: string, value: string): void {
    originalSetItemRef?.(key, value);
    if (isDocKey(key)) {
      recordLocalWrite(key);
      scheduleAppDataDocPush();
    }
  };
  (st as unknown as { setItem: unknown }).setItem = patchedSetItem;
  const win = globalThis as { addEventListener?: (type: string, listener: () => void) => void };
  win.addEventListener?.("pagehide", () => {
    if (pushTimer != null) {
      clearTimeout(pushTimer);
      pushTimer = null;
    }
    void pushAppDataDocument({ report: false });
  });
}

/** 从数据文件重新水合缓存（“清理缓存”后调用：清的是缓存，主数据文件不受影响）。 */
export async function rehydrateFromAppDataDoc(): Promise<boolean> {
  const bindings = appBindings();
  if (!bindings) return false;
  try {
    const status = normalizeStatus(await withTimeout(bindings.GetAppDataDocument(), BOOTSTRAP_READ_TIMEOUT_MS));
    if (status.valid && status.document) {
      hydrateStorageFromDocument(status.document);
      return true;
    }
  } catch {
    // 读取失败：保留现有缓存
  }
  return false;
}

export interface AppDataDocInfo {
  path: string;
  savedAt: string;
  corruptFile: string;
  sizeBytes: number;
}

/** 设置页展示用：数据文件路径与最后保存时间。 */
export async function getAppDataDocInfo(): Promise<AppDataDocInfo | null> {
  const bindings = appBindings();
  if (!bindings) return null;
  try {
    const status = normalizeStatus(await withTimeout(bindings.GetAppDataDocument(), BOOTSTRAP_READ_TIMEOUT_MS));
    return { path: status.path, savedAt: status.savedAt, corruptFile: status.corruptFile, sizeBytes: status.sizeBytes };
  } catch {
    return null;
  }
}

/** 测试专用：重置模块级状态（拦截实例、防抖定时器、待消费提示）。 */
export function _resetAppDataDocStateForTests(): void {
  if (pushTimer != null) clearTimeout(pushTimer);
  pushTimer = null;
  pushInFlight = false;
  patchedStorage = null;
  originalSetItemRef = null;
  pendingNotice = null;
}
