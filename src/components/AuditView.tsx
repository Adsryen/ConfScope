import { useCallback, useEffect, useMemo, useState } from "react";
import { Connection, connectionEnvironmentName, connectionProjectName } from "../store/connections";
import { getConfig, listConfigs } from "../api/nacos";
import { detectFormat } from "../lib/format";
import { normalizeConfig, type ConfigEntry, type ParseStatus } from "../lib/normalize";
import { buildAuditMatrix, type AuditRow, type AuditSource, type IgnoreRule } from "../lib/audit";
import { useTranslation } from "../i18n";
import { reportError } from "../lib/errorCenter";
import Select from "./Select";
import CopyButton from "./CopyButton";

interface Props {
  connections: Connection[];
}

type AuditStatus = "consistent" | "partial" | "inconsistent" | "missing" | "parse_error" | "ignored";

interface EnvSource {
  conn: Connection;
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
  consistent: "一致",
  partial: "部分一致",
  inconsistent: "不一致",
  missing: "缺失",
  parse_error: "解析失败",
  ignored: "已忽略",
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
          {STATUS_LABELS[item.status]}: {item.count}
        </span>
      ))}
    </div>
  );
}

function environmentToneShort(name: string): string {
  const value = name.trim().toLowerCase();
  if (value.includes("prod") || value.includes("生产")) return "prod";
  if (value.includes("staging") || value.includes("预发") || value.includes("uat")) return "staging";
  if (value.includes("test") || value.includes("测试") || value.includes("qa")) return "test";
  if (value.includes("dev") || value.includes("开发")) return "dev";
  return "other";
}

