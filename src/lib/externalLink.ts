// 外部链接的唯一出口：桌面端交给系统浏览器，web 端回退 window.open，两条路都不通就复制链接。
//
// 为什么必须有这个文件（R66）：Wails v2.13 的 webview 里 window.open / target="_blank"
// 没有任何落地路径——运行时脚本只有 BrowserOpenURL(url) → window.WailsInvoke('BO:'+url)，
// 整个包内既没有 NewWindowRequested 也不拦 window.open，于是「点了没反应」。
// 另一侧 Go 的 BrowserOpenURL 会先过 ValidateAndSanitizeURL：scheme 拒绝 javascript/data/file/ftp/空，
// 并且把空格也列进 shell 元字符黑名单——所以这里必须先归一化，否则又是静默失败。
// 归一化用的是 WHATWG URL 解析，顺手把空格编码成 %20，与 Go 侧的口径对齐。

import { translate } from "../locales";
import { copyText } from "./clipboard";
import { toast } from "./toast";

/** 允许交给系统浏览器/新窗口的协议。名单外的链接一律拒绝，也不复制。 */
export const EXTERNAL_URL_PROTOCOLS = ["http:", "https:", "mailto:"] as const;

/** helper 只用到这几个成员，声明成窄接口便于测试注入，也避免把整个 Window 类型拖进断言。 */
export interface ExternalWindowLike {
  runtime?: { BrowserOpenURL?: (url: string) => void };
  open?: (url: string, target?: string, features?: string) => unknown;
}

/** 运行时注入对象只在桌面端存在，这里从 globalThis 上取，避免直接引用全局名。 */
function currentWindow(): ExternalWindowLike {
  return (globalThis as { window?: ExternalWindowLike }).window ?? {};
}

/**
 * 校验并归一化外链：协议必须在白名单内，http(s) 必须有 host（与 Go 侧一致）。
 * 返回归一化后的 href；不合法或危险时返回 null。
 */
export function normalizeExternalUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // 没有 scheme 的相对串（如 github.com/x）交系统浏览器没有意义，直接判不安全
    return null;
  }

  const protocols: readonly string[] = EXTERNAL_URL_PROTOCOLS;
  if (!protocols.includes(parsed.protocol)) return null;
  if (parsed.protocol !== "mailto:" && !parsed.host) return null;
  return parsed.href;
}

/**
 * 打开一条已归一化的外链，返回「是否成功交给浏览器」。
 * 有 Wails 运行时就走 BrowserOpenURL（它是 fire-and-forget，JS 侧拿不到失败回执，
 * 所以前提是调用方给的串已经过白名单校验）；没有运行时退回 window.open，
 * 并按返回值判断——弹窗被拦截时它返回 null。任何异常都算失败，不留静默路径。
 */
export function openExternalUrl(url: string, win: ExternalWindowLike = currentWindow()): boolean {
  const safe = normalizeExternalUrl(url);
  if (!safe) return false;

  try {
    const browserOpen = win.runtime?.BrowserOpenURL;
    if (typeof browserOpen === "function") {
      browserOpen(safe);
      return true;
    }
    const opened = win.open?.(safe, "_blank", "noopener,noreferrer");
    return opened !== null && opened !== undefined;
  } catch {
    return false;
  }
}

/**
 * 面向调用方的完整动作：打开失败时把链接复制到剪贴板并说明原因，
 * 用户至少还能自己粘到浏览器里——比「点了没反应」诚实。
 * 危险/畸形链接只报拒绝，绝不复制（复制等于把 javascript: 串递到用户手里的另一个位置）。
 */
export async function openExternalLink(raw: string, win: ExternalWindowLike = currentWindow()): Promise<boolean> {
  const safe = normalizeExternalUrl(raw);
  if (!safe) {
    toast(translate("common.linkUnsafe"), "error");
    return false;
  }

  if (openExternalUrl(safe, win)) return true;

  if (await copyText(safe)) {
    toast(translate("common.openLinkCopied"), "info");
  } else {
    toast(translate("common.copyFailed"), "error");
  }
  return false;
}
