import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, posix, relative, sep } from "node:path";
import {
  apolloNamespaceContent,
  apolloNamespaceUpdateTime,
  getApolloNamespace,
  listApolloNamespaces,
  type SmokeApolloNamespace,
} from "../env/apollo";
import {
  getConsulKV,
  listConsulDatacenters,
  listConsulKV,
  type SmokeConsulKV,
} from "../env/consul";
import {
  deleteNacosConfig,
  getNacosConfig,
  listNacosConfigs,
  publishNacosConfig,
  waitForNacosContent,
  type SmokeNacosConfig,
  type SmokeNacosConfigSummary,
} from "../env/nacos";
import type { SmokeConsulEndpoint, SmokeNacosEndpoint, SmokeState } from "../env/workspace";

interface ConnectionProfile {
  id: string;
  name: string;
  provider: "nacos" | "local" | "apollo" | "consul";
  baseUrl: string;
  accessToken: string;
  apolloEnv: string;
  apolloAppId: string;
  apolloCluster: string;
  apolloNamespaceName: string;
  consulDatacenter: string;
  consulKeyPrefix: string;
}

interface ConfigRef {
  namespace: string;
  group: string;
  dataId: string;
  key?: string;
}

interface ListConfigsRequest {
  namespace: string;
  group: string;
  dataId: string;
  pageNo: number;
  pageSize: number;
}

interface PublishConfigRequest {
  ref: ConfigRef;
  content: string;
  format: string;
}

interface ConfigSnapshot {
  namespace: string;
  group: string;
  dataId: string;
  content: string;
  configType?: string;
  contentType?: string;
  updateTime?: string;
}

interface SnapshotSource {
  provider: string;
  connectionId: string;
  connectionName: string;
  namespace: string;
  namespaceId: string;
}

interface Snapshot {
  schemaVersion: number;
  toolVersion: string;
  id: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  source: SnapshotSource;
  configs: ConfigSnapshot[];
  remoteSnapshotId?: string;
  importedFrom?: {
    type: string;
    remotePath: string;
    importedAt: string;
  };
}

export function createSmokeAppBinding(state: SmokeState): (method: string, args: unknown[]) => Promise<unknown> {
  let lastLocalAppDataBackupPath = join(state.appBackupsDir, "confscope-smoke-local.csbackup");
  return async (method, args) => {
    switch (method) {
      case "GetAppInfo":
        return { name: "ConfScope", version: "1.4.1-smoke", updateSources: [{ name: "Smoke", url: "http://127.0.0.1/smoke-update.json" }] };
      case "CheckForUpdates":
        return {
          hasUpdate: false,
          latestVersion: "1.4.1-smoke",
          currentVersion: "1.4.1-smoke",
          sourceName: "Smoke",
          releaseNotes: "",
          mandatory: false,
          error: "",
        };
      case "DownloadUpdate":
        return join(state.rootDir, "downloads", "ConfScope-smoke.exe");
      case "GetDownloadProgress":
        return { totalBytes: 1, downloadedBytes: 1, percent: 100, done: true, error: "" };
      case "InstallAndRestart":
        return undefined;
      case "GetCurrentPlatform":
        return "windows-amd64";
      case "SelectLocalSnapshotDirectory":
        return state.fixtures.strictPublic;
      case "ValidateLocalSnapshotDirectory":
        return validateLocalSnapshotDirectory(stringArg(args, 0));
      case "ValidateSnapshot":
        return validateSnapshotOrThrow(stringArg(args, 0));
      case "SelectAppDataBackupSaveFile":
        lastLocalAppDataBackupPath = join(state.appBackupsDir, basename(stringArg(args, 0)) || "confscope-smoke-local.csbackup");
        return lastLocalAppDataBackupPath;
      case "SelectAppDataBackupOpenFile":
        return lastLocalAppDataBackupPath;
      case "WriteAppDataBackupFile":
        return writeAppDataBackupFile(stringArg(args, 0), stringArg(args, 1), stringArg(args, 2), appDataPackageMetaArg(args, 3));
      case "ReadAppDataBackupFile":
        return readAppDataBackupFile(stringArg(args, 0), stringArg(args, 1));
      case "CreateAppDataRecoveryPoint":
        return createAppDataRecoveryPoint(state, stringArg(args, 0), stringArg(args, 1), appDataPackageMetaArg(args, 2));
      case "TestAppDataWebDAV":
        return testAppDataWebDAV(webDAVTargetArg(args, 0));
      case "ListAppDataWebDAVBackups":
        return listAppDataWebDAVBackups(webDAVTargetArg(args, 0));
      case "UploadAppDataWebDAVBackup":
        return uploadAppDataWebDAVBackup(webDAVTargetArg(args, 0), stringArg(args, 1), stringArg(args, 2), appDataPackageMetaArg(args, 3));
      case "DownloadAppDataWebDAVBackup":
        return downloadAppDataWebDAVBackup(webDAVTargetArg(args, 0), stringArg(args, 1), stringArg(args, 2));
      case "TestSnapshotWebDAV":
        return testSnapshotWebDAV(webDAVTargetArg(args, 0));
      case "UploadSnapshotWebDAVPackage":
        return uploadSnapshotWebDAVPackage(state, webDAVTargetArg(args, 0), stringArg(args, 1), stringArg(args, 2));
      case "ListSnapshotWebDAVPackages":
        return listSnapshotWebDAVPackages(webDAVTargetArg(args, 0));
      case "ImportSnapshotWebDAVPackage":
        return importSnapshotWebDAVPackage(state, webDAVTargetArg(args, 0), stringArg(args, 1), stringArg(args, 2));
      case "ConfigCenterTestConnection":
        return testConnection(profileArg(args, 0));
      case "ConfigCenterListNamespaces":
        return listNamespaces(state, profileArg(args, 0));
      case "ConfigCenterListConfigs":
        return listConfigs(state, profileArg(args, 0), listRequestArg(args, 1));
      case "ConfigCenterGetConfig":
        return getConfigDocument(state, profileArg(args, 0), refArg(args, 1));
      case "ConfigCenterPublishConfig":
      case "ConfigCenterDeleteConfig":
      case "NacosPublishConfig":
      case "NacosDeleteConfig":
        throw new Error("Direct config writes are disabled. Generate and execute an ApplyPlan instead.");
      case "ConfigCenterPublishConfigFromApplyPlan":
        return publishFromApplyPlan(state, profileArg(args, 0), publishRequestArg(args, 1));
      case "ConfigCenterDeleteConfigFromApplyPlan":
        return deleteFromApplyPlan(state, profileArg(args, 0), refArg(args, 1));
      case "ConfigCenterListHistory":
      case "NacosHistoryList":
        return { totalCount: 0, pageNumber: 1, pagesAvailable: 0, pageItems: [] };
      case "ConfigCenterGetHistoryDetail":
      case "NacosHistoryDetail":
        throw new Error("Smoke bridge did not seed history detail.");
      case "NacosDetectVersion":
        return "v1";
      case "NacosLogin":
        return { accessToken: "", tokenTtl: 18000, globalAdmin: false };
      case "NacosNamespaces":
        return [{ namespace: "", namespaceShowName: "public", configCount: 0, kind: 0 }];
      case "NacosListConfigs":
        return listLegacyNacos(state, args);
      case "NacosGetConfig":
        return getNacosConfig(endpointForBaseUrl(state, stringArg(args, 0)), {
          namespace: stringArg(args, 3),
          dataId: stringArg(args, 4),
          group: stringArg(args, 5),
        });
      case "NacosPublishConfigFromApplyPlan":
        return publishAndWait(endpointForBaseUrl(state, stringArg(args, 0)), {
          namespace: stringArg(args, 3),
          dataId: stringArg(args, 4),
          group: stringArg(args, 5),
          content: stringArg(args, 6),
          type: stringArg(args, 7) || "text",
        });
      case "NacosDeleteConfigFromApplyPlan":
        return deleteNacosConfig(endpointForBaseUrl(state, stringArg(args, 0)), {
          namespace: stringArg(args, 3),
          dataId: stringArg(args, 4),
          group: stringArg(args, 5),
        });
      case "CreateSnapshot":
        return createSnapshot(state, sourceArg(args, 0), configSnapshotsArg(args, 1));
      case "GetSnapshot":
        return getSnapshot(state, stringArg(args, 0));
      case "ListSnapshots":
        return listSnapshots(state);
      case "DeleteSnapshot":
        return deleteSnapshot(state, stringArg(args, 0));
      case "CreateSSHTunnel":
        return 18858;
      case "TestSSHConnection":
        return { latencyMs: 1 };
      case "StopSSHTunnel":
      case "StopAllSSHTunnels":
        return undefined;
      case "GetSSHTunnelLocalPort":
        return 18858;
      default:
        throw new Error(`Smoke bridge method is not implemented: ${method}`);
    }
  };
}

