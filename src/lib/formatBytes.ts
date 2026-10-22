/**
 * 字节数的紧凑展示（轮62）。
 *
 * 为什么要单独一个函数而不是 `toLocaleString`：数据位置面板里要横向并排显示迁移体积、
 * 主数据文件大小这类「量级差三个数量级」的数字，固定两位小数会让 1.20 KB 和 1023.45 KB
 * 挤在同一行里对不齐；这里按量级收小数位，同时保证 1023 KB 往上能进到 MB 档。
 * 单位用 B/KB/MB/GB 二进制档位（1024），和 Windows 资源管理器口径一致，
 * 避免用户在文件管理器里核对大小时看到另一个数。
 */
const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes;
  let unit = 0;
  while (unit < UNITS.length - 1 && value >= 1024) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}
