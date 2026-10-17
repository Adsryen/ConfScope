import type { MouseEvent, ReactNode } from "react";
import { openExternalLink } from "../lib/externalLink";

interface ExternalLinkProps {
  /** 完整的外部地址。留在 DOM 上，右键复制链接、中间点击这些原生习惯才有得用。 */
  href: string;
  className?: string;
  title?: string;
  children: ReactNode;
}

/**
 * 外链的唯一 JSX 出口（R66）。
 *
 * 桌面 webview 里 `window.open` / `target="_blank"` 开不出窗口（Wails 只认 runtime.BrowserOpenURL），
 * 所以点击一律接管后交给 ../lib/externalLink；`target="_blank"` 仍保留，
 * 那是接管失败时（例如脚本异常）的最后一层语义：宁可新开标签，也不要把整个应用导航走。
 * 带修饰键的点击也走同一条路：桌面端原生新窗口本来就不存在，交给浏览器的话两端行为会分叉。
 */
export default function ExternalLink({ href, className, title, children }: ExternalLinkProps) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    void openExternalLink(e.currentTarget.href);
  };

  return (
    <a href={href} className={className} title={title} target="_blank" rel="noopener noreferrer" onClick={onClick}>
      {children}
    </a>
  );
}