interface AppDataPackageMeta {
  appVersion: string;
  sourcePlatform: string;
  createdAt: string;
}

interface AppDataPackageSummary {
  format: string;
  schemaVersion: number;
  appVersion: string;
  sourcePlatform: string;
  createdAt: string;
  size: number;
}

interface AppDataWebDAVTarget {
  enabled: boolean;
  url: string;
  username: string;
  password: string;
  rootPath: string;
}

interface EncryptedEnvelope {
  format: string;
  schemaVersion: number;
  createdAt: string;
  appVersion: string;
  sourcePlatform: string;
  encryption: {
    algorithm: string;
    kdf: string;
    salt: string;
    nonce: string;
  };
  ciphertext: string;
}

interface RemoteBackup {
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
}

interface ConfigSnapshotEnvelope {
  format: string;
  schemaVersion: number;
  snapshot: RemoteConfigSnapshot;
  encryption: {
    algorithm: string;
    kdf: string;
    salt: string;
    nonce: string;
  };
  ciphertext: string;
}

interface RemoteConfigSnapshot {
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
  snapshotId: string;
  snapshotName: string;
  provider: string;
  connectionId: string;
  connectionName: string;
  configCount: number;
  createdAt: string;
}

function writeAppDataBackupFile(path: string, plaintextJson: string, password: string, meta: AppDataPackageMeta): AppDataPackageSummary {
  const bytes = encryptAppDataPackage(plaintextJson, password, meta);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return packageSummary(bytes);
}

function readAppDataBackupFile(path: string, password: string): { plaintextJson: string; summary: AppDataPackageSummary } {
  const bytes = readFileSync(path);
  return {
    plaintextJson: decryptAppDataPackage(bytes, password),
    summary: packageSummary(bytes),
  };
}

function createAppDataRecoveryPoint(
  state: SmokeState,
  plaintextJson: string,
  password: string,
  meta: AppDataPackageMeta
): AppDataPackageSummary {
  const dir = join(state.appBackupsDir, "recovery-points");
  mkdirSync(dir, { recursive: true });
  return writeAppDataBackupFile(join(dir, `recovery-${Date.now()}.csbackup`), plaintextJson, password, meta);
}

async function testAppDataWebDAV(target: AppDataWebDAVTarget): Promise<void> {
  const response = await fetch(webDAVURL(target, target.rootPath), {
    method: "MKCOL",
    headers: webDAVHeaders(target),
  });
  if (![200, 201, 204, 405].includes(response.status)) {
    throw new Error(`WebDAV test failed: HTTP ${response.status} ${await response.text()}`);
  }
}

async function uploadAppDataWebDAVBackup(
  target: AppDataWebDAVTarget,
  plaintextJson: string,
  password: string,
  meta: AppDataPackageMeta
): Promise<RemoteBackup> {
  await testAppDataWebDAV(target);
  const name = `confscope-app-data-${meta.createdAt.replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}.csbackup`;
  const remotePath = remoteJoin(target.rootPath, name);
  const bytes = encryptAppDataPackage(plaintextJson, password, meta);
  const response = await fetch(webDAVURL(target, remotePath), {
    method: "PUT",
    headers: webDAVHeaders(target),
    body: bytes as unknown as BodyInit,
  });
  if (!response.ok) {
    throw new Error(`WebDAV upload failed: HTTP ${response.status} ${await response.text()}`);
  }
  return { name, path: remotePath, size: bytes.length, modifiedAt: new Date().toISOString() };
}

