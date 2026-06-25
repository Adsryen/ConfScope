import { useEffect, useState } from "react";
import { Connection } from "../store/connections";
import { ConfigItem, getConfig, listConfigs, listNamespaces, Namespace } from "../api/nacos";
import { detectFormat, Format } from "../lib/format";
import { keysDoc } from "../lib/keys";
import Combobox from "./Combobox";
import DiffPanel from "./DiffPanel";
import Select from "./Select";

type DiffMode = "text" | "key" | "lines";

/** 忽略顺序的整行对比:去空行、按行排序后再 diff(保留值,只忽略顺序)。 */
function sortedLinesDoc(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "")
    .sort()
    .join("\n");
}

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

const emptySource = (connId: string): Source => ({
  connId,
  tenant: "",
  dataId: "",
  group: "DEFAULT_GROUP",
});

/** 单侧来源选择器：选连接 / 命名空间 / dataId / group（仅选择，加载由外层统一触发）。 */
function SourcePicker({
  title,
  connections,
  source,
  onChange,
}: {
  title: string;
  connections: Connection[];
  source: Source;
  onChange: (s: Source) => void;
}) {
  const [namespaces, setNamespaces] = useState<Namespace[]>([]);
  const [nsLoading, setNsLoading] = useState(false);
  const [configs, setConfigs] = useState<ConfigItem[]>([]);
  const [cfgLoading, setCfgLoading] = useState(false);

  const conn = connections.find((c) => c.id === source.connId);

  // 选定连接后拉取命名空间
  useEffect(() => {
    if (!conn) return;
    let alive = true;
    setNsLoading(true);
    setNamespaces([]);
    listNamespaces(conn)
      .then((ns) => alive && setNamespaces(ns))
      .catch(() => alive && setNamespaces([]))
      .finally(() => alive && setNsLoading(false));
    return () => {
      alive = false;
    };
  }, [source.connId]);

  // 连接 / 命名空间确定后,拉取该范围下的配置列表用于下拉模糊选择
  useEffect(() => {
    if (!conn) return;
    let alive = true;
    setCfgLoading(true);
    setConfigs([]);
    listConfigs(conn, source.tenant, "", "", 1, 500)
      .then((page) => alive && setConfigs(page.pageItems))
      .catch(() => alive && setConfigs([]))
      .finally(() => alive && setCfgLoading(false));
    return () => {
      alive = false;
    };
  }, [source.connId, source.tenant]);

  // dataId 候选（带 group 说明）；group 候选去重
  const dataIdOptions = configs.map((c) => ({ value: c.dataId, sub: c.group }));
  const groupOptions = Array.from(new Set(configs.map((c) => c.group))).map((g) => ({ value: g }));

  return (
    <div className="source-picker">
      <div className="source-title">{title}</div>
      <label className="field">
        <span>连接</span>
        <Select
          className="wide"
          value={source.connId}
          options={connections.map((c) => ({ value: c.id, label: c.name }))}
          onChange={(v) => onChange({ ...emptySource(v) })}
        />
      </label>
      <label className="field">
        <span>命名空间 {nsLoading ? "（加载中…）" : ""}</span>
        <Select
          className="wide"
          value={source.tenant}
          options={[
            { value: "", label: "public（默认）" },
            ...namespaces
              .filter((n) => n.namespace)
              .map((n) => ({ value: n.namespace, label: n.namespaceShowName || n.namespace })),
          ]}
          onChange={(v) => onChange({ ...source, tenant: v })}
        />
      </label>
      <div className="field-row">
        <label className="field">
          <span>dataId {cfgLoading ? "（加载中…）" : `（${configs.length}）`}</span>
          <Combobox
            value={source.dataId}
            placeholder="留空则匹配所有同名 dataId"
            options={dataIdOptions}
            onChange={(v) => onChange({ ...source, dataId: v })}
            onPick={(o) => onChange({ ...source, dataId: o.value, group: o.sub || source.group })}
          />
        </label>
        <label className="field">
          <span>group</span>
          <Combobox
            value={source.group}
            placeholder="DEFAULT_GROUP"
            options={groupOptions}
            onChange={(v) => onChange({ ...source, group: v })}
          />
        </label>
      </div>
    </div>
  );
}

