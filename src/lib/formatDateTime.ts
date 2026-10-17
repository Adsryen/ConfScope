/**
 * 时间显示的唯一事实源（轮11 R41）。
 *
 * 为什么要单独一个模块：显示型时间以前散着写 `toLocaleString()` / `toLocaleTimeString()`，
 * 外加两处手写 `YYYY-MM-DD HH:mm` 拼接。同一个值在列表里是 `2026-10-17 21:40`，
 * 到了详情区就跟着**操作系统**的区域设置变成 `10/17/2026 9:40:07 PM`——换台机器、
 * 切个系统语言就会变，用户分不清哪条时间更新，`9:40 PM` 也没法按字符串排序。
 *
 * 这里固定数字 + 24 小时制：显示型时间属于数据不属于文案，切应用语言不该变，
 * 所以既不接 locale 参数也不用 Intl。解析不出来时退回原值，既不出现 `NaN-NaN`，
 * 也不静默变空白（以前 MessageCenter 返回空串，页面上那一块直接空掉）。
 */

/** 补零到两位。 */
function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 能被显示的时间输入：ISO 串、epoch 秒/毫秒数字或字符串、Date。 */
export type DisplayableTime = string | number | Date | null | undefined;

export interface DateTimeFormatOptions {
  /** 是否显示秒。列表类传 false 只要分钟，详情/日志保留秒。默认 true。 */
  seconds?: boolean;
  /** 解析不出来时的兜底文本。默认退回原值，原值也拿不出手时用 "—"。 */
  fallback?: string;
}

/**
 * 统一解析：纯数字串按 epoch 时间戳处理。
 *
 * 接口层（Nacos v3）给的时间是 epoch 毫秒字符串，`new Date("1755420000000")` 是 Invalid Date，
 * 以前由 `api/nacos.ts` 的 `formatTime` 自己判断，现在收到这里，免得每个显示站点再学一遍。
 */
function toDate(value: DisplayableTime): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const fromNumber = new Date(value);
    return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
  }
  const text = value.trim();
  if (!text) return null;
  if (/^\d{10,}$/.test(text)) {
    const ms = text.length <= 10 ? Number(text) * 1000 : Number(text);
    const fromEpoch = new Date(ms);
    return Number.isNaN(fromEpoch.getTime()) ? null : fromEpoch;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** 解析不出来时的兜底：调用方指定优先，其次退回原值，最后才用占位符。 */
function fallbackText(value: DisplayableTime, options: DateTimeFormatOptions): string {
  if (options.fallback !== undefined) return options.fallback;
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || value instanceof Date) return String(value);
  return "—";
}

/** `2026-10-17 21:40:07`（`seconds: false` 时到分钟）。 */
export function formatDateTime(value: DisplayableTime, options: DateTimeFormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return fallbackText(value, options);
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}${options.seconds === false ? "" : `:${pad(date.getSeconds())}`}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}

/** 只要时刻：`21:40:07`（`seconds: false` 时 `21:40`）。列表里时间戳挤不下整天日期时用这个。 */
export function formatClock(value: DisplayableTime, options: DateTimeFormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return fallbackText(value, options);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}${options.seconds === false ? "" : `:${pad(date.getSeconds())}`}`;
}