async function listAppDataWebDAVBackups(target: AppDataWebDAVTarget): Promise<RemoteBackup[]> {
  const response = await fetch(webDAVURL(target, target.rootPath), {
    method: "PROPFIND",
    headers: { ...webDAVHeaders(target), Depth: "1" },
  });
  if (!response.ok && response.status !== 207) {
    throw new Error(`WebDAV list failed: HTTP ${response.status} ${await response.text()}`);
  }
  const xml = await response.text();
  const backups: RemoteBackup[] = [];
  for (const block of webDAVResponseBlocks(xml)) {
    const href = webDAVTagText(block, "href");
    if (!href || href.endsWith("/") || !href.endsWith(".csbackup")) continue;
    backups.push({
      name: posix.basename(href),
      path: href,
      size: Number(webDAVTagText(block, "getcontentlength") || "0"),
      modifiedAt: webDAVTagText(block, "getlastmodified"),
    });
  }
  return backups.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

async function downloadAppDataWebDAVBackup(
  target: AppDataWebDAVTarget,
  remotePath: string,
  password: string
): Promise<{ plaintextJson: string; summary: AppDataPackageSummary }> {
  const response = await fetch(webDAVURL(target, remotePath), {
    method: "GET",
    headers: webDAVHeaders(target),
  });
  if (!response.ok) {
    throw new Error(`WebDAV download failed: HTTP ${response.status} ${await response.text()}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    plaintextJson: decryptAppDataPackage(bytes, password),
    summary: packageSummary(bytes),
  };
}

async function uploadSnapshotWebDAVPackage(
  state: SmokeState,
  target: AppDataWebDAVTarget,
  snapshotId: string,
  password: string
): Promise<RemoteConfigSnapshot> {
  await testSnapshotWebDAV(target);
  const snapshot = getSnapshot(state, snapshotId);
  const bytes = encryptConfigSnapshotPackage(snapshot, password);
  const name = `confscope-snapshot-${snapshot.id}.cssnapshot`;
  const remotePath = remoteJoin(target.rootPath, name);
  const response = await fetch(webDAVURL(target, remotePath), {
    method: "PUT",
    headers: webDAVHeaders(target),
    body: bytes as unknown as BodyInit,
  });
  if (!response.ok) {
    throw new Error(`WebDAV snapshot upload failed: HTTP ${response.status} ${await response.text()}`);
  }
  return remoteSnapshotFromSummary(name, remotePath, bytes.length, new Date().toISOString(), readConfigSnapshotPackageSummary(bytes));
}

async function testSnapshotWebDAV(target: AppDataWebDAVTarget): Promise<void> {
  for (const remotePath of collectionPaths(target.rootPath)) {
    const response = await fetch(webDAVURL(target, remotePath), {
      method: "MKCOL",
      headers: webDAVHeaders(target),
    });
    if (![200, 201, 204, 405, 409].includes(response.status)) {
      throw new Error(`WebDAV snapshot test failed: HTTP ${response.status} ${await response.text()}`);
    }
  }
}

function collectionPaths(rootPath: string): string[] {
  const normalized = normalizeRemotePath(rootPath);
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) return ["/"];
  const paths: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    paths.push(`/${segments.slice(0, i + 1).join("/")}`);
  }
  return paths;
}

async function listSnapshotWebDAVPackages(target: AppDataWebDAVTarget): Promise<RemoteConfigSnapshot[]> {
  const response = await fetch(webDAVURL(target, target.rootPath), {
    method: "PROPFIND",
    headers: { ...webDAVHeaders(target), Depth: "1" },
  });
  if (!response.ok && response.status !== 207) {
    throw new Error(`WebDAV snapshot list failed: HTTP ${response.status} ${await response.text()}`);
  }
  const xml = await response.text();
  const snapshots: RemoteConfigSnapshot[] = [];
  for (const block of webDAVResponseBlocks(xml)) {
    const href = webDAVTagText(block, "href");
    if (!href || href.endsWith("/") || !href.endsWith(".cssnapshot")) continue;
    const body = await downloadRawWebDAV(target, href);
    snapshots.push(
      remoteSnapshotFromSummary(
        posix.basename(href),
        href,
        Number(webDAVTagText(block, "getcontentlength") || body.length),
        webDAVTagText(block, "getlastmodified"),
        readConfigSnapshotPackageSummary(body)
      )
    );
  }
  return snapshots.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

async function importSnapshotWebDAVPackage(
  state: SmokeState,
  target: AppDataWebDAVTarget,
  remotePath: string,
  password: string
): Promise<Snapshot> {
  const bytes = await downloadRawWebDAV(target, remotePath);
  const snapshot = decryptConfigSnapshotPackage(bytes, password);
  const remoteSnapshotId = snapshot.id;
  const backupRoot = join(state.homeDir, ".confscope", "backups");
  mkdirSync(backupRoot, { recursive: true });
  let localId = remoteSnapshotId;
  if (existsSync(join(backupRoot, localId))) {
    localId = `snap_${Date.now()}_import`;
  }
  const imported: Snapshot = {
    ...snapshot,
    id: localId,
    path: join(backupRoot, localId),
    remoteSnapshotId,
    importedFrom: {
      type: "webdav",
      remotePath,
      importedAt: new Date().toISOString(),
    },
  };
  writeSnapshotDirectory(imported);
  return imported;
}

async function downloadRawWebDAV(target: AppDataWebDAVTarget, remotePath: string): Promise<Buffer> {
  const response = await fetch(webDAVURL(target, remotePath), {
    method: "GET",
    headers: webDAVHeaders(target),
  });
  if (!response.ok) {
    throw new Error(`WebDAV snapshot download failed: HTTP ${response.status} ${await response.text()}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function encryptConfigSnapshotPackage(snapshot: Snapshot, password: string): Buffer {
  if (!password) throw new Error("Snapshot package password is required");
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = pbkdf2Sync(password, salt, 100_000, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const payload = JSON.stringify({ metadata: snapshot });
  const encrypted = Buffer.concat([cipher.update(payload, "utf8"), cipher.final(), cipher.getAuthTag()]);
  const envelope: ConfigSnapshotEnvelope = {
    format: "confscope.config-snapshot",
    schemaVersion: 1,
    snapshot: remoteSnapshotFromSummary("", "", 0, "", {
      snapshotId: snapshot.id,
      snapshotName: snapshot.name,
      provider: snapshot.source.provider,
      connectionId: snapshot.source.connectionId,
      connectionName: snapshot.source.connectionName,
      configCount: snapshot.configs.length,
      createdAt: snapshot.createdAt,
    }),
    encryption: {
      algorithm: "AES-256-GCM",
      kdf: "pbkdf2-sha256",
      salt: salt.toString("base64"),
      nonce: nonce.toString("base64"),
    },
    ciphertext: encrypted.toString("base64"),
  };
  return Buffer.from(JSON.stringify(envelope), "utf8");
}

function decryptConfigSnapshotPackage(bytes: Buffer, password: string): Snapshot {
  const envelope = JSON.parse(bytes.toString("utf8")) as ConfigSnapshotEnvelope;
  if (envelope.format !== "confscope.config-snapshot" || envelope.schemaVersion !== 1) {
    throw new Error("Invalid config snapshot package");
  }
  const salt = Buffer.from(envelope.encryption.salt, "base64");
  const nonce = Buffer.from(envelope.encryption.nonce, "base64");
  const encrypted = Buffer.from(envelope.ciphertext, "base64");
  const ciphertext = encrypted.subarray(0, encrypted.length - 16);
  const tag = encrypted.subarray(encrypted.length - 16);
  const key = pbkdf2Sync(password, salt, 100_000, 32, "sha256");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  const payload = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")) as { metadata: Snapshot };
  return payload.metadata;
}

function readConfigSnapshotPackageSummary(bytes: Buffer): Omit<RemoteConfigSnapshot, "name" | "path" | "size" | "modifiedAt"> {
  const envelope = JSON.parse(bytes.toString("utf8")) as ConfigSnapshotEnvelope;
  if (envelope.format !== "confscope.config-snapshot" || envelope.schemaVersion !== 1) {
    throw new Error("Invalid config snapshot package");
  }
  return {
    snapshotId: envelope.snapshot.snapshotId,
    snapshotName: envelope.snapshot.snapshotName,
    provider: envelope.snapshot.provider,
    connectionId: envelope.snapshot.connectionId,
    connectionName: envelope.snapshot.connectionName,
    configCount: envelope.snapshot.configCount,
    createdAt: envelope.snapshot.createdAt,
  };
}

function remoteSnapshotFromSummary(
  name: string,
  remotePath: string,
  size: number,
  modifiedAt: string,
  summary: Omit<RemoteConfigSnapshot, "name" | "path" | "size" | "modifiedAt">
): RemoteConfigSnapshot {
  return {
    name,
    path: remotePath,
    size,
    modifiedAt,
    snapshotId: summary.snapshotId,
    snapshotName: summary.snapshotName,
    provider: summary.provider,
    connectionId: summary.connectionId,
    connectionName: summary.connectionName,
    configCount: summary.configCount,
    createdAt: summary.createdAt,
  };
}

function encryptAppDataPackage(plaintextJson: string, password: string, meta: AppDataPackageMeta): Buffer {
  if (!password) throw new Error("Backup password is required");
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = pbkdf2Sync(password, salt, 100_000, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintextJson, "utf8"), cipher.final(), cipher.getAuthTag()]);
  const envelope: EncryptedEnvelope = {
    format: "confscope.app-data-backup",
    schemaVersion: 1,
    createdAt: meta.createdAt,
    appVersion: meta.appVersion,
    sourcePlatform: meta.sourcePlatform,
    encryption: {
      algorithm: "AES-256-GCM",
      kdf: "pbkdf2-sha256",
      salt: salt.toString("base64"),
      nonce: nonce.toString("base64"),
    },
    ciphertext: encrypted.toString("base64"),
  };
  return Buffer.from(JSON.stringify(envelope), "utf8");
}

function decryptAppDataPackage(bytes: Buffer, password: string): string {
  const envelope = JSON.parse(bytes.toString("utf8")) as EncryptedEnvelope;
  const salt = Buffer.from(envelope.encryption.salt, "base64");
  const nonce = Buffer.from(envelope.encryption.nonce, "base64");
  const encrypted = Buffer.from(envelope.ciphertext, "base64");
  const ciphertext = encrypted.subarray(0, encrypted.length - 16);
  const tag = encrypted.subarray(encrypted.length - 16);
  const key = pbkdf2Sync(password, salt, 100_000, 32, "sha256");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function packageSummary(bytes: Buffer): AppDataPackageSummary {
  const envelope = JSON.parse(bytes.toString("utf8")) as EncryptedEnvelope;
  return {
    format: envelope.format,
    schemaVersion: envelope.schemaVersion,
    appVersion: envelope.appVersion,
    sourcePlatform: envelope.sourcePlatform,
    createdAt: envelope.createdAt,
    size: bytes.length,
  };
}

function webDAVHeaders(target: AppDataWebDAVTarget): Record<string, string> {
  return {
    Authorization: `Basic ${Buffer.from(`${target.username}:${target.password}`).toString("base64")}`,
  };
}

function webDAVURL(target: AppDataWebDAVTarget, remotePath: string): string {
  return new URL(remotePath.startsWith("/") ? remotePath : `/${remotePath}`, target.url).toString();
}

function remoteJoin(rootPath: string, name: string): string {
  const root = normalizeRemotePath(rootPath);
  return `${root}/${name}`.replace(/\/+/g, "/");
}

function normalizeRemotePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "/confscope";
  return trimmed.startsWith("/") ? trimmed.replace(/\/+$/g, "") : `/${trimmed.replace(/\/+$/g, "")}`;
}

const XML_TAG_PREFIX = String.raw`(?:[A-Za-z_][\w.-]*:)?`;

function webDAVResponseBlocks(xml: string): string[] {
  const pattern = new RegExp(`<${XML_TAG_PREFIX}response\\b[^>]*>([\\s\\S]*?)<\\/${XML_TAG_PREFIX}response>`, "gi");
  return [...xml.matchAll(pattern)].map((match) => match[1] ?? "");
}

function webDAVTagText(value: string, tagName: string): string {
  const pattern = new RegExp(`<${XML_TAG_PREFIX}${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${XML_TAG_PREFIX}${tagName}>`, "i");
  return decodeXmlEntities(value.match(pattern)?.[1] ?? "");
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

async function testConnection(profile: ConnectionProfile): Promise<void> {
  if (profile.provider === "local") {
    const result = validateLocalSnapshotDirectory(profile.baseUrl);
    if (!result.valid) throw new Error(result.message);
    return;
  }
  if (profile.provider === "apollo") {
    await getApolloNamespace(apolloEndpointForProfile(profile));
    return;
  }
  if (profile.provider === "consul") {
    await listConsulKV(consulEndpointForProfile(profile));
    return;
  }
  await listNacosConfigs(endpointForProfile(profile), { namespace: "", group: "DEFAULT_GROUP", dataId: "", pageNo: 1, pageSize: 1 });
}

async function listNamespaces(state: SmokeState, profile: ConnectionProfile): Promise<unknown[]> {
  if (profile.provider === "local") {
    const files = scanLocalConfigs(profile.baseUrl);
    const counts = new Map<string, number>();
    for (const file of files) counts.set(file.namespace, (counts.get(file.namespace) ?? 0) + 1);
    return [...counts.entries()].map(([id, count]) => ({ id, name: id || "public", configCount: count, kind: 0 }));
  }
  if (profile.provider === "apollo") {
    const endpoint = apolloEndpointForProfile(profile, state);
    const namespaces = await listApolloNamespaces(endpoint);
    return [
      { id: endpoint.appId, name: `${endpoint.appId} / ${endpoint.env} / ${endpoint.cluster}`, configCount: namespaces.length, kind: 0 },
    ];
  }
  if (profile.provider === "consul") {
    const endpoint = consulEndpointForProfile(profile, state);
    const datacenters = await listConsulDatacenters(endpoint);
    const values = datacenters.length > 0 ? datacenters : [endpoint.datacenter];
    return values.map((id) => ({ id, name: id, configCount: 0, kind: 0 }));
  }
  await listNacosConfigs(endpointForProfile(profile, state), { namespace: "", group: "DEFAULT_GROUP", dataId: "", pageNo: 1, pageSize: 1 });
  return [{ id: "", name: "public", configCount: 0, kind: 0 }];
}

async function listConfigs(state: SmokeState, profile: ConnectionProfile, request: ListConfigsRequest): Promise<unknown> {
  if (profile.provider === "local") {
    const files = scanLocalConfigs(profile.baseUrl).filter(
      (item) =>
        (!request.namespace || item.namespace === request.namespace) &&
        (!request.group || item.group === request.group) &&
        (!request.dataId || item.dataId.includes(request.dataId))
    );
    return {
      totalCount: files.length,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: files.map((item) => ({
        ref: refFor(profile, item),
        content: item.content,
        format: item.format,
        updateTime: item.updateTime,
      })),
    };
  }
  if (profile.provider === "apollo") {
    const endpoint = apolloEndpointForProfile(profile, state);
    const filtered = (await listApolloNamespaces(endpoint))
      .filter((namespace) => matchesApolloNamespaceFilter(namespace.namespaceName, request.dataId))
      .sort((left, right) => left.namespaceName.localeCompare(right.namespaceName));
    const pageNo = request.pageNo > 0 ? request.pageNo : 1;
    const pageSize = request.pageSize > 0 ? request.pageSize : filtered.length || 1;
    const start = Math.max(0, (pageNo - 1) * pageSize);
    const pageItems = filtered.slice(start, start + pageSize);
    return {
      totalCount: filtered.length,
      pageNumber: pageNo,
      pagesAvailable: filtered.length ? Math.ceil(filtered.length / pageSize) : 0,
      pageItems: pageItems.map((namespace) => ({
        ref: refFor(profile, { namespace: endpoint.appId, group: endpoint.cluster, dataId: namespace.namespaceName }),
        content: apolloNamespaceContent(namespace),
        format: apolloFormat(namespace),
        updateTime: apolloNamespaceUpdateTime(namespace),
      })),
    };
  }
  if (profile.provider === "consul") {
    const endpoint = consulEndpointForProfile(profile, state, { namespace: request.namespace, group: request.group, dataId: "" });
    const filtered = (await listConsulKV(endpoint, endpoint.keyPrefix))
      .filter((item) => matchesConsulKeyFilter(item.key, request.dataId))
      .sort((left, right) => left.key.localeCompare(right.key));
    const pageNo = request.pageNo > 0 ? request.pageNo : 1;
    const pageSize = request.pageSize > 0 ? request.pageSize : filtered.length || 1;
    const start = Math.max(0, (pageNo - 1) * pageSize);
    const pageItems = filtered.slice(start, start + pageSize);
    return {
      totalCount: filtered.length,
      pageNumber: pageNo,
      pagesAvailable: filtered.length ? Math.ceil(filtered.length / pageSize) : 0,
      pageItems: pageItems.map((item) => ({
        ref: refFor(profile, { namespace: endpoint.datacenter, group: endpoint.keyPrefix, dataId: item.key }),
        content: item.value,
        format: typeFromDataId(item.key),
        updateTime: consulVersion(item),
      })),
    };
  }
  const page = await listNacosConfigs(endpointForProfile(profile, state), request);
  return {
    totalCount: page.totalCount,
    pageNumber: page.pageNumber,
    pagesAvailable: page.pagesAvailable,
    pageItems: page.pageItems.map((item) => ({
      ref: refFor(profile, { namespace: request.namespace, group: item.group, dataId: item.dataId }),
      content: item.content,
      format: item.configType,
      updateTime: item.updateTime,
    })),
  };
}

async function getConfigDocument(state: SmokeState, profile: ConnectionProfile, ref: ConfigRef): Promise<unknown> {
  if (profile.provider === "local") {
    const item = scanLocalConfigs(profile.baseUrl).find(
      (file) => file.namespace === ref.namespace && file.group === ref.group && file.dataId === ref.dataId
    );
    if (!item) throw new Error(`local config not found: ${ref.group}/${ref.dataId}`);
    return {
      ref: refFor(profile, item),
      content: item.content,
      format: item.format,
      version: item.version,
      source: item.path,
      updateTime: item.updateTime,
    };
  }
  if (profile.provider === "apollo") {
    const endpoint = apolloEndpointForProfile(profile, state, ref);
    const namespace = await getApolloNamespace(endpoint);
    return {
      ref: refFor(profile, { namespace: endpoint.appId, group: endpoint.cluster, dataId: endpoint.namespaceName }),
      content: apolloNamespaceContent(namespace),
      format: apolloFormat(namespace),
      version: namespace.releaseKey ?? "",
      source: `apollo:${endpoint.env}/${endpoint.appId}/${endpoint.cluster}/${endpoint.namespaceName}`,
      updateTime: apolloNamespaceUpdateTime(namespace),
    };
  }
  if (profile.provider === "consul") {
    const endpoint = consulEndpointForProfile(profile, state, ref);
    const item = await getConsulKV(endpoint, ref.dataId);
    return {
      ref: refFor(profile, { namespace: endpoint.datacenter, group: endpoint.keyPrefix, dataId: item.key }),
      content: item.value,
      format: typeFromDataId(item.key),
      version: consulVersion(item),
      source: `consul:${endpoint.datacenter}/${item.key}`,
      updateTime: consulVersion(item),
    };
  }
  const content = await getNacosConfig(endpointForProfile(profile, state), ref);
  return { ref: refFor(profile, ref), content, format: typeFromDataId(ref.dataId), version: "", source: profile.baseUrl, updateTime: "" };
}

async function publishFromApplyPlan(state: SmokeState, profile: ConnectionProfile, request: PublishConfigRequest): Promise<void> {
  if (profile.provider === "local") throw new Error("Local snapshot sources are read-only and cannot publish configs");
  if (profile.provider === "apollo") throw new Error("Apollo provider is read-only in smoke");
  if (profile.provider === "consul") throw new Error("Consul provider is read-only in smoke");
  await publishAndWait(endpointForProfile(profile, state), {
    namespace: request.ref.namespace,
    group: request.ref.group,
    dataId: request.ref.dataId,
    content: request.content,
    type: request.format || typeFromDataId(request.ref.dataId),
  });
}

async function deleteFromApplyPlan(state: SmokeState, profile: ConnectionProfile, ref: ConfigRef): Promise<void> {
  if (profile.provider === "local") throw new Error("Local snapshot sources are read-only and cannot delete configs");
  if (profile.provider === "apollo") throw new Error("Apollo provider is read-only in smoke");
  if (profile.provider === "consul") throw new Error("Consul provider is read-only in smoke");
  await deleteNacosConfig(endpointForProfile(profile, state), ref);
}

async function publishAndWait(endpoint: SmokeNacosEndpoint, config: SmokeNacosConfig): Promise<void> {
  await publishNacosConfig(endpoint, config);
  await waitForNacosContent(endpoint, config);
}

async function listLegacyNacos(state: SmokeState, args: unknown[]): Promise<unknown> {
  const page = await listNacosConfigs(endpointForBaseUrl(state, stringArg(args, 0)), {
    namespace: stringArg(args, 3),
    dataId: stringArg(args, 4),
    group: stringArg(args, 5),
    pageNo: numberArg(args, 6),
    pageSize: numberArg(args, 7),
  });
  return page;
}

function validateLocalSnapshotDirectory(path: string): unknown {
  const checkedAt = new Date().toISOString();
  if (!path.trim()) return validation(path, checkedAt, false, "empty_path", "Local snapshot directory is required", 0);
  if (!existsSync(path)) return validation(path, checkedAt, false, "not_found", "Directory does not exist", 0);
  if (!statSync(path).isDirectory()) return validation(path, checkedAt, false, "not_directory", "Path is not a folder", 0);
  const metadataPath = join(path, "metadata.json");
  if (existsSync(metadataPath)) {
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { schemaVersion?: number; configs?: unknown[] };
      if (metadata.schemaVersion === 1 && Array.isArray(metadata.configs) && metadata.configs.length > 0) {
        return {
          valid: true,
          path,
          code: "valid",
          message: "Local snapshot directory is valid",
          configCount: metadata.configs.length,
          hasManifest: true,
          matchedMarkers: ["metadata.json", "configs/"],
          schemaVersion: 1,
          layout: "confscope-v1",
          legacy: false,
          checkedAt,
        };
      }
      return validation(path, checkedAt, false, "missing_schema_fields", "metadata.json is missing required snapshot schema fields", 0);
    } catch {
      return validation(path, checkedAt, false, "invalid_metadata", "metadata.json is not valid snapshot metadata", 0);
    }
  }
  const legacyMarker = ["manifest.json", "confscope.snapshot.json", ".metadata.yml", ".metadata.yaml"].some((name) =>
    existsSync(join(path, name))
  );
  const configCount = scanLocalConfigs(path).length;
  if (legacyMarker && configCount > 0) {
    return {
      valid: true,
      path,
      code: "legacy_valid",
      message: "Directory uses a legacy snapshot layout.",
      configCount,
      hasManifest: true,
      matchedMarkers: ["manifest.json", "configs/"],
      schemaVersion: 0,
      layout: "",
      legacy: true,
      checkedAt,
    };
  }
  return validation(
    path,
    checkedAt,
    false,
    configCount > 0 ? "missing_structure" : "missing_configs",
    "No comparable config files were found",
    configCount
  );
}

function validateSnapshotOrThrow(path: string): void {
  const result = validateLocalSnapshotDirectory(path) as { valid?: boolean; message?: string };
  if (!result.valid) throw new Error(result.message ?? "Invalid snapshot");
}

function validation(path: string, checkedAt: string, valid: boolean, code: string, message: string, configCount: number): unknown {
  return {
    valid,
    path,
    code,
    message,
    configCount,
    hasManifest: false,
    matchedMarkers: [],
    schemaVersion: 0,
    layout: "",
    legacy: false,
    checkedAt,
  };
}

function createSnapshot(state: SmokeState, source: SnapshotSource, configs: ConfigSnapshot[]): Snapshot {
  const backupRoot = join(state.homeDir, ".confscope", "backups");
  mkdirSync(backupRoot, { recursive: true });
  const id = `snap_${Date.now()}`;
  const snapshotDir = join(backupRoot, id);
  const timestamp = new Date().toISOString();
  const snapshot: Snapshot = {
    schemaVersion: 1,
    toolVersion: "confscope",
    id,
    name: `${source.connectionName}_${source.namespace || "public"}_${id}`,
    path: snapshotDir,
    createdAt: timestamp,
    updatedAt: timestamp,
    source,
    configs: configs.map((item) => ({
      ...item,
      namespace: item.namespace || source.namespace || "public",
      contentType: item.contentType || item.configType || typeFromDataId(item.dataId),
    })),
  };
  writeSnapshotDirectory(snapshot);
  return snapshot;
}

function writeSnapshotDirectory(snapshot: Snapshot): void {
  mkdirSync(snapshot.path, { recursive: true });
  writeFileSync(join(snapshot.path, "metadata.json"), JSON.stringify(snapshot, null, 2), "utf8");
  for (const config of snapshot.configs) {
    const namespace = config.namespace || "public";
    const groupDir = join(snapshot.path, "configs", namespace || "public", config.group);
    mkdirSync(groupDir, { recursive: true });
    writeFileSync(join(groupDir, ...config.dataId.split("/")), config.content, "utf8");
  }
}

function getSnapshot(state: SmokeState, id: string): Snapshot {
  const snapshotDir = join(state.homeDir, ".confscope", "backups", id);
  const snapshot = JSON.parse(readFileSync(join(snapshotDir, "metadata.json"), "utf8")) as Snapshot;
  return { ...snapshot, path: snapshotDir };
}

function listSnapshots(state: SmokeState): Snapshot[] {
  const backupRoot = join(state.homeDir, ".confscope", "backups");
  if (!existsSync(backupRoot)) return [];
  return readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.endsWith(".tmp"))
    .map((entry) => getSnapshot(state, entry.name));
}

function deleteSnapshot(state: SmokeState, id: string): void {
  rmSync(join(state.homeDir, ".confscope", "backups", id), { recursive: true, force: true });
}

interface LocalConfig {
  namespace: string;
  group: string;
  dataId: string;
  content: string;
  format: string;
  version: string;
  updateTime: string;
  path: string;
}

function scanLocalConfigs(root: string): LocalConfig[] {
  if (!existsSync(root)) return [];
  const metadata = readStrictMetadata(root);
  const out: LocalConfig[] = [];
  walk(root, (path) => {
    const name = basename(path).toLowerCase();
    if (["metadata.json", "manifest.json", "confscope.snapshot.json", ".metadata.yml", ".metadata.yaml"].includes(name)) return;
    if (!isConfigExt(extname(path))) return;
    const rel = relative(root, path).split(sep).join("/");
    const parts = rel.split("/");
    let namespace = "";
    let group = "DEFAULT_GROUP";
    let dataId = parts.join("/");
    if (parts.length >= 4 && (parts[0] === "configs" || parts[0] === "namespaces")) {
      namespace = parts[1] === "public" ? "" : parts[1];
      group = parts[2];
      dataId = parts.slice(3).join("/");
    }
    const key = `${namespace || "public"}|${group}|${dataId}`;
    const meta = metadata.configs.get(key);
    out.push({
      namespace,
      group,
      dataId,
      content: readFileSync(path, "utf8"),
      format: meta?.contentType ?? typeFromDataId(dataId),
      version: metadata.version,
      updateTime: meta?.updateTime ?? "",
      path,
    });
  });
  return out.sort((a, b) => `${a.namespace}/${a.group}/${a.dataId}`.localeCompare(`${b.namespace}/${b.group}/${b.dataId}`));
}

function readStrictMetadata(root: string): { version: string; configs: Map<string, { contentType: string; updateTime: string }> } {
  const metadataPath = join(root, "metadata.json");
  const configs = new Map<string, { contentType: string; updateTime: string }>();
  if (!existsSync(metadataPath)) return { version: "", configs };
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
    id?: string;
    configs?: Array<{
      namespace?: string;
      group?: string;
      dataId?: string;
      contentType?: string;
      configType?: string;
      updateTime?: string;
    }>;
  };
  for (const config of metadata.configs ?? []) {
    configs.set(`${config.namespace || "public"}|${config.group ?? ""}|${config.dataId ?? ""}`, {
      contentType: config.contentType || config.configType || typeFromDataId(config.dataId ?? ""),
      updateTime: config.updateTime ?? "",
    });
  }
  return { version: metadata.id ?? "", configs };
}

function walk(root: string, onFile: (path: string) => void): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walk(path, onFile);
    else onFile(path);
  }
}

