import { useId, useRef, useState } from "react";
import { reportError } from "../lib/errorCenter";
import { EscapePriority, isImeComposing, useEscape } from "../lib/useEscape";
import { useDialogFocus } from "../lib/useDialogFocus";
import { useTranslation } from "../i18n";
import CopyButton from "./CopyButton";

interface Props {
  /** 需要输入以确认的名称（dataId）。 */
  name: string;
  group: string;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

/** 删除确认弹框：必须输入 dataId 完全一致才能删除,防误删。 */
export default function DeleteConfirm({ name, group, onCancel, onConfirm }: Props) {
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

  const confirm = async () => {
    if (!match || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      reportError({
        title: t("config.deleteConfigFailed"),
        source: `${group} / ${name}`,
        message,
        detail: message,
        actionLabel: t("config.retryDelete"),
        onAction: () => confirm(),
      });
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={() => !busy && onCancel()}>
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
          <p className="del-warn">⚠️ {t('config.deleteWarning')}</p>
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
            <div className="test-msg err">
              <span>{error}</span>
              <CopyButton text={error} label={t("common.copyError")} />
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-danger" onClick={confirm} disabled={!match || busy}>
            {busy ? t('config.deleting') : t('common.delete')}
          </button>
        </div>
      </div>
    </div>
  );
}
