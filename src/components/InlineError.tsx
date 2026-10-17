import { useTranslation } from "../i18n";
import CopyButton from "./CopyButton";

interface Props {
  /** 错误标题，一律由站点传 t("…") 文案。 */
  title: string;
  /** 原样展示的详情文本（含 Error: 前缀之类的一律在写入时就清干净）。 */
  message: string;
  /** 传了就渲染重试按钮；重试逻辑仍由站点自己决定。 */
  onRetry?: () => void;
  retryLabel?: string;
  copyLabel?: string;
  /** 站点专属类（如 app-data-backup-error），只调间距不改结构。 */
  extraClassName?: string;
}

/**
 * 内联错误块的唯一出口（轮13 波28 / R48）。
 *
 * 为什么要收：13 份手抄的 head+title+actions+pre 结构里，role="alert" 播报、
 * 详情区 tabIndex={0}+role="region" 这些无障碍属性全靠「写的人恰好记得抄」，
 * 漏一份键盘用户就滚不到错误正文。收成一个组件后，新站点想漏都漏不掉。
 *
 * 统一带 .inline-error-actions 包裹（原先 3 份手抄把 CopyButton 直接放 head 里）：
 * head 是 flex + space-between，actions 是 flex + gap + flex-shrink:0，
 * 单个按钮时视觉等价，长标题不再把按钮挤没。
 */
export default function InlineError({ title, message, onRetry, retryLabel, copyLabel, extraClassName }: Props) {
  const { t } = useTranslation();
  return (
    <div className={extraClassName ? `inline-error ${extraClassName}` : "inline-error"} role="alert">
      <div className="inline-error-head">
        <span className="inline-error-title">{title}</span>
        <div className="inline-error-actions">
          {onRetry && (
            <button className="btn btn-ghost btn-sm" onClick={onRetry}>
              {retryLabel ?? t("common.retry")}
            </button>
          )}
          <CopyButton text={message} label={copyLabel ?? t("common.copyError")} />
        </div>
      </div>
      <pre className="inline-error-body" tabIndex={0} role="region" aria-label={t("common.errorDetail")}>
        {message}
      </pre>
    </div>
  );
}
