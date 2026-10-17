import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { interpolate, Locale, getTranslation } from '../locales';

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const saved = localStorage.getItem('locale');
    if (saved === 'zh-CN' || saved === 'en-US') {
      return saved;
    }
    // 检测浏览器语言
    const browserLang = navigator.language;
    if (browserLang.startsWith('zh')) {
      return 'zh-CN';
    }
    return 'en-US';
  });

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      // 插值口径与 lib translate() 同源（轮14 R52）：字符串替换会把值里的 $& / $' / $1 吞掉，
      // 组件侧 124 个 t(key, {…}) 调用点大量直接回显用户输入与底层异常原文，同样中招。
      return interpolate(getTranslation(locale, key), params);
    },
    [locale]
  );

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale);
    localStorage.setItem('locale', newLocale);
  }, []);

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useTranslation() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useTranslation must be used within an I18nProvider');
  }
  return context;
}