function refFor(profile: ConnectionProfile, ref: Pick<ConfigRef, "namespace" | "group" | "dataId">): unknown {
  return { provider: profile.provider, connectionId: profile.id, namespace: ref.namespace, group: ref.group, dataId: ref.dataId, key: "" };
}

function endpointForProfile(profile: ConnectionProfile, state?: SmokeState): SmokeNacosEndpoint {
  if (!state) return { role: "dev", containerName: "external-nacos", hostPort: 0, baseUrl: profile.baseUrl };
  return endpointForBaseUrl(state, profile.baseUrl);
}

function endpointForBaseUrl(state: SmokeState, baseUrl: string): SmokeNacosEndpoint {
  const hit = [state.nacos.dev, state.nacos.sandbox, state.nacos.prod].find((endpoint) => endpoint.baseUrl === baseUrl);
  if (hit) return hit;
  return { role: "dev", containerName: "external-nacos", hostPort: 0, baseUrl };
}

function apolloEndpointForProfile(profile: ConnectionProfile, state?: SmokeState, ref?: ConfigRef) {
  const fallback = state?.apollo;
  return {
    containerName: fallback?.containerName ?? "external-apollo",
    hostPort: fallback?.hostPort ?? 0,
    baseUrl: profile.baseUrl || fallback?.baseUrl || "",
    token: profile.accessToken || fallback?.token || "",
    env: profile.apolloEnv || fallback?.env || "DEV",
    appId: ref?.namespace || profile.apolloAppId || fallback?.appId || "",
    cluster: ref?.group || profile.apolloCluster || fallback?.cluster || "default",
    namespaceName: ref?.dataId || profile.apolloNamespaceName || fallback?.namespaceName || "application",
  };
}

