import { useEffect, useState } from "react";
import { Connection } from "../store/connections";
import { getConfig, listNamespaces, Namespace } from "../api/nacos";
import DiffPanel from "./DiffPanel";

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
}

const emptySource = (connId: string): Source => ({
  connId,
  tenant: "",
  dataId: "",
  group: "DEFAULT_GROUP",
});

/** 单侧来源选择器：选连接 / 命名空间 / dataId / group，并加载内容。 */
function SourcePicker({
  title,
  connections,
  source,
  onChange,
  onLoaded,
}: {
  title: string;
  connections: Connection[];
  source: Source;
  onChange: (s: Source) => void;
  onLoaded: (l: Loaded | null) => void;
}) {
  const [namespaces, setNamespaces] = useState<Namespace[]>([]);
  const [nsLoading, setNsLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const load = async () => {
    if (!conn || !source.dataId.trim()) {
      setError("请填写 dataId");
      return;
    }
    setLoading(true);
    setError(null);
    onLoaded(null);
    try {
      const content = await getConfig(
        conn,
        source.tenant,
        source.dataId.trim(),
        source.group.trim() || "DEFAULT_GROUP"
      );
      const nsName =
        namespaces.find((n) => n.namespace === source.tenant)?.namespaceShowName ||
        source.tenant ||
        "public";
      onLoaded({
        label: `${conn.name} · ${nsName} · ${source.dataId.trim()}`,
        content,
      });
    } catch (e) {
      setError(String(e));
      onLoaded(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="source-picker">
      <div className="source-title">{title}</div>
      <label className="field">
        <span>连接</span>
        <select
          className="search-input wide"
          value={source.connId}
          onChange={(e) => onChange({ ...emptySource(e.target.value) })}
        >
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>命名空间 {nsLoading ? "（加载中…）" : ""}</span>
        <select
          className="search-input wide"
          value={source.tenant}
          onChange={(e) => onChange({ ...source, tenant: e.target.value })}
        >
          <option value="">public（默认）</option>
          {namespaces
            .filter((n) => n.namespace)
            .map((n) => (
              <option key={n.namespace} value={n.namespace}>
                {n.namespaceShowName || n.namespace}
              </option>
            ))}
        </select>
      </label>
      <div className="field-row">
        <label className="field">
          <span>dataId</span>
          <input
            className="search-input mono"
            value={source.dataId}
            placeholder="application.yaml"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => onChange({ ...source, dataId: e.target.value })}
          />
        </label>
        <label className="field">
          <span>group</span>
          <input
            className="search-input mono"
            value={source.group}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => onChange({ ...source, group: e.target.value })}
          />
        </label>
      </div>
      {error && <div className="test-msg err">{error}</div>}
      <button className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>
        {loading ? "加载中…" : "加载内容"}
      </button>
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

  if (connections.length === 0) {
    return <div className="pad-msg big">请先在「连接管理」中添加 Nacos 连接</div>;
  }

  const ready = leftLoaded && rightLoaded;

  return (
    <div className="diff-view">
      <div className="diff-sources">
        <SourcePicker
          title="来源 A（左）"
          connections={connections}
          source={left}
          onChange={setLeft}
          onLoaded={setLeftLoaded}
        />
        <SourcePicker
          title="来源 B（右）"
          connections={connections}
          source={right}
          onChange={setRight}
          onLoaded={setRightLoaded}
        />
      </div>
      <div className="diff-result">
        {ready ? (
          <DiffPanel
            leftLabel={leftLoaded!.label}
            rightLabel={rightLoaded!.label}
            leftText={leftLoaded!.content}
            rightText={rightLoaded!.content}
          />
        ) : (
          <div className="pad-msg big">
            分别加载来源 A、B 的配置内容后自动对比
            <div className="diff-hint">
              支持：同一 Nacos 两个配置 · 跨命名空间 · 跨服务器环境对比
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
