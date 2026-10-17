import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../i18n";
import { countMigratableStoredCredentials, migrateStoredCredentials, type CredentialMigrationSummary } from "../lib/credentialSecrets";
import { clearAppCache } from "../lib/cacheCleanup";
import { formatDateTime } from "../lib/formatDateTime";
import { getAppDataDocInfo, type AppDataDocInfo } from "../lib/appDataDoc";
import { loadAppDataBackupState } from "../store/appDataBackup";
import { clearOperationHistory } from "../store/operationHistory";
import { loadSettings, saveSettings, type AppSettings } from "../store/settings";
import AppDataBackupPanel from "./AppDataBackupPanel";
import ConfirmModal from "./ConfirmModal";
import CopyButton from "./CopyButton";
import { GetDataLocations, OpenDataFolder, type DataLocations } from "../../wailsjs/go/app/App";
import LanguageSwitch from "./LanguageSwitch";
import { scrollBehavior } from "../lib/motion";
import { errorText } from "../lib/errorText";

export default function SettingsView() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [saved, setSaved] = useState(false);
  const [credentialPending, setCredentialPending] = useState(() => countMigratableStoredCredentials());
  const [credentialSummary, setCredentialSummary] = useState<CredentialMigrationSummary | null>(null);
  const [credentialError, setCredentialError] = useState("");
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheResult, setCacheResult] = useState<"" | "ok" | "fail">("");
  const [docInfo, setDocInfo] = useState<AppDataDocInfo | null>(null);
  const [dataLocations, setDataLocations] = useState<DataLocations | null>(null);
  const [openFolderBusy, setOpenFolderBusy] = useState(false);
  const [openFolderError, setOpenFolderError] = useState("");
  // 危险操作二次确认：走应用内 ConfirmModal，不用原生 confirm()
  // （WebView2 里原生对话框跟随系统浅色、破坏主题，且同步阻塞主线程）。
  const [pendingConfirm, setPendingConfirm] = useState<{ title: string; message: string; action: () => void } | null>(null);
  const askConfirm = (title: string, message: string, action: () => void) => setPendingConfirm({ title, message, action });
  const panelsRef = useRef<HTMLDivElement | null>(null);
  const savedTimerRef = useRef<number | null>(null);

  const sectionLinks = [
    { id: "settings-general", label: t("settings.groupBasic") },
    { id: "settings-network", label: t("settings.groupNetwork") },
    { id: "settings-compare", label: t("settings.comparePreferences") },
    { id: "settings-credentials", label: t("settings.credentials") },
    { id: "settings-backup", label: t("settings.backup") },
    { id: "settings-data-locations", label: t("settings.dataLocations") },
    { id: "settings-developer", label: t("settings.developer") },
  ];

  const update = (patch: Partial<AppSettings>) => {
    const next = {
      ...settings,
      ...patch,
      proxy: { ...settings.proxy, ...(patch.proxy ?? {}) },
      compare: { ...settings.compare, ...(patch.compare ?? {}) },
      update: { ...settings.update, ...(patch.update ?? {}) },
    };
    setSettings(next);
    saveSettings(next);
    setSaved(true);
    if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
    savedTimerRef.current = window.setTimeout(() => {
      setSaved(false);
      savedTimerRef.current = null;
    }, 1200);
  };

  useEffect(() => {
    return () => {
      if (savedTimerRef.current !== null) {
        window.clearTimeout(savedTimerRef.current);
        savedTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void getAppDataDocInfo().then((info) => {
      if (alive) setDocInfo(info);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    try {
      GetDataLocations()
        .then((locs) => {
          if (alive && locs && Array.isArray(locs.entries) && locs.entries.length > 0) {
            setDataLocations(locs);
          }
        })
        .catch(() => {
          // 绑定缺失（降级环境）时区块显示不可用提示，不报错
        });
    } catch {
      // 绑定对象缺失该方法（同步异常，如前后端版本错配）同样降级，不整树崩溃
    }
    return () => {
      alive = false;
    };
  }, []);

  const scrollToSection = (id: string) => {
    const container = panelsRef.current;
    const target = document.getElementById(id);
    if (!container || !target) return;
    const containerTop = container.getBoundingClientRect().top;
    const targetTop = target.getBoundingClientRect().top;
    container.scrollTo({
      top: container.scrollTop + targetTop - containerTop,
      behavior: scrollBehavior(),
    });
  };

  const runCredentialMigration = async () => {
    setCredentialError("");
    setCredentialSummary(null);
    setCredentialBusy(true);
    try {
      const summary = await migrateStoredCredentials();
      setCredentialSummary(summary);
      setCredentialPending(countMigratableStoredCredentials());
    } catch (e) {
      setCredentialError(errorText(e));
    } finally {
      setCredentialBusy(false);
    }
  };

  const runOpenDataFolder = async (key: string) => {
    setOpenFolderError("");
    setOpenFolderBusy(true);
    try {
      await OpenDataFolder(key);
    } catch (e) {
      setOpenFolderError(errorText(e));
    } finally {
      setOpenFolderBusy(false);
    }
  };

  const runClearCache = async () => {
    setCacheBusy(true);
    setCacheResult("");
    try {
      await clearAppCache();
      setCacheResult("ok");
    } catch {
      setCacheResult("fail");
    } finally {
      setCacheBusy(false);
    }
  };

  return (
    <div className="page-surface settings-page">
      <div className="page-header">
        <div>
          <h3>{t("app.settings")}</h3>
          <div className="page-subtitle">{t("app.settingsSubtitle")}</div>
        </div>
        {saved && <div className="test-msg ok">{t("settings.settingsSaved")}</div>}
      </div>
      <div className="settings-workbench">
        <aside className="settings-rail" aria-label={t("app.settings")}>
          {sectionLinks.map((item) => (
            <button key={item.id} type="button" className="settings-rail-item" onClick={() => scrollToSection(item.id)}>
              {item.label}
            </button>
          ))}
        </aside>

        <div ref={panelsRef} className="settings-panels">
          <section id="settings-general" className="settings-panel">
            <div className="settings-panel-head">
              <h4>{t("settings.groupBasic")}</h4>
              <div className="settings-panel-description">{t("settings.generalDescription")}</div>
            </div>
            <label className="settings-setting-row">
              <span>{t("app.language")}</span>
              <LanguageSwitch />
            </label>
            <div className="settings-panel-note">{t("settings.connectionScopedNote")}</div>
          </section>

          <section id="settings-network" className="settings-panel">
            <div className="settings-panel-head">
              <h4>{t("settings.groupNetwork")}</h4>
              <div className="settings-panel-description">{t("settings.networkDescription")}</div>
            </div>
            <div className="settings-proxy-grid">
              <label className="field">
                <span>{t("settings.httpProxy")}</span>
                <input
                  type="text"
                  className="search-input"
                  value={settings.proxy.httpProxy}
                  placeholder="http://127.0.0.1:7890"
                  onChange={(e) => update({ proxy: { ...settings.proxy, httpProxy: e.target.value } })}
                />
              </label>
              <label className="field">
                <span>{t("settings.httpsProxy")}</span>
                <input
                  type="text"
                  className="search-input"
                  value={settings.proxy.httpsProxy}
                  placeholder="http://127.0.0.1:7890"
                  onChange={(e) => update({ proxy: { ...settings.proxy, httpsProxy: e.target.value } })}
                />
              </label>
              <label className="field">
                <span>{t("settings.noProxy")}</span>
                <input
                  type="text"
                  className="search-input"
                  value={settings.proxy.noProxy}
                  placeholder="localhost,127.0.0.1"
                  onChange={(e) => update({ proxy: { ...settings.proxy, noProxy: e.target.value } })}
                />
              </label>
            </div>
          </section>

          <section id="settings-compare" className="settings-panel">
            <div className="settings-panel-head">
              <h4>{t("settings.comparePreferences")}</h4>
              <div className="settings-panel-description">{t("settings.compareDescription")}</div>
            </div>
            <label className="settings-setting-row">
              <span>{t("settings.sortConnections")}</span>
              <input
                type="checkbox"
                checked={settings.compare.sortConnections}
                onChange={(e) => update({ compare: { ...settings.compare, sortConnections: e.target.checked } })}
              />
            </label>
            <label className="settings-setting-row">
              <span>{t("settings.sortNamespaces")}</span>
              <input
                type="checkbox"
                checked={settings.compare.sortNamespaces}
                onChange={(e) => update({ compare: { ...settings.compare, sortNamespaces: e.target.checked } })}
              />
            </label>
          </section>

          <section id="settings-credentials" className="settings-panel">
            <div className="settings-panel-head">
              <h4>{t("settings.credentials")}</h4>
              <div className="settings-panel-description">{t("settings.credentialsDescription")}</div>
            </div>
            <div className="settings-setting-row">
              <div>
                <strong>{t("settings.credentialMigrationTitle")}</strong>
                <div className="settings-panel-description">
                  {credentialPending > 0
                    ? t("settings.credentialMigrationPending", { count: credentialPending })
                    : t("settings.credentialMigrationNone")}
                </div>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                disabled={credentialBusy || credentialPending === 0}
                onClick={runCredentialMigration}
              >
                {credentialBusy ? t("settings.migratingCredentials") : t("settings.migrateCredentials")}
              </button>
            </div>
            {credentialSummary && (
              <div className="test-msg ok">
                <span className="test-msg-text">
                  {t("settings.credentialMigrationSummary", {
                    migrated: credentialSummary.migrated,
                    unsupported: credentialSummary.unsupported,
                    failed: credentialSummary.failed,
                  })}
                </span>
              </div>
            )}
            {credentialError && (
              <div className="inline-error" role="alert">
                <div className="inline-error-head">
                  <span className="inline-error-title">{t("settings.credentialMigrationFailed")}</span>
                  <div className="inline-error-actions">
                    <CopyButton text={credentialError} label={t("common.copyError")} />
                  </div>
                </div>
                <pre className="inline-error-body" tabIndex={0} role="region" aria-label={t("common.errorDetail")}>
                  {credentialError}
                </pre>
              </div>
            )}
          </section>

          <section id="settings-backup" className="settings-panel settings-backup-panel">
            <div className="settings-panel-head">
              <h4>{t("settings.backup")}</h4>
              <div className="settings-panel-description">{t("settings.backupDescription")}</div>
            </div>
            {docInfo && (
              <div className="settings-setting-row settings-data-file-row">
                <div>
                  <strong>{t("settings.dataFile")}</strong>
                  <div className="settings-panel-description">{t("settings.dataFileDescription")}</div>
                </div>
                <div className="data-file-info">
                  <div>
                    {t("settings.dataFilePath")}: <code>{docInfo.path || t("settings.dataFileNone")}</code>
                  </div>
                  {docInfo.savedAt && (
                    <div>
                      {t("settings.dataFileLastSaved")}: {formatDateTime(docInfo.savedAt)}
                    </div>
                  )}
                  {(() => {
                    const lastBackupAt = loadAppDataBackupState().activities.find((item) => item.status === "success")?.createdAt ?? "";
                    return lastBackupAt ? (
                      <div>
                        {t("settings.dataFileLastBackup")}: {formatDateTime(lastBackupAt)}
                      </div>
                    ) : null;
                  })()}
                </div>
              </div>
            )}
            <AppDataBackupPanel />
            <div className="settings-setting-row settings-danger-zone">
              <div>
                <strong>{t("settings.dangerZone")}</strong>
                <div className="settings-panel-description">{t("settings.clearHistoryHint")}</div>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-danger"
                onClick={() => askConfirm(t("settings.clearLocalHistory"), t("operationHistory.confirmClear"), clearOperationHistory)}
              >
                {t("settings.clearLocalHistory")}
              </button>
            </div>
          </section>

          <section id="settings-data-locations" className="settings-panel">
            <div className="settings-panel-head">
              <h4>{t("settings.dataLocations")}</h4>
              <div className="settings-panel-description">{t("settings.dataLocationsDescription")}</div>
            </div>
            {dataLocations ? (
              <div className="settings-data-locations">
                {dataLocations.entries.map((entry) => (
                  <div key={entry.key} className="settings-setting-row">
                    <div>
                      <strong>
                        {t(`settings.dataLoc${entry.key.charAt(0).toUpperCase()}${entry.key.slice(1)}`)}
                        {!entry.exists && <span className="settings-data-location-missing">{t("settings.dataLocMissing")}</span>}
                      </strong>
                      <div className="settings-data-location-path" title={entry.path}>
                        <code>{entry.path}</code>
                      </div>
                    </div>
                    <div className="settings-data-location-actions">
                      <CopyButton text={entry.path} />
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={openFolderBusy || !entry.exists}
                        onClick={() => {
                          if (openFolderBusy || !entry.exists) return;
                          void runOpenDataFolder(entry.key);
                        }}
                      >
                        {t("settings.openFolder")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="settings-panel-note">{t("settings.dataLocationsUnavailable")}</div>
            )}
            {openFolderError && (
              <div className="inline-error" role="alert">
                {t("settings.openFolderFailed", { error: openFolderError })}
              </div>
            )}
          </section>
          <section id="settings-developer" className="settings-panel">
            <div className="settings-panel-head">
              <h4>{t("settings.developer")}</h4>
              <div className="settings-panel-description">{t("settings.developerDescription")}</div>
            </div>
            <div className="settings-setting-row">
              <div>
                <strong>{t("settings.clearCache")}</strong>
                <div className="settings-panel-description">{t("settings.clearCacheHint")}</div>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-danger"
                disabled={cacheBusy}
                onClick={() => askConfirm(t("settings.clearCache"), t("settings.confirmClearCache"), () => void runClearCache())}
              >
                {cacheBusy ? "…" : t("settings.clearCache")}
              </button>
            </div>
            {cacheResult === "ok" && <div className="test-msg ok">{t("settings.clearCacheSuccess")}</div>}
            {cacheResult === "fail" && (
              <div className="inline-error" role="alert">
                {t("settings.clearCacheFailed")}
              </div>
            )}
          </section>
        </div>
      </div>

      {pendingConfirm && (
        <ConfirmModal
          title={pendingConfirm.title}
          message={pendingConfirm.message}
          danger
          onConfirm={() => {
            const action = pendingConfirm.action;
            setPendingConfirm(null);
            action();
          }}
          onCancel={() => setPendingConfirm(null)}
        />
      )}
    </div>
  );
}
