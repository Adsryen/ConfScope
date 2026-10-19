import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Connection, connectionEnvironmentName, connectionProjectName } from "../store/connections";
import { getConfig, listAllConfigs } from "../api/nacos";
import { detectFormat } from "../lib/format";
import { environmentTone } from "../lib/envTone";
import { normalizeConfig, type ConfigEntry, type ParseStatus } from "../lib/normalize";
import { buildAuditMatrix, type AuditRow, type AuditSource, type IgnoreRule } from "../lib/audit";
import { useTranslation } from "../i18n";
import { describeConfigListGaps, isStaleRequestError } from "../lib/configListStatus";
import { reportError } from "../lib/errorCenter";
import { exportAuditCSV, exportAuditJSON, downloadFile } from "../lib/export";
import { applyEntryRiskSummary, type ApplyEntryEndpoint, type ApplyEntryPayload, type ApplyEntryRef } from "../lib/applyEntry";
import CopyButton from "./CopyButton";
import { clickableRowProps } from "../lib/clickableRow";
import { createAuditSession, auditSessionEvent, endAuditSession } from "../lib/auditSessionLog";
import { readViewState, useRememberedState, useScrollMemory, writeViewState } from "../lib/viewState";
import Select from "./Select";
import { errorText } from "../lib/errorText";
import { useScrollResetRef } from "../lib/useScrollResetOnContentChange";
import { statusMessageProps } from "../lib/statusSemantics";
import type { DiffJumpParams } from "../lib/diffJump";

// 轮46 R04：跳转参数的契约收在 src/lib/diffJump.ts 一份，这里只转出给既有引用方（App 从这里导入）。
export type { DiffJumpParams, DiffJumpSideParams } from "../lib/diffJump";

interface Props {
  connections: Connection[];
  onNavigateToDiff?: (params: DiffJumpParams) => void;
  onStartApply?: (payload: ApplyEntryPayload) => void;
}

type AuditStatus = "consistent" | "partial" | "inconsistent" | "missing" | "parse_error" | "ignored";

export interface EnvSource {
  conn: Connection;
  namespace: string;
  group: string;
  dataIdFilter: string;
}

type AuditSortKey = "dataId" | "key" | "status";
type AuditSortDir = "asc" | "desc";

/** lib/viewState 里记的环境来源形状（连接对象不进记忆层，按 id 重新取最新配置）。 */
interface RememberedEnvSource {
  connId: string;
  namespace: string;
  group: string;
  dataIdFilter: string;
}

interface NormalizeRule {
  id: string;
  type: "prefix" | "suffix" | "replace";
  pattern: string;
  replacement: string;
  caseSensitive: boolean;
}

const STATUS_LABELS: Record<AuditStatus, string> = {
  consistent: "audit.statusConsistent",
  partial: "audit.statusPartial",
  inconsistent: "audit.statusInconsistent",
  missing: "audit.statusMissing",
  parse_error: "audit.statusParseError",
  ignored: "audit.statusIgnored",
};

const STATUS_CLASS: Record<AuditStatus, string> = {
  consistent: "ok",
  partial: "warn",
  inconsistent: "err",
  missing: "missing",
  parse_error: "err",
  ignored: "dim",
};

function envKey(s: EnvSource): string {
  return `${s.conn.id}:${s.namespace}`;
}

function envLabel(s: EnvSource): string {
  return `${connectionEnvironmentName(s.conn)} / ${s.conn.name || s.conn.sourceName} / ${s.namespace || "public"}`;
}

function envShortLabel(s: EnvSource): string {
  return `${connectionEnvironmentName(s.conn)} / ${s.namespace || "public"}`;
}

function applyEntryEndpoint(env: EnvSource): ApplyEntryEndpoint {
  return {
    provider: env.conn.provider ?? "nacos",
    connectionId: env.conn.id,
    connectionName: env.conn.name || env.conn.sourceName || env.conn.id,
    namespace: env.namespace,
    label: envLabel(env),
  };
}

function summaryBar(rows: AuditRow[], t: (key: string, params?: Record<string, string | number>) => string) {
  const total = rows.length;
  const counts = new Map<AuditStatus, number>();
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  const items: { status: AuditStatus; count: number }[] = [];
  for (const status of ["consistent", "partial", "inconsistent", "missing", "parse_error", "ignored"] as AuditStatus[]) {
    const count = counts.get(status) ?? 0;
    if (count > 0) items.push({ status, count });
  }
  return (
    <div className="audit-summary">
      <span className="audit-summary-total">{t("audit.totalConfigs", { count: total })}</span>
      {items.map((item) => (
        <span key={item.status} className={`audit-summary-item ${STATUS_CLASS[item.status]}`}>
          {t(STATUS_LABELS[item.status])}: {item.count}
        </span>
      ))}
    </div>
  );
}

