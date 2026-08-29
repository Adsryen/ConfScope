// Nacos 连接的本地持久化。桌面端单机工具，连接信息（含密码）存 localStorage。

import type { ConnectionSecretField, StoredSecretPointer } from "../lib/credentialSecrets";

export interface SSHConfig {
  /** SSH 服务器地址 */
  host: string;
  /** SSH 端口，默认 22 */
  port: number;
  /** SSH 用户名 */
  username: string;
  /** 认证方式：password 或 key */
  authType: "password" | "key";
  /** SSH 密码（password 认证时使用） */
  password?: string;
  /** SSH 私钥内容（key 认证时使用） */
  privateKey?: string;
  /** 私钥密码（如果有） */
  passphrase?: string;
  /** 本地端口（可选，默认自动分配） */
  localPort?: number;
  /** @deprecated 从连接 baseUrl 自动推导，仅保留用于兼容旧本地数据。 */
  remotePort?: number;
  /** @deprecated 从连接 baseUrl 自动推导，仅保留用于兼容旧本地数据。 */
  remoteHost?: string;
}

export type ProviderType = "nacos" | "apollo" | "consul" | "local";
export type NacosDistribution = "opensource" | "aliyun-mse";
export type ConnectionAuthType = "none" | "nacos-password" | "aliyun-aksk";
export type ConfigSourceType = "nacos" | "local-snapshot";

export const DEFAULT_PROJECT_NAME = "默认项目";
export const DEFAULT_ENVIRONMENT_NAME = "未分组";

export interface Connection {
  id: string;
  name: string;
  projectId?: string;
  projectName?: string;
  environmentId?: string;
  environmentName?: string;
  sourceName?: string;
  sourceType?: ConfigSourceType;
  localPath?: string;
  forceLocalSnapshot?: boolean;
  localValidation?: {
    valid: boolean;
    code?: string;
    message: string;
    configCount: number;
    schemaVersion?: number;
    layout?: string;
    legacy?: boolean;
    checkedAt: string;
  };
  readonly?: boolean;
  isDefaultSource?: boolean;
  tags?: string[];
  provider?: ProviderType;
  distribution?: NacosDistribution;
  authType?: ConnectionAuthType;
  /** 形如 http://localhost:8848/nacos（含 context-path）。 */
  baseUrl: string;
  username: string;
  password: string;
  accessKeyId?: string;
  accessKeySecret?: string;
  securityToken?: string;
  /** 默认命名空间 id（tenant），空表示 public。 */
  defaultNamespace: string;
  /** 默认 group。空或 DEFAULT_GROUP 表示默认组；设置后浏览/对比/新建/审计默认使用它。 */
  defaultGroup?: string;
  /** SSH 隧道配置（可选） */
  sshConfig?: SSHConfig;
  /** 全局 SSH 隧道配置档案引用；优先于 sshConfig。 */
  sshProfileId?: string;
  /** 是否通过系统代理连接 Nacos（默认关闭）。 */
  useProxy?: boolean;
  /** Apollo OpenAPI 环境，例如 DEV/FAT/UAT/PRO。 */
  apolloEnv?: string;
  /** Apollo App ID，同时作为现有浏览/Diff/Audit 第一维 namespace 的默认值。 */
  apolloAppId?: string;
  /** Apollo 集群名称，默认 default。 */
  apolloCluster?: string;
  /** Apollo Namespace 名称，例如 application。 */
  apolloNamespaceName?: string;
  /** Apollo OpenAPI token。 */
  apolloToken?: string;
  /** Consul HTTP API token，可为空。 */
  consulToken?: string;
  /** Consul datacenter，例如 dc1。 */
  consulDatacenter?: string;
  /** Consul KV key prefix，用于限定浏览范围。 */
  consulKeyPrefix?: string;
  /** 已迁移到系统凭据库的小凭据指针；SSH auth family 暂不迁移。 */
  secretRefs?: Partial<Record<ConnectionSecretField, StoredSecretPointer>>;
}

