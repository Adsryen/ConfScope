import { useId, useRef } from "react";
import { useTranslation } from "../i18n";
import { useDialogFocus } from "../lib/useDialogFocus";
import { useOverlayDismiss } from "../lib/useOverlayDismiss";
import { EscapePriority, useEscape } from "../lib/useEscape";

interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /**
   * 正文下的补充要点（如迁移条目数、体积、是否需重启、旧位置保留说明）。
   * 用途是把「确认前必须看到的事实」结构化摆出来，而不是一整段话糊在 message 里。
   */
  details?: string[];
  /**
   * 宿主页面是否在前台。配置浏览被保活隐藏时，弹层虽然看不见，
   * 但仍会在 Esc 分层注册表里排在高位，并把焦点陷阱伸到其他模式的界面上，
   * 等于替其他模式吃掉按键。传 false 交出这两条职责。
   */
  active?: boolean;
}

/** 通用确认弹框(无需输入,用于「放弃未保存修改」等)。 */
export default function ConfirmModal({ title, message, details, confirmLabel, cancelLabel, danger, onConfirm, onCancel, active = true }: Props) {
  const { t } = useTranslation();
  const modalRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const messageId = useId();

  // Esc 交给分层注册表：确认框盖在别的弹层上时，一次 Esc 只关确认框这一层。
  useEscape(active, onCancel, EscapePriority.confirm);
  // Enter 不再挂全局监听：由焦点所在按钮原生激活，语义与视觉焦点一致。
  useDialogFocus({ active, containerRef: modalRef });
  const overlayDismiss = useOverlayDismiss(onCancel);

  return (
    <div className="modal-overlay" {...overlayDismiss}>
      <div
        ref={modalRef}
        className="modal modal-sm"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3 id={titleId}>{title}</h3>
          <button className="modal-x" onClick={onCancel} title={t("common.close")} aria-label={t("common.close")}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <p id={messageId} className="confirm-msg">
            {message}
          </p>
          {details && details.length > 0 && (
            <ul className="confirm-details">
              {details.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="modal-footer">
          {/* 危险动作默认焦点落在「取消」：误按回车只会离开，不会丢数据。 */}
          <button className="btn btn-ghost" onClick={onCancel} {...(danger ? { "data-dialog-autofocus": "" } : {})}>
            {cancelLabel || t("common.cancel")}
          </button>
          <button
            className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
            onClick={onConfirm}
            {...(danger ? {} : { "data-dialog-autofocus": "" })}
          >
            {confirmLabel || t("common.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
