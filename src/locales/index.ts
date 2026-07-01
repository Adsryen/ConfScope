import zhCN from './zh-CN.json';
import enUS from './en-US.json';

export type Locale = 'zh-CN' | 'en-US';

export const locales: Record<Locale, Record<string, any>> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

export const localeNames: Record<Locale, string> = {
  'zh-CN': '中文',
  'en-US': 'English',
};

/**
 * 根据 key 获取翻译文本，支持嵌套 key（如 "app.title"）
 */
export function getTranslation(locale: Locale, key: string): string {
  const keys = key.split('.');
  let value: any = locales[locale];

  for (const k of keys) {
    if (value && typeof value === 'object' && k in value) {
      value = value[k];
    } else {
      // 找不到翻译时返回 key 本身
      // eslint-disable-next-line no-console
      console.warn(`Translation missing: ${key} for locale ${locale}`);
      return key;
    }
  }

  return typeof value === 'string' ? value : key;
}