function consulEndpointForProfile(profile: ConnectionProfile, state?: SmokeState, ref?: ConfigRef): SmokeConsulEndpoint {
  const fallback = state?.consul;
  const refGroup = ref?.group?.trim();
  return {
    containerName: fallback?.containerName ?? "external-consul",
    hostPort: fallback?.hostPort ?? 0,
    baseUrl: profile.baseUrl || fallback?.baseUrl || "",
    datacenter: ref?.namespace || profile.consulDatacenter || fallback?.datacenter || "dc1",
    keyPrefix: refGroup && refGroup !== "DEFAULT_GROUP" ? refGroup : profile.consulKeyPrefix || fallback?.keyPrefix || "",
  };
}

function matchesApolloNamespaceFilter(namespaceName: string, filter: string): boolean {
  const value = filter.trim();
  if (!value) return true;
  if (value.includes("*")) {
    const needle = value.replaceAll("*", "");
    return !needle || namespaceName.includes(needle);
  }
  return namespaceName === value;
}

function matchesConsulKeyFilter(key: string, filter: string): boolean {
  const value = filter.trim();
  if (!value) return true;
  if (value.includes("*")) {
    const needle = value.replaceAll("*", "");
    return !needle || key.includes(needle);
  }
  return key.includes(value);
}

