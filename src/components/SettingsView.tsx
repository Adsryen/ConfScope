import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../i18n";
import { countMigratableStoredCredentials, migrateStoredCredentials, type CredentialMigrationSummary } from "../lib/credentialSecrets";
import { clearOperationHistory } from "../store/operationHistory";
import { loadSettings, saveSettings, type AppSettings } from "../store/settings";
import AppDataBackupPanel from "./AppDataBackupPanel";
import CopyButton from "./CopyButton";
import LanguageSwitch from "./LanguageSwitch";

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function SettingsView() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [saved, setSaved] = useState(false);
  const [credentialPending, setCredentialPending] = useState(() => countMigratableStoredCredentials());
  const [credentialSummary, setCredentialSummary] = useState<CredentialMigrationSummary | null>(null);
  const [credentialError, setCredentialError] = useState("");
  const [credentialBusy, setCredentialBusy] = useState(false);
  const panelsRef = useRef<HTMLDivElement | null>(null);
  const savedTimerRef = useRef<number | null>(null);

  const sectionLinks = [
    { id: "settings-general", label: t("settings.groupBasic") },
    { id: "settings-network", label: t("settings.groupNetwork") },
    { id: "settings-compare", label: t("settings.comparePreferences") },
    { id: "settings-credentials", label: t("settings.credentials") },
    { id: "settings-backup", label: t("settings.backup") },
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

  const scrollToSection = (id: string) => {
    const container = panelsRef.current;
    const target = document.getElementById(id);
    if (!container || !target) return;
    const containerTop = container.getBoundingClientRect().top;
    const targetTop = target.getBoundingClientRect().top;
    container.scrollTo({
      top: container.scrollTop + targetTop - containerTop,
      behavior: "smooth",
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
      setCredentialError(toErrorMessage(e));
    } finally {
      setCredentialBusy(false);
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
            <button
              key={item.id}
              type="button"
              className="settings-rail-item"
              onClick={() => scrollToSection(item.id)}
            >
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
                  className="search-input"
                  value={settings.proxy.httpProxy}
                  placeholder="http://127.0.0.1:7890"
                  onChange={(e) => update({ proxy: { ...settings.proxy, httpProxy: e.target.value } })}
                />
              </label>
              <label className="field">
                <span>{t("settings.httpsProxy")}</span>
                <input
                  className="search-input"
                  value={settings.proxy.httpsProxy}
                  placeholder="http://127.0.0.1:7890"
                  onChange={(e) => update({ proxy: { ...settings.proxy, httpsProxy: e.target.value } })}
                />
              </label>
              <label className="field">
                <span>{t("settings.noProxy")}</span>
                <input
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
                <pre className="inline-error-body">{credentialError}</pre>
              </div>
            )}
          </section>

          <section id="settings-backup" className="settings-panel settings-backup-panel">
            <div className="settings-panel-head">
              <h4>{t("settings.backup")}</h4>
              <div className="settings-panel-description">{t("settings.backupDescription")}</div>
            </div>
            <AppDataBackupPanel />
            <div className="settings-setting-row settings-danger-zone">
              <div>
                <strong>{t("settings.dangerZone")}</strong>
                <div className="settings-panel-description">{t("settings.clearHistoryHint")}</div>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-danger"
                onClick={() => {
                  if (confirm(t("operationHistory.confirmClear"))) {
                    clearOperationHistory();
                  }
                }}
              >
                {t("settings.clearLocalHistory")}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