export default function AuditView({ connections }: Props) {
  const { t } = useTranslation();
  const firstProject = connections[0] ? connectionProjectName(connections[0]) : "";
  const projectNames = useMemo(() => {
    const names = new Set(connections.map((c) => connectionProjectName(c)));
    return Array.from(names).sort();
  }, [connections]);
  const [selectedProject, setSelectedProject] = useState(firstProject);
  const projectConns = useMemo(
    () => connections.filter((c) => connectionProjectName(c) === selectedProject),
    [connections, selectedProject]
  );

  // 环境来源（最多 6 个）
  const [envSources, setEnvSources] = useState<EnvSource[]>(() => {
    const nonLocal = projectConns.filter((c) => c.sourceType !== "local-snapshot");
    return nonLocal.slice(0, 4).map((c) => ({
      conn: c,
      namespace: c.defaultNamespace ?? "",
      group: "DEFAULT_GROUP",
      dataIdFilter: "",
    }));
  });

  useEffect(() => {
    setEnvSources((prev) => {
      const nonLocal = projectConns.filter((c) => c.sourceType !== "local-snapshot");
      if (nonLocal.length === 0) return [];
      return nonLocal.slice(0, 4).map((c) => {
        const existing = prev.find((s) => s.conn.id === c.id);
        return existing ?? { conn: c, namespace: c.defaultNamespace ?? "", group: "DEFAULT_GROUP", dataIdFilter: "" };
      });
    });
  }, [projectConns]);

  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<AuditRow | null>(null);
  const [baseline, setBaseline] = useState<string>("");
  const [showSettings, setShowSettings] = useState(false);

  // 忽略规则
  const [ignoreRules, setIgnoreRules] = useState<IgnoreRule[]>([]);
  const [ignoreForm, setIgnoreForm] = useState<{ dataId?: string; key?: string; reason: string }>({ reason: "" });

  // 名称归一化
  const [normalizeEnabled, setNormalizeEnabled] = useState(false);
  const [normalizeRules, setNormalizeRules] = useState<NormalizeRule[]>([]);
  const [normalizeForm, setNormalizeForm] = useState<NormalizeRule>({
    id: "", type: "prefix", pattern: "", replacement: "", caseSensitive: false,
  });

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
      { conn: unused[0], namespace: unused[0].defaultNamespace ?? "", group: "DEFAULT_GROUP", dataIdFilter: "" },
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

    try {
      const sources: AuditSource[] = [];
      const errors: string[] = [];

      for (const env of envSources) {
        try {
          const dataId = env.dataIdFilter.trim() ? `*${env.dataIdFilter.trim()}*` : "";
          const page = await listConfigs(env.conn, env.namespace, dataId, env.group, 1, 500);
          const entriesList: { dataId: string; entries: ConfigEntry[]; format: string }[] = [];
          for (const item of page.pageItems) {
            try {
              const content = await getConfig(env.conn, env.namespace, item.dataId, item.group);
              const fmt = detectFormat(item.dataId, item.configType, content);
              const { entries } = normalizeConfig(content, fmt);
              entriesList.push({ dataId: item.dataId, entries, format: fmt });
            } catch {
              // 单个配置加载失败不影响整体
              entriesList.push({ dataId: item.dataId, entries: [{ key: "__parse__", value: `加载失败`, valueType: "text" as const, sourcePath: "__parse__", parseStatus: "error" as ParseStatus }], format: "TEXT" });
            }
          }
          for (const item of entriesList) {
            sources.push({
              envId: envKey(env),
              label: envLabel(env),
              providerType: env.conn.provider ?? "nacos",
              namespace: env.namespace || "public",
              group: env.group || "DEFAULT_GROUP",
              dataId: item.dataId,
              entries: item.entries,
            });
          }
        } catch (e) {
          errors.push(`${envShortLabel(env)}: ${String(e)}`);
        }
      }

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

      if (errors.length > 0) {
        reportError({
          title: t("audit.partialError"),
          source: "审计矩阵",
          message: errors.join(" | "),
        });
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [envSources, t]);

  const envIds = useMemo(() => envSources.map(envKey), [envSources]);

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
                <span className={`env-badge env-${environmentToneShort(connectionEnvironmentName(env.conn))}`}>
                  {connectionEnvironmentName(env.conn)}
                </span>
                <span className="audit-env-name">{env.conn.name || env.conn.sourceName}</span>
                {envSources.length > 2 && (
                  <button className="btn btn-ghost btn-sm" onClick={() => removeSource(index)} title={t("common.delete")}>
                    ×
                  </button>
                )}
              </div>
              <label className="field">
                <span>{t("app.namespace")}</span>
                <input
                  className="search-input mono"
                  value={env.namespace}
                  placeholder="public"
                  onChange={(e) => updateSource(index, { namespace: e.target.value })}
                />
              </label>
              <label className="field">
                <span>group</span>
                <input
                  className="search-input mono"
                  value={env.group}
                  placeholder="DEFAULT_GROUP"
                  onChange={(e) => updateSource(index, { group: e.target.value })}
                />
              </label>
              <label className="field">
                <span>dataId {t("audit.filter")}</span>
                <input
                  className="search-input mono"
                  value={env.dataIdFilter}
                  placeholder={t("audit.allConfigs")}
                  onChange={(e) => updateSource(index, { dataIdFilter: e.target.value })}
                />
              </label>
            </div>
          ))}
          {envSources.length < 6 && (
            <button className="btn btn-ghost btn-sm audit-add-env" onClick={addSource}>
              + 环境
            </button>
          )}
        </div>

        <div className="audit-settings-toggle">
          <button className="btn btn-ghost btn-sm" onClick={() => setShowSettings(!showSettings)}>
            {showSettings ? "▼" : "▶"} 忽略规则 · 名称归一化
          </button>
        </div>

        {showSettings && (
          <div className="audit-settings">
            {/* 忽略规则 */}
            <div className="audit-settings-section">
              <h4>忽略规则</h4>
              {ignoreRules.length > 0 && (
                <div className="ignore-rules-list">
                  {ignoreRules.map((rule, i) => (
                    <div className="ignore-rule-item" key={i}>
                      <span className="ignore-rule-text">
                        {rule.dataId && <span className="ignore-rule-dataid">{rule.dataId}</span>}
                        {rule.key && <span className="ignore-rule-key">{rule.key}</span>}
                        {!rule.dataId && !rule.key && <span className="ignore-rule-dataid">全部</span>}
                        <span className="ignore-rule-reason"> — {rule.reason}</span>
                      </span>
                      <button className="btn btn-ghost btn-sm" onClick={() => removeIgnoreRule(i)}>×</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="field-row">
                <input
                  className="search-input"
                  placeholder="dataId 过滤（可选）"
                  value={ignoreForm.dataId ?? ""}
                  onChange={(e) => setIgnoreForm({ ...ignoreForm, dataId: e.target.value || undefined })}
                />
                <input
                  className="search-input"
                  placeholder="key 过滤（可选）"
                  value={ignoreForm.key ?? ""}
                  onChange={(e) => setIgnoreForm({ ...ignoreForm, key: e.target.value || undefined })}
                />
                <input
                  className="search-input"
                  placeholder="忽略原因"
                  value={ignoreForm.reason}
                  onChange={(e) => setIgnoreForm({ ...ignoreForm, reason: e.target.value })}
                />
                <button className="btn btn-ghost btn-sm" onClick={addIgnoreRule}>添加</button>
              </div>
            </div>

            {/* 名称归一化 */}
            <div className="audit-settings-section">
              <h4>名称归一化</h4>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={normalizeEnabled}
                  onChange={(e) => setNormalizeEnabled(e.target.checked)}
                />
                <span>启用名称归一化（对齐不同环境的 dataId）</span>
              </label>
              {normalizeEnabled && (
                <>
                  {normalizeRules.length > 0 && (
                    <div className="ignore-rules-list">
                      {normalizeRules.map((rule, i) => (
                        <div className="ignore-rule-item" key={rule.id}>
                          <span className="ignore-rule-text">
                            {rule.type === "prefix" ? "前缀" : rule.type === "suffix" ? "后缀" : "替换"}
                            : {rule.pattern} → {rule.replacement || "(删除)"}
                            {rule.caseSensitive ? " [区分大小写]" : ""}
                          </span>
                          <button className="btn btn-ghost btn-sm" onClick={() => removeNormalizeRule(i)}>×</button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="field-row">
                    <select
                      className="search-input"
                      value={normalizeForm.type}
                      onChange={(e) => setNormalizeForm({ ...normalizeForm, type: e.target.value as NormalizeRule["type"] })}
                    >
                      <option value="prefix">前缀裁剪</option>
                      <option value="suffix">后缀裁剪</option>
                      <option value="replace">精确替换</option>
                    </select>
                    <input
                      className="search-input mono"
                      placeholder="匹配模式"
                      value={normalizeForm.pattern}
                      onChange={(e) => setNormalizeForm({ ...normalizeForm, pattern: e.target.value })}
                    />
                    <input
                      className="search-input mono"
                      placeholder="替换为（留空=删除）"
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
                    <span>区分大小写</span>
                  </label>
                  <button className="btn btn-ghost btn-sm" onClick={addNormalizeRule}>添加规则</button>
                </>
              )}
            </div>
          </div>
        )}

        <div className="audit-actions">
          <button className="btn btn-primary" onClick={runAudit} disabled={loading}>
            {loading ? t("common.loading") : t("audit.runAudit")}
          </button>
          {error && <div className="test-msg err">{error}</div>}
        </div>
      </div>

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
                      设基准
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="audit-matrix-body">
            {rows.map((row) => (
              <div
                key={row.id}
                className={`audit-matrix-row ${selectedRow?.id === row.id ? "selected" : ""}`}
                onClick={() => setSelectedRow(row)}
              >
                <div className="audit-cell key">
                  <span className={`audit-status-badge ${STATUS_CLASS[row.status]}`}>
                    {STATUS_LABELS[row.status]}
                  </span>
                  <div className="audit-key-path">
                    <span className="audit-dataid">{row.dataId}</span>
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
            <button className="btn btn-ghost btn-sm" onClick={() => setSelectedRow(null)}>
              {t("common.close")}
            </button>
          </div>
          <div className="audit-detail-body">
            {envIds.map((envId) => {
              const cell = selectedRow.values[envId];
              const env = envSources.find((s) => envKey(s) === envId);
              return (
                <div key={envId} className="audit-detail-env">
                  <div className="audit-detail-env-label">{env ? envShortLabel(env) : envId}</div>
                  <pre className="audit-detail-value">{cell?.exists ? cell.value : "(缺失)"}</pre>
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