function apolloFormat(namespace: SmokeApolloNamespace): string {
  if (namespace.format?.trim()) return namespace.format.trim().toLowerCase();
  return typeFromDataId(namespace.namespaceName);
}

function consulVersion(item: SmokeConsulKV): string {
  return item.modifyIndex > 0 ? String(item.modifyIndex) : "";
}

function sourceArg(args: unknown[], index: number): SnapshotSource {
  const value = args[index] as Partial<SnapshotSource>;
  return {
    provider: String(value.provider ?? "nacos"),
    connectionId: String(value.connectionId ?? ""),
    connectionName: String(value.connectionName ?? ""),
    namespace: String(value.namespace ?? ""),
    namespaceId: String(value.namespaceId ?? ""),
  };
}

function configSnapshotsArg(args: unknown[], index: number): ConfigSnapshot[] {
  const value = args[index];
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const raw = item as Partial<ConfigSnapshot>;
    return {
      namespace: String(raw.namespace ?? ""),
      group: String(raw.group ?? "DEFAULT_GROUP"),
      dataId: String(raw.dataId ?? ""),
      content: String(raw.content ?? ""),
      configType: String(raw.configType ?? raw.contentType ?? "text"),
      contentType: String(raw.contentType ?? raw.configType ?? "text"),
      updateTime: String(raw.updateTime ?? ""),
    };
  });
}

