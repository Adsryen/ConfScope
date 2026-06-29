// Nacos 连接的本地持久化。桌面端单机工具，连接信息（含密码）存 localStorage。

export interface SSHConfig {
  /** SSH 服务器地址 */
  host: string;
  /** SSH 端口，默认 22 */
  port: number;
  /** SSH 用户名 */
  username: string;
  /** 认证方式：password 或 key */
  authType: 'password' | 'key';
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
    message: string;
    configCount: number;
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
  /** SSH 隧道配置（可选） */
  sshConfig?: SSHConfig;
}

const KEY = "cs.connections";

function genId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function loadConnections(): Connection[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(normalizeConnection) : [];
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

export function deleteConnection(id: string) {
  saveAll(loadConnections().filter((c) => c.id !== id));
}

export function renameProject(oldName: string, newName: string): Connection[] {
  const from = oldName.trim() || DEFAULT_PROJECT_NAME;
  const to = newName.trim();
  const list = loadConnections();
  if (!to || from === to) return list;

  const next = list.map((conn) =>
    connectionProjectName(conn) === from ? normalizeConnection({ ...conn, projectName: to }) : conn
  );
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
    sshConfig: raw.sshConfig,
  };
}
