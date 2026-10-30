import { DeleteLargeSecret, ReadLargeSecret, WriteLargeSecret } from "../../wailsjs/go/app/App";
import { deleteSecureSecret, readSecureSecret, writeSecureSecret } from "../api/secureStore";
import { loadAppDataBackupState, saveAppDataBackupState, type AppDataWebDAVSettings } from "../store/appDataBackup";
import { loadConnections, updateConnection, type Connection, type SSHConfig } from "../store/connections";
import { getSSHProfile, loadSSHProfiles, upsertSSHProfile, type SSHProfile } from "../store/sshProfiles";
import { loadSnapshotWebDAVState, saveSnapshotWebDAVState, type SnapshotWebDAVSettings } from "../store/snapshotWebDAV";
import { translate } from "../locales";
import { errorText } from "./errorText";

export type CredentialSecretNamespace = "connection" | "app-data-webdav" | "snapshot-webdav" | "app-data-backup";
export type StoredSecretStatus = "stored" | "missing" | "unsupported";
export const CONNECTION_SECRET_FIELDS = [
  "password",
  "accessKeyId",
  "accessKeySecret",
  "securityToken",
  "apolloToken",
  "consulToken",
] as const;
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

export const SSH_SECRET_FIELDS = ["password", "privateKey", "passphrase"] as const;
export type SSHSecretField = (typeof SSH_SECRET_FIELDS)[number];
export type LargeSecretNamespace = "connection-ssh" | "ssh-profile";

export interface LargeSecretRef {
  namespace: LargeSecretNamespace;
  ownerId: string;
  field: SSHSecretField;
}

export interface LargeSecretWriteResult {
  ref: LargeSecretRef;
  storage: string;
  valueSize: number;
  verified: boolean;
}

export interface LargeSecretPointer extends Omit<StoredSecretPointer, "namespace" | "field"> {
  namespace: LargeSecretNamespace;
  field: SSHSecretField;
  storage: string;
}

