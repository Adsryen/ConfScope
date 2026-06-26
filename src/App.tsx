import { useEffect, useState } from "react";
import { Connection, loadConnections } from "./store/connections";
import { listNamespaces, Namespace } from "./api/nacos";
import { useTranslation } from "./i18n";
import ConnectionManager from "./components/ConnectionManager";
import ConfigBrowser from "./components/ConfigBrowser";
import DiffView from "./components/DiffView";
import About from "./components/About";
import Select from "./components/Select";
import Toaster from "./components/Toaster";
import LanguageSwitch from "./components/LanguageSwitch";

type Mode = "browse" | "diff";

const UI_KEY = "cs.ui";
function loadUI(): { connId?: string; mode?: Mode } {
  try {
    return JSON.parse(localStorage.getItem(UI_KEY) || "{}");
  } catch {
    return {};
  }
}

export default function App() {
  const { t } = useTranslation();
  const [connections, setConnections] = useState<Connection[]>(loadConnections());
  const ui0 = loadUI();
  const [activeConnId, setActiveConnId] = useState<string>(
    connections.some((c) => c.id === ui0.connId) ? ui0.connId! : connections[0]?.id ?? ""
  );
  const [namespaces, setNamespaces] = useState<Namespace[]>([]);
  const [nsLoading, setNsLoading] = useState(false);
  const [nsError, setNsError] = useState<string | null>(null);
  const [tenant, setTenant] = useState<string>("");
  const [mode, setMode] = useState<Mode>(ui0.mode === "diff" ? "diff" : "browse");
  const [showConnMgr, setShowConnMgr] = useState(connections.length === 0);
  const [showAbout, setShowAbout] = useState(false);
  // 自增即重新拉取命名空间（用于「重试」）。
  const [nsReload, setNsReload] = useState(0);

  const activeConn = connections.find((c) => c.id === activeConnId) ?? null;

  // 记住上次的连接与模式
  useEffect(() => {
    localStorage.setItem(UI_KEY, JSON.stringify({ connId: activeConnId, mode }));
  }, [activeConnId, mode]);

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
  }, [activeConnId, nsReload]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <div className="mode-switch">
            <button
              className={`mode-btn${mode === "browse" ? " active" : ""}`}
              onClick={() => setMode("browse")}
            >
              {t('app.title')}
            </button>
            <button
              className={`mode-btn${mode === "diff" ? " active" : ""}`}
              onClick={() => setMode("diff")}
            >
              {t('app.diff')}
            </button>
          </div>
        </div>

        <div className="topbar-controls">
          {mode === "browse" && (
            <>
              <Select
                value={activeConnId}
                disabled={connections.length === 0}
                title={t('app.connection')}
                options={connections.map((c) => ({ value: c.id, label: c.name }))}
                onChange={setActiveConnId}
              />

              <Select
                value={tenant}
                disabled={!activeConn || nsLoading}
                title={t('app.namespace')}
                options={[
                  { value: "", label: nsLoading ? t('app.namespaceLoading') : t('app.namespaceDefault') },
                  ...namespaces
                    .filter((n) => n.namespace)
                    .map((n) => ({
                      value: n.namespace,
                      label: `${n.namespaceShowName || n.namespace}（${n.configCount}）`,
                    })),
                ]}
                onChange={setTenant}
              />
            </>
          )}

          <button className="btn btn-ghost btn-sm" onClick={() => setShowConnMgr(true)}>
            {t('app.connectionManage')}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowAbout(true)}>
            {t('app.about')}
          </button>
          <LanguageSwitch />
        </div>
      </header>

      <main className="workspace">
        {connections.length === 0 ? (
          <div className="pad-msg big">
            {t('app.noConnection')}
            <button className="btn btn-primary" onClick={() => setShowConnMgr(true)}>
              {t('app.addConnection')}
            </button>
          </div>
        ) : mode === "browse" ? (
          !activeConn ? (
            <div className="pad-msg big">{t('app.selectConnection')}</div>
          ) : nsError ? (
            <div className="pad-msg big err">
              {t('app.cannotConnect', { name: activeConn.name })}
              <div className="diff-hint">{nsError}</div>
              <div className="err-actions">
                <button className="btn btn-primary" onClick={() => setNsReload((x) => x + 1)}>
                  {t('common.retry')}
                </button>
                <button className="btn btn-ghost" onClick={() => setShowConnMgr(true)}>
                  {t('app.connectionManage')}
                </button>
              </div>
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

      {showAbout && (
        <About onClose={() => setShowAbout(false)} />
      )}

      <Toaster />
    </div>
  );
}
