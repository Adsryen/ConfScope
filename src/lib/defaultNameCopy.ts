// 中文默认名（哨兵值）的展示层本地化。
//
// 为什么不能直接把 DEFAULT_* 改成英文：这三个串既存在于用户存档（cs.connections 的
// projectName / environmentName / sourceName），又被当作分组与选中的匹配键
// （`filter(conn => connectionEnvironmentName(conn) === activeProject)` 之类）。
// 改值 = 换语言就打断分组 / 选中 / 已存数据。
//
// 所以约定：**数据层永远存 raw 中文哨兵，展示层判哨兵再 t()**。
// - 需要「身份 / 选择键 / 排序键 / 存档值」的地方一律用 raw getter，不要走这里；
// - 需要「给人看的一行字」的地方（文本节点、option label、title、错误面板 source）走这里。
//
// 另外 `environmentTone(name)`（src/lib/envTone.ts）的入参必须继续喂 raw 名：
// 它按「生产 / 预发 / 灰度」等关键词判色调，翻成 Ungrouped 之后虽也落 other，
// 但为了让色调与语言彻底解耦，一律用 raw，别把本地化后的串传进去。
import {
  DEFAULT_ENVIRONMENT_NAME,
  DEFAULT_PROJECT_NAME,
  DEFAULT_SOURCE_NAME,
  type Connection,
  connectionEnvironmentName,
  connectionProjectName,
  connectionSourceName,
} from "../store/connections";

type Translate = (key: string) => string;

const SENTINEL_KEYS: Record<string, string> = {
  [DEFAULT_PROJECT_NAME]: "connection.defaultProjectName",
  [DEFAULT_ENVIRONMENT_NAME]: "connection.defaultEnvironmentName",
  [DEFAULT_SOURCE_NAME]: "connection.defaultSourceName",
};

/** 三个内置默认名翻成当前语言；用户自取的名字原样返回。 */
export function localizeDefaultName(value: string, t: Translate): string {
  const key = SENTINEL_KEYS[value];
  if (!key) return value;
  const translated = t(key);
  // i18n 未命中时 t() 会把 key 原样吐回来——那种情况宁可显示中文默认名，也别露 `connection.xxx`。
  return translated === key ? value : translated;
}

export function projectLabel(conn: Pick<Connection, "projectName">, t: Translate): string {
  return localizeDefaultName(connectionProjectName(conn), t);
}

export function environmentLabel(conn: Pick<Connection, "environmentName">, t: Translate): string {
  return localizeDefaultName(connectionEnvironmentName(conn), t);
}

export function sourceLabel(conn: Pick<Connection, "sourceName" | "name">, t: Translate): string {
  return localizeDefaultName(connectionSourceName(conn), t);
}

/** 展示用的「项目 / 环境 / 来源」三段串；对应 connectionDisplayLabel 的人读版本。 */
export function connectionLabel(conn: Connection, t: Translate): string {
  return `${projectLabel(conn, t)} / ${environmentLabel(conn, t)} / ${sourceLabel(conn, t)}`;
}

/** Select 的 {value,label}：value 保持 raw（它是匹配键），label 走本地化。 */
export function defaultNameOption(value: string, t: Translate): { value: string; label: string } {
  return { value, label: localizeDefaultName(value, t) };
}