export default function AuditView({ connections, onNavigateToDiff, onStartApply }: Props) {
  const { t } = useTranslation();
  // 矩阵详情每格的环境标题 id 前缀：让只读的 pre 用 aria-labelledby 指向它（R39）
  const envLabelIdBase = useId();
  const firstProject = connections[0] ? connectionProjectName(connections[0]) : "";
  const projectNames = useMemo(() => {
    const names = new Set(connections.map((c) => connectionProjectName(c)));
    return Array.from(names).sort();
  }, [connections]);
  // 切 Tab 不再丢：项目、环境筛选、忽略/归一化规则、状态筛选与排序都记在 lib/viewState（R27）
  const [selectedProject, setSelectedProject] = useRememberedState<string>("audit.project", firstProject);
  const projectConns = useMemo(
    () => connections.filter((c) => connectionProjectName(c) === selectedProject),
    [connections, selectedProject]
  );

  // 记住的项目可能因为连接被删/改名而不复存在，回落到第一个可用项目，避免空白页
  useEffect(() => {
    if (projectNames.length === 0 || projectNames.includes(selectedProject)) return;
    setSelectedProject(projectNames[0]);
  }, [projectNames, selectedProject, setSelectedProject]);

  // 环境来源（最多 6 个）
  // group 默认跟随连接配置的默认 group（留空 = 该命名空间全部 group）
  const defaultGroupFor = (c: Connection) => {
    const g = (c.defaultGroup ?? "").trim();
    return g && g !== "DEFAULT_GROUP" ? g : "";
  };
  const [envSources, setEnvSources] = useState<EnvSource[]>(() => {
    const nonLocal = projectConns.filter((c) => c.sourceType !== "local-snapshot");
    // 只记连接 id 与三个筛选值，连接对象本身按最新配置重新取（改过地址/命名空间的连接不会被旧快照钉住）
    const remembered = readViewState<RememberedEnvSource[]>("audit.envs");
    const hydrated = (remembered ?? [])
      .map((item): EnvSource | null => {
        const conn = nonLocal.find((c) => c.id === item.connId);
        if (!conn) return null;
        return { conn, namespace: item.namespace, group: item.group, dataIdFilter: item.dataIdFilter };
      })
      .filter((env): env is EnvSource => env !== null);
    if (hydrated.length > 0) return hydrated.slice(0, 6);
    return nonLocal.slice(0, 4).map((c) => ({
      conn: c,
      namespace: c.defaultNamespace ?? "",
      group: defaultGroupFor(c),
      dataIdFilter: "",
    }));
  });

  useEffect(() => {
    writeViewState(
      "audit.envs",
      envSources.map((env) => ({ connId: env.conn.id, namespace: env.namespace, group: env.group, dataIdFilter: env.dataIdFilter }))
    );
  }, [envSources]);

  useEffect(() => {
    setEnvSources((prev) => {
      const nonLocal = projectConns.filter((c) => c.sourceType !== "local-snapshot");
      if (nonLocal.length === 0) return [];
      return nonLocal.slice(0, 4).map((c) => {
        const existing = prev.find((s) => s.conn.id === c.id);
        return existing ?? { conn: c, namespace: c.defaultNamespace ?? "", group: defaultGroupFor(c), dataIdFilter: "" };
      });
    });
  }, [projectConns]);

  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 聚合列表的不完整信号（命中安全上限 / 有页失败）与已扫描条数，两者都必须让用户看见
  const [runGaps, setRunGaps] = useState<string[]>([]);
  const [scanCount, setScanCount] = useState(0);
  const auditReqId = useRef(0);
  const [selectedRow, setSelectedRow] = useState<AuditRow | null>(null);
  // 详情区每个环境一格，切换数据项时这些 <pre> 复用同一批节点，不归零就会让新内容
  // 停在上一份的偏移处，用户会以为差异就只有滚到的这几行（轮13 波29 / R49）。
  const resetRef = useScrollResetRef([selectedRow?.dataId ?? "", selectedRow?.key ?? ""]);
  const [baseline, setBaseline] = useState<string>("");
  const [showSettings, setShowSettings] = useRememberedState<boolean>("audit.showSettings", false);

  // 忽略规则
  const [ignoreRules, setIgnoreRules] = useRememberedState<IgnoreRule[]>("audit.ignoreRules", []);
  const [ignoreForm, setIgnoreForm] = useState<{ dataId?: string; key?: string; reason: string }>({ reason: "" });

  // 名称归一化
  const [normalizeEnabled, setNormalizeEnabled] = useRememberedState<boolean>("audit.normalizeEnabled", false);
  const [normalizeRules, setNormalizeRules] = useRememberedState<NormalizeRule[]>("audit.normalizeRules", []);
  const [normalizeForm, setNormalizeForm] = useState<NormalizeRule>({
    id: "", type: "prefix", pattern: "", replacement: "", caseSensitive: false,
  });

  // 导出
  const [exportFormat, setExportFormat] = useState<"csv" | "json">("csv");
  const [sanitizeExport, setSanitizeExport] = useState(true);

  // 过滤与排序
  const [statusFilter, setStatusFilter] = useRememberedState<Set<string>>("audit.statusFilter", new Set<string>());
  const [hideIgnored, setHideIgnored] = useRememberedState<boolean>("audit.hideIgnored", false);
  const [sortKey, setSortKey] = useRememberedState<AuditSortKey>("audit.sortKey", "dataId");
  const [sortDir, setSortDir] = useRememberedState<AuditSortDir>("audit.sortDir", "asc");

  const genId = () => `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  const addIgnoreRule = () => {
    if (!ignoreForm.reason.trim()) return;
    setIgnoreRules((prev) => [...prev, { ...ignoreForm, reason: ignoreForm.reason.trim() }]);
    setIgnoreForm({ reason: "" });
  };

  const removeIgnoreRule = (index: number) => setIgnoreRules((prev) => prev.filter((_, i) => i !== index));

  const addNormalizeRule = () => {
    if (!normalizeForm.pattern.trim()) return;
    setNormalizeRules((prev) => [...prev, { ...normalizeForm, id: genId() }]);
    setNormalizeForm({ id: "", type: "prefix", pattern: "", replacement: "", caseSensitive: false });
  };

  const removeNormalizeRule = (index: number) => setNormalizeRules((prev) => prev.filter((_, i) => i !== index));

  // 环境 ID 列表
  const envIds = useMemo(() => envSources.map(envKey), [envSources]);

  // 导出处理
  const handleExport = useCallback(() => {
    if (rows.length === 0) return;
    const opts = { sanitize: sanitizeExport };
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    if (exportFormat === "csv") {
      const csv = exportAuditCSV(rows, envSources, opts);
      downloadFile(csv, `audit-${timestamp}.csv`, "text/csv;charset=utf-8");
    } else {
      const json = exportAuditJSON(rows, envSources, opts);
      downloadFile(JSON.stringify(json, null, 2), `audit-${timestamp}.json`, "application/json");
    }
  }, [rows, envSources, exportFormat, sanitizeExport]);

  // 跳转 DiffView
  const handleJumpToDiff = useCallback(() => {
    if (!selectedRow || !baseline || !onNavigateToDiff) return;
    const baselineCell = selectedRow.values[baseline];
    // 找第一个值不匹配的环境
    const targetEnvId = envIds.find((envId) => {
      if (envId === baseline) return false;
      const cell = selectedRow.values[envId];
      return cell?.exists && cell.value !== baselineCell?.value;
    }) ?? envIds.find((envId) => envId !== baseline);
    if (!targetEnvId) return;
    const targetEnv = envSources.find((env) => envKey(env) === targetEnvId);
    onNavigateToDiff({
      leftConnId: baseline.split(":")[0],
      rightConnId: targetEnvId.split(":")[0],
      left: {
        tenant: selectedRow.values[baseline]?.namespace ?? selectedRow.namespace,
        group: selectedRow.group,
        dataId: selectedRow.originalDataIds[baseline] ?? selectedRow.dataId,
      },
      right: {
        tenant: targetEnv ? targetEnv.namespace : selectedRow.namespace,
        group: selectedRow.group,
        dataId: selectedRow.originalDataIds[targetEnvId] ?? selectedRow.dataId,
      },
    });
  }, [selectedRow, baseline, envIds, onNavigateToDiff]);

  const handleStartApply = useCallback(() => {
    if (!selectedRow || !baseline || !onStartApply) return;
    const baselineEnv = envSources.find((env) => envKey(env) === baseline);
    const baselineCell = selectedRow.values[baseline];
    const targetEnvId =
      envIds.find((envId) => {
        if (envId === baseline) return false;
        const cell = selectedRow.values[envId];
        return !cell?.exists || cell.value !== baselineCell?.value;
      }) ?? envIds.find((envId) => envId !== baseline);
    const targetEnv = targetEnvId ? envSources.find((env) => envKey(env) === targetEnvId) : undefined;
    if (!baselineEnv || !targetEnv || !targetEnvId) return;

    const sourceRef: ApplyEntryRef = {
      provider: baselineEnv.conn.provider ?? "nacos",
      connectionId: baselineEnv.conn.id,
      namespace: baselineEnv.namespace || selectedRow.namespace,
      group: selectedRow.group,
      dataId: selectedRow.originalDataIds[baseline] ?? selectedRow.dataId,
      key: selectedRow.key,
    };
    const targetRef: ApplyEntryRef = {
      provider: targetEnv.conn.provider ?? "nacos",
      connectionId: targetEnv.conn.id,
      namespace: targetEnv.namespace || selectedRow.values[targetEnvId]?.namespace || selectedRow.namespace,
      group: selectedRow.group,
      dataId: selectedRow.originalDataIds[targetEnvId] ?? selectedRow.dataId,
      key: selectedRow.key,
    };
    const item = {
      ...targetRef,
      sourceRef,
      targetRef,
    };

    onStartApply({
      sourceType: "audit",
      scope: "key",
      source: applyEntryEndpoint(baselineEnv),
      target: applyEntryEndpoint(targetEnv),
      items: [item],
      rangeSummary: applyEntryRiskSummary([item], selectedRow.status === "ignored" ? 1 : 0),
      origin: {
        mode: "audit",
        returnMode: "audit",
      },
    });
  }, [selectedRow, baseline, envSources, envIds, onStartApply]);

  const applyNormalize = useCallback(
    (name: string): string => {
      if (!normalizeEnabled) return name;
      let result = name;
      for (const rule of normalizeRules) {
        const flags = rule.caseSensitive ? "" : "i";
        switch (rule.type) {
          case "prefix": {
            const re = new RegExp(`^${rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, flags);
            result = result.replace(re, rule.replacement);
            break;
          }
          case "suffix": {
            const re = new RegExp(`${rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, flags);
            result = result.replace(re, rule.replacement);
            break;
          }
          case "replace": {
            const escaped = rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const re = new RegExp(escaped, flags + "g");
            result = result.replace(re, rule.replacement);
            break;
          }
        }
      }
      return result;
    },
    [normalizeEnabled, normalizeRules]
  );

  const updateSource = (index: number, patch: Partial<EnvSource>) => {
    setEnvSources((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };

  const addSource = () => {
    if (envSources.length >= 6) return;
    const unused = projectConns.filter(
      (c) => c.sourceType !== "local-snapshot" && !envSources.some((s) => s.conn.id === c.id)
    );
    if (unused.length === 0) return;
    setEnvSources((prev) => [
      ...prev,
      { conn: unused[0], namespace: unused[0].defaultNamespace ?? "", group: defaultGroupFor(unused[0]), dataIdFilter: "" },
    ]);
  };

  const removeSource = (index: number) => {
    setEnvSources((prev) => prev.filter((_, i) => i !== index));
  };

  const runAudit = useCallback(async () => {
    if (envSources.length < 2) {
      setError(t("audit.atLeastTwo"));
      return;
    }
    setLoading(true);
    setError(null);
    setRows([]);
    setSelectedRow(null);
    setRunGaps([]);
    setScanCount(0);
    // 请求序号守卫：重跑审计后旧聚合结果必须作废，不得覆盖新一轮结果
    const myReq = ++auditReqId.current;
    const session = createAuditSession("audit");
    auditSessionEvent(session, {
      kind: "audit_run_start",
      scope: "audit",
      selectedCount: envSources.length,
      left: envSources.map((env) => envLabel(env)).join(" | "),
    });

    try {
      const sources: AuditSource[] = [];
      const errors: string[] = [];
      const gaps: string[] = [];

      for (const env of envSources) {
        try {
          const dataId = env.dataIdFilter.trim() ? `*${env.dataIdFilter.trim()}*` : "";
          // 按 pagesAvailable 取全该环境的配置条目，超过安全上限或少页时显式提示
          const listResult = await listAllConfigs(env.conn, env.namespace, dataId, env.group, {
            pageSize: 500,
            isStale: () => myReq !== auditReqId.current,
            onProgress: (loaded) => {
              if (myReq === auditReqId.current) setScanCount(loaded);
            },
          });
          const entriesList: { dataId: string; entries: ConfigEntry[]; format: string }[] = [];
          for (const item of listResult.items) {
            try {
              const content = await getConfig(env.conn, env.namespace, item.dataId, item.group);
              const fmt = detectFormat(item.dataId, item.configType, content);
              const { entries } = normalizeConfig(content, fmt);
              entriesList.push({ dataId: item.dataId, entries, format: fmt });
            } catch {
              // 单个配置加载失败不影响整体
              entriesList.push({ dataId: item.dataId, entries: [{ key: "__parse__", value: t("audit.configLoadFailedValue"), valueType: "text" as const, sourcePath: "__parse__", parseStatus: "error" as ParseStatus }], format: "TEXT" });
            }
          }
          gaps.push(...describeConfigListGaps(listResult, t).map((gap) => `${envShortLabel(env)}: ${gap}`));
          for (const item of entriesList) {
            sources.push({
              envId: envKey(env),
              label: envLabel(env),
              providerType: env.conn.provider ?? "nacos",
              namespace: env.namespace,
              group: env.group || "DEFAULT_GROUP",
              dataId: item.dataId,
              entries: item.entries,
            });
          }
        } catch (e) {
          // 作废信号继续上抛，由外层静默处理，不能污染本轮 errors
          if (isStaleRequestError(e)) throw e;
          errors.push(`${envShortLabel(env)}: ${errorText(e)}`);
        }
      }

      if (myReq !== auditReqId.current) return;
      setRunGaps(gaps);

      if (sources.length === 0) {
        setError(t("audit.noData"));
        return;
      }

      const matrix = buildAuditMatrix(sources, {
        ignoreRules: ignoreRules.length > 0 ? ignoreRules : undefined,
        normalizeName: normalizeEnabled ? applyNormalize : (name: string) => name,
      });
      setRows(matrix);
      setBaseline(envSources[0] ? envKey(envSources[0]) : "");
      const statusSummary: Record<string, number> = {};
      for (const row of matrix) {
        statusSummary[row.status] = (statusSummary[row.status] ?? 0) + 1;
      }
      auditSessionEvent(session, {
        kind: "audit_run_result",
        result: errors.length === 0 ? "success" : "failure",
        statusSummary,
        error: errors.length > 0 ? errors.join(" | ") : undefined,
      });
      endAuditSession(session, errors.length === 0 ? "success" : "failure", errors.length > 0 ? errors.join(" | ") : undefined);

      if (errors.length > 0) {
        reportError({
          title: t("audit.partialError"),
          source: t("app.audit"),
          message: errors.join(" | "),
        });
      }
    } catch (e) {
      if (isStaleRequestError(e)) return;
      setError(errorText(e));
      auditSessionEvent(session, { kind: "audit_run_result", result: "failure", error: errorText(e) });
      endAuditSession(session, "failure", errorText(e));
    } finally {
      setLoading(false);
    }
  }, [applyNormalize, envSources, ignoreRules, normalizeEnabled, t]);

  // 过滤与排序后的行
  const filteredRows = useMemo(() => {
    let result = rows;
    // 状态过滤
    if (statusFilter.size > 0) {
      result = result.filter((row) => statusFilter.has(row.status));
    }
    // 隐藏已忽略
    if (hideIgnored) {
      result = result.filter((row) => row.status !== "ignored");
    }
    // 排序
    return [...result].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "dataId") cmp = a.dataId.localeCompare(b.dataId);
      else if (sortKey === "key") cmp = a.key.localeCompare(b.key);
      else if (sortKey === "status") cmp = a.status.localeCompare(b.status);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [rows, statusFilter, hideIgnored, sortKey, sortDir]);

  // 矩阵滚动位置：审计结果要手动跑一次才有，挂载时列表是空的（真实浏览器会把偏移夹回 0），
  // 所以按条数作为列表版本，数据到达后再恢复一次（见 lib/viewState）。
  const matrixScroll = useScrollMemory("audit.scroll.matrix", filteredRows.length);

  // 切换状态过滤
  const toggleStatusFilter = (status: string) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  // 切换排序
  const toggleSort = (key: AuditSortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  if (connections.length === 0) {
    return <div className="pad-msg big">{t("diff.noConnection")}</div>;
  }

  return (
    <div className="page-surface audit-page">
      <div className="page-header">
        <div>
          <h3>{t("app.audit")}</h3>
          <div className="page-subtitle">{t("app.auditPlanned")}</div>
        </div>
      </div>

      {/* 顶部审计条件 */}
      <div className="audit-toolbar">
        <div className="audit-project-row">
          <label className="field">
            <span>{t("connection.project")}</span>
            <Select
              className="wide"
              value={selectedProject}
              options={projectNames.map((n) => ({ value: n, label: n }))}
              onChange={setSelectedProject}
            />
          </label>
        </div>

        <div className="audit-envs">
          {envSources.map((env, index) => (
            <div className="audit-env-card" key={`${env.conn.id}:${env.namespace}`}>
              <div className="audit-env-head">
                <span
                  className={`env-badge env-${environmentTone(connectionEnvironmentName(env.conn))}`}
                  title={connectionEnvironmentName(env.conn)}
                >
                  {connectionEnvironmentName(env.conn)}
                </span>
                <span className="audit-env-name">{env.conn.name || env.conn.sourceName}</span>
                {envSources.length > 2 && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => removeSource(index)}
                    title={t("common.delete")}
                    aria-label={t("common.delete")}
                  >
                    ×
                  </button>
                )}
              </div>
              <label className="field">
                <span>{t("app.namespace")}</span>
                <input
                  type="text"
                  className="search-input mono"
                  spellCheck={false}
                  value={env.namespace}
                  placeholder="public"
                  onChange={(e) => updateSource(index, { namespace: e.target.value })}
                />
              </label>
              <label className="field">
                <span>group</span>
                <input
                  type="text"
                  className="search-input mono"
                  spellCheck={false}
                  value={env.group}
                  placeholder={t("diff.groupPlaceholder")}
                  onChange={(e) => updateSource(index, { group: e.target.value })}
                />
              </label>
              <label className="field">
                <span>dataId {t("audit.filter")}</span>
                <input
                  type="text"
                  className="search-input mono"
                  spellCheck={false}
                  value={env.dataIdFilter}
                  placeholder={t("audit.allConfigs")}
                  onChange={(e) => updateSource(index, { dataIdFilter: e.target.value })}
                />
              </label>
            </div>
          ))}
          {envSources.length < 6 && (
            <button className="btn btn-ghost btn-sm audit-add-env" onClick={addSource}>
              {t("audit.addEnv")}
            </button>
          )}
        </div>

        <div className="audit-settings-toggle">
          <button className="btn btn-ghost btn-sm" onClick={() => setShowSettings(!showSettings)} aria-expanded={showSettings}>
            {showSettings ? "▼" : "▶"} {t("audit.settingsToggle")}
          </button>
        </div>

        {showSettings && (
          <div className="audit-settings">
            {/* 忽略规则 */}
            <div className="audit-settings-section">
              <h4>{t("audit.ignoreRulesTitle")}</h4>
              {ignoreRules.length > 0 && (
                <div className="ignore-rules-list">
                  {ignoreRules.map((rule, i) => (
                    <div className="ignore-rule-item" key={i}>
                      <span className="ignore-rule-text">
                        {rule.dataId && <span className="ignore-rule-dataid">{rule.dataId}</span>}
                        {rule.key && <span className="ignore-rule-key">{rule.key}</span>}
                        {!rule.dataId && !rule.key && <span className="ignore-rule-dataid">{t("audit.ignoreRuleAll")}</span>}
                        <span className="ignore-rule-reason"> — {rule.reason}</span>
                      </span>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => removeIgnoreRule(i)}
                        title={t("audit.removeRule")}
                        aria-label={t("audit.removeRule")}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="field-row">
                <input
                  type="text"
                  className="search-input"
                  placeholder={t("audit.ignoreDataIdPlaceholder")}
                  aria-label={t("audit.ignoreDataIdPlaceholder")}
                  value={ignoreForm.dataId ?? ""}
                  onChange={(e) => setIgnoreForm({ ...ignoreForm, dataId: e.target.value || undefined })}
                />
                <input
                  type="text"
                  className="search-input"
                  placeholder={t("audit.ignoreKeyPlaceholder")}
                  aria-label={t("audit.ignoreKeyPlaceholder")}
                  value={ignoreForm.key ?? ""}
                  onChange={(e) => setIgnoreForm({ ...ignoreForm, key: e.target.value || undefined })}
                />
                <input
                  type="text"
                  className="search-input"
                  placeholder={t("audit.ignoreReasonPlaceholder")}
                  aria-label={t("audit.ignoreReasonPlaceholder")}
                  value={ignoreForm.reason}
                  onChange={(e) => setIgnoreForm({ ...ignoreForm, reason: e.target.value })}
                />
                <button className="btn btn-ghost btn-sm" onClick={addIgnoreRule}>{t("audit.addRule")}</button>
              </div>
            </div>

            {/* 名称归一化 */}
            <div className="audit-settings-section">
              <h4>{t("audit.normalizeTitle")}</h4>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={normalizeEnabled}
                  onChange={(e) => setNormalizeEnabled(e.target.checked)}
                />
                <span>{t("audit.normalizeEnabledLabel")}</span>
              </label>
              {normalizeEnabled && (
                <>
                  {normalizeRules.length > 0 && (
                    <div className="ignore-rules-list">
                      {normalizeRules.map((rule, i) => (
                        <div className="ignore-rule-item" key={rule.id}>
                          <span className="ignore-rule-text">
                            {rule.type === "prefix" ? t("audit.normalizePrefix") : rule.type === "suffix" ? t("audit.normalizeSuffix") : t("audit.normalizeReplace")}
                            : {rule.pattern} → {rule.replacement || t("audit.normalizeDeleteHint")}
                            {rule.caseSensitive ? ` [${t("audit.caseSensitive")}]` : ""}
                          </span>
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => removeNormalizeRule(i)}
                            title={t("audit.removeRule")}
                            aria-label={t("audit.removeRule")}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="field-row">
                    <select
                      className="search-input"
                      aria-label={t("audit.ruleType")}
                      value={normalizeForm.type}
                      onChange={(e) => setNormalizeForm({ ...normalizeForm, type: e.target.value as NormalizeRule["type"] })}
                    >
                      <option value="prefix">{t("audit.normalizePrefix")}</option>
                      <option value="suffix">{t("audit.normalizeSuffix")}</option>
                      <option value="replace">{t("audit.normalizeReplace")}</option>
                    </select>
                    <input
                      type="text"
                      className="search-input mono"
                      spellCheck={false}
                      placeholder={t("audit.matchPattern")}
                      aria-label={t("audit.matchPattern")}
                      value={normalizeForm.pattern}
                      onChange={(e) => setNormalizeForm({ ...normalizeForm, pattern: e.target.value })}
                    />
                    <input
                      type="text"
                      className="search-input mono"
                      spellCheck={false}
                      placeholder={t("audit.replaceTo")}
                      aria-label={t("audit.replaceTo")}
                      value={normalizeForm.replacement}
                      onChange={(e) => setNormalizeForm({ ...normalizeForm, replacement: e.target.value })}
                    />
                  </div>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={normalizeForm.caseSensitive}
                      onChange={(e) => setNormalizeForm({ ...normalizeForm, caseSensitive: e.target.checked })}
                    />
                    <span>{t("audit.caseSensitive")}</span>
                  </label>
                  <button className="btn btn-ghost btn-sm" onClick={addNormalizeRule}>{t("audit.addNormalizeRule")}</button>
                </>
              )}
            </div>
          </div>
        )}

        <div className="audit-actions">
          <button className="btn btn-primary" onClick={runAudit} disabled={loading}>
            {loading ? (scanCount > 0 ? t("audit.scanning", { count: scanCount }) : t("common.loading")) : t("audit.runAudit")}
          </button>
          {rows.length > 0 && (
            <div className="audit-export">
              <button className="btn btn-ghost" onClick={handleExport}>
                {t("audit.export")} ({exportFormat === "csv" ? "CSV" : "JSON"})
              </button>
              <label className="check-row audit-export-opt">
                <input
                  type="checkbox"
                  checked={exportFormat === "json"}
                  onChange={(e) => setExportFormat(e.target.checked ? "json" : "csv")}
                />
                <span>JSON</span>
              </label>
              <label className="check-row audit-export-opt">
                <input
                  type="checkbox"
                  checked={sanitizeExport}
                  onChange={(e) => setSanitizeExport(e.target.checked)}
                />
                <span>{t("audit.sanitizeToggle")}</span>
              </label>
            </div>
          )}
          {error && (
            <div className="test-msg err" {...statusMessageProps("error")}>
              <span>{error}</span>
              <CopyButton text={error} label={t("common.copyError")} />
            </div>
          )}
          {runGaps.length > 0 && (
            <div className="diff-warnings" role="status">
              {runGaps.map((gap) => (
                <div className="diff-warning" key={gap}>
                  {gap}
                </div>
              ))}
              <div className="field-error-actions">
                <CopyButton text={runGaps.join("\n")} label={t("common.copyError")} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 过滤与排序 */}
      {rows.length > 0 && (
        <div className="audit-filter-bar">
          <span className="audit-filter-label">{t("audit.filter")}:</span>
          {(["consistent", "partial", "inconsistent", "missing", "parse_error", "ignored"] as const).map((status) => (
            <button
              key={status}
              className={`btn btn-sm ${statusFilter.has(status) ? "btn-primary" : "btn-ghost"}`}
              onClick={() => toggleStatusFilter(status)}
              aria-pressed={statusFilter.has(status)}
            >
              {t(STATUS_LABELS[status])}
            </button>
          ))}
          <label className="check-row audit-filter-opt">
            <input
              type="checkbox"
              checked={hideIgnored}
              onChange={(e) => setHideIgnored(e.target.checked)}
            />
            <span>{t("audit.hideIgnored")}</span>
          </label>
          <span className="audit-filter-sort">
            {(["dataId", "key", "status"] as const).map((key) => (
              <button
                key={key}
                className={`btn btn-sm ${sortKey === key ? "btn-primary" : "btn-ghost"}`}
                onClick={() => toggleSort(key)}
                aria-pressed={sortKey === key}
              >
                {key} {sortKey === key ? (sortDir === "asc" ? "↑" : "↓") : ""}
              </button>
            ))}
          </span>
        </div>
      )}

      {/* 状态摘要 */}
      {rows.length > 0 && summaryBar(rows, t)}

      {/* 矩阵表格 */}
      {rows.length > 0 && (
        <div className="audit-matrix">
          <div className="audit-matrix-header">
            <div className="audit-matrix-row">
              <div className="audit-cell key">{t("audit.configItem")}</div>
              {envSources.map((env) => (
                <div key={envKey(env)} className={`audit-cell env ${baseline === envKey(env) ? "baseline" : ""}`}>
                  <div className="audit-env-label">{envShortLabel(env)}</div>
                  {baseline !== envKey(env) && (
                    <button className="btn btn-ghost btn-sm" onClick={() => setBaseline(envKey(env))}>
                      {t("audit.setBaseline")}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="audit-matrix-body" ref={matrixScroll.ref} onScroll={matrixScroll.onScroll}>
            {filteredRows.map((row) => (
              <div
                key={row.id}
                className={`audit-matrix-row ${selectedRow?.id === row.id ? "selected" : ""}`}
                onClick={() => setSelectedRow(row)}
                {...clickableRowProps(() => setSelectedRow(row), { selected: selectedRow?.id === row.id })}
              >
                <div className="audit-cell key">
                  <span className={`audit-status-badge ${STATUS_CLASS[row.status]}`}>
                    {t(STATUS_LABELS[row.status])}
                  </span>
                  <div className="audit-key-path">
                    <span className="audit-dataid" title={row.dataId}>
                      {row.dataId}
                    </span>
                    <span className="audit-key">{row.key}</span>
                  </div>
                </div>
                {envIds.map((envId) => {
                  const cell = row.values[envId];
                  const isBaseline = envId === baseline;
                  if (!cell || !cell.exists) {
                    return <div key={envId} className="audit-cell missing">—</div>;
                  }
                  const differ = !isBaseline && baseline && row.values[baseline]?.value !== cell.value;
                  return (
                    <div
                      key={envId}
                      className={`audit-cell value ${differ ? "differ" : ""}`}
                      title={cell.value ?? ""}
                    >
                      <span className="audit-value">{cell.value ?? ""}</span>
                      {cell.parseStatus === "error" && <span className="audit-parse-err">⚠</span>}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 详情面板 */}
      {selectedRow && (
        <div className="audit-detail">
          <div className="audit-detail-head">
            <div>
              <strong>{selectedRow.dataId}</strong>
              <span className="audit-detail-key"> / {selectedRow.key}</span>
            </div>
            <div className="audit-detail-actions">
              {baseline && onNavigateToDiff && (
                <button className="btn btn-primary btn-sm" onClick={handleJumpToDiff}>
                  {t("audit.jumpToDiff")}
                </button>
              )}
              {baseline && onStartApply && (
                <button className="btn btn-primary btn-sm" onClick={handleStartApply}>
                  {t("audit.startApply")}
                </button>
              )}
              <button className="btn btn-ghost btn-sm" onClick={() => setSelectedRow(null)}>
                {t("audit.close")}
              </button>
            </div>
          </div>
          <div className="audit-detail-body">
            {envIds.map((envId) => {
              const cell = selectedRow.values[envId];
              const env = envSources.find((s) => envKey(s) === envId);
              const envLabelId = `${envLabelIdBase}-${envId}`;
              return (
                <div key={envId} className="audit-detail-env">
                  <div className="audit-detail-env-label" id={envLabelId}>
                    {env ? envShortLabel(env) : envId}
                  </div>
                  <pre className="audit-detail-value" tabIndex={0} role="region" aria-labelledby={envLabelId} ref={resetRef}>
                    {cell?.exists ? cell.value : t("audit.detailMissing")}
                  </pre>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!rows.length && !loading && !error && (
        <div className="pad-msg big">{t("audit.selectHint")}</div>
      )}
    </div>
  );
}
