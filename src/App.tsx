import { useEffect, useState } from "react";
import { Connection, connectionDisplayLabel, loadConnections } from "./store/connections";
import { listNamespaces, Namespace } from "./api/nacos";
import { useTranslation } from "./i18n";
import ConnectionManager from "./components/ConnectionManager";
import ConfigBrowser from "./components/ConfigBrowser";
import DiffView from "./components/DiffView";
import About from "./components/About";
import Select from "./components/Select";
import Toaster from "./components/Toaster";
import SettingsView from "./components/SettingsView";
import SSHManagerView from "./components/SSHManagerView";
import ErrorDialog from "./components/ErrorDialog";
import MessageCenter from "./components/MessageCenter";
import { reportError } from "./lib/errorCenter";

type Mode = "browse" | "diff" | "connections" | "ssh" | "audit" | "backup" | "tasks" | "settings" | "about";

const navIconPath: Record<Mode, string[]> = {
  browse: [
    "M4 5h16",
    "M4 10h16",
    "M4 15h10",
    "M4 20h8",
  ],
  diff: [
    "M6 4v5c0 2 1 3 3 3h6",
    "M6 20v-5c0-2 1-3 3-3h6",
    "M15 8l4 4-4 4",
  ],
  connections: [
    "M5 5h9v6H5z",
    "M10 11v4",
    "M10 18h4",
    "M17 15h2a2 2 0 012 2v1a2 2 0 01-2 2h-2a2 2 0 01-2-2v-1a2 2 0 012-2z",
    "M7 8h5",
  ],
  ssh: [
    "M5 12h5",
    "M14 12h5",
    "M10 8l4 4-4 4",
    "M6 7a3 3 0 100 6 3 3 0 000-6z",
    "M18 11a3 3 0 100 6 3 3 0 000-6z",
  ],
  audit: [
    "M4 5h16v14H4z",
    "M4 10h16",
    "M9 5v14",
    "M15 5v14",
  ],
  backup: [
    "M5 7c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3z",
    "M5 7v8c0 1.7 3.1 3 7 3s7-1.3 7-3V7",
    "M5 11c0 1.7 3.1 3 7 3s7-1.3 7-3",
    "M16 17l3 3",
    "M19 17l-3 3",
  ],
  tasks: [
    "M5 7l2 2 4-4",
    "M13 8h6",
    "M5 16l2 2 4-4",
    "M13 17h6",
  ],
  settings: [
    "M5 7h14",
    "M5 12h14",
    "M5 17h14",
    "M9 5v4",
    "M15 10v4",
    "M11 15v4",
  ],
  about: [
    "M12 11v6",
    "M12 7h.01",
    "M12 22a10 10 0 100-20 10 10 0 000 20z",
  ],
};