const KEY = "cs.connections";
let idSeq = 0;
const CONNECTION_SECRET_FIELDS: ConnectionSecretField[] = [
  "password",
  "accessKeyId",
  "accessKeySecret",
  "securityToken",
  "apolloToken",
  "consulToken",
];

function genId(): string {
  idSeq = (idSeq + 1) % 1000000;
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}_${idSeq.toString(36)}`;
}

export function loadConnections(): Connection[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(normalizeStoredConnection).filter((conn): conn is Connection => conn !== null) : [];
  } catch {
    return [];
  }
}

function saveAll(list: Connection[]) {
  localStorage.setItem(KEY, JSON.stringify(list));
}

export function upsertConnection(conn: Omit<Connection, "id"> & { id?: string }): Connection {
  const list = loadConnections();
  if (conn.id) {
    const idx = list.findIndex((c) => c.id === conn.id);
    if (idx >= 0) {
      const updated = normalizeConnection({ ...list[idx], ...conn, id: conn.id });
      list[idx] = updated;
      saveAll(list);
      return updated;
    }
  }
  const created = normalizeConnection({ ...conn, id: genId() });
  list.push(created);
  saveAll(list);
  return created;
}

export function updateConnection(id: string, patch: Partial<Omit<Connection, "id">>): Connection[] {
  const list = loadConnections();
  const idx = list.findIndex((c) => c.id === id);
  if (idx < 0) return list;
  list[idx] = normalizeConnection({ ...list[idx], ...patch, id });
  saveAll(list);
  return list;
}

export function deleteConnection(id: string) {
  saveAll(loadConnections().filter((c) => c.id !== id));
}

export function renameProject(oldName: string, newName: string): Connection[] {
  const from = oldName.trim() || DEFAULT_PROJECT_NAME;
  const to = newName.trim();
  const list = loadConnections();
  if (!to || from === to) return list;

  const next = list.map((conn) => (connectionProjectName(conn) === from ? normalizeConnection({ ...conn, projectName: to }) : conn));
  saveAll(next);
  return next;
}

export function renameEnvironment(projectName: string, oldName: string, newName: string): Connection[] {
  const project = projectName.trim() || DEFAULT_PROJECT_NAME;
  const from = oldName.trim() || DEFAULT_ENVIRONMENT_NAME;
  const to = newName.trim();
  const list = loadConnections();
  if (!to || from === to) return list;

  const next = list.map((conn) =>
    connectionProjectName(conn) === project && connectionEnvironmentName(conn) === from
      ? normalizeConnection({ ...conn, environmentName: to })
      : conn
  );
  saveAll(next);
  return next;
}

export function connectionProjectName(conn: Pick<Connection, "projectName">): string {
  return conn.projectName?.trim() || DEFAULT_PROJECT_NAME;
}

export function connectionEnvironmentName(conn: Pick<Connection, "environmentName">): string {
  return conn.environmentName?.trim() || DEFAULT_ENVIRONMENT_NAME;
}

export function connectionSourceName(conn: Pick<Connection, "sourceName" | "name">): string {
  return conn.sourceName?.trim() || conn.name?.trim() || "默认来源";
}

export function connectionDisplayLabel(conn: Connection): string {
  return `${connectionProjectName(conn)} / ${connectionEnvironmentName(conn)} / ${connectionSourceName(conn)}`;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeStoredConnection(value: unknown): Connection | null {
  if (!isObjectRecord(value)) return null;
  const conn = normalizeConnection(value);
  // 安全存储迁移会重写 cs.connections（只回写 secretRefs + 已解引用字段）。
  // 历史版本的回写清单漏了 defaultGroup，导致持久化连接丢失默认 group、
  // group 筛选/下拉回退成"全部分组"。这里按字段白名单合并原始记录，
  // 确保新增字段不会被迁移流程静默丢弃。
  // 注意：secretRefs 是对象字段，由 normalizeConnectionSecretRefs 规范化
  // （空对象→undefined），不能参与标量回填，否则会把规范化后的 undefined
  // 覆盖回原始空对象，破坏"无效引用应丢弃"的既有语义。
  const knownFields = [
    "id", "name", "projectId", "projectName", "environmentId", "environmentName",
    "sourceName", "sourceType", "localPath", "forceLocalSnapshot", "localValidation",
    "readonly", "isDefaultSource", "tags", "provider", "distribution", "authType",
    "baseUrl", "username", "password", "accessKeyId", "accessKeySecret", "securityToken",
    "defaultNamespace", "defaultGroup", "sshConfig", "sshProfileId", "useProxy",
    "apolloEnv", "apolloAppId", "apolloCluster", "apolloNamespaceName", "apolloToken",
    "consulToken", "consulDatacenter", "consulKeyPrefix",
  ] as const;
  const target = conn as unknown as Record<string, unknown>;
  for (const field of knownFields) {
    const rawValue = value[field];
    if (rawValue !== undefined && target[field] === undefined) {
      target[field] = rawValue;
    }
  }
  // 清理回填产生的 undefined 槽位，保持序列化形态与 normalizeConnection 一致
  for (const key of Object.keys(target)) {
    if (target[key] === undefined) delete target[key];
  }
  return conn;
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
  if (namespace !== "connection") return undefined;
  return {
    ref,
    namespace: namespace as StoredSecretPointer["namespace"],
    ownerId,
    field,
    migratedAt,
    status,
  };
}

function normalizeConnectionSecretRefs(value: unknown): Partial<Record<ConnectionSecretField, StoredSecretPointer>> | undefined {
  if (!isObjectRecord(value)) return undefined;
  const refs: Partial<Record<ConnectionSecretField, StoredSecretPointer>> = {};
  for (const field of CONNECTION_SECRET_FIELDS) {
    const pointer = normalizeSecretPointer(value[field]);
    if (pointer) refs[field] = pointer;
  }
  return Object.keys(refs).length > 0 ? refs : undefined;
}

function normalizeConnection(raw: Partial<Connection> & { id?: string }): Connection {
  const provider = raw.provider ?? "nacos";
  const distribution = raw.distribution ?? "opensource";
  let authType = raw.authType;
  if (!authType) {
    authType = raw.username ? "nacos-password" : "none";
  }
  return {
    id: raw.id ?? genId(),
    name: raw.name ?? "",
    projectId: raw.projectId ?? "",
    projectName: raw.projectName?.trim() || DEFAULT_PROJECT_NAME,
    environmentId: raw.environmentId ?? "",
    environmentName: raw.environmentName?.trim() || DEFAULT_ENVIRONMENT_NAME,
    sourceName: raw.sourceName?.trim() || raw.name || "",
    sourceType: raw.sourceType ?? "nacos",
    localPath: raw.localPath?.trim() || "",
    forceLocalSnapshot: raw.forceLocalSnapshot ?? false,
    localValidation: raw.localValidation,
    readonly: raw.readonly ?? false,
    isDefaultSource: raw.isDefaultSource ?? false,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    provider,
    distribution,
    authType,
    baseUrl: raw.baseUrl ?? "",
    username: raw.username ?? "",
    password: raw.password ?? "",
    accessKeyId: raw.accessKeyId,
    accessKeySecret: raw.accessKeySecret,
    securityToken: raw.securityToken,
    defaultNamespace: raw.defaultNamespace ?? "",
    defaultGroup: raw.defaultGroup,
    sshConfig: raw.sshConfig,
    sshProfileId: raw.sshProfileId ?? "",
    useProxy: raw.useProxy ?? false,
    apolloEnv: raw.apolloEnv?.trim() || "",
    apolloAppId: raw.apolloAppId?.trim() || "",
    apolloCluster: raw.apolloCluster?.trim() || "",
    apolloNamespaceName: raw.apolloNamespaceName?.trim() || "",
    apolloToken: raw.apolloToken ?? "",
    consulToken: raw.consulToken ?? "",
    consulDatacenter: raw.consulDatacenter?.trim() || "",
    consulKeyPrefix: raw.consulKeyPrefix?.trim() || "",
    secretRefs: normalizeConnectionSecretRefs(raw.secretRefs),
  };
}
