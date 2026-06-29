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
  /** 远程端口（Nacos 服务器端口） */
  remotePort: number;
  /** 远程主机（通常是 localhost 或 127.0.0.1） */
  remoteHost: string;
}

export type ProviderType = "nacos" | "apollo" | "consul" | "local";
export type NacosDistribution = "opensource" | "aliyun-mse";
export type ConnectionAuthType = "none" | "nacos-password" | "aliyun-aksk";

export interface Connection {
  id: string;
  name: string;
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