function profileArg(args: unknown[], index: number): ConnectionProfile {
  const value = args[index] as Partial<ConnectionProfile>;
  const provider =
    value.provider === "local" ? "local" : value.provider === "apollo" ? "apollo" : value.provider === "consul" ? "consul" : "nacos";
  return {
    id: String(value.id ?? ""),
    name: String(value.name ?? ""),
    provider,
    baseUrl: String(value.baseUrl ?? ""),
    accessToken: String(value.accessToken ?? ""),
    apolloEnv: String(value.apolloEnv ?? ""),
    apolloAppId: String(value.apolloAppId ?? ""),
    apolloCluster: String(value.apolloCluster ?? ""),
    apolloNamespaceName: String(value.apolloNamespaceName ?? ""),
    consulDatacenter: String(value.consulDatacenter ?? ""),
    consulKeyPrefix: String(value.consulKeyPrefix ?? ""),
  };
}

function refArg(args: unknown[], index: number): ConfigRef {
  const value = args[index] as Partial<ConfigRef>;
  return {
    namespace: String(value.namespace ?? ""),
    group: String(value.group ?? "DEFAULT_GROUP"),
    dataId: String(value.dataId ?? ""),
    key: String(value.key ?? ""),
  };
}

function publishRequestArg(args: unknown[], index: number): PublishConfigRequest {
  const value = args[index] as Partial<PublishConfigRequest>;
  return { ref: refArg([value.ref], 0), content: String(value.content ?? ""), format: String(value.format ?? "text") };
}