/** 智能对比工作台：任选两个来源（可跨连接 / 跨命名空间 / 跨 dataId）做差异对比。 */
export default function DiffView({ connections }: Props) {
  const firstId = connections[0]?.id ?? "";
  const [left, setLeft] = useState<Source>(emptySource(firstId));
  const [right, setRight] = useState<Source>(emptySource(firstId));
  const [leftLoaded, setLeftLoaded] = useState<Loaded | null>(null);
  const [rightLoaded, setRightLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<DiffMode>("text");

  // 批量匹配相关状态
  const [matchResults, setMatchResults] = useState<{ dataId: string; group: string }[] | null>(null);
  const [matchLoading, setMatchLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchResults, setBatchResults] = useState<
    { dataId: string; leftLabel: string; rightLabel: string; leftText: string; rightText: string; format: Format; identical: boolean }[]
  >([]);
  const [batchLoading, setBatchLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  if (connections.length === 0) {
    return <div className="pad-msg big">请先在「连接管理」中添加 Nacos 连接</div>;
  }

  // 拉取单个来源内容并组装成 Loaded
  const loadOne = async (src: Source, dataId?: string): Promise<Loaded> => {
    const conn = connections.find((c) => c.id === src.connId);
    if (!conn) throw "未选择连接";
    const id = (dataId ?? src.dataId).trim();
    if (!id) throw "未填写 dataId";
    const group = src.group.trim() || "DEFAULT_GROUP";
    const content = await getConfig(conn, src.tenant, id, group);
    return {
      label: `${conn.name} · ${src.tenant || "public"} · ${id}`,
      content,
      format: detectFormat(id, "", content),
    };
  };

  // 判断是否需要走批量匹配
  const needMatch = !left.dataId.trim() || !right.dataId.trim();

  // 匹配同名 dataId
  const doMatch = async () => {
    setMatchLoading(true);
    setError(null);
    setMatchResults(null);
    setBatchResults([]);
    try {
      const lConn = connections.find((c) => c.id === left.connId);
      const rConn = connections.find((c) => c.id === right.connId);
      if (!lConn || !rConn) throw "未选择连接";
      const lGroup = left.group.trim() || "DEFAULT_GROUP";
      const rGroup = right.group.trim() || "DEFAULT_GROUP";

      const [lPage, rPage] = await Promise.all([
        listConfigs(lConn, left.tenant, "", lGroup, 1, 500),
        listConfigs(rConn, right.tenant, "", rGroup, 1, 500),
      ]);

      const lIds = new Set(lPage.pageItems.map((c) => c.dataId));
      const rIds = new Set(rPage.pageItems.map((c) => c.dataId));

      // 如果某一侧指定了 dataId，只保留该 dataId
      let common: string[];
      const lId = left.dataId.trim();
      const rId = right.dataId.trim();
      if (lId && rId) {
        // 两侧都有 → 单一匹配，不应该走到这里，但兜底
        common = [lId];
      } else if (lId) {
        common = rIds.has(lId) ? [lId] : [];
      } else if (rId) {
        common = lIds.has(rId) ? [rId] : [];
      } else {
        common = [...lIds].filter((id) => rIds.has(id)).sort();
      }

      if (common.length === 0) {
        setError("两侧命名空间+group 下没有找到同名 dataId");
        setMatchResults([]);
      } else {
        setMatchResults(common.map((dataId) => ({ dataId, group: lGroup })));
        setSelectedIds(new Set(common));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setMatchLoading(false);
    }
  };

  // 一个按钮同时加载 A、B 并对比；任一失败只标记该侧（单个模式）
  const loadBoth = async () => {
    if (needMatch) {
      await doMatch();
      return;
    }
    setLoading(true);
    setError(null);
    const [a, b] = await Promise.allSettled([loadOne(left), loadOne(right)]);
    const errs: string[] = [];
    if (a.status === "fulfilled") setLeftLoaded(a.value);
    else {
      setLeftLoaded(null);
      errs.push(`来源 A：${a.reason}`);
    }
    if (b.status === "fulfilled") setRightLoaded(b.value);
    else {
      setRightLoaded(null);
      errs.push(`来源 B：${b.reason}`);
    }
    setError(errs.join("    ") || null);
    setLoading(false);
  };

  // 批量对比选中的 dataId
  const loadBatch = async () => {
    if (!matchResults) return;
    const toCompare = matchResults.filter((m) => selectedIds.has(m.dataId));
    if (toCompare.length === 0) return;
    setBatchLoading(true);
    setBatchResults([]);
    setError(null);

    const results: typeof batchResults = [];
    // 并发控制，每批 5 个
    for (let i = 0; i < toCompare.length; i += 5) {
      const chunk = toCompare.slice(i, i + 5);
      const settled = await Promise.allSettled(
        chunk.map(async (m) => {
          const [a, b] = await Promise.all([loadOne(left, m.dataId), loadOne(right, m.dataId)]);
          const prep = (l: Loaded) =>
            mode === "key" ? keysDoc(l.content, l.format) : mode === "lines" ? sortedLinesDoc(l.content) : l.content;
          return {
            dataId: m.dataId,
            leftLabel: a.label,
            rightLabel: b.label,
            leftText: prep(a),
            rightText: prep(b),
            format: (mode === "key" ? "TEXT" : a.format !== "TEXT" ? a.format : b.format) as Format,
            identical: false, // 由 DiffPanel 计算
          };
        })
      );
      for (const s of settled) {
        if (s.status === "fulfilled") results.push(s.value);
      }
    }
    setBatchResults(results);
    setBatchLoading(false);
  };

  const ready = leftLoaded && rightLoaded;
  // 按对比模式决定喂给 diff 的文本
  const prep = (l: Loaded) =>
    mode === "key" ? keysDoc(l.content, l.format) : mode === "lines" ? sortedLinesDoc(l.content) : l.content;
  const leftText = ready ? prep(leftLoaded!) : "";
  const rightText = ready ? prep(rightLoaded!) : "";
  const diffFormat =
    mode === "key" ? "TEXT" : leftLoaded?.format !== "TEXT" ? leftLoaded?.format : rightLoaded?.format;

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
    setSelectedIds((prev) =>
      prev.size === matchResults.length ? new Set() : new Set(matchResults.map((m) => m.dataId))
    );
  };

  const toggleCollapse = (dataId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(dataId)) next.delete(dataId);
      else next.add(dataId);
      return next;
    });
  };

  return (
    <div className="diff-view">
      <div className="diff-sources">
        <SourcePicker title="来源 A（左）" connections={connections} source={left} onChange={setLeft} />
        <SourcePicker title="来源 B（右）" connections={connections} source={right} onChange={setRight} />
      </div>
      <div className="diff-loadbar">
        <span className="fmt-label">对比模式</span>
        <Select
          value={mode}
          options={[
            { value: "text", label: "文本(逐行)" },
            { value: "lines", label: "忽略顺序(整行)" },
            { value: "key", label: "仅 Key(忽略顺序)" },
          ]}
          onChange={(v) => setMode(v as DiffMode)}
        />
        {matchResults ? (
          <button className="btn btn-primary" onClick={loadBatch} disabled={batchLoading || selectedIds.size === 0}>
            {batchLoading ? "对比中…" : `对比选中（${selectedIds.size}）`}
          </button>
        ) : (
          <button className="btn btn-primary" onClick={loadBoth} disabled={loading || matchLoading}>
            {loading || matchLoading ? "加载中…" : "加载并对比"}
          </button>
        )}
        {error && <span className="diff-loaderr">{error}</span>}
      </div>
      <div className="diff-result">
        {/* 批量匹配列表 */}
        {matchResults && matchResults.length > 0 && batchResults.length === 0 && (
          <div className="match-list">
            <div className="match-list-head">
              <label className="match-toggle-all">
                <input
                  type="checkbox"
                  checked={selectedIds.size === matchResults.length}
                  onChange={toggleAll}
                />
                全选
              </label>
              <span className="match-count">
                找到 {matchResults.length} 个同名 dataId，已选 {selectedIds.size} 个
              </span>
            </div>
            <div className="match-items">
              {matchResults.map((m) => (
                <label className="match-item" key={m.dataId}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(m.dataId)}
                    onChange={() => toggleSelect(m.dataId)}
                  />
                  <span className="match-dataid">{m.dataId}</span>
                  <span className="match-group">{m.group}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* 批量对比结果 */}
        {batchResults.length > 0 && (
          <div className="batch-diff">
            {batchResults.map((r) => (
              <div className="batch-diff-item" key={r.dataId}>
                <div
                  className="batch-diff-header"
                  onClick={() => toggleCollapse(r.dataId)}
                >
                  <span className="batch-diff-toggle">{collapsed.has(r.dataId) ? "▶" : "▼"}</span>
                  <span className="batch-diff-title">{r.dataId}</span>
                </div>
                {!collapsed.has(r.dataId) && (
                  <DiffPanel
                    leftLabel={r.leftLabel}
                    rightLabel={r.rightLabel}
                    leftText={r.leftText}
                    rightText={r.rightText}
                    format={r.format}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        {/* 单个对比结果（原有逻辑） */}
        {!matchResults && ready ? (
          <DiffPanel
            leftLabel={leftLoaded!.label}
            rightLabel={rightLoaded!.label}
            leftText={leftText}
            rightText={rightText}
            format={diffFormat}
          />
        ) : !matchResults && !ready ? (
          <div className="pad-msg big">
            选择来源 A、B 后点「加载并对比」
            <div className="diff-hint">
              支持：同一 Nacos 两个配置 · 跨命名空间 · 跨服务器环境对比
              <br />
              dataId 留空可自动匹配两侧同名配置进行批量对比
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
