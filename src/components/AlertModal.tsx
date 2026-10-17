import { useEffect } from "react";
import { useTranslation } from "../i18n";
import { EscapePriority, useEscape } from "../lib/useEscape";

interface Props {
  title: string;
  messages: string[];
  onClose: () => void;
  /**
   * 宿主页面是否在前台。配置浏览被保活隐藏时，弹层虽然看不见，
   * 但仍会在 Esc 分层注册表里排在高位、也仍会响应 Enter，
   * 等于替其他模式吃掉按键。传 false 交出这两条职责。
   */
  active?: boolean;
}

/** 仅提示用的弹框(列出若干问题 + 知道了)。 */
export default function AlertModal({ title, messages, onClose, active = true }: Props) {
  const { t } = useTranslation();

  // Esc 交给分层注册表，Enter 仍按原行为关闭。
  useEscape(active, onClose, EscapePriority.confirm);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onClose]);

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
