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

export interface Connection {
  id: string;
  name: string;
  /** 形如 http://localhost:8848/nacos（含 context-path）。 */
  baseUrl: string;
  username: string;
  password: string;
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
    return Array.isArray(arr) ? arr : [];
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
      const updated = { ...list[idx], ...conn, id: conn.id } as Connection;
      list[idx] = updated;
      saveAll(list);
      return updated;
    }
  }
  const created: Connection = { ...conn, id: genId() } as Connection;
  list.push(created);
  saveAll(list);
  return created;
}

export function deleteConnection(id: string) {
  saveAll(loadConnections().filter((c) => c.id !== id));
}
