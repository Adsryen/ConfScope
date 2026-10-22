import type { SSHConfig } from "./connections";
import { type Connection, loadConnections } from "./connections";
import { connectionLabel } from "../lib/defaultNameCopy";
import { SSH_DEFAULT_PORT } from "../lib/ports";

export interface SSHProfile {
  id: string;
  name: string;
  config: SSHConfig;
  createdAt: string;
  updatedAt: string;
}

const KEY = "cs.sshProfiles";

function genId(): string {
  return `ssh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function sshProfileLabel(profile: Pick<SSHProfile, "name" | "config">): string {
  const name = profile.name?.trim() || `${profile.config.username}@${profile.config.host}`;
  return `${name} (${profile.config.username}@${profile.config.host}:${profile.config.port || 22})`;
}

export function normalizeSSHConfig(raw?: Partial<SSHConfig>): SSHConfig {
  return {
    host: raw?.host?.trim() || "",
    // 只有「没填」才回落到默认端口；0 之类非法值原样留着，交给表单报错（R24），
    // 否则 `|| SSH_DEFAULT_PORT` 会把用户明确敲下的非法值静默夹成一个合法端口。
    port: Number.isFinite(raw?.port) ? (raw!.port as number) : SSH_DEFAULT_PORT,
    username: raw?.username?.trim() || "root",
    authType: raw?.authType ?? "password",
    password: raw?.password,
    privateKey: raw?.privateKey,
    passphrase: raw?.passphrase,
    localPort: raw?.localPort,
  };
}

function normalizeProfile(raw: Partial<SSHProfile> & { id?: string }): SSHProfile {
  const createdAt = raw.createdAt || nowIso();
  const config = normalizeSSHConfig(raw.config);
  return {
    id: raw.id ?? genId(),
    name: raw.name?.trim() || `${config.username}@${config.host || "ssh"}`,
    config,
    createdAt,
    updatedAt: raw.updatedAt || createdAt,
  };
}

function normalizeStoredProfile(value: unknown): SSHProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return normalizeProfile(value as Partial<SSHProfile> & { id?: string });
}

export function loadSSHProfiles(): SSHProfile[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? arr.map(normalizeStoredProfile).filter((profile): profile is SSHProfile => profile !== null)
      : [];
  } catch {
    return [];
  }
}

function saveAll(list: SSHProfile[]) {
  localStorage.setItem(KEY, JSON.stringify(list));
}

export function upsertSSHProfile(profile: Omit<SSHProfile, "id" | "createdAt" | "updatedAt"> & Partial<Pick<SSHProfile, "id" | "createdAt" | "updatedAt">>): SSHProfile {
  const list = loadSSHProfiles();
  const timestamp = nowIso();
  if (profile.id) {
    const idx = list.findIndex((item) => item.id === profile.id);
    if (idx >= 0) {
      const updated = normalizeProfile({
        ...list[idx],
        ...profile,
        id: profile.id,
        createdAt: list[idx].createdAt,
        updatedAt: timestamp,
      });
      list[idx] = updated;
      saveAll(list);
      return updated;
    }
  }

  const created = normalizeProfile({
    ...profile,
    id: profile.id ?? genId(),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  list.push(created);
  saveAll(list);
  return created;
}

export function deleteSSHProfile(id: string): SSHProfile[] {
  const next = loadSSHProfiles().filter((profile) => profile.id !== id);
  saveAll(next);
  return next;
}

export function countSSHProfileReferences(id: string): number {
  return loadConnections().filter((conn) => conn.sshProfileId === id).length;
}

/**
 * 引用该隧道的连接清单（删除/改动前的拦截面板要展示）。
 * 传入 t 才会把内置默认名翻成当前语言；不传就只给机器名（conn.id 之外仍可能露中文哨兵，
 * 所以调用方一律传 t —— 守卫 tests/ux/defaultSentinelsMustNotReachRenderUntranslated 盯着展示位）。
 */
export function listSSHProfileReferences(id: string, t: (key: string) => string): string[] {
  return loadConnections()
    .filter((conn) => conn.sshProfileId === id)
    .map((conn: Connection) => connectionLabel(conn, t));
}

export function getSSHProfile(id?: string): SSHProfile | undefined {
  if (!id) return undefined;
  return loadSSHProfiles().find((profile) => profile.id === id);
}

export function connectionSSHConfig(conn: { sshProfileId?: string; sshConfig?: SSHConfig }): SSHConfig | undefined {
  return getSSHProfile(conn.sshProfileId)?.config ?? conn.sshConfig;
}
