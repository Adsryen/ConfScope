// 审计日志页：展示会话审计 JSONL（audit-trail.jsonl）。
// 实时事件来自内存环形缓冲（auditSessionLog），持久化事件来自
// Go 绑定 ReadAuditLogLines；原生应用显示持久化文件，Web 手动桥
// 模式下 __auditBridge 缺失时只显示实时缓冲（页面说明里写明）。
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "../i18n";
import { ReadAuditLogLines } from "../../wailsjs/go/app/App";
import {
  listAuditSessions,
  onAuditSessionUpdate,
  sessionsFromJsonlLines,
  type AuditEventPayload,
  type AuditSession,
} from "../lib/auditSessionLog";
import CopyButton from "./CopyButton";

function eventTime(event: AuditEventPayload): number {
  const t = Date.parse(event.ts);
  return Number.isFinite(t) ? t : 0;
}

interface PersistentSession {
  id: string;
  kind: string;
  startedAt: string;
  status: "running" | "success" | "failure";
  events: AuditEventPayload[];
}

function buildPersistentSessions(grouped: Map<string, AuditEventPayload[]>): PersistentSession[] {
  const sessions: PersistentSession[] = [];
  for (const [id, events] of grouped) {
    events.sort((a, b) => eventTime(a) - eventTime(b));
    const first = events[0];
    const last = events[events.length - 1];
    const kind = (first?.scope as string) || (first?.kind as string) || "unknown";
    let status: PersistentSession["status"] = "running";
    if (last?.kind === "session_end") status = last.result === "failure" ? "failure" : "success";
    else if (events.some((e) => e.kind === "compare_error" || e.kind === "apply_error")) status = "failure";
    else if (events.some((e) => e.kind === "compare_result" || e.kind === "audit_run_result" || e.kind === "apply_result")) status = "success";
    sessions.push({ id, kind, startedAt: first?.ts ?? "", status, events });
  }
  return sessions.sort((a, b) => eventTime(b.events[0]) - eventTime(a.events[0]));
}

