/**
 * 错误文本的单一出口（R44）。
 *
 * 这之前，仓库里有两套写法各自跑偏：
 * 1. 直接 `String(e)` —— 对 `new Error("boom")` 得到 `Error: boom`，界面上一眼就能看见多余的
 *    `Error: ` 前缀；对 `{ code: "ENOENT" }` 这类非 Error 抛出得到 `[object Object]`，等于没报错。
 * 2. 手抄一份 `e instanceof Error ? e.message : String(e)` —— 全仓 11 个私有副本，第 2 种坑照踩。
 *
 * 这里定下唯一口径，并明确两条边界：
 * - **不截断**：`api/nacos.ts` 的 403 重登、`credentialSecrets.ts` 的 unsupported 判定、
 *   变更计划的 404 判定都要拿全文做子串嗅探，复制错误详情也要求完整；显示层的长度收口归 UI。
 * - **只摘构造器前缀**：历史审计记录、迁移摘要、操作历史里已经存过 `String(e)` 的结果
 *   （落盘的 `"Error: xxx"`），显示时一并擦干净。判据收紧为「必须以 Error/Exception 结尾」，
 *   所以 `EOF: connection reset`、`Nacos returned 403: Invalid signature` 都不会被误伤。
 */

/** 形如 `Error: `、`TypeError: `、`DOMException: ` 的构造器前缀（历史落盘数据里也有）。 */
const CONSTRUCTOR_PREFIX = /^(?:[A-Za-z][A-Za-z0-9_$]*)?(?:Error|Exception):\s+/;

/** 非 Error 抛出对象上常见的正文字段（SDK / axios / 手写 reject 都爱这么放）。 */
const MESSAGE_KEYS = ["message", "msg", "error", "detail", "reason"] as const;

/** 去掉构造器前缀，顺手收掉首尾空白。 */
function stripPrefix(text: string): string {
  return text.replace(CONSTRUCTOR_PREFIX, "").trim();
}

function fromObject(error: object): string {
  const record = error as Record<string, unknown>;
  for (const key of MESSAGE_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  // 没有正文字段就把结构打出来：`{"code":"ENOENT"}` 至少比 `[object Object]` 有用。
  try {
    const json = JSON.stringify(error);
    if (json && json !== "{}" && json !== "[]") return json;
  } catch {
    // 循环引用之类的序列化失败，退回下面的兜底。
  }
  try {
    return String(error);
  } catch {
    // `String(Object.create(null))` 会再抛一次：捕获错误本身不该制造新错误。
    return "";
  }
}

/**
 * 把任意抛出值转成可以直接进界面、日志、剪贴板的文本。
 * 空 message 的 Error 退回 `Error` / `TypeError` 这样的类型名，避免界面出现空白错误。
 */
export function errorText(error: unknown): string {
  if (error instanceof Error) return stripPrefix(error.message) || stripPrefix(String(error));
  // 抛出的字符串同样要摘前缀：历史数据里存的就是 `String(e)` 的结果，重放显示时不能带尾巴。
  if (typeof error === "string") return stripPrefix(error);
  if (error === null) return "null";
  if (error === undefined) return "undefined";
  if (typeof error === "object") return stripPrefix(fromObject(error));
  try {
    return String(error);
  } catch {
    return "";
  }
}
