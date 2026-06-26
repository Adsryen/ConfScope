import { useTranslation } from '../i18n';
import { Locale, localeNames } from '../locales';

export default function LanguageSwitch() {
  const { locale, setLocale } = useTranslation();

  return (
    <select
      className="lang-switch"
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      title="Switch Language / 切换语言"
    >
      {(Object.entries(localeNames) as [Locale, string][]).map(([key, name]) => (
        <option key={key} value={key}>
          {name}
        </option>
      ))}
    </select>
  );
}
