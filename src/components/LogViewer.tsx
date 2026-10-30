// 审计日志页：展示会话审计 JSONL（audit-trail.jsonl）。
// 实时事件来自内存环形缓冲（auditSessionLog），持久化事件来自
// Go 绑定 ReadAuditLogLines；原生应用显示持久化文件，Web 手动桥
// 模式下 __auditBridge 缺失时只显示实时缓冲（页面说明里写明）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../i18n";
import { ReadAuditLogLines } from "../../wailsjs/go/app/App";
import { clickableRowProps } from "../lib/clickableRow";
import { formatClock, formatDateTime, formatElapsed, formatListTime } from "../lib/formatDateTime";
import {
  listAuditSessions,
  onAuditSessionUpdate,
  sessionsFromJsonlLines,
  type AuditEventPayload,
  type AuditSession,
} from "../lib/auditSessionLog";
import { useRememberedState } from "../lib/viewState";
import { useScrollResetOnContentChange, useScrollResetRef } from "../lib/useScrollResetOnContentChange";
import BusyLabel from "./BusyLabel";
import CopyButton from "./CopyButton";

function eventTime(event: AuditEventPayload): number {
  const t = Date.parse(event.ts);
  return Number.isFinite(t) ? t : 0;
}

// 与 lib/auditSessionLog 的 AuditSession["kind"] 对应；新增档时记得同时补 locales 里的 logViewer.kind*
const KNOWN_LOG_KINDS = new Set(["compare", "audit", "apply"]);

interface PersistentSession {
  id: string;
  kind: string;
  startedAt: string;
  status: "running" | "success" | "failure";
  events: AuditEventPayload[];
}

type LogSession = PersistentSession | AuditSession;

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

/**
 * 单条事件的人可读定位（轮142 B1）。
 *
 * 会话 id 是一串 `compare-mrx3k1a_1`，列表行原来只印它：八行日志看下来等于没看。
 * 定位优先取「哪条配置」——dataId 散在四个字段位上（事件本身、item、source、target），
 * 因为对比 / 审计 / 应用三种会话各自写在不同处；都没有就退回 planId / taskId。
 */
function eventLocator(event: AuditEventPayload): string {
  const dataId = event.dataId ?? event.item?.dataId ?? event.source?.dataId ?? event.target?.dataId ?? "";
  if (!dataId) return event.planId ?? event.taskId ?? "";
  const group = event.group ?? event.item?.group ?? event.source?.group ?? event.target?.group ?? "";
  return group ? `${group}/${dataId}` : dataId;
}

/** 会话摘要：第一条能定位到配置的事件；对比会话退到「左源 → 右源」；再退到会话 id。 */
function sessionHeadline(events: AuditEventPayload[], fallback: string): string {
  for (const event of events) {
    const locator = eventLocator(event);
    if (locator) return locator;
  }
  const withSides = events.find((event) => event.left && event.right);
  if (withSides) return `${withSides.left} → ${withSides.right}`;
  return fallback;
}

/**
 * 差异计数：`+2 −1 ~3`，只写非零档；没有这几个字段或全是 0 时返回空串（调用方决定怎么说「无差异」）。
 *
 * 减号用 U+2212 不用 ASCII `-`：ASCII 那个在等宽字体里比加号窄一格，`+2 -1` 读起来像「负一度」。
 */
function diffMetric(events: AuditEventPayload[]): string {
  let additions = 0;
  let deletions = 0;
  let changed = 0;
  let seen = false;
  for (const event of events) {
    if (event.additions === undefined && event.deletions === undefined && event.changedKeys === undefined) continue;
    seen = true;
    additions += event.additions ?? 0;
    deletions += event.deletions ?? 0;
    changed += event.changedKeys ?? 0;
  }
  if (!seen || additions + deletions + changed === 0) return "";
  const parts: string[] = [];
  if (additions) parts.push(`+${additions}`);
  if (deletions) parts.push(`\u2212${deletions}`);
  if (changed) parts.push(`~${changed}`);
  return parts.join(" ");
}

/** 审计会话扫了几个环境 / 应用会话动了几项：都没有就返回 0，调用方决定不印。 */
function auditEnvCount(events: AuditEventPayload[]): number {
  return events.find((event) => event.kind === "audit_run_start")?.selectedCount ?? 0;
}

