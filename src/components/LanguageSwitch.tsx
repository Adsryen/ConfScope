import { useTranslation } from '../i18n';
import { Locale, localeNames } from '../locales';

export default function LanguageSwitch() {
  const { locale, setLocale, t } = useTranslation();

  return (
    <select
      className="lang-switch"
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      title={t("app.language")}
    >
      {(Object.entries(localeNames) as [Locale, string][]).map(([key, name]) => (
        <option key={key} value={key}>
          {name}
        </option>
      ))}
    </select>
  );
}
