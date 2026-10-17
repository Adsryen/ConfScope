import { useTranslation } from "../i18n";
import CopyButton from "./CopyButton";

interface Props {
  /**
   * 错误标题。缺省时走组件级默认 common.operationFailed（「操作失败」）——
   * 这四个字本来就是所有失败场景的兜底说法，没有专属语境时不该逼站点再传一遍；
   * 有专属语境（加载失败 / 生成失败 / 执行失败）的站点继续自己传。
   */
  title?: string;
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
  // 三个标签的默认文案只在这里定义一次，站点侧不许再攒私有对象。
  const heading = title ?? t("common.operationFailed");
  return (
    <div className={extraClassName ? `inline-error ${extraClassName}` : "inline-error"} role="alert">
      <div className="inline-error-head">
        <span className="inline-error-title">{heading}</span>
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