function applyItemCount(events: AuditEventPayload[]): number {
  const total = events.find((event) => event.kind === "apply_session_start")?.summary?.total;
  if (typeof total === "number" && total > 0) return total;
  return events.reduce((acc, event) => acc + (event.kind === "apply_item_result" ? 1 : 0), 0);
}

/** 事件行左侧色条：失败红、成功绿、其余不上色（轮142 B2）。类名写全，别拼——拼出来的类 deadCss 认不出。 */
function eventToneClass(event: AuditEventPayload): string {
  if (event.result === "failure" || event.error) return "log-event-tone-error";
  if (event.result === "success") return "log-event-tone-ok";
  return "log-event-tone-plain";
}

/** 会话从第一条到最后一条的耗时（毫秒）。空事件流给 0，交给 formatElapsed 说「—」。 */
function sessionElapsedMs(events: AuditEventPayload[]): number {
  if (events.length === 0) return 0;
  return eventTime(events[events.length - 1]) - eventTime(events[0]);
}

export default function LogViewer() {
  const { t } = useTranslation();
  const [liveSessions, setLiveSessions] = useState<AuditSession[]>(listAuditSessions());
  const [persistentSessions, setPersistentSessions] = useState<PersistentSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterKind, setFilterKind] = useState<string>("");
  // 开关跨页签保活（值只存在 lib/viewState 那一份里）：从审计页翻回来不该又变回脱敏态。
  const [showContent, setShowContent] = useRememberedState<boolean>("log.showContent", true);
  const [refreshing, setRefreshing] = useState(false);
  const [persistAvailable, setPersistAvailable] = useState(true);
  // 展开态受控：以前由 DOM 自己记着，切会话时 `<details>` 节点被复用，
  // 上一份日志展开的行会串到这一份的同一位置（轮6 R46 的另一半）。
  const [openEvents, setOpenEvents] = useState<Set<number>>(new Set());

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const lines = await ReadAuditLogLines(20000);
      setPersistentSessions(buildPersistentSessions(sessionsFromJsonlLines(lines)));
      setPersistAvailable(true);
    } catch (e) {
      // Web 手动桥模式下没有持久化日志；只显示实时缓冲
      setPersistAvailable(false);
      console.warn("审计日志持久化不可用（Web 手动桥模式）", e);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return onAuditSessionUpdate((sessions) => setLiveSessions(sessions));
  }, [refresh]);

  const allSessions = useMemo(() => {
    const byId = new Map<string, LogSession>();
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
    return [...byId.values()].sort((a, b) => {
      const at = a.events[0] ? eventTime(a.events[0]) : 0;
      const bt = b.events[0] ? eventTime(b.events[0]) : 0;
      return bt - at;
    });
  }, [persistentSessions, liveSessions]);

  const sessions = useMemo(() => (filterKind ? allSessions.filter((s) => s.kind === filterKind) : allSessions), [allSessions, filterKind]);
  const selected = sessions.find((s) => s.id === selectedId) ?? sessions[0] ?? null;
  // 计数从**未过滤**的会话派生：以前 kinds 取自已过滤列表，选中一种类型后其余按钮就消失了。
  const kindStats = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of allSessions) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [allSessions]);
  const selectedJson = selected ? selected.events.map((e) => JSON.stringify(e)).join("\n") : "";
  // 原文块与事件载荷块都复用节点：切会话时不归零就会停在上一份日志的偏移处（轮13 波29 / R49）。
  const jsonlRef = useRef<HTMLPreElement>(null);
  useScrollResetOnContentChange(jsonlRef, [selected?.id ?? "", selectedJson]);
  const resetRef = useScrollResetRef([selected?.id ?? ""]);

  useEffect(() => {
    setOpenEvents(new Set());
  }, [selected?.id]);

  // scope 来自持久化 JSONL，历史日志里可能出现这里没见过的值；
  // 以前直接拼 key，碰上缺条目就把 "logViewer.kindUnknown" 这种原始键名印到按钮上（轮6 R47）。
  // 现在只认已知三档，其余原样显示 scope 本身——日志页里看到真值比看到猜测的译文有用。
  const kindLabel = (kind: string) => {
    if (!KNOWN_LOG_KINDS.has(kind)) return kind;
    return t(`logViewer.kind${kind.charAt(0).toUpperCase()}${kind.slice(1)}`);
  };
  const statusLabel = (s: string) => (s === "success" ? t("logViewer.statusSuccess") : s === "failure" ? t("logViewer.statusFailure") : t("logViewer.statusRunning"));
  // 色条沿用 data-item-accent 那一组（danger / success / running 三条都在）；
  // 徽章却是另一套字面量 task-status-*：原来这里发的是 "task-status success"，
  // CSS 里根本没有 `.task-status.success`，成功 / 失败 / 进行中三档全是裸的（轮142 B1 实测）。
  const statusClass = (s: string) => (s === "failure" ? "danger" : s === "success" ? "success" : "running");
  const chipClass = (s: string) => (s === "failure" ? "task-status-failed" : s === "success" ? "task-status-success" : "task-status-running");

  /** 会话度量：三档会话各说各的「这次动了多少东西」。要 t()，所以留在组件里。 */
  const sessionMetricText = (s: LogSession): string => {
    if (s.kind === "audit") {
      const count = auditEnvCount(s.events);
      return count > 0 ? t("logViewer.metricEnv", { count }) : "";
    }
    if (s.kind === "apply") {
      const count = applyItemCount(s.events);
      return count > 0 ? t("logViewer.metricItems", { count }) : "";
    }
    const diff = diffMetric(s.events);
    if (diff) return diff;
    return s.events.some((e) => e.kind === "compare_result") ? t("logViewer.noDiff") : "";
  };

  const expandAll = (count: number) => setOpenEvents(new Set(Array.from({ length: count }, (_unused, index) => index)));

  return (
    <div className="page-surface data-page log-viewer">
      <div className="page-header">
        <div>
          <h3>{t("app.logViewer")}</h3>
          <div className="page-subtitle">{t("logViewer.subtitle")}</div>
        </div>
        <div className="page-actions data-summary">
          <span className="data-pill">{sessions.length}</span>
          <button className={`btn btn-sm${filterKind === "" ? " btn-primary" : " btn-ghost"}`} aria-pressed={filterKind === ""} onClick={() => setFilterKind("")}>
            {t("logViewer.allKinds")} {allSessions.length}
          </button>
          {kindStats.map(([kind, count]) => (
            <button
              key={kind}
              className={`btn btn-sm${filterKind === kind ? " btn-primary" : " btn-ghost"}`}
              aria-pressed={filterKind === kind}
              onClick={() => setFilterKind(filterKind === kind ? "" : kind)}
            >
              {kindLabel(kind)} {count}
            </button>
          ))}
          <label className="log-toggle">
            <input type="checkbox" checked={showContent} onChange={(e) => setShowContent(e.target.checked)} />
            {t("logViewer.showContent")}
          </label>
          <button className="btn btn-ghost btn-sm" onClick={() => void refresh()} disabled={refreshing}>
            <BusyLabel busy={refreshing} idle={t("logViewer.refresh")} busyText={t("logViewer.refreshing")} />
          </button>
        </div>
      </div>

      {/* 列表一条会话都没有时收成单列，别再并排两条空态（与任务中心同口径，见 styles.css .list-empty）。
          空态里必须说清数据从哪来：原生读 audit-trail.jsonl，Web 手动桥只有本次会话的内存缓冲。 */}
      <div className={`data-split${sessions.length === 0 ? " list-empty" : ""}`}>
        <div className="data-list">
          {sessions.length === 0 ? (
            <div className="data-empty-state page-empty">
              <div>{t("logViewer.empty")}</div>
              <span>{t("logViewer.emptyHint")}</span>
              {!persistAvailable && <span>{t("logViewer.webModeNote")}</span>}
            </div>
          ) : (
            sessions.map((s) => {
              const headline = sessionHeadline(s.events, s.id);
              const metric = sessionMetricText(s);
              const meta = `${s.events.length} ${t("logViewer.eventCountUnit")}${metric ? ` · ${metric}` : ""}`;
              return (
                <div
                  key={s.id}
                  className={`data-list-item task-item${selected?.id === s.id ? " active" : ""}`}
                  onClick={() => setSelectedId(s.id)}
                  {...clickableRowProps(() => setSelectedId(s.id), { selected: selected?.id === s.id })}
                >
                  <span className={`data-item-accent ${statusClass(s.status)}`} />
                  <div className="task-item-header">
                    <span className={`task-status ${chipClass(s.status)}`}>{statusLabel(s.status)}</span>
                    <span className="task-type">{kindLabel(s.kind)}</span>
                    <span className="log-item-time" title={formatDateTime(s.events[0]?.ts ?? s.startedAt)}>
                      {formatListTime(s.events[0]?.ts ?? s.startedAt, { seconds: false })}
                    </span>
                  </div>
                  <div className="task-item-name" title={headline}>
                    {headline}
                  </div>
                  <div className="log-item-metrics">
                    <span className="task-item-scope" title={meta}>
                      {meta}
                    </span>
                    <span className="log-item-id" title={s.id}>
                      {s.id}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {selected && (
          <div className="data-detail log-detail">
            <div className="log-detail-header">
              <div className="log-detail-meta">
                <span className={`task-status ${chipClass(selected.status)}`}>{statusLabel(selected.status)}</span>
                <span className="task-type">{kindLabel(selected.kind)}</span>
                <strong className="data-detail-title log-detail-title" title={sessionHeadline(selected.events, selected.id)}>
                  {sessionHeadline(selected.events, selected.id)}
                </strong>
              </div>
              <div className="log-detail-actions">
                <span className="log-detail-ts">{formatDateTime(selected.events[0]?.ts ?? selected.startedAt)}</span>
                <CopyButton text={selectedJson} label={t("common.copy")} />
              </div>
            </div>
            <div className="log-detail-sub">
              <span className="log-item-id" title={selected.id}>
                {selected.id}
              </span>
              <span className="log-detail-count">
                {t("logViewer.eventCountUnit")} {selected.events.length}
              </span>
              <span className="log-detail-duration">
                {t("logViewer.duration", { duration: formatElapsed(sessionElapsedMs(selected.events)) })}
              </span>
            </div>

            <div className="data-section-head">
              <h4>{t("logViewer.timeline")}</h4>
              <div className="log-detail-tools">
                <button className="btn btn-ghost btn-sm" onClick={() => expandAll(selected.events.length)}>
                  {t("logViewer.expandAll")}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setOpenEvents(new Set())}>
                  {t("logViewer.collapseAll")}
                </button>
              </div>
            </div>
            <div className="log-detail-expanded">
              {/* 先按原始下标建立 DOM 身份，再在渲染时决定显不显示：
                  以前先 filter 再 key={index}，勾掉「显示内容」会让事件整体上移一位，
                  用户展开的那些 <details> 就串到别的日志行上了（轮6 R46） */}
              {selected.events.map((e, index) => {
                const carriesValue =
                  Boolean(e.item) &&
                  (e.item?.sourceValue !== undefined || e.item?.targetValue !== undefined || e.item?.afterValue !== undefined);
                if (!showContent && carriesValue) return null;
                const locator = eventLocator(e);
                const metric = diffMetric([e]);
                return (
                  <details
                    key={index}
                    className={`log-event ${eventToneClass(e)}`}
                    open={openEvents.has(index)}
                    onToggle={(event) => {
                      const isOpen = (event.currentTarget as HTMLDetailsElement).open;
                      setOpenEvents((prev) => {
                        if (prev.has(index) === isOpen) return prev;
                        const next = new Set(prev);
                        if (isOpen) next.add(index);
                        else next.delete(index);
                        return next;
                      });
                    }}
                  >
                    <summary>
                      <span className="log-event-ts">{formatClock(e.ts)}</span>
                      <span className="log-event-kind">{e.kind}</span>
                      {locator ? (
                        <span className="log-event-loc" title={locator}>
                          {locator}
                        </span>
                      ) : null}
                      {e.direction ? <span className="log-event-dir">{e.direction}</span> : null}
                      {metric ? <span className="log-event-metric">{metric}</span> : null}
                      {e.error ? (
                        <span className="log-event-error" title={e.error}>
                          {e.error}
                        </span>
                      ) : null}
                    </summary>
                    <pre className="log-event-payload" tabIndex={0} role="region" aria-label={t("logViewer.eventPayload")} ref={resetRef}>
                      {JSON.stringify(e, null, 2)}
                    </pre>
                  </details>
                );
              })}
            </div>
            <details className="log-raw">
              <summary>{t("logViewer.rawEvents")}</summary>
              <pre className="log-jsonl" tabIndex={0} role="region" aria-label={t("logViewer.rawEvents")} ref={jsonlRef}>
                {selectedJson}
              </pre>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}
