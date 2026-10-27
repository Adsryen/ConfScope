import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../i18n";
import { copyText } from "../lib/clipboard";
import { formatClock } from "../lib/formatDateTime";
import { toast } from "../lib/toast";
import {
  AppErrorItem,
  clearErrors,
  dismissError,
  markAllMessagesRead,
  showMessageDetail,
  subscribeErrors,
} from "../lib/errorCenter";

function levelLabel(level: AppErrorItem["level"], t: (key: string) => string) {
  if (level === "error") return t("messageCenter.levelError");
  if (level === "warning") return t("messageCenter.levelWarning");
  if (level === "success") return t("messageCenter.levelSuccess");
  return t("messageCenter.levelInfo");
}

function fullText(item: AppErrorItem) {
  return item.detail || item.message;
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 7h14" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M8 7l1-3h6l1 3" />
      <path d="M7 7l1 13h8l1-13" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 8h10v12H8z" />
      <path d="M6 16H4V4h12v2" />
    </svg>
  );
}

function DetailIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 5h12v14H6z" />
      <path d="M9 9h6" />
      <path d="M9 13h6" />
      <path d="M9 17h3" />
    </svg>
  );
}

export default function MessageCenter({ collapsed }: { collapsed?: boolean }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<AppErrorItem[]>([]);
  const [open, setOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const copiedTimer = useRef<number | undefined>(undefined);
  const unread = items.filter((item) => !item.read).length;
  const sorted = useMemo(() => [...items].sort((a, b) => b.id - a.id), [items]);

  useEffect(() => subscribeErrors(setItems), []);
  useEffect(() => {
    if (open && unread > 0) markAllMessagesRead();
  }, [open, unread]);
  useEffect(
    () => () => {
      window.clearTimeout(closeTimer.current);
      window.clearTimeout(copiedTimer.current);
    },
    []
  );

  const openPanel = () => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };

  const scheduleClose = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 220);
  };

  const copyMessage = async (item: AppErrorItem) => {
    // 失败要说一声：WebView 拦剪贴板时以前点了没反应（轮6 R51）
    if (await copyText(fullText(item))) {
      window.clearTimeout(copiedTimer.current);
      setCopiedId(item.id);
      copiedTimer.current = window.setTimeout(() => setCopiedId((id) => (id === item.id ? null : id)), 1200);
      return;
    }
    toast(t("common.copyFailed"), "error");
  };

  const removeMessage = (id: number) => {
    dismissError(id);
    if (items.length <= 1) setOpen(false);
  };

  return (
    <div className="message-center" onMouseEnter={openPanel} onMouseLeave={scheduleClose}>
      <button
        className={`message-center-btn${open ? " active" : ""}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        onFocus={openPanel}
        title={t("messageCenter.title")}
      >
        <svg className="side-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 6h14v10H8l-3 3V6z" />
          <path d="M8 9h8" />
          <path d="M8 12h5" />
        </svg>
        {!collapsed && <span className="side-label">{t("messageCenter.title")}</span>}
        {unread > 0 && <span className="message-badge">{unread > 99 ? "99+" : unread}</span>}
      </button>

      {/* 未读数的读屏播报（轮94）。口径的另一半：系统自发的好消息不再抢即时通道，
          「看得见」就得由角标这一侧还回来——静默登记如果只是变哑，这条改动就不该做。
          活区必须常驻且挂在 button 的兄弟节点：button 里换文案读屏不一定会念，
          条件渲染整块也等于没有活区（内容插入前活区就得存在，见 Toaster 的同款注释）。 */}
      <span className="message-live" role="status" aria-live="polite" aria-atomic="true">
        {unread > 0
          ? t(unread === 1 ? "messageCenter.unreadAnnounceOne" : "messageCenter.unreadAnnounce", { count: unread })
          : ""}
      </span>

      {open && (
        <div className="message-panel" onMouseEnter={openPanel} onMouseLeave={scheduleClose}>
          <div className="message-panel-head">
            <div>
              <h3>{t("messageCenter.title")}</h3>
              <span>
                {items.length
                  ? t(items.length === 1 ? "messageCenter.messageCountOne" : "messageCenter.messageCount", { count: items.length })
                  : t("messageCenter.noMessages")}
              </span>
            </div>
            <button
              className="message-icon-btn"
              onClick={clearErrors}
              disabled={items.length === 0}
              title={t("messageCenter.clear")}
              aria-label={t("messageCenter.clear")}
            >
              <TrashIcon />
            </button>
          </div>
          <div className="message-list">
            {sorted.length === 0 ? (
              <div className="message-empty">{t("messageCenter.emptyHint")}</div>
            ) : (
              sorted.map((item) => (
                <div key={item.id} className={`message-item message-${item.level}${item.read ? "" : " unread"}`}>
                  <div className="message-item-top">
                    <span className="message-level">{levelLabel(item.level, t)}</span>
                    <span className="message-time">{formatClock(item.createdAt)}</span>
                    {item.count > 1 && <span className="message-count">x{item.count}</span>}
                  </div>
                  <div className="message-title">{item.title}</div>
                  {item.source && <div className="message-source">{item.source}</div>}
                  <div className="message-text">{item.message}</div>
                  <div className="message-actions">
                    <button
                      className="message-icon-btn"
                      onClick={() => showMessageDetail(item.id)}
                      title={t("messageCenter.viewDetail")}
                      aria-label={t("messageCenter.viewDetail")}
                    >
                      <DetailIcon />
                    </button>
                    <button
                      className="message-icon-btn wide"
                      onClick={() => copyMessage(item)}
                      title={t("messageCenter.copyFull")}
                      aria-label={t("messageCenter.copyFull")}
                    >
                      {copiedId === item.id ? <span className="message-copied">{t("messageCenter.copied")}</span> : <CopyIcon />}
                    </button>
                    <button
                      className="message-icon-btn danger"
                      onClick={() => removeMessage(item.id)}
                      title={t("messageCenter.delete")}
                      aria-label={t("messageCenter.delete")}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