export interface SecureStoreClient {
  write(ref: SecureSecretRef, value: string): Promise<SecureSecretWriteResult>;
  read(ref: SecureSecretRef): Promise<string>;
  delete(ref: SecureSecretRef): Promise<void>;
  writeLarge(ref: LargeSecretRef, value: string): Promise<LargeSecretWriteResult>;
  readLarge(ref: LargeSecretRef): Promise<string>;
  deleteLarge(ref: LargeSecretRef): Promise<void>;
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
  namespace: string;
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
  writeLarge: async (ref, value) => {
    const result = await WriteLargeSecret(ref, value);
    // Go 侧回显的 ref 是三串字符串，指针要保住本地窄类型，因此以入参为准
    return { storage: result.storage, valueSize: result.valueSize, verified: result.verified, ref };
  },
  readLarge: (ref) => ReadLargeSecret(ref),
  deleteLarge: (ref) => DeleteLargeSecret(ref),
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

export function formatStoredSecretRef(ref: { namespace: string; ownerId: string; field: string }): string {
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
  if (
    typeof value.ref !== "string" ||
    typeof value.ownerId !== "string" ||
    typeof value.field !== "string" ||
    typeof value.migratedAt !== "string"
  ) {
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
    throw new Error(translate("credentials.writeVerifyFailed"));
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
    throw new Error(translate("credentials.statusUnresolvable", { ref: pointer.ref, status: pointer.status }));
  }
  try {
    return await clientFromDeps(deps).read(refFromPointer(pointer));
  } catch (e) {
    throw new Error(translate("credentials.missingAfterMigration", { ref: pointer.ref, detail: errorText(e) }));
  }
}

export function deleteStoredSecret(pointer: StoredSecretPointer, deps?: CredentialSecretDeps): Promise<void> {
  return clientFromDeps(deps).delete(refFromPointer(pointer));
}

export async function writeAndVerifyLargeSecret(
  input: LargeSecretRef & { value: string },
  deps?: CredentialSecretDeps
): Promise<LargeSecretPointer> {
  const ref: LargeSecretRef = {
    namespace: input.namespace,
    ownerId: input.ownerId,
    field: input.field,
  };
  const result = await clientFromDeps(deps).writeLarge(ref, input.value);
  if (!result.verified) {
    throw new Error(translate("credentials.writeVerifyFailed"));
  }
  return {
    ref: formatStoredSecretRef(ref),
    namespace: ref.namespace,
    ownerId: ref.ownerId,
    field: ref.field,
    migratedAt: nowFromDeps(deps),
    status: "stored",
    storage: result.storage,
  };
}

export async function resolveLargeSecret(pointer: LargeSecretPointer, deps?: CredentialSecretDeps): Promise<string> {
  if (pointer.status !== "stored") {
    throw new Error(translate("credentials.statusUnresolvable", { ref: pointer.ref, status: pointer.status }));
  }
  try {
    return await clientFromDeps(deps).readLarge({
      namespace: pointer.namespace,
      ownerId: pointer.ownerId,
      field: pointer.field,
    });
  } catch (e) {
    throw new Error(translate("credentials.missingAfterMigration", { ref: pointer.ref, detail: errorText(e) }));
  }
}

export function deleteLargeStoredSecret(pointer: LargeSecretPointer, deps?: CredentialSecretDeps): Promise<void> {
  return clientFromDeps(deps).deleteLarge({
    namespace: pointer.namespace,
    ownerId: pointer.ownerId,
    field: pointer.field,
  });
}

const APP_DATA_BACKUP_PASSWORD_REF: SecureSecretRef = {
  namespace: "app-data-backup",
  ownerId: "default",
  field: "encryption-password",
};

export async function saveAppDataBackupPassword(password: string, deps?: CredentialSecretDeps): Promise<StoredSecretPointer> {
  if (!password.trim()) {
    throw new Error(translate("appDataBackup.passwordRequired"));
  }
  return writeAndVerifySecret({ ...APP_DATA_BACKUP_PASSWORD_REF, value: password }, deps);
}

export async function resolveAppDataBackupPassword(pointer: StoredSecretPointer, deps?: CredentialSecretDeps): Promise<string> {
  if (
    pointer.namespace !== APP_DATA_BACKUP_PASSWORD_REF.namespace ||
    pointer.ownerId !== APP_DATA_BACKUP_PASSWORD_REF.ownerId ||
    pointer.field !== APP_DATA_BACKUP_PASSWORD_REF.field
  ) {
    throw new Error(translate("credentials.backupPasswordRefInvalid"));
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
  ref: { namespace: string; ownerId: string; field: string },
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
  const message = errorText(error).toLowerCase();
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

function sshConfigFieldValue(config: SSHConfig | undefined, field: SSHSecretField): string {
  return config?.[field] ?? "";
}

export async function hydrateSSHConfigFields(
  config: SSHConfig | undefined,
  refs: Partial<Record<SSHSecretField, LargeSecretPointer>> | undefined,
  deps?: CredentialSecretDeps
): Promise<SSHConfig | undefined> {
  if (!config || !refs) return config;
  const next: SSHConfig = { ...config };
  for (const field of SSH_SECRET_FIELDS) {
    if (sshConfigFieldValue(next, field)) continue;
    const pointer = refs[field];
    if (pointer?.status !== "stored") continue;
    next[field] = await resolveLargeSecret(pointer, deps);
  }
  return next;
}

export async function hydrateSSHProfile(profile: SSHProfile, deps?: CredentialSecretDeps): Promise<SSHProfile> {
  if (!profile.sshSecretRefs) return profile;
  const config = await hydrateSSHConfigFields(profile.config, profile.sshSecretRefs, deps);
  return { ...profile, config: config ?? profile.config };
}

export async function resolveConnectionSSHConfig(conn: Connection, deps?: CredentialSecretDeps): Promise<SSHConfig | undefined> {
  // 与 sshProfiles.connectionSSHConfig 同口径：档案优先于内联配置。
  const profile = getSSHProfile(conn.sshProfileId);
  if (profile) {
    return hydrateSSHConfigFields(profile.config, profile.sshSecretRefs, deps);
  }
  return hydrateSSHConfigFields(conn.sshConfig, conn.sshSecretRefs, deps);
}

export async function hydrateAppDataWebDAVSettings(
  settings: AppDataWebDAVSettings,
  deps?: CredentialSecretDeps
): Promise<AppDataWebDAVSettings> {
  if (settings.password || settings.passwordSecretRef?.status !== "stored") return settings;
  return {
    ...settings,
    password: await resolveSecret(settings.passwordSecretRef, deps),
  };
}

export async function hydrateSnapshotWebDAVSettings(
  settings: SnapshotWebDAVSettings,
  deps?: CredentialSecretDeps
): Promise<SnapshotWebDAVSettings> {
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
    if (conn.sshConfig) {
      for (const field of SSH_SECRET_FIELDS) {
        if (sshConfigFieldValue(conn.sshConfig, field)) count += 1;
      }
    }
  }
  for (const profile of loadSSHProfiles()) {
    for (const field of SSH_SECRET_FIELDS) {
      if (sshConfigFieldValue(profile.config, field)) count += 1;
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
    recordMigrationItem(summary, ref, isUnsupportedError(e) ? "unsupported" : "failed", errorText(e));
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

async function migrateLargeSecretValue(
  summary: CredentialMigrationSummary,
  input: LargeSecretRef & { value: string },
  deps?: CredentialSecretDeps
): Promise<LargeSecretPointer | null> {
  const ref: LargeSecretRef = { namespace: input.namespace, ownerId: input.ownerId, field: input.field };
  if (!input.value) {
    recordMigrationItem(summary, ref, "skipped");
    return null;
  }
  try {
    const pointer = await writeAndVerifyLargeSecret({ ...ref, value: input.value }, deps);
    recordMigrationItem(summary, ref, "migrated");
    return pointer;
  } catch (e) {
    recordMigrationItem(summary, ref, isUnsupportedError(e) ? "unsupported" : "failed", errorText(e));
    return null;
  }
}

async function migrateConnectionSSHSecrets(summary: CredentialMigrationSummary, deps?: CredentialSecretDeps): Promise<void> {
  for (const conn of loadConnections()) {
    const config = conn.sshConfig;
    if (!config) continue;
    const refs: Partial<Record<SSHSecretField, LargeSecretPointer>> = { ...(conn.sshSecretRefs ?? {}) };
    const cleared: Partial<SSHConfig> = {};
    let changed = false;

    for (const field of SSH_SECRET_FIELDS) {
      const value = sshConfigFieldValue(config, field);
      if (!value && refs[field]?.status === "stored") {
        recordMigrationItem(summary, { namespace: "connection-ssh", ownerId: conn.id, field }, "skipped");
        continue;
      }
      const pointer = await migrateLargeSecretValue(summary, { namespace: "connection-ssh", ownerId: conn.id, field, value }, deps);
      if (pointer) {
        refs[field] = pointer;
        cleared[field] = "";
        changed = true;
      }
    }

    if (changed) {
      updateConnection(conn.id, { ...{ sshConfig: { ...config, ...cleared } }, sshSecretRefs: refs });
    }
  }
}

async function migrateSSHProfileSecrets(summary: CredentialMigrationSummary, deps?: CredentialSecretDeps): Promise<void> {
  for (const profile of loadSSHProfiles()) {
    const config = profile.config;
    const refs: Partial<Record<SSHSecretField, LargeSecretPointer>> = { ...(profile.sshSecretRefs ?? {}) };
    const cleared: Partial<SSHConfig> = {};
    let changed = false;

    for (const field of SSH_SECRET_FIELDS) {
      const value = sshConfigFieldValue(config, field);
      if (!value && refs[field]?.status === "stored") {
        recordMigrationItem(summary, { namespace: "ssh-profile", ownerId: profile.id, field }, "skipped");
        continue;
      }
      const pointer = await migrateLargeSecretValue(summary, { namespace: "ssh-profile", ownerId: profile.id, field, value }, deps);
      if (pointer) {
        refs[field] = pointer;
        cleared[field] = "";
        changed = true;
      }
    }

    if (changed) {
      upsertSSHProfile({ id: profile.id, name: profile.name, config: { ...config, ...cleared }, sshSecretRefs: refs });
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
  await migrateConnectionSSHSecrets(summary, deps);
  await migrateSSHProfileSecrets(summary, deps);
  await migrateAppDataWebDAVCredential(summary, deps);
  await migrateSnapshotWebDAVCredential(summary, deps);
  return summary;
}

/*
 * 编辑回显与保存结算（轮142 C）
 *
 * 用户原话：「我在编辑现有的档案配置的时候，我看不到里面配置的数据，连密码也看不到。」
 * 根因不是渲染 bug：设置页「迁移凭据」把 password/privateKey/passphrase 等字段搬进系统
 * 凭据库后就清空了内联值，只留指针；而建连时才读库（src/api/nacos.ts），编辑入口从来没读过，
 * 所以表单永远是空的。
 *
 * 只补一次 hydrate 会开出另一个洞：表单里带着明文，用户改个名字点保存，整份 config
 * 被写回 localStorage ⇒ 刚迁走的凭据以明文静默回到本地文件。所以读回来时必须同时记下
 * 「打开那一刻的值」作为基线，保存时按「用户有没有动过这个字段」分三路结算：
 *
 *   草稿值 == 基线（没动）  ⇒ 内联清空、指针原样保留（localStorage 不出现明文）
 *   草稿值 != 基线且非空    ⇒ 写库；成功则内联清空并更新指针，失败则内联保留（＝迁移前的老形状，
 *                            不假装成功；运行侧「内联优先」，下次点迁移会覆盖）
 *   草稿值为空（用户清空）  ⇒ 删库条目并摘指针（删库失败也只摘：留着会让下次建连读到旧凭据）
 *
 * 基线只活在组件内存里（打开表单那一刻快照），不写进本地数据，也不在保存时再读一次库比对——
 * 那会多三趟异步，而且期间库可能已被别处改动。
 */

export interface SecretEditNotice {
  field: string;
  /** 涉及的凭据引用，仅用于提示与日志（不含明文）。 */
  ref: string;
  /** read＝打开表单时读不回来；write＝入库失败（明文留在本地）；delete＝解引用后库里残留旧条目。 */
  kind: "read" | "write" | "delete";
  detail: string;
}

export interface SecretEditSnapshot {
  /** 打开表单时应当显示的值：内联有值用内联，否则从系统凭据库读回。 */
  values: Record<string, string>;
  /** 读回来那一刻的值＝判定「用户动没动」的基线。 */
  baseline: Record<string, string>;
  /** 指针在、但库里读不出来的字段：表单留空，UI 提示「读不到，请重新填写」，不阻断编辑。 */
  unavailable: SecretEditNotice[];
}

export interface SettledSecrets<P> {
  inline: Record<string, string>;
  pointers: Record<string, P>;
  /** 写库或删库没成功的字段。UI 要就近说清「实际存在哪儿」，不能只报成功。 */
  notices: SecretEditNotice[];
  /**
   * 下一次保存该用的新基线：内联被清空（＝值已进库，或已明确删除）的字段跟进到草稿值；
   * 内联仍留着明文的字段（写库失败或库不可用）基线不动——下次保存要再试一次入库，
   * 否则「值 == 基线」会把它误判成没动，明文号就此停在本地文件里。
   */
  baseline: Record<string, string>;
}

interface PointerWithRef {
  ref: string;
}

async function readSecretFieldsForEdit<F extends string, P extends PointerWithRef>(
  fields: readonly F[],
  inline: Partial<Record<F, string | undefined>>,
  refs: Partial<Record<F, P>> | undefined,
  resolve: (pointer: P) => Promise<string>
): Promise<SecretEditSnapshot> {
  const values: Record<string, string> = {};
  const baseline: Record<string, string> = {};
  const unavailable: SecretEditNotice[] = [];

  for (const field of fields) {
    let value = inline[field] ?? "";
    const pointer = refs?.[field];
    // 内联有值就不必读库：没迁移过的记录里内联明文才是事实源。
    if (!value && pointer) {
      try {
        value = await resolve(pointer);
      } catch (e) {
        unavailable.push({ field, ref: pointer.ref, kind: "read", detail: errorText(e) });
      }
    }
    values[field] = value;
    baseline[field] = value;
  }

  return { values, baseline, unavailable };
}

async function settleSecretFields<F extends string, P extends PointerWithRef>(
  fields: readonly F[],
  draft: Partial<Record<F, string | undefined>>,
  baseline: Partial<Record<F, string | undefined>>,
  refs: Partial<Record<F, P>> | undefined,
  ops: { write: (field: F, value: string) => Promise<P>; remove: (pointer: P) => Promise<void> }
): Promise<SettledSecrets<P>> {
  const inline: Record<string, string> = {};
  const pointers: Record<string, P> = {};
  const notices: SecretEditNotice[] = [];

  for (const field of fields) {
    const value = draft[field] ?? "";
    const pointer = refs?.[field];
    if (pointer) pointers[field] = pointer;

    if (value === (baseline[field] ?? "")) {
      // 没动：库里有指针就继续只存指针；本来没指针的记录保持原样（不顺手替他做迁移）。
      inline[field] = pointer ? "" : value;
      continue;
    }

    if (value) {
      try {
        pointers[field] = await ops.write(field, value);
        inline[field] = "";
      } catch (e) {
        if (isUnsupportedError(e)) {
          // 系统凭据库不可用（Web 版、无 keyring 的环境）：明文留在内联＝迁移前的形状。
          // 这条不算异常，用户从没要求过入库，播报出来只会变成每次保存都亮的红字。
          inline[field] = value;
          continue;
        }
        notices.push({ field, ref: pointer?.ref ?? field, kind: "write", detail: errorText(e) });
        inline[field] = value;
      }
      continue;
    }

    if (pointer) {
      try {
        await ops.remove(pointer);
      } catch (e) {
        // 删不掉也要摘指针：留着指针等于下一次建连还在用用户刚刚清掉的凭据。
        notices.push({ field, ref: pointer.ref, kind: "delete", detail: errorText(e) });
      }
      delete pointers[field];
    }
    inline[field] = "";
  }

  const nextBaseline: Record<string, string> = {};
  for (const field of fields) {
    const original = baseline[field] ?? "";
    nextBaseline[field] = inline[field] === "" ? draft[field] ?? "" : original;
  }

  return { inline, pointers, notices, baseline: nextBaseline };
}

/** 连接小凭据（namespace "connection"）的编辑回显。 */
export async function loadConnectionSecretsForEdit(
  conn: Pick<Connection, "password" | "accessKeyId" | "accessKeySecret" | "securityToken" | "apolloToken" | "consulToken"> & {
    secretRefs?: Partial<Record<ConnectionSecretField, StoredSecretPointer>>;
  },
  deps?: CredentialSecretDeps
): Promise<SecretEditSnapshot> {
  const inline: Partial<Record<ConnectionSecretField, string | undefined>> = {
    password: conn.password,
    accessKeyId: conn.accessKeyId,
    accessKeySecret: conn.accessKeySecret,
    securityToken: conn.securityToken,
    apolloToken: conn.apolloToken,
    consulToken: conn.consulToken,
  };
  return readSecretFieldsForEdit(CONNECTION_SECRET_FIELDS, inline, conn.secretRefs, (pointer) =>
    resolveSecret(pointer, deps)
  );
}

/** 保存连接小凭据：见文件头三路判定。ownerId 必须是最终入库的连接 id。 */
export async function settleConnectionSecrets(params: {
  ownerId: string;
  draft: Partial<Record<ConnectionSecretField, string | undefined>>;
  baseline: Partial<Record<ConnectionSecretField, string>>;
  refs?: Partial<Record<ConnectionSecretField, StoredSecretPointer>>;
  deps?: CredentialSecretDeps;
}): Promise<SettledSecrets<StoredSecretPointer>> {
  return settleSecretFields(CONNECTION_SECRET_FIELDS, params.draft, params.baseline, params.refs, {
      write: (field, value) =>
        writeAndVerifySecret({ namespace: "connection", ownerId: params.ownerId, field, value }, params.deps),
      remove: (pointer) => deleteStoredSecret(pointer, params.deps),
    }
  );
}

/** SSH 大凭据（档案 / 连接内联）的编辑回显。 */
export async function loadSSHSecretsForEdit(
  config: SSHConfig | undefined,
  refs: Partial<Record<SSHSecretField, LargeSecretPointer>> | undefined,
  deps?: CredentialSecretDeps
): Promise<SecretEditSnapshot> {
  const inline: Partial<Record<SSHSecretField, string | undefined>> = {
    password: config?.password,
    privateKey: config?.privateKey,
    passphrase: config?.passphrase,
  };
  return readSecretFieldsForEdit(SSH_SECRET_FIELDS, inline, refs, (pointer) => resolveLargeSecret(pointer, deps));
}

/** 保存 SSH 大凭据：见文件头三路判定。namespace 区分档案与连接内联两套条目。 */
export async function settleSSHSecrets(params: {
  namespace: LargeSecretNamespace;
  ownerId: string;
  draft: Partial<Record<SSHSecretField, string | undefined>>;
  baseline: Partial<Record<SSHSecretField, string>>;
  refs?: Partial<Record<SSHSecretField, LargeSecretPointer>>;
  deps?: CredentialSecretDeps;
}): Promise<SettledSecrets<LargeSecretPointer>> {
  return settleSecretFields(SSH_SECRET_FIELDS, params.draft, params.baseline, params.refs, {
      write: (field, value) =>
        writeAndVerifyLargeSecret({ namespace: params.namespace, ownerId: params.ownerId, field, value }, params.deps),
      remove: (pointer) => deleteLargeStoredSecret(pointer, params.deps),
    }
  );
}

/**
 * 凭据字段的展示名来源（唯一出处）：档案页与连接页提示「哪几个字段读回来了 / 没能入库」时
 * 复用同一张表，不再各写一套中文。值是 locale key，渲染侧必须过 t()。
 * 注意小凭据的 password 是 Nacos 密码，大凭据的 password 是 SSH 密码，两张表不能混用。
 */
export const CONNECTION_SECRET_LABEL_KEYS: Record<ConnectionSecretField, string> = {
  password: "connection.password",
  accessKeyId: "connection.accessKeyId",
  accessKeySecret: "connection.accessKeySecret",
  securityToken: "connection.securityToken",
  apolloToken: "connection.apolloToken",
  consulToken: "connection.consulToken",
};

export const SSH_SECRET_LABEL_KEYS: Record<SSHSecretField, string> = {
  password: "connection.sshPassword",
  privateKey: "connection.privateKey",
  passphrase: "connection.privateKeyPassword",
};

function pickSecretFields<F extends string>(
  fields: readonly F[],
  values: Record<string, string | undefined>
): Record<F, string> {
  const picked = {} as Record<F, string>;
  for (const field of fields) picked[field] = values[field] ?? "";
  return picked;
}

/**
 * 把回显快照 / 结算结果里的 `Record<string, string>` 铺回具体凭据字段（轮142 C，唯一出处）。
 * 映射留给页面各写一遍的话，漏掉的那个字段就会变成「看不见也存不上」的凭据——
 * 连接页原本正是靠 spread 整份 Connection 才没漏，改成部分字段后必须有个集中的地方。
 */
export function connectionSecretPatch(values: Record<string, string | undefined>): Record<ConnectionSecretField, string> {
  return pickSecretFields(CONNECTION_SECRET_FIELDS, values);
}

export function sshSecretPatch(values: Record<string, string | undefined>): Record<SSHSecretField, string> {
  return pickSecretFields(SSH_SECRET_FIELDS, values);
}
