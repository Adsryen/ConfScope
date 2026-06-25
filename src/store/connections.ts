// Nacos 连接的本地持久化。桌面端单机工具，连接信息（含密码）存 localStorage。

export interface Connection {
  id: string;
  name: string;
  /** 形如 http://localhost:8848/nacos（含 context-path）。 */
  baseUrl: string;
  username: string;
  password: string;
  /** 默认命名空间 id（tenant），空表示 public。 */
  defaultNamespace: string;
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