export default function LogViewer() {
  const { t } = useTranslation();
  const [liveSessions, setLiveSessions] = useState<AuditSession[]>(listAuditSessions());
  const [persistentSessions, setPersistentSessions] = useState<PersistentSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterKind, setFilterKind] = useState<string>("");
  const [showContent, setShowContent] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const lines = await ReadAuditLogLines(20000);
      setPersistentSessions(buildPersistentSessions(sessionsFromJsonlLines(lines)));
    } catch (e) {
      // Web 手动桥模式下没有持久化日志；只显示实时缓冲
      console.warn("审计日志持久化不可用（Web 手动桥模式）", e);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return onAuditSessionUpdate((sessions) => setLiveSessions(sessions));
  }, [refresh]);

  const sessions = useMemo(() => {
    const byId = new Map<string, PersistentSession | AuditSession>();
    for (const s of persistentSessions) byId.set(s.id, s);
    for (const s of liveSessions) {
      const existing = byId.get(s.id);
      if (existing) {
        // 合并：持久化行 + 实时新增（去重按 kind+ts）
        const seen = new Set(existing.events.map((e) => `${e.kind}|${e.ts}`));
        const merged = [...existing.events, ...s.events.filter((e) => !seen.has(`${e.kind}|${e.ts}`))];
        merged.sort((a, b) => eventTime(a) - eventTime(b));
        (existing as PersistentSession).events = merged;
        (existing as PersistentSession).status = s.status;
      } else {
        byId.set(s.id, s);
      }
    }
    const all = [...byId.values()].sort((a, b) => {
      const at = a.events[0] ? eventTime(a.events[0]) : 0;
      const bt = b.events[0] ? eventTime(b.events[0]) : 0;
      return bt - at;
    });
    if (!filterKind) return all;
    return all.filter((s) => s.kind === filterKind);
  }, [persistentSessions, liveSessions, filterKind]);

  const selected = sessions.find((s) => s.id === selectedId) ?? sessions[0] ?? null;
  const kinds = useMemo(() => [...new Set(sessions.map((s) => s.kind))].sort(), [sessions]);
  const selectedJson = selected ? selected.events.map((e) => JSON.stringify(e)).join("\n") : "";

  const kindLabel = (kind: string) => t(`logViewer.kind${kind.charAt(0).toUpperCase()}${kind.slice(1)}`) as string;
  const statusLabel = (s: string) => (s === "success" ? t("logViewer.statusSuccess") : s === "failure" ? t("logViewer.statusFailure") : t("logViewer.statusRunning"));
  const statusClass = (s: string) => (s === "failure" ? "danger" : s === "success" ? "success" : "running");

  return (
    <div className="page-surface data-page log-viewer">
      <div className="page-header">
        <div>
          <h3>{t("app.logViewer")}</h3>
          <div className="page-subtitle">{t("logViewer.subtitle")}</div>
        </div>
        <div className="page-actions data-summary">
          <span className="data-pill">{sessions.length}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setFilterKind("")}>{t("logViewer.allKinds")}</button>
          {kinds.map((k) => (
            <button key={k} className={`btn btn-sm${filterKind === k ? " btn-primary" : " btn-ghost"}`} onClick={() => setFilterKind(filterKind === k ? "" : k)}>
              {kindLabel(k)}
            </button>
          ))}
          <label className="log-toggle">
            <input type="checkbox" checked={showContent} onChange={(e) => setShowContent(e.target.checked)} />
            {t("logViewer.showContent")}
          </label>
          <button className="btn btn-ghost btn-sm" onClick={() => void refresh()}>{t("logViewer.refresh")}</button>
        </div>
      </div>

      <div className="data-split">
        <div className="data-list">
          {sessions.length === 0 && <div className="data-empty-state"><div>{t("logViewer.empty")}</div><span>{t("logViewer.emptyHint")}</span></div>}
          {sessions.map((s) => (
            <div key={s.id} className={`data-list-item${selected?.id === s.id ? " active" : ""}`} onClick={() => setSelectedId(s.id)}>
              <span className={`data-item-accent ${statusClass(s.status)}`} />
              <div className="task-item-header">
                <span className={`task-status ${statusClass(s.status)}`}>{statusLabel(s.status)}</span>
                <span className="task-type">{kindLabel(s.kind)}</span>
              </div>
              <div className="task-item-name">{s.id}</div>
              <div className="task-item-scope">
                {s.events.length} {t("logViewer.eventCountUnit")} · {new Date(s.events[0]?.ts ?? s.startedAt).toLocaleTimeString()}
              </div>
            </div>
          ))}
        </div>

        <div className="data-detail log-detail">
          {!selected ? (
            <div className="data-empty-state">{t("logViewer.empty")}</div>
          ) : (
            <>
              <div className="log-detail-header">
                <div className="log-detail-meta">
                  <span className="task-type">{kindLabel(selected.kind)}</span>
                  <span className="task-item-name">{selected.id}</span>
                  <span className="task-item-scope">
                    {new Date(selected.events[0]?.ts ?? selected.startedAt).toLocaleString()}
                  </span>
                </div>
                <CopyButton text={selectedJson} label={t("common.copy")} />
              </div>
              <pre className="log-jsonl">{selected.events.map((e) => JSON.stringify(e)).join("\n")}</pre>
              <div className="log-detail-expanded">
                {selected.events
                  .filter((e) => showContent || !e.item || (e.item.sourceValue === undefined && e.item.targetValue === undefined && e.item.afterValue === undefined))
                  .map((e, index) => (
                    <details key={index} className="log-event">
                      <summary>
                        <span className={`log-event-kind ${e.result === "failure" ? "danger" : ""}`}>{e.kind}</span>
                        <span className="log-event-ts">{new Date(e.ts).toLocaleTimeString()}</span>
                        {e.dataId ? <span className="log-event-loc">{e.group ? `${e.group}/` : ""}{e.dataId}</span> : null}
                        {e.direction ? <span className="log-event-dir">{e.direction}</span> : null}
                        {e.error ? <span className="danger">{e.error}</span> : null}
                      </summary>
                      <pre className="log-event-payload">{JSON.stringify(e, null, 2)}</pre>
                    </details>
                  ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
