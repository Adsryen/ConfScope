import zhCN from "./zh-CN.json";
import enUS from "./en-US.json";
import { escapeRegex } from "../lib/textMatch";

export type Locale = "zh-CN" | "en-US";
/** 文案插值参数表：值一律按字符串插入，允许数字。 */
export type TranslationParams = Record<string, string | number>;

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

/**
 * 文案参数插值的唯一实现（轮14 波31 / R52）。
 *
 * 两条硬性要求，改动前请先读完：
 * 1. **必须函数替换**。第二参传字符串时 `String.replace` 会把值里的 `$&` / `` $` `` / `$'` / `$1`
 *    当特殊序列展开，用户可见文案直接缺字（波24 R43 在 lib 侧踩过，轮14 实测组件侧 `t()` 仍在踩：
 *    搜索词 `a$&b` 会被渲染成「未找到包含 a{term}b 的配置」，占位符名漏出、原词被吞）。
 * 2. **必须单趟扫描**。逐个 key 循环时，前一个值里字面出现的 `{otherKey}` 会被后一趟再插一遍，
 *    「把用户输入原样回显」的文案会二次变形。
 *
 * 占位符名按字面量转义后入正则；未知占位符原样保留（与历史行为一致，便于发现漏参）。
 */
export function interpolate(text: string, params: TranslationParams = {}): string {
  const names = Object.keys(params);
  if (!text || names.length === 0) return text;
  const pattern = new RegExp(`\\{(${names.map(escapeRegex).join("|")})\\}`, "g");
  // 只替换传进来的占位符：漏参时 `{name}` 原样留在界面上，比渲染成 undefined 更容易被发现。
  return text.replace(pattern, (_whole: string, name: string) => String(params[name]));
}

export function translate(key: string, params: TranslationParams = {}): string {
  return interpolate(getTranslation(currentLocale(), key), params);
}
