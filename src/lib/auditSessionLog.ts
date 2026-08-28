// 会话审计日志（JSONL）前端层：
// 每次对比/审计/应用生成一个 sessionId，过程中的每个事件：
//   1) 内存环形缓冲（供「审计日志」页实时查看，刷新即丢）
//   2) 转发给 window.__auditBridge → Go AppendAuditEvent → audit-trail.jsonl 持久化
export { AUDIT_EVENT_SCHEMA_VERSION, AUDIT_SESSION_MAX_EVENTS, appendAuditEvent } from "./auditSession";
import { appendAuditEvent } from "./auditSession";
import type { AuditEventPayload } from "./auditSession";

export type { AuditEventPayload };

export interface AuditSession {
  id: string;
  startedAt: string;
  kind: "compare" | "audit" | "apply";
  status: "running" | "success" | "failure";
  events: AuditEventPayload[];
}

type Listener = (sessions: AuditSession[]) => void;

let nextSeq = 1;
let sessions: AuditSession[] = [];
const listeners = new Set<Listener>();

function nowIso(): string {
  return new Date().toISOString();
}

function genSessionId(kind: AuditSession["kind"]): string {
  return `${kind}-${Date.now().toString(36)}${(nextSeq++).toString(36)}`;
}

function emit(): void {
  for (const listener of listeners) listener(listAuditSessions());
}

export function createAuditSession(kind: AuditSession["kind"], meta?: { appVersion?: string; platform?: string }): string {
  const id = genSessionId(kind);
  sessions.unshift({ id, startedAt: nowIso(), kind, status: "running", events: [] });
  appendAuditEvent({
    kind: "session_start",
    sessionId: id,
    scope: kind,
    appVersion: meta?.appVersion,
    platform: meta?.platform,
  });
  emit();
  return id;
}

function findSession(id: string): AuditSession | undefined {
  return sessions.find((s) => s.id === id);
}

/** 记录事件到会话缓冲并持久化；session 不存在时（如刷新后）仍会持久化。 */
export function auditSessionEvent(sessionId: string, event: Partial<AuditEventPayload>): void {
  appendAuditEvent({ ...event, sessionId });
  const session = findSession(sessionId);
  if (!session) return;
  session.events.push({
    schema: 1,
    ts: nowIso(),
    kind: "unknown",
    ...event,
    sessionId,
  });
  if (session.events.length > 2000) session.events.shift();
  if (event.kind === "compare_error" || event.kind === "apply_error") session.status = "failure";
  if (event.kind === "compare_result" || event.kind === "audit_run_result" || event.kind === "apply_result") {
    session.status = event.result === "failure" ? "failure" : "success";
  }
  emit();
}

export function endAuditSession(sessionId: string, result: "success" | "failure", error?: string): void {
  auditSessionEvent(sessionId, { kind: "session_end", result, error });
}

export function listAuditSessions(): AuditSession[] {
  return [...sessions];
}

/** 测试辅助：清空内存会话缓冲（不触碰持久化文件）。 */
export function __resetAuditSessionsForTest(): void {
  sessions = [];
}

export function onAuditSessionUpdate(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 从持久化的 JSONL 行重建会话（按 sessionId 分组）。 */
export function sessionsFromJsonlLines(lines: string[]): Map<string, AuditEventPayload[]> {
  const grouped = new Map<string, AuditEventPayload[]>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const event = parsed as AuditEventPayload;
    if (!event.sessionId || typeof event.kind !== "string") continue;
    const list = grouped.get(event.sessionId) ?? [];
    list.push(event);
    grouped.set(event.sessionId, list);
  }
  return grouped;
}
