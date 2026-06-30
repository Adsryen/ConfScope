import LanguageSwitch from "./LanguageSwitch";
import { useTranslation } from "../i18n";
import { loadSettings, saveSettings, type AppSettings } from "../store/settings";
import { useState } from "react";

export default function SettingsView() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [saved, setSaved] = useState(false);

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

  return (
    <div className="page-surface settings-page">
      <div className="page-header">
        <div>
          <h3>{t('app.settings')}</h3>
          <div className="page-subtitle">{t('app.settingsSubtitle')}</div>
        </div>
      </div>
      <div className="settings-body">
        <section className="settings-section">
          <h4>{t('app.language')}</h4>
          <LanguageSwitch />
        </section>

        <section className="settings-section">
          <h4>{t('settings.comparePreferences')}</h4>
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.compare.sortConnections}
              onChange={(e) => update({ compare: { ...settings.compare, sortConnections: e.target.checked } })}
            />
            <span>{t('settings.sortConnections')}</span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.compare.sortNamespaces}
              onChange={(e) => update({ compare: { ...settings.compare, sortNamespaces: e.target.checked } })}
            />
            <span>{t('settings.sortNamespaces')}</span>
          </label>
        </section>

        <section className="settings-section">
          <h4>{t('settings.networkProxy')}</h4>
          <div className="field-row update-proxy-row">
            <label className="field">
              <span>{t('settings.httpProxy')}</span>
              <input
                className="search-input"
                value={settings.proxy.httpProxy}
                placeholder="http://127.0.0.1:7890"
                onChange={(e) => update({ proxy: { ...settings.proxy, httpProxy: e.target.value } })}
              />
            </label>
            <label className="field">
              <span>{t('settings.httpsProxy')}</span>
              <input
                className="search-input"
                value={settings.proxy.httpsProxy}
                placeholder="http://127.0.0.1:7890"
                onChange={(e) => update({ proxy: { ...settings.proxy, httpsProxy: e.target.value } })}
              />
            </label>
            <label className="field">
              <span>{t('settings.noProxy')}</span>
              <input
                className="search-input"
                value={settings.proxy.noProxy}
                placeholder="localhost,127.0.0.1"
                onChange={(e) => update({ proxy: { ...settings.proxy, noProxy: e.target.value } })}
              />
            </label>
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.update.proxyOnlyForUpdate}
              onChange={(e) => update({ update: { ...settings.update, proxyOnlyForUpdate: e.target.checked } })}
            />
            <span>{t('settings.proxyOnlyForUpdate')}</span>
          </label>
          {saved && <div className="test-msg ok">{t('settings.settingsSaved')}</div>}
        </section>
      </div>
    </div>
  );
}
