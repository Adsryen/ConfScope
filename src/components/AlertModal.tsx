import { useId, useRef } from "react";
import { useTranslation } from "../i18n";
import { useDialogFocus } from "../lib/useDialogFocus";
import { EscapePriority, useEscape } from "../lib/useEscape";

/** 弹框里的一条内容：纯文本，或带行号的「可定位」条目（校验错误）。 */
export interface AlertItem {
  text: string;
  line?: number;
}

interface Props {
  title: string;
  messages: (string | AlertItem)[];
  onClose: () => void;
  /**
   * 传了它，带 line 的条目就会多出「跳到第 N 行」动作（R28：报错不再只让你从头滚）。
   * 关闭弹框由调用方决定——跳转通常意味着要回到编辑器。
   */
  onJumpToLine?: (line: number) => void;
  /**
   * 宿主页面是否在前台。配置浏览被保活隐藏时，弹层虽然看不见，
   * 但仍会在 Esc 分层注册表里排在高位，并把焦点陷阱伸到其他模式的界面上，
   * 等于替其他模式吃掉按键。传 false 交出这两条职责。
   */
  active?: boolean;
}

/** 仅提示用的弹框(列出若干问题 + 知道了)。 */
export default function AlertModal({ title, messages, onClose, active = true, onJumpToLine }: Props) {
  const { t } = useTranslation();
  const modalRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const listId = useId();

  // Esc 交给分层注册表；Enter 改由焦点所在的「知道了」按钮原生激活（弹框打开即拿到焦点）。
  useEscape(active, onClose, EscapePriority.confirm);
  useDialogFocus({ active, containerRef: modalRef });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={modalRef}
        className="modal modal-sm"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={listId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3 id={titleId}>{title}</h3>
          <button className="modal-x" onClick={onClose} title={t("common.close")} aria-label={t("common.close")}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <ul id={listId} className="alert-list">
            {messages.map((item, i) => {
              const text = typeof item === "string" ? item : item.text;
              const line = typeof item === "string" ? undefined : item.line;
              return (
                <li key={i}>
                  {text}
                  {line && onJumpToLine && (
                    <button type="button" className="alert-jump" onClick={() => onJumpToLine(line as number)}>
                      {t("config.jumpToLine", { line })}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
        <div className="modal-footer">
          <button className="btn btn-primary" onClick={onClose} data-dialog-autofocus="">
            {t("common.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
