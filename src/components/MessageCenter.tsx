import { useEffect, useMemo, useRef, useState } from "react";
import { copyText } from "../lib/clipboard";
import {
  AppErrorItem,
  clearErrors,
  dismissError,
  markAllMessagesRead,
  showMessageDetail,
  subscribeErrors,
} from "../lib/errorCenter";

function levelLabel(level: AppErrorItem["level"]) {
  if (level === "error") return "错误";
  if (level === "warning") return "警告";
  if (level === "success") return "成功";
  return "信息";
}

function fullText(item: AppErrorItem) {
  return item.detail || item.message;
}

function formatTime(value: string) {
  try {
    return new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
  } catch {
    return "";
  }
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
  const [items, setItems] = useState<AppErrorItem[]>([]);
  const [open, setOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const unread = items.filter((item) => !item.read).length;
  const sorted = useMemo(() => [...items].sort((a, b) => b.id - a.id), [items]);

  useEffect(() => subscribeErrors(setItems), []);
  useEffect(() => {
    if (open && unread > 0) markAllMessagesRead();
  }, [open, unread]);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const openPanel = () => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };

  const scheduleClose = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 220);
  };

  const copyMessage = async (item: AppErrorItem) => {
    if (await copyText(fullText(item))) {
      setCopiedId(item.id);
      window.setTimeout(() => setCopiedId((id) => (id === item.id ? null : id)), 1200);
    }
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
        onFocus={openPanel}
        title="消息中心"
      >
        <svg className="side-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 6h14v10H8l-3 3V6z" />
          <path d="M8 9h8" />
          <path d="M8 12h5" />
        </svg>
        {!collapsed && <span className="side-label">消息中心</span>}
        {unread > 0 && <span className="message-badge">{unread > 99 ? "99+" : unread}</span>}
      </button>

      {open && (
        <div className="message-panel" onMouseEnter={openPanel} onMouseLeave={scheduleClose}>
          <div className="message-panel-head">
            <div>
              <h3>消息中心</h3>
              <span>{items.length ? `${items.length} 条消息` : "暂无消息"}</span>
            </div>
            <button
              className="message-icon-btn"
              onClick={clearErrors}
              disabled={items.length === 0}
              title="清空消息"
              aria-label="清空消息"
            >
              <TrashIcon />
            </button>
          </div>
          <div className="message-list">
            {sorted.length === 0 ? (
              <div className="message-empty">错误、同步进度和系统通知会显示在这里。</div>
            ) : (
              sorted.map((item) => (
                <div key={item.id} className={`message-item message-${item.level}${item.read ? "" : " unread"}`}>
                  <div className="message-item-top">
                    <span className="message-level">{levelLabel(item.level)}</span>
                    <span className="message-time">{formatTime(item.createdAt)}</span>
                    {item.count > 1 && <span className="message-count">x{item.count}</span>}
                  </div>
                  <div className="message-title">{item.title}</div>
                  {item.source && <div className="message-source">{item.source}</div>}
                  <div className="message-text">{item.message}</div>
                  <div className="message-actions">
                    <button className="message-icon-btn" onClick={() => showMessageDetail(item.id)} title="查看详情" aria-label="查看详情">
                      <DetailIcon />
                    </button>
                    <button className="message-icon-btn wide" onClick={() => copyMessage(item)} title="复制完整消息" aria-label="复制完整消息">
                      {copiedId === item.id ? <span className="message-copied">已复制</span> : <CopyIcon />}
                    </button>
                    <button className="message-icon-btn danger" onClick={() => removeMessage(item.id)} title="删除消息" aria-label="删除消息">
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
