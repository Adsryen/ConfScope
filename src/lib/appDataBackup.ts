// 应用数据备份 payload 合同：统一收集、校验、摘要和恢复本地应用数据。
import { loadAppDataBackupState } from "../store/appDataBackup";
import { loadApplyPlans } from "../store/applyPlans";
import { loadApplyVerifications } from "../store/applyVerifications";
import { loadConnections } from "../store/connections";
import { loadOperationHistory } from "../store/operationHistory";
import { loadSettings } from "../store/settings";
import { loadSSHProfiles } from "../store/sshProfiles";

export const APP_DATA_BACKUP_SCHEMA_VERSION = 1;

export interface CollectAppDataBackupInput {
  appVersion: string;
  sourcePlatform: string;
  createdAt: string;
}

export interface AppDataBackupData {
  connections: unknown[];
  sshProfiles: unknown[];
  settings: unknown;
  operationHistory: unknown[];
  applyPlans: unknown[];
  applyVerifications: unknown[];
  ui: unknown;
  locale: string;
  appDataBackup: unknown;
}

export interface AppDataBackupPayload {
  schemaVersion: typeof APP_DATA_BACKUP_SCHEMA_VERSION;
  createdAt: string;
  appVersion: string;
  sourcePlatform: string;
  data: AppDataBackupData;
}

export interface AppDataBackupSummary {
  schemaVersion: number;
  appVersion: string;
  createdAt: string;
  sourcePlatform: string;
  sections: {
    connections: number;
    sshProfiles: number;
    operationHistory: number;
    applyPlans: number;
    applyVerifications: number;
  };
  hasSettings: boolean;
  hasUi: boolean;
  locale: string;
  includesSensitiveData: boolean;
}

const UI_KEY = "cs.ui";
const LOCALE_KEY = "locale";
const SENSITIVE_KEYS = new Set(["password", "accessKeySecret", "securityToken", "privateKey", "passphrase"]);

function readJsonStorage(key: string, fallback: unknown): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function localeValue(value: unknown): string {
  return value === "en-US" || value === "zh-CN" ? value : "zh-CN";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function arraySection(data: Record<string, unknown>, key: keyof AppDataBackupData): unknown[] {
  const value = data[key];
  if (!Array.isArray(value)) {
    throw new Error(`应用数据备份缺少有效分区: ${String(key)}`);
  }
  return value;
}

function objectSection(data: Record<string, unknown>, key: keyof AppDataBackupData): unknown {
  const value = data[key];
  if (!isObject(value)) {
    throw new Error(`应用数据备份缺少有效分区: ${String(key)}`);
  }
  return value;
}

function sectionLocale(data: Record<string, unknown>): string {
  const value = data.locale;
  if (typeof value !== "string") {
    throw new Error("应用数据备份缺少有效分区: locale");
  }
  return localeValue(value);
}

function containsSensitiveData(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsSensitiveData);
  }
  if (!isObject(value)) {
    return false;
  }
  return Object.entries(value).some(([key, item]) => (SENSITIVE_KEYS.has(key) && typeof item === "string" && item.length > 0) || containsSensitiveData(item));
}

export function collectAppDataBackupPayload(input: CollectAppDataBackupInput): AppDataBackupPayload {
  return {
    schemaVersion: APP_DATA_BACKUP_SCHEMA_VERSION,
    createdAt: input.createdAt,
    appVersion: input.appVersion,
    sourcePlatform: input.sourcePlatform,
    data: {
      connections: loadConnections(),
      sshProfiles: loadSSHProfiles(),
      settings: loadSettings(),
      operationHistory: loadOperationHistory(),
      applyPlans: loadApplyPlans(),
      applyVerifications: loadApplyVerifications(),
      ui: readJsonStorage(UI_KEY, {}),
      locale: localeValue(localStorage.getItem(LOCALE_KEY)),
      appDataBackup: loadAppDataBackupState(),
    },
  };
}

export function validateAppDataBackupPayload(value: unknown): AppDataBackupPayload {
  if (!isObject(value)) {
    throw new Error("应用数据备份格式无效");
  }
  if (value.schemaVersion !== APP_DATA_BACKUP_SCHEMA_VERSION) {
    throw new Error("不支持的应用数据备份版本");
  }
  if (typeof value.createdAt !== "string" || typeof value.appVersion !== "string" || typeof value.sourcePlatform !== "string") {
    throw new Error("应用数据备份缺少元信息");
  }
  if (!isObject(value.data)) {
    throw new Error("应用数据备份缺少数据分区");
  }
  const data = value.data;
  return {
    schemaVersion: APP_DATA_BACKUP_SCHEMA_VERSION,
    createdAt: value.createdAt,
    appVersion: value.appVersion,
    sourcePlatform: value.sourcePlatform,
    data: {
      connections: arraySection(data, "connections"),
      sshProfiles: arraySection(data, "sshProfiles"),
      settings: objectSection(data, "settings"),
      operationHistory: arraySection(data, "operationHistory"),
      applyPlans: arraySection(data, "applyPlans"),
      applyVerifications: arraySection(data, "applyVerifications"),
      ui: objectSection(data, "ui"),
      locale: sectionLocale(data),
      appDataBackup: objectSection(data, "appDataBackup"),
    },
  };
}

export function summarizeAppDataBackupPayload(value: unknown): AppDataBackupSummary {
  const payload = validateAppDataBackupPayload(value);
  return {
    schemaVersion: payload.schemaVersion,
    appVersion: payload.appVersion,
    createdAt: payload.createdAt,
    sourcePlatform: payload.sourcePlatform,
    sections: {
      connections: payload.data.connections.length,
      sshProfiles: payload.data.sshProfiles.length,
      operationHistory: payload.data.operationHistory.length,
      applyPlans: payload.data.applyPlans.length,
      applyVerifications: payload.data.applyVerifications.length,
    },
    hasSettings: isObject(payload.data.settings),
    hasUi: isObject(payload.data.ui),
    locale: payload.data.locale,
    includesSensitiveData: containsSensitiveData(payload.data),
  };
}

export function restoreAppDataBackupPayload(value: unknown): AppDataBackupPayload {
  const payload = validateAppDataBackupPayload(value);
  localStorage.setItem("cs.connections", JSON.stringify(payload.data.connections));
  localStorage.setItem("cs.sshProfiles", JSON.stringify(payload.data.sshProfiles));
  localStorage.setItem("cs.settings", JSON.stringify(payload.data.settings));
  localStorage.setItem("cs.operationHistory", JSON.stringify(payload.data.operationHistory));
  localStorage.setItem("cs.applyPlans", JSON.stringify(payload.data.applyPlans));
  localStorage.setItem("cs.applyVerifications", JSON.stringify(payload.data.applyVerifications));
  localStorage.setItem(UI_KEY, JSON.stringify(payload.data.ui));
  localStorage.setItem(LOCALE_KEY, payload.data.locale);
  localStorage.setItem("cs.appDataBackup", JSON.stringify(payload.data.appDataBackup));
  return payload;
}
