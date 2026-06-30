import { useEffect, useState } from "react";
import { ConfigItem, getConfig, listConfigs, listNamespaces, Namespace } from "../api/nacos";
import { detectFormat, Format } from "../lib/format";
import { keysDoc } from "../lib/keys";
import { Connection, connectionDisplayLabel } from "../store/connections";
import { loadSettings } from "../store/settings";
import { useTranslation } from "../i18n";
import Combobox from "./Combobox";
import DiffPanel from "./DiffPanel";
import Select from "./Select";

type DiffMode = "text" | "key" | "lines";

interface Props {
  connections: Connection[];
}

interface Source {
  connId: string;
  tenant: string;
  dataId: string;
  group: string;
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
  };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
}

function SourcePicker({
  title,
  connections,
  source,
  onChange,
  sortConnections,
  sortNamespaces,
}: {
  title: string;
  connections: Connection[];
  source: Source;
  onChange: (source: Source) => void;
  sortConnections: boolean;
  sortNamespaces: boolean;
}) {
  const { t } = useTranslation();
  const [namespaces, setNamespaces] = useState<Namespace[]>([]);
  const [nsLoading, setNsLoading] = useState(false);
  const [nsError, setNsError] = useState<string | null>(null);
  const [configs, setConfigs] = useState<ConfigItem[]>([]);
  const [cfgLoading, setCfgLoading] = useState(false);
  const [cfgError, setCfgError] = useState<string | null>(null);

  const conn = connections.find((item) => item.id === source.connId);
  const isLocalSnapshot = conn?.sourceType === "local-snapshot";
  const snapshotPath = conn?.localPath || conn?.baseUrl || "";

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
        setNamespaces([]);
        setNsError(errorText(e));
      })
      .finally(() => {
        if (alive) setNsLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [conn]);

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
        setConfigs([]);
        setCfgError(errorText(e));
      })
      .finally(() => {
        if (alive) setCfgLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [conn, source.tenant]);

  const connectionOptions = [...connections]
    .sort((a, b) => sortConnections ? compareText(connectionDisplayLabel(a), connectionDisplayLabel(b)) : 0)
    .map((item) => ({ value: item.id, label: connectionDisplayLabel(item) }));
  const namespaceItems = namespaces
    .filter((item) => item.namespace)
    .sort((a, b) => sortNamespaces ? compareText(a.namespaceShowName || a.namespace, b.namespaceShowName || b.namespace) : 0);
  const namespaceOptions = [
    { value: "", label: t("app.namespaceDefault") },
    ...namespaceItems.map((item) => ({ value: item.namespace, label: item.namespaceShowName || item.namespace })),
  ];
  const dataIdOptions = configs.map((item) => ({ value: item.dataId, sub: item.group }));
  const groupOptions = Array.from(new Set(configs.map((item) => item.group))).map((value) => ({ value }));

  return (
    <div className={`source-picker${isLocalSnapshot ? " local-source" : ""}`}>
      <div className="source-title-row">
        <div className="source-title">{title}</div>
        <span className={`source-kind${isLocalSnapshot ? " local" : ""}`}>
          {isLocalSnapshot ? t("connection.sourceTypeSnapshot") : t("connection.sourceTypeNacos")}
        </span>
      </div>

      <label className="field">
        <span>{t("app.connection")}</span>
        <Select
          className="wide"
          value={source.connId}
          options={connectionOptions}
          onChange={(value) => onChange(emptySource(value, connections))}
        />
      </label>

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
        <Select
          className="wide"
          value={source.tenant}
          options={namespaceOptions}
          onChange={(value) => onChange({ ...source, tenant: value })}
        />
        {nsError && (
          <span className="field-error">
            {t("diff.namespaceLoadFailed")}: {nsError}
          </span>
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
            <span className="field-error">
              {t("diff.configListLoadFailed")}: {cfgError}
            </span>
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

export default function DiffView({ connections }: Props) {
  const { t } = useTranslation();
  const settings = loadSettings();
  const firstId = connections[0]?.id ?? "";
  const [left, setLeft] = useState<Source>(emptySource(firstId, connections));
  const [right, setRight] = useState<Source>(emptySource(firstId, connections));
  const [leftLoaded, setLeftLoaded] = useState<Loaded | null>(null);
  const [rightLoaded, setRightLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<DiffMode>("text");
  const [matchResults, setMatchResults] = useState<MatchResult[] | null>(null);
  const [matchLoading, setMatchLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchResults, setBatchResults] = useState<BatchResult[]>([]);
  const [batchLoading, setBatchLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const resetComparisonState = () => {
    setMatchResults(null);
    setBatchResults([]);
    setSelectedIds(new Set());
    setCollapsed(new Set());
    setLeftLoaded(null);
    setRightLoaded(null);
  };

  const updateLeft = (source: Source) => {
    setLeft(source);
    resetComparisonState();
  };

  const updateRight = (source: Source) => {
    setRight(source);
    resetComparisonState();
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

  const needMatch = !left.dataId.trim() || !right.dataId.trim();

  const doMatch = async () => {
    setMatchLoading(true);
    setError(null);
    setMatchResults(null);
    setBatchResults([]);

    try {
      const leftConn = connections.find((item) => item.id === left.connId);
      const rightConn = connections.find((item) => item.id === right.connId);
      if (!leftConn || !rightConn) throw new Error(t("diff.connectionRequired"));
      const leftGroup = left.group.trim() || "DEFAULT_GROUP";
      const rightGroup = right.group.trim() || "DEFAULT_GROUP";

      const [leftPage, rightPage] = await Promise.all([
        listConfigs(leftConn, left.tenant, "", leftGroup, 1, 500),
        listConfigs(rightConn, right.tenant, "", rightGroup, 1, 500),
      ]);

      const leftIds = new Set(leftPage.pageItems.map((item) => item.dataId));
      const rightIds = new Set(rightPage.pageItems.map((item) => item.dataId));
      const leftId = left.dataId.trim();
      const rightId = right.dataId.trim();
      let common: string[];

      if (leftId && rightId) common = [leftId];
      else if (leftId) common = rightIds.has(leftId) ? [leftId] : [];
      else if (rightId) common = leftIds.has(rightId) ? [rightId] : [];
      else common = [...leftIds].filter((id) => rightIds.has(id)).sort();

      if (common.length === 0) {
        setError(t("diff.noMatchedDataId"));
        return;
      }

      setMatchResults(common.map((dataId) => ({ dataId, leftGroup, rightGroup })));
      setSelectedIds(new Set(common));
    } catch (e) {
      setError(errorText(e));
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

    setError(errors.join("  ") || null);
    setLoading(false);
  };

  const loadBatch = async () => {
    if (!matchResults) return;
    const toCompare = matchResults.filter((item) => selectedIds.has(item.dataId));
    if (toCompare.length === 0) return;

    setBatchLoading(true);
    setBatchResults([]);
    setError(null);

    const results: BatchResult[] = [];
    for (let i = 0; i < toCompare.length; i += 5) {
      const chunk = toCompare.slice(i, i + 5);
      const settled = await Promise.allSettled(
        chunk.map(async (item) => {
          const [leftItem, rightItem] = await Promise.all([
            loadOne(left, item.dataId, item.leftGroup),
            loadOne(right, item.dataId, item.rightGroup),
          ]);
          return {
            dataId: item.dataId,
            leftLabel: leftItem.label,
            rightLabel: rightItem.label,
            leftText: prepareText(leftItem),
            rightText: prepareText(rightItem),
            format: (mode === "key" ? "TEXT" : leftItem.format !== "TEXT" ? leftItem.format : rightItem.format) as Format,
          };
        })
      );

      for (const item of settled) {
        if (item.status === "fulfilled") results.push(item.value);
      }
    }

    setBatchResults(results);
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

  const ready = leftLoaded && rightLoaded;
  const leftText = ready ? prepareText(leftLoaded) : "";
  const rightText = ready ? prepareText(rightLoaded) : "";
  const diffFormat = mode === "key" ? "TEXT" : leftLoaded?.format !== "TEXT" ? leftLoaded?.format : rightLoaded?.format;

  return (
    <div className="diff-view">
      <div className="diff-sources">
        <SourcePicker
          title={t("diff.sourceA")}
          connections={connections}
          source={left}
          onChange={updateLeft}
          sortConnections={settings.compare.sortConnections}
          sortNamespaces={settings.compare.sortNamespaces}
        />
        <SourcePicker
          title={t("diff.sourceB")}
          connections={connections}
          source={right}
          onChange={updateRight}
          sortConnections={settings.compare.sortConnections}
          sortNamespaces={settings.compare.sortNamespaces}
        />
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
        {error && <span className="diff-loaderr">{error}</span>}
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



