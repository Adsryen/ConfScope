import { deleteSecureSecret, readSecureSecret, writeSecureSecret } from "../api/secureStore";
import { loadAppDataBackupState, saveAppDataBackupState, type AppDataWebDAVSettings } from "../store/appDataBackup";
import { loadConnections, updateConnection, type Connection } from "../store/connections";
import { loadSnapshotWebDAVState, saveSnapshotWebDAVState, type SnapshotWebDAVSettings } from "../store/snapshotWebDAV";

export type CredentialSecretNamespace = "connection" | "app-data-webdav" | "snapshot-webdav" | "app-data-backup";
export type StoredSecretStatus = "stored" | "missing" | "unsupported";
export const CONNECTION_SECRET_FIELDS = ["password", "accessKeyId", "accessKeySecret", "securityToken", "apolloToken", "consulToken"] as const;
export type ConnectionSecretField = (typeof CONNECTION_SECRET_FIELDS)[number];

export interface SecureSecretRef {
  namespace: CredentialSecretNamespace;
  ownerId: string;
  field: string;
}

export interface SecureSecretWriteResult {
  ref: SecureSecretRef;
  targetName: string;
  valueSize: number;
  verified: boolean;
}

export interface StoredSecretPointer extends SecureSecretRef {
  ref: string;
  migratedAt: string;
  status: StoredSecretStatus;
}

export interface SecureStoreClient {
  write(ref: SecureSecretRef, value: string): Promise<SecureSecretWriteResult>;
  read(ref: SecureSecretRef): Promise<string>;
  delete(ref: SecureSecretRef): Promise<void>;
}

interface CredentialSecretDeps {
  client?: SecureStoreClient;
  now?: () => string;
}

interface WriteSecretInput extends SecureSecretRef {
  value: string;
}

export type CredentialMigrationItemStatus = "migrated" | "skipped" | "unsupported" | "failed";

export interface CredentialMigrationItem {
  namespace: CredentialSecretNamespace;
  ownerId: string;
  field: string;
  ref: string;
  status: CredentialMigrationItemStatus;
  error?: string;
}

export interface CredentialMigrationSummary {
  migrated: number;
  skipped: number;
  unsupported: number;
  failed: number;
  items: CredentialMigrationItem[];
}

const defaultClient: SecureStoreClient = {
  write: async (ref, value) => {
    const result = await writeSecureSecret(ref, value);
    return { ...result, ref };
  },
  read: (ref) => readSecureSecret(ref),
  delete: (ref) => deleteSecureSecret(ref),
};

function clientFromDeps(deps?: CredentialSecretDeps): SecureStoreClient {
  return deps?.client ?? defaultClient;
}

function nowFromDeps(deps?: CredentialSecretDeps): string {
  return deps?.now ? deps.now() : new Date().toISOString();
}

function refFromPointer(pointer: StoredSecretPointer): SecureSecretRef {
  return {
    namespace: pointer.namespace,
    ownerId: pointer.ownerId,
    field: pointer.field,
  };
}

