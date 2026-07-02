import { useEffect, useMemo, useRef, useState } from "react";
import { ConfigItem, getConfig, listConfigs, listNamespaces, Namespace } from "../api/nacos";
import { detectFormat, Format } from "../lib/format";
import { reportError, reportMessage } from "../lib/errorCenter";
import { keysDoc } from "../lib/keys";
import {
  Connection,
  connectionDisplayLabel,
  connectionEnvironmentName,
  connectionProjectName,
  connectionSourceName,
  updateConnection,
} from "../store/connections";
import { loadSettings } from "../store/settings";
import { useTranslation } from "../i18n";
import Combobox from "./Combobox";
import CopyButton from "./CopyButton";
import DiffPanel from "./DiffPanel";
import Select from "./Select";

type DiffMode = "text" | "key" | "lines";

interface Props {
  connections: Connection[];
  onConnectionsChange?: (connections: Connection[]) => void;
}

interface Source {
  connId: string;
  tenant: string;
  dataId: string;
  group: string;
  usesDefaultNamespace: boolean;
}

interface Loaded {
  label: string;
  content: string;
  format: Format;
}

interface MatchResult {
  dataId: string;
  leftGroup: string;
  rightGroup: string;
}
interface BatchResult {
  dataId: string;
  leftLabel: string;
  rightLabel: string;
  leftText: string;
  rightText: string;
  format: Format;
}

function sortedLinesDoc(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim() !== "")
    .sort()
    .join("\n");
}

function emptySource(connId: string, connections: Connection[] = []): Source {
  const conn = connections.find((item) => item.id === connId);
  return {
    connId,
    tenant: conn?.defaultNamespace ?? "",
    dataId: "",
    group: "DEFAULT_GROUP",
    usesDefaultNamespace: true,
  };
}

function syncDefaultNamespace(source: Source, connections: Connection[]): Source {
  const conn = connections.find((item) => item.id === source.connId);
  if (!conn) return source;
  const nextTenant = conn.defaultNamespace ?? "";
  if (!source.usesDefaultNamespace) return source;
  if (source.tenant === nextTenant) return source;
  return { ...source, tenant: nextTenant };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
}

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values.filter((item) => item.trim())));
}

type EnvironmentTone = "dev" | "test" | "staging" | "prod" | "canary" | "local" | "other";

function environmentTone(name: string): EnvironmentTone {
  const value = name.trim().toLowerCase();
  if (!value) return "other";
  if (value.includes("生产") || value.includes("prod")) return "prod";
  if (value.includes("预发") || value.includes("staging") || value.includes("stage") || value.includes("uat")) return "staging";
  if (value.includes("灰度") || value.includes("canary")) return "canary";
  if (value.includes("测试") || value.includes("test") || value.includes("qa")) return "test";
  if (value.includes("本地") || value.includes("local")) return "local";
  if (value.includes("开发") || value.includes("dev")) return "dev";
  return "other";
}

function environmentSortWeight(name: string): number {
  const weights: Record<EnvironmentTone, number> = {
    dev: 10,
    test: 20,
    staging: 30,
    canary: 40,
    prod: 50,
    local: 60,
    other: 90,
  };
  return weights[environmentTone(name)];
}

function sortEnvironments(values: string[]): string[] {
  return [...values].sort((a, b) => {
    const byWeight = environmentSortWeight(a) - environmentSortWeight(b);
    return byWeight || compareText(a, b);
  });
}

function environmentHint(t: (key: string) => string, name: string): string {
  const keyByTone: Record<EnvironmentTone, string> = {
    dev: "diff.environmentHintDev",
    test: "diff.environmentHintTest",
    staging: "diff.environmentHintStaging",
    prod: "diff.environmentHintProd",
    canary: "diff.environmentHintCanary",
    local: "diff.environmentHintLocal",
    other: "diff.environmentHintOther",
  };
  return `${name} · ${t(keyByTone[environmentTone(name)])}`;
}

function EnvironmentBadge({ name }: { name: string }) {
  const { t } = useTranslation();
  return (
    <span className={`env-badge env-${environmentTone(name)}`} title={environmentHint(t, name)}>
      {name || t("diff.environmentUnknown")}
    </span>
  );
}

function sourceSummary(source: Source, connections: Connection[], autoMatch: string): string {
  const conn = connections.find((item) => item.id === source.connId);
  const label = conn ? `${connectionEnvironmentName(conn)} / ${connectionSourceName(conn)}` : source.connId;
  const namespace = source.tenant || "public";
  const group = source.group.trim() || "DEFAULT_GROUP";
  const dataId = source.dataId.trim() || autoMatch;
  return `${label} / ${namespace} / ${group} / ${dataId}`;
}