function appDataPackageMetaArg(args: unknown[], index: number): AppDataPackageMeta {
  const value = args[index] as Partial<AppDataPackageMeta>;
  return {
    appVersion: String(value.appVersion ?? "1.4.1-smoke"),
    sourcePlatform: String(value.sourcePlatform ?? "windows-amd64"),
    createdAt: String(value.createdAt ?? new Date().toISOString()),
  };
}

function webDAVTargetArg(args: unknown[], index: number): AppDataWebDAVTarget {
  const value = args[index] as Partial<AppDataWebDAVTarget>;
  return {
    enabled: value.enabled !== false,
    url: String(value.url ?? ""),
    username: String(value.username ?? ""),
    password: String(value.password ?? ""),
    rootPath: normalizeRemotePath(String(value.rootPath ?? "/confscope")),
  };
}

function listRequestArg(args: unknown[], index: number): ListConfigsRequest {
  const value = args[index] as Partial<ListConfigsRequest>;
  return {
    namespace: String(value.namespace ?? ""),
    group: String(value.group ?? "DEFAULT_GROUP"),
    dataId: String(value.dataId ?? ""),
    pageNo: typeof value.pageNo === "number" ? value.pageNo : 1,
    pageSize: typeof value.pageSize === "number" ? value.pageSize : 20,
  };
}

function stringArg(args: unknown[], index: number): string {
  return String(args[index] ?? "");
}

function numberArg(args: unknown[], index: number): number {
  return typeof args[index] === "number" ? args[index] : Number(args[index] ?? 1);
}

function isConfigExt(ext: string): boolean {
  return [".json", ".yaml", ".yml", ".properties", ".xml", ".toml", ".ini", ".txt"].includes(ext.toLowerCase());
}

function typeFromDataId(dataId: string): string {
  if (dataId.endsWith(".json")) return "json";
  if (dataId.endsWith(".properties")) return "properties";
  if (dataId.endsWith(".yaml") || dataId.endsWith(".yml")) return "yaml";
  return "text";
}
