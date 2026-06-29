import LanguageSwitch from "./LanguageSwitch";
import { useTranslation } from "../i18n";

export default function SettingsView() {
  const { t } = useTranslation();

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

        <section className="settings-section muted">
          <span className="planned-badge">{t('app.planned')}</span>
          <p>{t('app.settingsPlanned')}</p>
        </section>
      </div>
    </div>
  );
}