function sourceOptionLabel(conn: Connection): string {
  const source = connectionSourceName(conn);
  const remark = conn.name?.trim();
  return remark && remark !== source ? `${source} (${remark})` : source;
}

function chooseDefaultConnection(connections: Connection[], environment?: string): Connection | undefined {
  const candidates = environment
    ? connections.filter((conn) => connectionEnvironmentName(conn) === environment)
    : connections;
  return candidates.find((conn) => conn.isDefaultSource) ?? candidates[0] ?? connections[0];
}

function SourcePicker({
  title,
  connections,
  projectConnections,
  source,
  onChange,
  onSetDefaultNamespace,
  onLoadError,
  sortNamespaces,
}: {
  title: string;
  connections: Connection[];
  projectConnections: Connection[];
  source: Source;
  onChange: (source: Source) => void;
  onSetDefaultNamespace?: (connId: string, namespace: string) => void;
  onLoadError?: () => void;
  sortNamespaces: boolean;
}) {
  const { t } = useTranslation();
  const [namespaces, setNamespaces] = useState<Namespace[]>([]);
  const [nsLoading, setNsLoading] = useState(false);
  const [nsError, setNsError] = useState<string | null>(null);
  const [nsReload, setNsReload] = useState(0);
  const [configs, setConfigs] = useState<ConfigItem[]>([]);
  const [cfgLoading, setCfgLoading] = useState(false);
  const [cfgError, setCfgError] = useState<string | null>(null);
  const [cfgReload, setCfgReload] = useState(0);

  const conn = connections.find((item) => item.id === source.connId);
  const isLocalSnapshot = conn?.sourceType === "local-snapshot";
  const snapshotPath = conn?.localPath || conn?.baseUrl || "";
  const selectedEnvironment = conn ? connectionEnvironmentName(conn) : "";
  const environmentNames = sortEnvironments(uniqueValues(projectConnections.map((item) => connectionEnvironmentName(item))));
  const environmentOptions = environmentNames.map((value) => ({ value, label: value }));
  const sourceConnections = selectedEnvironment
    ? projectConnections.filter((item) => connectionEnvironmentName(item) === selectedEnvironment)
    : projectConnections;
  const sourceOptions = [...sourceConnections]
    .sort((a, b) => compareText(sourceOptionLabel(a), sourceOptionLabel(b)))
    .map((item) => ({ value: item.id, label: sourceOptionLabel(item) }));

  useEffect(() => {
    if (!conn) return;
    let alive = true;
    setNsLoading(true);
    setNsError(null);
    setNamespaces([]);

    listNamespaces(conn)
      .then((items) => {
        if (alive) setNamespaces(items);
      })
      .catch((e) => {
        if (!alive) return;
        const message = errorText(e);
        setNamespaces([]);
        setNsError(message);
        onLoadError?.();
        reportError({
          title: "命名空间加载失败",
          source: conn ? `${connectionDisplayLabel(conn)} / ${title}` : title,
          message,
          detail: message,
          mergeKey: `diff:namespace:${conn?.id || source.connId}`,
          actionLabel: t("common.retry"),
          onAction: () => setNsReload((value) => value + 1),
        });
      })
      .finally(() => {
        if (alive) setNsLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [conn, nsReload]);

  useEffect(() => {
    if (!conn) return;
    let alive = true;
    setCfgLoading(true);
    setCfgError(null);
    setConfigs([]);

    listConfigs(conn, source.tenant, "", "", 1, 500)
      .then((page) => {
        if (alive) setConfigs(page.pageItems);
      })
      .catch((e) => {
        if (!alive) return;
        const message = errorText(e);
        setConfigs([]);
        setCfgError(message);
        onLoadError?.();
        reportError({
          title: "配置列表加载失败",
          source: conn ? `${connectionDisplayLabel(conn)} / ${source.tenant || "public"} / ${title}` : title,
          message,
          detail: message,
          mergeKey: `diff:configs:${conn?.id || source.connId}:${source.tenant || "public"}`,
          actionLabel: t("common.retry"),
          onAction: () => setCfgReload((value) => value + 1),
        });
      })
      .finally(() => {
        if (alive) setCfgLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [conn, source.tenant, cfgReload]);

  const namespaceItems = namespaces
    .filter((item) => item.namespace)
    .sort((a, b) => sortNamespaces ? compareText(a.namespaceShowName || a.namespace, b.namespaceShowName || b.namespace) : 0);
  const namespaceOptions = [
    { value: "", label: t("app.namespaceDefault") },
    ...namespaceItems.map((item) => ({ value: item.namespace, label: item.namespaceShowName || item.namespace })),
  ];
  const canSetDefaultNamespace = !!conn && conn.sourceType !== "local-snapshot" && source.tenant !== (conn.defaultNamespace ?? "");
  const dataIdOptions = configs.map((item) => ({ value: item.dataId, sub: item.group }));
  const groupOptions = Array.from(new Set(configs.map((item) => item.group))).map((value) => ({ value }));

  return (
    <div className={`source-picker${isLocalSnapshot ? " local-source" : ""}`}>
      <div className="source-title-row">
        <div className="source-title">
          {title}
          {selectedEnvironment && <EnvironmentBadge name={selectedEnvironment} />}
        </div>
        <div className="source-kind-wrap">
          <span className={`source-kind${isLocalSnapshot ? " local" : ""}`}>
            {isLocalSnapshot ? t("connection.sourceTypeSnapshot") : t("connection.sourceTypeNacos")}
          </span>
        </div>
      </div>

      <div className="field-row">
        <label className="field">
          <span>{t("connection.environment")}</span>
          <Select
            className="wide"
            value={selectedEnvironment}
            options={environmentOptions}
            onChange={(value) => {
              const nextConn = chooseDefaultConnection(projectConnections, value);
              if (nextConn) onChange(emptySource(nextConn.id, connections));
            }}
          />
        </label>
        <label className="field">
          <span>{t("diff.sourceEntry")}</span>
          <Select
            className="wide"
            value={source.connId}
            options={sourceOptions}
            onChange={(value) => onChange(emptySource(value, connections))}
          />
        </label>
      </div>

      {isLocalSnapshot && (
        <div className="source-note">
          <span>{t("diff.localSnapshotHint")}</span>
          <strong title={snapshotPath}>{snapshotPath}</strong>
        </div>
      )}

      <label className="field">
        <span>
          {t("app.namespace")} {nsLoading ? `(${t("common.loading")})` : ""}
        </span>
        <div className="namespace-pick-row">
          <Select
            className="wide"
            value={source.tenant}
            options={namespaceOptions}
            onChange={(value) => onChange({ ...source, tenant: value, usesDefaultNamespace: false })}
          />
          {onSetDefaultNamespace && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={!canSetDefaultNamespace}
              onClick={() => onSetDefaultNamespace(source.connId, source.tenant)}
            >
              {t("diff.setDefaultNamespace")}
            </button>
          )}
        </div>
        {nsError && (
          <div className="field-error-box">
            <span className="field-error">
              {t("diff.namespaceLoadFailed")}: {nsError}
            </span>
            <div className="field-error-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={nsLoading}
                onClick={() => setNsReload((value) => value + 1)}
              >
                {t("diff.retryNamespaces")}
              </button>
              <CopyButton text={`${t("diff.namespaceLoadFailed")}: ${nsError}`} label={t("diff.copyError")} />
            </div>
          </div>
        )}
      </label>

      <div className="field-row">
        <label className="field">
          <span>
            dataId {cfgLoading ? `(${t("common.loading")})` : `(${configs.length})`}
          </span>
          <Combobox
            value={source.dataId}
            placeholder={t("diff.dataIdPlaceholder")}
            options={dataIdOptions}
            onChange={(value) => onChange({ ...source, dataId: value })}
            onPick={(option) => onChange({ ...source, dataId: option.value, group: option.sub || source.group })}
          />
          {cfgError && (
            <div className="field-error-box">
              <span className="field-error">
                {t("diff.configListLoadFailed")}: {cfgError}
              </span>
              <div className="field-error-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={cfgLoading}
                  onClick={() => setCfgReload((value) => value + 1)}
                >
                  {t("diff.retryConfigs")}
                </button>
                <CopyButton text={`${t("diff.configListLoadFailed")}: ${cfgError}`} label={t("diff.copyError")} />
              </div>
            </div>
          )}
        </label>

        <label className="field">
          <span>group</span>
          <Combobox
            value={source.group}
            placeholder="DEFAULT_GROUP"
            options={groupOptions}
            onChange={(value) => onChange({ ...source, group: value })}
          />
        </label>
      </div>
    </div>
  );
}

export default function DiffView({ connections, onConnectionsChange }: Props) {
  const { t } = useTranslation();
  const settings = loadSettings();
  const firstId = connections[0]?.id ?? "";
  const firstProject = connections[0] ? connectionProjectName(connections[0]) : "";
  const [selectedProject, setSelectedProject] = useState(firstProject);
  const [left, setLeft] = useState<Source>(emptySource(firstId, connections));
  const [right, setRight] = useState<Source>(emptySource(firstId, connections));
  const [leftLoaded, setLeftLoaded] = useState<Loaded | null>(null);
  const [rightLoaded, setRightLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leftFailed, setLeftFailed] = useState(false);
  const [rightFailed, setRightFailed] = useState(false);
  const [mode, setMode] = useState<DiffMode>("text");
  const [matchResults, setMatchResults] = useState<MatchResult[] | null>(null);
  const [matchLoading, setMatchLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchResults, setBatchResults] = useState<BatchResult[]>([]);
  const [batchLoading, setBatchLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [batchOnlyChanges, setBatchOnlyChanges] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [sourcesCollapsed, setSourcesCollapsed] = useState(false);
  const sourcesRef = useRef<HTMLDivElement>(null);
  const projectNames = useMemo(
    () => [...uniqueValues(connections.map((item) => connectionProjectName(item)))].sort((a, b) => compareText(a, b)),
    [connections]
  );
  const activeProject = projectNames.includes(selectedProject) ? selectedProject : projectNames[0] ?? "";
  const projectConnections = useMemo(
    () => connections.filter((item) => connectionProjectName(item) === activeProject),
    [connections, activeProject]
  );
  const projectOptions = useMemo(() => projectNames.map((value) => ({ value, label: value })), [projectNames]);

  const resetComparisonState = () => {
    setMatchResults(null);
    setBatchResults([]);
    setSelectedIds(new Set());
    setCollapsed(new Set());
    setBatchOnlyChanges(new Set());
    setLeftLoaded(null);
    setRightLoaded(null);
    setLeftFailed(false);
    setRightFailed(false);
    setNotice(null);
  };

  useEffect(() => {
    if (selectedProject !== activeProject) {
      setSelectedProject(activeProject);
      return;
    }
    if (!activeProject || projectConnections.length === 0) return;
    const leftInProject = projectConnections.some((item) => item.id === left.connId);
    const rightInProject = projectConnections.some((item) => item.id === right.connId);
    if (leftInProject && rightInProject) return;

    const fallback = chooseDefaultConnection(projectConnections);
    if (!fallback) return;
    resetComparisonState();
    setSourcesCollapsed(false);
    if (!leftInProject) setLeft(emptySource(fallback.id, connections));
    if (!rightInProject) setRight(emptySource(fallback.id, connections));
  }, [activeProject, projectConnections, left.connId, right.connId]);

  useEffect(() => {
    const nextLeft = syncDefaultNamespace(left, connections);
    const nextRight = syncDefaultNamespace(right, connections);
    if (nextLeft !== left || nextRight !== right) {
      resetComparisonState();
      setSourcesCollapsed(false);
      setLeft(nextLeft);
      setRight(nextRight);
    }
  }, [connections]);

  useEffect(() => {
    const node = sourcesRef.current;
    if (!node) return;
    if (sourcesCollapsed) node.setAttribute("inert", "");
    else node.removeAttribute("inert");
  }, [sourcesCollapsed]);

  const updateLeft = (source: Source) => {
    setLeft(source);
    setSourcesCollapsed(false);
    resetComparisonState();
  };

  const updateRight = (source: Source) => {
    setRight(source);
    setSourcesCollapsed(false);
    resetComparisonState();
  };

  const changeProject = (projectName: string) => {
    const nextConnections = connections.filter((item) => connectionProjectName(item) === projectName);
    const fallback = chooseDefaultConnection(nextConnections);
    setSelectedProject(projectName);
    setSourcesCollapsed(false);
    resetComparisonState();
    if (fallback) {
      const nextSource = emptySource(fallback.id, connections);
      setLeft(nextSource);
      setRight(nextSource);
    }
  };

  const setConnectionDefaultNamespace = (connId: string, namespace: string) => {
    const next = updateConnection(connId, { defaultNamespace: namespace });
    onConnectionsChange?.(next);
    setNotice(t("diff.defaultNamespaceSaved"));
    setError(null);
  };

  if (connections.length === 0) {
    return <div className="pad-msg big">{t("diff.noConnection")}</div>;
  }

  const loadOne = async (source: Source, dataId?: string, groupOverride?: string): Promise<Loaded> => {
    const conn = connections.find((item) => item.id === source.connId);
    if (!conn) throw new Error(t("diff.connectionRequired"));
    const id = (dataId ?? source.dataId).trim();
    if (!id) throw new Error(t("diff.dataIdRequired"));
    const group = (groupOverride ?? source.group).trim() || "DEFAULT_GROUP";
    const content = await getConfig(conn, source.tenant, id, group);

    return {
      label: `${connectionDisplayLabel(conn)} / ${source.tenant || "public"} / ${id}`,
      content,
      format: detectFormat(id, "", content),
    };
  };

  const prepareText = (loaded: Loaded): string => {
    if (mode === "key") return keysDoc(loaded.content, loaded.format);
    if (mode === "lines") return sortedLinesDoc(loaded.content);
    return loaded.content;
  };

  const loadSideSafe = async (source: Source, dataId: string, group: string, sideFailed: boolean): Promise<Loaded> => {
    if (sideFailed) {
      return { label: `(${t("diff.sideUnavailable")})`, content: "", format: "TEXT" as Format };
    }
    return loadOne(source, dataId, group);
  };

  const needMatch = !left.dataId.trim() || !right.dataId.trim();

  const doMatch = async () => {
    setMatchLoading(true);
    setError(null);
    setNotice(null);
    setMatchResults(null);
    setBatchResults([]);
    setLeftFailed(false);
    setRightFailed(false);

    try {
      const leftConn = connections.find((item) => item.id === left.connId);
      const rightConn = connections.find((item) => item.id === right.connId);
      if (!leftConn || !rightConn) throw new Error(t("diff.connectionRequired"));
      const leftGroup = left.group.trim() || "DEFAULT_GROUP";
      const rightGroup = right.group.trim() || "DEFAULT_GROUP";

      const [leftResult, rightResult] = await Promise.allSettled([
        listConfigs(leftConn, left.tenant, "", leftGroup, 1, 500),
        listConfigs(rightConn, right.tenant, "", rightGroup, 1, 500),
      ]);

      const leftErr = leftResult.status === "rejected" ? errorText(leftResult.reason) : "";
      const rightErr = rightResult.status === "rejected" ? errorText(rightResult.reason) : "";
      const leftOk = leftResult.status === "fulfilled";
      const rightOk = rightResult.status === "fulfilled";

      // 两侧都失败 → 整体报错
      if (!leftOk && !rightOk) {
        setSourcesCollapsed(false);
        setError(`${t("diff.sourceA")}: ${leftErr}  ${t("diff.sourceB")}: ${rightErr}`);
        return;
      }

      // 标记失败侧
      if (!leftOk) setLeftFailed(true);
      if (!rightOk) setRightFailed(true);

      // 单侧失败提示
      if (!leftOk || !rightOk) {
        const failSide = !leftOk ? t("diff.sourceA") : t("diff.sourceB");
        const failMsg = !leftOk ? leftErr : rightErr;
        setNotice(`${failSide} ${t("diff.sideUnavailable")}: ${failMsg}`);
        setSourcesCollapsed(false);
      }

      const leftPage = leftResult.status === "fulfilled" ? leftResult.value : null;
      const rightPage = rightResult.status === "fulfilled" ? rightResult.value : null;

      const leftIds = leftPage ? new Set(leftPage.pageItems.map((item) => item.dataId)) : null;
      const rightIds = rightPage ? new Set(rightPage.pageItems.map((item) => item.dataId)) : null;
      const leftId = left.dataId.trim();
      const rightId = right.dataId.trim();
      let common: string[];

      if (leftId && rightId) {
        common = [leftId];
      } else if (leftId) {
        if (rightOk) common = rightIds!.has(leftId) ? [leftId] : [];
        else common = [leftId]; // 右侧不可用，用左侧指定 dataId
      } else if (rightId) {
        if (leftOk) common = leftIds!.has(rightId) ? [rightId] : [];
        else common = [rightId]; // 左侧不可用，用右侧指定 dataId
      } else if (leftOk && rightOk) {
        common = [...leftIds!].filter((id) => rightIds!.has(id)).sort();
      } else {
        // 单侧可用 → 用可用侧全部配置
        const ids = leftOk ? leftIds! : rightIds!;
        common = [...ids].sort();
      }

      if (common.length === 0) {
        setSourcesCollapsed(false);
        setError(t("diff.noMatchedDataId"));
        return;
      }

      setMatchResults(common.map((dataId) => ({ dataId, leftGroup, rightGroup })));
      setSelectedIds(new Set(common));
      setSourcesCollapsed(true);
    } catch (e) {
      const message = errorText(e);
      setSourcesCollapsed(false);
      setError(message);
      reportError({
        title: "同名配置匹配失败",
        source: t("app.diff"),
        message,
        detail: message,
        mergeKey: "diff:match",
        actionLabel: "重试",
        onAction: () => doMatch(),
      });
    } finally {
      setMatchLoading(false);
    }
  };

  const loadBoth = async () => {
    if (needMatch) {
      await doMatch();
      return;
    }

    setLoading(true);
    setError(null);
    setNotice(null);
    const [leftResult, rightResult] = await Promise.allSettled([loadOne(left), loadOne(right)]);
    const errors: string[] = [];

    if (leftResult.status === "fulfilled") setLeftLoaded(leftResult.value);
    else {
      setLeftLoaded(null);
      errors.push(`${t("diff.sourceA")}: ${errorText(leftResult.reason)}`);
    }

    if (rightResult.status === "fulfilled") setRightLoaded(rightResult.value);
    else {
      setRightLoaded(null);
      errors.push(`${t("diff.sourceB")}: ${errorText(rightResult.reason)}`);
    }

    const message = errors.join("  ");
    setError(message || null);
    setSourcesCollapsed(!message);
    if (message) {
      reportError({
        title: "配置对比加载失败",
        source: t("app.diff"),
        message,
        detail: message,
        mergeKey: `diff:load:${left.connId}:${left.tenant}:${left.group}:${left.dataId}:${right.connId}:${right.tenant}:${right.group}:${right.dataId}`,
        actionLabel: "重试",
        onAction: () => loadBoth(),
      });
    }
    setLoading(false);
  };

  const loadBatch = async () => {
    if (!matchResults) return;
    const toCompare = matchResults.filter((item) => selectedIds.has(item.dataId));
    if (toCompare.length === 0) return;

    setBatchLoading(true);
    setBatchResults([]);
    setError(null);
    setNotice(null);
    setBatchOnlyChanges(new Set());

    const results: BatchResult[] = [];
    const failed: { dataId: string; error: string }[] = [];

    for (let i = 0; i < toCompare.length; i += 5) {
      const chunk = toCompare.slice(i, i + 5);
      const settled = await Promise.allSettled(
        chunk.map(async (item) => {
          const [leftItem, rightItem] = await Promise.all([
            loadSideSafe(left, item.dataId, item.leftGroup, leftFailed),
            loadSideSafe(right, item.dataId, item.rightGroup, rightFailed),
          ]);
          return {
            dataId: item.dataId,
            leftLabel: leftItem.label,
            rightLabel: rightItem.label,
            leftText: leftFailed ? "" : prepareText(leftItem),
            rightText: rightFailed ? "" : prepareText(rightItem),
            format: (mode === "key" ? "TEXT" : !leftFailed && leftItem.format !== "TEXT" ? leftItem.format : rightItem.format) as Format,
          };
        })
      );

      for (let j = 0; j < settled.length; j++) {
        const item = settled[j];
        if (item.status === "fulfilled") {
          results.push(item.value);
        } else {
          failed.push({ dataId: chunk[j].dataId, error: errorText(item.reason) });
        }
      }
    }

    const total = toCompare.length;
    const successCount = results.length;
    const failCount = failed.length;

    const detailLines = [`批量对比结果: 成功 ${successCount}/${total}, 失败 ${failCount}/${total}`];
    if (failed.length > 0) {
      detailLines.push("失败列表:");
      for (const f of failed) detailLines.push(`  - ${f.dataId}: ${f.error}`);
    }
    const detail = detailLines.join("\n");

    let level: "success" | "warning" | "error";
    let title: string;
    let message: string;

    if (failCount === 0) {
      level = "success";
      title = `批量对比完成: ${successCount}/${total} 全部成功`;
      message = `${successCount} 个配置全部加载成功`;
    } else if (successCount === 0) {
      level = "error";
      title = `批量对比完成: ${failCount}/${total} 全部失败`;
      message = `${failCount} 个配置全部加载失败: ${failed.map((f) => f.dataId).join(", ")}`;
      setError("全部配置加载失败");
    } else {
      level = "warning";
      title = `批量对比完成: 成功 ${successCount}/${total}, 失败 ${failCount}/${total}`;
      message = `${failCount} 个配置加载失败: ${failed.map((f) => f.dataId).join(", ")}`;
      setError(message);
    }

    reportMessage({
      level,
      title,
      source: t("app.diff"),
      message,
      detail,
      mergeKey: `diff:batch:summary:${Date.now()}`,
      actionLabel: "重试",
      onAction: () => loadBatch(),
    });

    setBatchResults(results);
    setSourcesCollapsed(results.length > 0);
    setBatchLoading(false);
  };

  const toggleSelect = (dataId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(dataId)) next.delete(dataId);
      else next.add(dataId);
      return next;
    });
  };

  const toggleAll = () => {
    if (!matchResults) return;
    setSelectedIds((prev) => (prev.size === matchResults.length ? new Set() : new Set(matchResults.map((item) => item.dataId))));
  };

  const toggleCollapse = (dataId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(dataId)) next.delete(dataId);
      else next.add(dataId);
      return next;
    });
  };

  const batchAllOnlyChanges = batchResults.length > 0 && batchResults.every((item) => batchOnlyChanges.has(item.dataId));
  const toggleBatchOnlyChanges = (checked: boolean) => {
    setBatchOnlyChanges(checked ? new Set(batchResults.map((item) => item.dataId)) : new Set());
  };
  const toggleItemOnlyChanges = (dataId: string, checked: boolean) => {
    setBatchOnlyChanges((prev) => {
      const next = new Set(prev);
      if (checked) next.add(dataId);
      else next.delete(dataId);
      return next;
    });
  };

  const retryCurrentCompare = () => {
    if (leftFailed || rightFailed) {
      setLeftFailed(false);
      setRightFailed(false);
    }
    if (matchResults) void loadBatch();
    else void loadBoth();
  };

  const ready = leftLoaded && rightLoaded;
  const leftText = ready ? prepareText(leftLoaded) : "";
  const rightText = ready ? prepareText(rightLoaded) : "";
  const diffFormat = mode === "key" ? "TEXT" : leftLoaded?.format !== "TEXT" ? leftLoaded?.format : rightLoaded?.format;
  const leftConn = connections.find((item) => item.id === left.connId);
  const rightConn = connections.find((item) => item.id === right.connId);

  return (
    <div className="diff-view">
      <div className={`diff-source-panel${sourcesCollapsed ? " collapsed" : ""}`}>
        <div className="diff-source-toolbar">
          <div className="diff-source-toolbar-title">
            <span className="diff-source-heading">{t("diff.sourceConfig")}</span>
            {sourcesCollapsed && <span className="diff-source-hint">{t("diff.sourceCollapsedHint")}</span>}
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setSourcesCollapsed((value) => !value)}
          >
            {sourcesCollapsed ? t("diff.expandSources") : t("diff.collapseSources")}
          </button>
        </div>
        <div className="diff-project-row">
          <label className="diff-project-select">
            <span>{t("connection.project")}</span>
            <Select
              className="wide"
              value={activeProject}
              options={projectOptions}
              onChange={changeProject}
            />
          </label>
        </div>
        <div className="diff-source-summary" aria-hidden={!sourcesCollapsed}>
          <div className="diff-source-summary-card">
            <span className="diff-source-summary-title">{t("diff.sourceA")}</span>
            {leftConn && <EnvironmentBadge name={connectionEnvironmentName(leftConn)} />}
            <span className="diff-source-summary-text" title={sourceSummary(left, connections, t("diff.autoMatch"))}>
              {sourceSummary(left, connections, t("diff.autoMatch"))}
            </span>
          </div>
          <div className="diff-source-summary-card">
            <span className="diff-source-summary-title">{t("diff.sourceB")}</span>
            {rightConn && <EnvironmentBadge name={connectionEnvironmentName(rightConn)} />}
            <span className="diff-source-summary-text" title={sourceSummary(right, connections, t("diff.autoMatch"))}>
              {sourceSummary(right, connections, t("diff.autoMatch"))}
            </span>
          </div>
        </div>
        <div className="diff-sources" ref={sourcesRef} aria-hidden={sourcesCollapsed}>
          <SourcePicker
            title={t("diff.sourceA")}
            connections={connections}
            projectConnections={projectConnections}
            source={left}
            onChange={updateLeft}
            onLoadError={() => setSourcesCollapsed(false)}
            onSetDefaultNamespace={onConnectionsChange ? setConnectionDefaultNamespace : undefined}
            sortNamespaces={settings.compare.sortNamespaces}
          />
          <SourcePicker
            title={t("diff.sourceB")}
            connections={connections}
            projectConnections={projectConnections}
            source={right}
            onChange={updateRight}
            onLoadError={() => setSourcesCollapsed(false)}
            onSetDefaultNamespace={onConnectionsChange ? setConnectionDefaultNamespace : undefined}
            sortNamespaces={settings.compare.sortNamespaces}
          />
        </div>
      </div>

      <div className="diff-loadbar">
        <span className="fmt-label">{t("diff.compareMode")}</span>
        <Select
          value={mode}
          options={[
            { value: "text", label: t("diff.modeText") },
            { value: "lines", label: t("diff.modeLines") },
            { value: "key", label: t("diff.modeKey") },
          ]}
          onChange={(value) => setMode(value as DiffMode)}
        />
        {matchResults ? (
          <button className="btn btn-primary" onClick={loadBatch} disabled={batchLoading || selectedIds.size === 0}>
            {batchLoading ? t("diff.comparing") : t("diff.compareSelected", { count: selectedIds.size })}
          </button>
        ) : (
          <button className="btn btn-primary" onClick={loadBoth} disabled={loading || matchLoading}>
            {loading || matchLoading ? t("common.loading") : t("diff.loadAndCompare")}
          </button>
        )}
        {notice && (
          <div className={`diff-loadok${(leftFailed || rightFailed) ? " warn" : ""}`}>
            <span>{notice}</span>
            {(leftFailed || rightFailed) && <CopyButton text={notice} label={t("diff.copyError")} />}
          </div>
        )}
        {error && (
          <div className="diff-loaderr">
            <span>{error}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={retryCurrentCompare} disabled={loading || matchLoading || batchLoading}>
              {t("diff.retryCompare")}
            </button>
            <CopyButton text={error} label={t("diff.copyError")} />
          </div>
        )}
      </div>

      <div className="diff-result">
        {matchResults && matchResults.length > 0 && batchResults.length === 0 && (
          <div className="match-list">
            <div className="match-list-head">
              <label className="match-toggle-all">
                <input type="checkbox" checked={selectedIds.size === matchResults.length} onChange={toggleAll} />
                {t("diff.selectAll")}
              </label>
              <span className="match-count">
                {t("diff.matchCount", { total: matchResults.length, selected: selectedIds.size })}
              </span>
            </div>
            <div className="match-items">
              {matchResults.map((item) => (
                <label className="match-item" key={item.dataId}>
                  <input type="checkbox" checked={selectedIds.has(item.dataId)} onChange={() => toggleSelect(item.dataId)} />
                  <span className="match-dataid">{item.dataId}</span>
                  <span className="match-group">{item.leftGroup === item.rightGroup ? item.leftGroup : `${item.leftGroup} / ${item.rightGroup}`}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {batchResults.length > 0 && (
          <div className="batch-diff">
            <div className="batch-diff-toolbar">
              <span className="batch-diff-count">已生成 {batchResults.length} 个文件对比</span>
              <span className="fmt-spacer" />
              <label className="diff-toggle">
                <input
                  type="checkbox"
                  checked={batchAllOnlyChanges}
                  onChange={(e) => toggleBatchOnlyChanges(e.target.checked)}
                />
                全部仅显示变更
              </label>
            </div>
            {batchResults.map((item) => (
              <div className="batch-diff-item" key={item.dataId}>
                <div className="batch-diff-header" onClick={() => toggleCollapse(item.dataId)}>
                  <span className="batch-diff-toggle">{collapsed.has(item.dataId) ? ">" : "v"}</span>
                  <span className="batch-diff-title">{item.dataId}</span>
                </div>
                {!collapsed.has(item.dataId) && (
                  <DiffPanel
                    leftLabel={item.leftLabel}
                    rightLabel={item.rightLabel}
                    leftText={item.leftText}
                    rightText={item.rightText}
                    format={item.format}
                    onlyChanges={batchOnlyChanges.has(item.dataId)}
                    onOnlyChangesChange={(checked) => toggleItemOnlyChanges(item.dataId, checked)}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        {!matchResults && ready ? (
          <DiffPanel
            leftLabel={leftLoaded.label}
            rightLabel={rightLoaded.label}
            leftText={leftText}
            rightText={rightText}
            format={diffFormat}
          />
        ) : !matchResults && !ready ? (
          <div className="pad-msg big">
            {t("diff.selectHint")}
            <div className="diff-hint">{t("diff.supportHint")}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}



