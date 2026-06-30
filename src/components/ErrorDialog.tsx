import { useEffect, useMemo, useState } from "react";
import { AppErrorItem, closeMessageDetail, subscribeActiveError } from "../lib/errorCenter";
import CopyButton from "./CopyButton";

function displayText(item: AppErrorItem): string {
  return item.detail || item.message;
}

export default function ErrorDialog() {
  const [current, setCurrent] = useState<AppErrorItem | null>(null);

  useEffect(() => subscribeActiveError(setCurrent), []);

  const fullText = useMemo(() => (current ? displayText(current) : ""), [current]);

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMessageDetail();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current]);

  if (!current) return null;

  const close = () => closeMessageDetail();
  const runAction = () => {
    close();
    current.onAction?.();
  };

  return (
    <div className="modal-overlay error-overlay" onClick={close}>
      <div className="modal modal-error" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header error-header">
          <div>
            <h3>{current.title}</h3>
            {current.source && <div className="error-source">{current.source}</div>}
          </div>
          <button className="modal-x" onClick={close} title="关闭">
            ×
          </button>
        </div>
        <div className="modal-body error-body">
          <div className="error-summary">{current.message}</div>
          {current.detail && current.detail !== current.message && (
            <>
              <div className="error-detail-title">完整错误</div>
              <pre className="error-detail">{current.detail}</pre>
            </>
          )}
        </div>
        <div className="modal-footer error-footer">
          <CopyButton text={fullText} label="复制完整错误" />
          <span className="spacer" />
          {current.onAction && (
            <button className="btn btn-ghost" onClick={runAction}>
              {current.actionLabel || "重试"}
            </button>
          )}
          <button className="btn btn-primary" onClick={close}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
