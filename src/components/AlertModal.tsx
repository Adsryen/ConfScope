import { useEffect } from "react";
import { useTranslation } from "../i18n";

interface Props {
  title: string;
  messages: string[];
  onClose: () => void;
}

/** 仅提示用的弹框(列出若干问题 + 知道了)。 */
export default function AlertModal({ title, messages, onClose }: Props) {
  const { t } = useTranslation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="modal-x" onClick={onClose} title={t('common.close')}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <ul className="alert-list">
            {messages.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
        <div className="modal-footer">
          <button className="btn btn-primary" onClick={onClose}>
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