export function formatStoredSecretRef(ref: SecureSecretRef): string {
  return `${ref.namespace}.${ref.ownerId}.${ref.field}`;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isCredentialSecretNamespace(value: unknown): value is CredentialSecretNamespace {
  return value === "connection" || value === "app-data-webdav" || value === "snapshot-webdav";
}

function isStoredSecretStatus(value: unknown): value is StoredSecretStatus {
  return value === "stored" || value === "missing" || value === "unsupported";
}

export function normalizeStoredSecretPointer(value: unknown): StoredSecretPointer | null {
  if (!isObjectRecord(value)) return null;
  if (!isCredentialSecretNamespace(value.namespace) || !isStoredSecretStatus(value.status)) return null;
  if (typeof value.ref !== "string" || typeof value.ownerId !== "string" || typeof value.field !== "string" || typeof value.migratedAt !== "string") {
    return null;
  }
  if (!value.ref || !value.ownerId || !value.field || !value.migratedAt) return null;
  return {
    ref: value.ref,
    namespace: value.namespace,
    ownerId: value.ownerId,
    field: value.field,
    migratedAt: value.migratedAt,
    status: value.status,
  };
}

export async function writeAndVerifySecret(input: WriteSecretInput, deps?: CredentialSecretDeps): Promise<StoredSecretPointer> {
  const ref: SecureSecretRef = {
    namespace: input.namespace,
    ownerId: input.ownerId,
    field: input.field,
  };
  const result = await clientFromDeps(deps).write(ref, input.value);
  if (!result.verified) {
    throw new Error("系统凭据库写入后未通过读回校验");
  }
  return {
    ...ref,
    ref: formatStoredSecretRef(ref),
    migratedAt: nowFromDeps(deps),
    status: "stored",
  };
}

export async function resolveSecret(pointer: StoredSecretPointer, deps?: CredentialSecretDeps): Promise<string> {
  if (pointer.status !== "stored") {
    throw new Error(`凭据 ${pointer.ref} 当前状态为 ${pointer.status}，无法从系统凭据库读取`);
  }
  try {
    return await clientFromDeps(deps).read(refFromPointer(pointer));
  } catch (e) {
    throw new Error(`凭据已迁移到系统凭据库，但当前系统中找不到 ${pointer.ref}，请重新输入密码或从应用数据备份恢复：${String(e)}`);
  }
}

export function deleteStoredSecret(pointer: StoredSecretPointer, deps?: CredentialSecretDeps): Promise<void> {
  return clientFromDeps(deps).delete(refFromPointer(pointer));
}

const APP_DATA_BACKUP_PASSWORD_REF: SecureSecretRef = {
  namespace: "app-data-backup",
  ownerId: "default",
  field: "encryption-password",
};

export async function saveAppDataBackupPassword(password: string, deps?: CredentialSecretDeps): Promise<StoredSecretPointer> {
  if (!password.trim()) {
    throw new Error("备份密码不能为空");
  }
  return writeAndVerifySecret({ ...APP_DATA_BACKUP_PASSWORD_REF, value: password }, deps);
}

export async function resolveAppDataBackupPassword(pointer: StoredSecretPointer, deps?: CredentialSecretDeps): Promise<string> {
  if (pointer.namespace !== APP_DATA_BACKUP_PASSWORD_REF.namespace || pointer.ownerId !== APP_DATA_BACKUP_PASSWORD_REF.ownerId || pointer.field !== APP_DATA_BACKUP_PASSWORD_REF.field) {
    throw new Error("备份密码凭据引用无效，请重新设置密码");
  }
  return resolveSecret(pointer, deps);
}

function emptyMigrationSummary(): CredentialMigrationSummary {
  return {
    migrated: 0,
    skipped: 0,
    unsupported: 0,
    failed: 0,
    items: [],
  };
}

function migrationRef(namespace: CredentialSecretNamespace, ownerId: string, field: string): SecureSecretRef {
  return { namespace, ownerId, field };
}

function recordMigrationItem(
  summary: CredentialMigrationSummary,
  ref: SecureSecretRef,
  status: CredentialMigrationItemStatus,
  error?: string
): void {
  summary.items.push({
    ...ref,
    ref: formatStoredSecretRef(ref),
    status,
    error,
  });
  if (status === "migrated") summary.migrated += 1;
  if (status === "skipped") summary.skipped += 1;
  if (status === "unsupported") summary.unsupported += 1;
  if (status === "failed") summary.failed += 1;
}

function isUnsupportedError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes("unsupported") || message.includes("不支持");
}

function connectionSecretValue(conn: Connection, field: ConnectionSecretField): string {
  return conn[field] ?? "";
}

function clearConnectionSecretField(patch: Partial<Omit<Connection, "id">>, field: ConnectionSecretField): void {
  switch (field) {
    case "password":
      patch.password = "";
      break;
    case "accessKeyId":
      patch.accessKeyId = "";
      break;
    case "accessKeySecret":
      patch.accessKeySecret = "";
      break;
    case "securityToken":
      patch.securityToken = "";
      break;
    case "apolloToken":
      patch.apolloToken = "";
      break;
    case "consulToken":
      patch.consulToken = "";
      break;
  }
}

function setConnectionSecretField(conn: Connection, field: ConnectionSecretField, value: string): void {
  switch (field) {
    case "password":
      conn.password = value;
      break;
    case "accessKeyId":
      conn.accessKeyId = value;
      break;
    case "accessKeySecret":
      conn.accessKeySecret = value;
      break;
    case "securityToken":
      conn.securityToken = value;
      break;
    case "apolloToken":
      conn.apolloToken = value;
      break;
    case "consulToken":
      conn.consulToken = value;
      break;
  }
}

export async function hydrateConnectionSecrets(conn: Connection, deps?: CredentialSecretDeps): Promise<Connection> {
  const next: Connection = { ...conn, secretRefs: conn.secretRefs ? { ...conn.secretRefs } : undefined };
  for (const field of CONNECTION_SECRET_FIELDS) {
    if (connectionSecretValue(next, field)) continue;
    const pointer = conn.secretRefs?.[field];
    if (pointer?.status !== "stored") continue;
    setConnectionSecretField(next, field, await resolveSecret(pointer, deps));
  }
  return next;
}

