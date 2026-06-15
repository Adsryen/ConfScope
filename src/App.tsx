import { useEffect, useState } from "react";
import { Connection, loadConnections } from "./store/connections";
import { listNamespaces, Namespace } from "./api/nacos";
import ConnectionManager from "./components/ConnectionManager";
import ConfigBrowser from "./components/ConfigBrowser";
import DiffView from "./components/DiffView";

type Mode = "browse" | "diff";

export default function App() {
  const [connections, setConnections] = useState<Connection[]>(loadConnections());
  const [activeConnId, setActiveConnId] = useState<string>(connections[0]?.id ?? "");
  const [namespaces, setNamespaces] = useState<Namespace[]>([]);
  const [nsLoading, setNsLoading] = useState(false);
  const [nsError, setNsError] = useState<string | null>(null);
  const [tenant, setTenant] = useState<string>("");
  const [mode, setMode] = useState<Mode>("browse");
  const [showConnMgr, setShowConnMgr] = useState(connections.length === 0);

  const activeConn = connections.find((c) => c.id === activeConnId) ?? null;

  // 连接列表变化后，确保 activeConnId 有效
  useEffect(() => {
    if (connections.length === 0) {
      setActiveConnId("");
    } else if (!connections.some((c) => c.id === activeConnId)) {
      setActiveConnId(connections[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections]);

  // 切换连接：重置命名空间并拉取
  useEffect(() => {
    if (!activeConn) {
      setNamespaces([]);
      return;
    }
    let alive = true;
    setNsLoading(true);
    setNsError(null);
    setTenant(activeConn.defaultNamespace || "");
    listNamespaces(activeConn)
      .then((ns) => alive && setNamespaces(ns))
      .catch((e) => {
        if (!alive) return;
        setNsError(String(e));
        setNamespaces([]);
      })
      .finally(() => alive && setNsLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConnId]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-name">配置中心</span>
          <span className="brand-sub">Nacos 配置管理</span>
        </div>

        <div className="topbar-controls">
          <div className="mode-switch">
            <button
              className={`mode-btn${mode === "browse" ? " active" : ""}`}
              onClick={() => setMode("browse")}
            >
              配置浏览
            </button>
            <button
              className={`mode-btn${mode === "diff" ? " active" : ""}`}
              onClick={() => setMode("diff")}
            >
              智能对比
            </button>
          </div>

          {mode === "browse" && (
            <>
              <select
                className="search-input"
                value={activeConnId}
                onChange={(e) => setActiveConnId(e.target.value)}
                disabled={connections.length === 0}
              >
                {connections.length === 0 && <option value="">无连接</option>}
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>

              <select
                className="search-input"
                value={tenant}
                onChange={(e) => setTenant(e.target.value)}
                disabled={!activeConn || nsLoading}
                title="命名空间"
              >
                <option value="">{nsLoading ? "命名空间加载中…" : "public（默认）"}</option>
                {namespaces
                  .filter((n) => n.namespace)
                  .map((n) => (
                    <option key={n.namespace} value={n.namespace}>
                      {n.namespaceShowName || n.namespace}（{n.configCount}）
                    </option>
                  ))}
              </select>
            </>
          )}

          <button className="btn btn-ghost btn-sm" onClick={() => setShowConnMgr(true)}>
            连接管理
          </button>
        </div>
      </header>

      <main className="workspace">
        {connections.length === 0 ? (
          <div className="pad-msg big">
            还没有任何 Nacos 连接
            <button className="btn btn-primary" onClick={() => setShowConnMgr(true)}>
              添加连接
            </button>
          </div>
        ) : mode === "browse" ? (
          !activeConn ? (
            <div className="pad-msg big">请选择一个连接</div>
          ) : nsError ? (
            <div className="pad-msg big err">
              无法连接到 {activeConn.name}
              <div className="diff-hint">{nsError}</div>
            </div>
          ) : (
            <ConfigBrowser key={`${activeConnId}:${tenant}`} conn={activeConn} tenant={tenant} />
          )
        ) : (
          <DiffView connections={connections} />
        )}
      </main>

      {showConnMgr && (
        <ConnectionManager
          onClose={() => setShowConnMgr(false)}
          onChange={(conns) => setConnections(conns)}
        />
      )}
    </div>
  );
}
