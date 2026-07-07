import { useRef, useState } from "react";
import { useTranslation } from "../i18n";
import { clearOperationHistory } from "../store/operationHistory";
import { loadSettings, saveSettings, type AppSettings } from "../store/settings";
import AppDataBackupPanel from "./AppDataBackupPanel";
import LanguageSwitch from "./LanguageSwitch";

export default function SettingsView() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [saved, setSaved] = useState(false);
  const panelsRef = useRef<HTMLDivElement | null>(null);

  const sectionLinks = [
    { id: "settings-general", label: t("settings.groupBasic") },
    { id: "settings-network", label: t("settings.groupNetwork") },
    { id: "settings-compare", label: t("settings.comparePreferences") },
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
    window.setTimeout(() => setSaved(false), 1200);
  };

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
