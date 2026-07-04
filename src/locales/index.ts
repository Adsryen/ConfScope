import zhCN from "./zh-CN.json";
import enUS from "./en-US.json";

export type Locale = "zh-CN" | "en-US";
type TranslationParams = Record<string, string | number>;

export const locales: Record<Locale, Record<string, unknown>> = {
  "zh-CN": zhCN,
  "en-US": enUS,
};

export const localeNames: Record<Locale, string> = {
  "zh-CN": "中文",
  "en-US": "English",
};

/**
 * 根据 key 获取翻译文本，支持嵌套 key（如 "app.title"）
 */
export function getTranslation(locale: Locale, key: string): string {
  const keys = key.split(".");
  let value: unknown = locales[locale];

  for (const k of keys) {
    if (value && typeof value === "object" && k in value) {
      value = (value as Record<string, unknown>)[k];
    } else {
      // 找不到翻译时返回 key 本身
      // eslint-disable-next-line no-console
      console.warn(`Translation missing: ${key} for locale ${locale}`);
      return key;
    }
  }

  return typeof value === "string" ? value : key;
}

export function currentLocale(): Locale {
  try {
    const saved = localStorage.getItem("locale");
    if (saved === "zh-CN" || saved === "en-US") return saved;
    return navigator.language.startsWith("zh") ? "zh-CN" : "en-US";
  } catch {
    return "zh-CN";
  }
}

export function translate(key: string, params: TranslationParams = {}): string {
  let text = getTranslation(currentLocale(), key);
  for (const [name, value] of Object.entries(params)) {
    text = text.replace(new RegExp(`\\{${name}\\}`, "g"), String(value));
  }
  return text;
}
