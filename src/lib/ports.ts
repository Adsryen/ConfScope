// 端口类数字输入的唯一口径（R24）。
//
// 改之前，4 个表单各写了一份 `onChange={(e) => set({ port: parseInt(e.target.value) || 22 })}`，
// 谁都不查范围：清空会被 `||` 弹回默认值、输入 0 被 `||` 当 falsy 吞掉、999999 照样能存进配置，
// 一路要到连接超时才暴露。边界常量、判定逻辑与错误文案从此只在这里出现一次，
// 输入框的行内提示、保存按钮的禁用与 save() 的拦截共用同一条判据，不会出现「界面说合法、保存又拦」。

import { translate } from "../locales";

/** TCP 端口下界。0 是保留端口，本地绑定也不该拿来用。 */
export const PORT_MIN = 1;

/** TCP 端口上界。 */
export const PORT_MAX = 65535;

/** SSH 默认端口：留空时失焦回弹用它，不在用户敲字的过程中抢文本。 */
export const SSH_DEFAULT_PORT = 22;

export interface PortCheckOptions {
  /** 已本地化的字段名，出现在错误文案里（如「SSH 端口」）。 */
  label: string;
  /** 是否允许留空。本地端口留空 = 交给系统自动分配。 */
  optional?: boolean;
}

/**
 * 单个端口的合法性判据：合法返回 undefined，非法返回可直接展示的文案。
 * 注意这里不做任何夹取——静默改值本身就是坑，越界要让用户看见并自己改。
 */
export function portIssue(value: number | undefined, options: PortCheckOptions): string | undefined {
  const { label, optional = false } = options;
  if (value === undefined) {
    return optional ? undefined : translate("connection.portRequired", { label });
  }
  if (!Number.isInteger(value)) return translate("connection.portInteger", { label });
  if (value < PORT_MIN || value > PORT_MAX) {
    return translate("connection.portRange", { label, min: PORT_MIN, max: PORT_MAX, value });
  }
  return undefined;
}

/**
 * 一份 SSH 配置的端口问题清单，顺序即展示顺序（先 SSH 端口，后本地端口）。
 * config 为空表示这一屏根本没启用 SSH，不该拿默认值去报错。
 */
export function sshPortIssues(
  config: { port?: number; localPort?: number } | undefined,
  labels: { port: string; localPort: string }
): string[] {
  if (!config) return [];
  const messages = [
    portIssue(config.port, { label: labels.port }),
    portIssue(config.localPort, { label: labels.localPort, optional: true }),
  ];
  return messages.filter((message): message is string => Boolean(message));
}