export async function hydrateAppDataWebDAVSettings(settings: AppDataWebDAVSettings, deps?: CredentialSecretDeps): Promise<AppDataWebDAVSettings> {
  if (settings.password || settings.passwordSecretRef?.status !== "stored") return settings;
  return {
    ...settings,
    password: await resolveSecret(settings.passwordSecretRef, deps),
  };
}

export async function hydrateSnapshotWebDAVSettings(settings: SnapshotWebDAVSettings, deps?: CredentialSecretDeps): Promise<SnapshotWebDAVSettings> {
  if (settings.password || settings.passwordSecretRef?.status !== "stored") return settings;
  return {
    ...settings,
    password: await resolveSecret(settings.passwordSecretRef, deps),
  };
}

export function countMigratableStoredCredentials(): number {
  let count = 0;
  for (const conn of loadConnections()) {
    for (const field of CONNECTION_SECRET_FIELDS) {
      if (connectionSecretValue(conn, field)) count += 1;
    }
  }
  if (loadAppDataBackupState().webdav.password) count += 1;
  if (loadSnapshotWebDAVState().webdav.password) count += 1;
  return count;
}

async function migrateSecretValue(
  summary: CredentialMigrationSummary,
  input: WriteSecretInput,
  deps?: CredentialSecretDeps
): Promise<StoredSecretPointer | null> {
  const ref = migrationRef(input.namespace, input.ownerId, input.field);
  if (!input.value) {
    recordMigrationItem(summary, ref, "skipped");
    return null;
  }
  try {
    const pointer = await writeAndVerifySecret(input, deps);
    recordMigrationItem(summary, ref, "migrated");
    return pointer;
  } catch (e) {
    recordMigrationItem(summary, ref, isUnsupportedError(e) ? "unsupported" : "failed", String(e));
    return null;
  }
}

async function migrateConnectionCredentials(summary: CredentialMigrationSummary, deps?: CredentialSecretDeps): Promise<void> {
  for (const conn of loadConnections()) {
    const secretRefs: Partial<Record<ConnectionSecretField, StoredSecretPointer>> = { ...(conn.secretRefs ?? {}) };
    const patch: Partial<Omit<Connection, "id">> = {};
    let changed = false;

    for (const field of CONNECTION_SECRET_FIELDS) {
      const value = connectionSecretValue(conn, field);
      if (!value && secretRefs[field]?.status === "stored") {
        recordMigrationItem(summary, migrationRef("connection", conn.id, field), "skipped");
        continue;
      }
      const pointer = await migrateSecretValue(summary, { namespace: "connection", ownerId: conn.id, field, value }, deps);
      if (pointer) {
        secretRefs[field] = pointer;
        clearConnectionSecretField(patch, field);
        changed = true;
      }
    }

    if (changed) {
      updateConnection(conn.id, { ...patch, secretRefs });
    }
  }
}

async function migrateAppDataWebDAVCredential(summary: CredentialMigrationSummary, deps?: CredentialSecretDeps): Promise<void> {
  const state = loadAppDataBackupState();
  if (!state.webdav.password && state.webdav.passwordSecretRef?.status === "stored") {
    recordMigrationItem(summary, migrationRef("app-data-webdav", "default", "password"), "skipped");
    return;
  }
  const pointer = await migrateSecretValue(
    summary,
    { namespace: "app-data-webdav", ownerId: "default", field: "password", value: state.webdav.password },
    deps
  );
  if (!pointer) return;
  saveAppDataBackupState({
    ...state,
    webdav: {
      ...state.webdav,
      password: "",
      passwordSecretRef: pointer,
    },
  });
}

async function migrateSnapshotWebDAVCredential(summary: CredentialMigrationSummary, deps?: CredentialSecretDeps): Promise<void> {
  const state = loadSnapshotWebDAVState();
  if (!state.webdav.password && state.webdav.passwordSecretRef?.status === "stored") {
    recordMigrationItem(summary, migrationRef("snapshot-webdav", "default", "password"), "skipped");
    return;
  }
  const pointer = await migrateSecretValue(
    summary,
    { namespace: "snapshot-webdav", ownerId: "default", field: "password", value: state.webdav.password },
    deps
  );
  if (!pointer) return;
  saveSnapshotWebDAVState({
    ...state,
    webdav: {
      ...state.webdav,
      password: "",
      passwordSecretRef: pointer,
    },
  });
}

export async function migrateStoredCredentials(deps?: CredentialSecretDeps): Promise<CredentialMigrationSummary> {
  const summary = emptyMigrationSummary();
  await migrateConnectionCredentials(summary, deps);
  await migrateAppDataWebDAVCredential(summary, deps);
  await migrateSnapshotWebDAVCredential(summary, deps);
  return summary;
}
