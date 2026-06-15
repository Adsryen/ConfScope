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
            placeholder="搜索或输入 dataId…"
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

  if (connections.length === 0) {
    return <div className="pad-msg big">请先在「连接管理」中添加 Nacos 连接</div>;
  }

  // 拉取单个来源内容并组装成 Loaded
  const loadOne = async (src: Source): Promise<Loaded> => {
    const conn = connections.find((c) => c.id === src.connId);
    if (!conn) throw "未选择连接";
    if (!src.dataId.trim()) throw "未填写 dataId";
    const group = src.group.trim() || "DEFAULT_GROUP";
    const content = await getConfig(conn, src.tenant, src.dataId.trim(), group);
    return {
      label: `${conn.name} · ${src.tenant || "public"} · ${src.dataId.trim()}`,
      content,
      format: detectFormat(src.dataId.trim(), "", content),
    };
  };

  // 一个按钮同时加载 A、B 并对比；任一失败只标记该侧
  const loadBoth = async () => {
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

  const ready = leftLoaded && rightLoaded;
  // 按对比模式决定喂给 diff 的文本
  const prep = (l: Loaded) =>
    mode === "key" ? keysDoc(l.content, l.format) : mode === "lines" ? sortedLinesDoc(l.content) : l.content;
  const leftText = ready ? prep(leftLoaded!) : "";
  const rightText = ready ? prep(rightLoaded!) : "";
  const diffFormat =
    mode === "key" ? "TEXT" : leftLoaded?.format !== "TEXT" ? leftLoaded?.format : rightLoaded?.format;

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
        <button className="btn btn-primary" onClick={loadBoth} disabled={loading}>
          {loading ? "加载中…" : "加载并对比"}
        </button>
        {error && <span className="diff-loaderr">{error}</span>}
      </div>
      <div className="diff-result">
        {ready ? (
          <DiffPanel
            leftLabel={leftLoaded!.label}
            rightLabel={rightLoaded!.label}
            leftText={leftText}
            rightText={rightText}
            format={diffFormat}
          />
        ) : (
          <div className="pad-msg big">
            选择来源 A、B 后点「加载并对比」
            <div className="diff-hint">
              支持：同一 Nacos 两个配置 · 跨命名空间 · 跨服务器环境对比
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
