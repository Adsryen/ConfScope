import { useId, useRef, useState } from "react";
import { reportError } from "../lib/errorCenter";
import { EscapePriority, isImeComposing, useEscape } from "../lib/useEscape";
import { useDialogFocus } from "../lib/useDialogFocus";
import { useOverlayDismiss } from "../lib/useOverlayDismiss";
import { useTranslation } from "../i18n";
import CopyButton from "./CopyButton";
import { errorText } from "../lib/errorText";
import { statusMessageProps } from "../lib/statusSemantics";

interface Props {
  /** 需要输入以确认的名称（dataId）。 */
  name: string;
  group: string;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
  /**
   * 四个动作文案（确认按钮 / 进行中 / 失败标题 / 重试）由宿主按「onConfirm 到底做了什么」传入。
   *
   * 为什么要留口子：本组件的防误删结构（输入完整 dataId 才能按）与弹层语义是通用的，
   * 但直写被砍掉之后，宿主给它的 onConfirm 已经不是「删」而是「生成删除计划」——
   * 写死「删除」就会把按钮和「删除中…」一起说谎（轮42）。缺省值保持原样，
   * 让其它宿主与既有测试不必跟着改。
   */
  confirmLabel?: string;
  busyLabel?: string;
  failureTitle?: string;
  retryLabel?: string;
}

/** 删除确认弹框：必须输入 dataId 完全一致才能删除,防误删。 */
export default function DeleteConfirm({
  name,
  group,
  onCancel,
  onConfirm,
  confirmLabel,
  busyLabel,
  failureTitle,
  retryLabel,
}: Props) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const match = input === name;

  // Esc 走分层注册表：确认框盖在别的弹层上时一次只关这一层，删除进行中（busy）不放行。
  useEscape(!busy, onCancel, EscapePriority.confirm);

  // 焦点陷阱：本组件只在父层决定要确认时才挂载，所以 active 恒为 true。
  // 删除进行中（busy）不交出陷阱——那时只剩「取消」还能走，Tab 更不该逃到被遮住的下层。
  const modalRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocus({ active: true, containerRef: modalRef });
  // 删除进行中（busy）时遮罩点不动，与「取消」按钮同时禁用一致（R53）。
  const overlayDismiss = useOverlayDismiss(onCancel, !busy);

  const confirm = async () => {
    if (!match || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      const message = errorText(e);
      setError(message);
      reportError({
        title: failureTitle ?? t("config.deleteConfigFailed"),
        source: `${group} / ${name}`,
        message,
        detail: message,
        actionLabel: retryLabel ?? t("config.retryDelete"),
        onAction: () => confirm(),
      });
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" {...overlayDismiss}>
      <div
        ref={modalRef}
        className="modal modal-sm"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3 id={titleId}>{t("config.deleteTitle")}</h3>
          <button className="modal-x" onClick={onCancel} disabled={busy} title={t("common.close")} aria-label={t("common.close")}>
            ×
          </button>
        </div>
        <div className="modal-body del-body">
          <p className="del-warn">⚠ {t('config.deleteWarning')}</p>
          <div className="del-target mono">
            {name}
            <span className="del-group"> · {group}</span>
          </div>
          <p className="del-hint">
            {t('config.deleteHint')} <b className="mono">{name}</b>
          </p>
          <input
            type="text"
            className="search-input wide mono"
            value={input}
            placeholder={name}
            aria-label={t("config.deleteConfirmInput")}
            autoFocus
            data-dialog-autofocus=""
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // 组合态回车是把候选词上屏到输入框，不是提交删除
              if (isImeComposing(e)) return;
              if (e.key === "Enter") confirm();
            }}
          />
          {error && (
            <div className="test-msg err" {...statusMessageProps("error")}>
              <span>{error}</span>
              <CopyButton text={error} label={t("common.copyError")} />
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-danger-fill" onClick={confirm} disabled={!match || busy}>
            {busy ? (busyLabel ?? t("config.deleting")) : (confirmLabel ?? t("common.delete"))}
          </button>
        </div>
      </div>
    </div>
  );
}