function NavIcon({ mode }: { mode: Mode }) {
  return (
    <svg className="side-icon" viewBox="0 0 24 24" aria-hidden="true">
      {navIconPath[mode].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

const UI_KEY = "cs.ui";
function loadUI(): { connId?: string; mode?: Mode; sidebarCollapsed?: boolean } {
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
  const [tenantFollowsDefault, setTenantFollowsDefault] = useState(true);
  const knownMode = ["browse", "diff", "connections", "ssh", "audit", "backup", "tasks", "settings", "about"].includes(ui0.mode ?? "")
    ? ui0.mode!
    : "browse";
  const [mode, setMode] = useState<Mode>(connections.length === 0 ? "connections" : knownMode);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(!!ui0.sidebarCollapsed);
  // 自增即重新拉取命名空间（用于「重试」）。
  const [nsReload, setNsReload] = useState(0);

  const activeConn = connections.find((c) => c.id === activeConnId) ?? null;

  // 记住上次的连接与模式
  useEffect(() => {
    localStorage.setItem(UI_KEY, JSON.stringify({ connId: activeConnId, mode, sidebarCollapsed }));
  }, [activeConnId, mode, sidebarCollapsed]);

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
      setTenant("");
      setTenantFollowsDefault(true);
      return;
    }
    let alive = true;
    setNsLoading(true);
    setNsError(null);
    listNamespaces(activeConn)
      .then((ns) => alive && setNamespaces(ns))
      .catch((e) => {
        if (!alive) return;
        const message = String(e);
        setNsError(message);
        setNamespaces([]);
        reportError({
          title: "命名空间加载失败",
          source: connectionDisplayLabel(activeConn),
          message,
          detail: message,
          actionLabel: t('common.retry'),
          onAction: () => setNsReload((x) => x + 1),
        });
      })
      .finally(() => alive && setNsLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConnId, nsReload]);

  useEffect(() => {
    setTenantFollowsDefault(true);
  }, [activeConnId]);

  useEffect(() => {
    if (!activeConn || !tenantFollowsDefault) return;
    setTenant(activeConn.defaultNamespace || "");
  }, [activeConn?.defaultNamespace, activeConnId, tenantFollowsDefault]);

  const navItems: { mode: Mode; label: string; unavailable?: boolean }[] = [
    { mode: "browse", label: t('app.title'), unavailable: connections.length === 0 },
    { mode: "diff", label: t('app.diff'), unavailable: connections.length === 0 },
    { mode: "connections", label: t('app.connectionManage') },
    { mode: "ssh", label: t('app.sshTunnels') },
    { mode: "audit", label: t('app.audit'), unavailable: true },
    { mode: "backup", label: t('app.backup'), unavailable: true },
    { mode: "tasks", label: t('app.tasks'), unavailable: true },
    { mode: "settings", label: t('app.settings') },
    { mode: "about", label: t('app.about') },
  ];

  const plannedPage = (title: string, description: string) => (
    <div className="planned-page">
      <div className="planned-badge">{t('app.planned')}</div>
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  );

  const browsePage = (
    <div className="page-surface browse-page">
      <div className="page-header browse-header">
        <div>
          <h3>{t('app.title')}</h3>
          <div className="page-subtitle">{activeConn ? connectionDisplayLabel(activeConn) : t('app.selectConnection')}</div>
        </div>
        <div className="page-actions">
          <Select
            value={activeConnId}
            disabled={connections.length === 0}
            title={t('app.connection')}
            options={connections.map((c) => ({ value: c.id, label: connectionDisplayLabel(c) }))}
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
            onChange={(value) => {
              setTenant(value);
              setTenantFollowsDefault(false);
            }}
          />
        </div>
      </div>
      {!activeConn ? (
        <div className="pad-msg big">{t('app.selectConnection')}</div>
      ) : nsError ? (
        <div className="pad-msg big err">
          {t('app.cannotConnect', { name: activeConn.name })}
          <div className="diff-hint">{nsError}</div>
          <div className="err-actions">
            <button className="btn btn-primary" onClick={() => setNsReload((x) => x + 1)}>
              {t('common.retry')}
            </button>
            <button className="btn btn-ghost" onClick={() => setMode("connections")}>
              {t('app.connectionManage')}
            </button>
          </div>
        </div>
      ) : (
        <ConfigBrowser key={`${activeConnId}:${tenant}`} conn={activeConn} tenant={tenant} />
      )}
    </div>
  );

  return (
    <div className="app-shell">
      <div className="app-main">
        <aside className={`sidebar${sidebarCollapsed ? " collapsed" : ""}`}>
          <nav className="side-nav">
            {navItems.map((item) => (
              <button
                key={item.mode}
                className={`side-nav-item${mode === item.mode ? " active" : ""}`}
                title={sidebarCollapsed ? item.label : undefined}
                onClick={() => setMode(item.mode)}
              >
                <NavIcon mode={item.mode} />
                <span className="side-label">{item.label}</span>
                {item.unavailable && <span className="nav-planned">{t('app.planned')}</span>}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <MessageCenter collapsed={sidebarCollapsed} />
            <button
              className="sidebar-toggle"
              title={sidebarCollapsed ? t('app.expandSidebar') : t('app.collapseSidebar')}
              onClick={() => setSidebarCollapsed((value) => !value)}
            >
              {sidebarCollapsed ? ">" : "<"}
            </button>
          </div>
        </aside>

        <main className="workspace">
        {mode === "connections" ? (
          <ConnectionManager
            embedded
            onClose={() => setMode(connections.length ? "browse" : "connections")}
            onChange={(conns) => setConnections(conns)}
          />
        ) : mode === "audit" ? (
          plannedPage(t('app.audit'), t('app.auditPlanned'))
        ) : mode === "backup" ? (
          plannedPage(t('app.backup'), t('app.backupPlanned'))
        ) : mode === "tasks" ? (
          plannedPage(t('app.tasks'), t('app.tasksPlanned'))
        ) : mode === "ssh" ? (
          <SSHManagerView />
        ) : mode === "settings" ? (
          <SettingsView />
        ) : connections.length === 0 ? (
          <div className="pad-msg big">
            {t('app.noConnection')}
            <button className="btn btn-primary" onClick={() => setMode("connections")}>
              {t('app.addConnection')}
            </button>
          </div>
        ) : mode === "browse" ? (
          browsePage
        ) : mode === "diff" ? (
          <DiffView connections={connections} />
        ) : mode === "about" ? (
          <About embedded />
        ) : null}
        </main>
      </div>

      <Toaster />
      <ErrorDialog />
    </div>
  );
}
