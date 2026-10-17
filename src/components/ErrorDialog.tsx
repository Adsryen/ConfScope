import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "../i18n";
import { AppErrorItem, closeMessageDetail, subscribeActiveError } from "../lib/errorCenter";
import { EscapePriority, useEscape } from "../lib/useEscape";
import CopyButton from "./CopyButton";

function displayText(item: AppErrorItem): string {
  return item.detail || item.message;
}

export default function ErrorDialog() {
  const { t } = useTranslation();
  const [current, setCurrent] = useState<AppErrorItem | null>(null);

  useEffect(() => subscribeActiveError(setCurrent), []);

  const fullText = useMemo(() => (current ? displayText(current) : ""), [current]);

  // 错误详情盖在应用内所有弹层之上，Esc 优先关掉它自己。
  useEscape(!!current, closeMessageDetail, EscapePriority.global);

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
          <button className="modal-x" onClick={close} title={t("common.close")} aria-label={t("common.close")}>
            ×
          </button>
        </div>
        <div className="modal-body error-body">
          <div className="error-summary">{current.message}</div>
          {current.detail && current.detail !== current.message && (
            <>
              <div className="error-detail-title">{t("errorDialog.fullError")}</div>
              <pre className="error-detail">{current.detail}</pre>
            </>
          )}
        </div>
        <div className="modal-footer error-footer">
          <CopyButton text={fullText} label={t("errorDialog.copyFullError")} />
          <span className="spacer" />
          {current.onAction && (
            <button className="btn btn-ghost" onClick={runAction}>
              {current.actionLabel || t("common.retry")}
            </button>
          )}
          <button className="btn btn-primary" onClick={close}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
