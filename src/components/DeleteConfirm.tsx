import { useEffect, useState } from "react";
import { useTranslation } from "../i18n";

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, busy]);

  const confirm = async () => {
    if (!match || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={() => !busy && onCancel()}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{t('config.deleteTitle')}</h3>
          <button className="modal-x" onClick={onCancel} disabled={busy} title={t('common.close')}>
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
            className="search-input wide mono"
            value={input}
            placeholder={name}
            autoFocus
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && confirm()}
          />
          {error && <div className="test-msg err">{error}</div>}
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
