// 变更向导第三步「选择变更」的人工微调抽屉（轮60）。
//
// 为什么要有它：跨环境同步时来源侧的值常常不能原样落到目标（内网地址、密码、namespace、
// 租户名都不一样）。第三步原本只能整块从左边挑到右，挑完就得进计划，用户没有一处能手写
// 最终要落到右侧的内容。
//
// 为什么是个抽屉而不是三栏 merge editor：本项目的结果面板本来就是「要写出去的那一份」，
// 就地编辑 + 下方既有 diff 回显已经覆盖诉求；三栏要重排整个第三步布局，风险与收益不匹配。
//
// 状态归属：草稿由宿主（DiffView）按文件存放并传进来。以前编辑态挂在明细组件自己的
// useState 上，切换选中项时不会重置，A 文件写了一半的内容会显示在 B 文件上，保存就把 A 的
// 正文塞进了 B 的计划（轮7 R60）。这里沿用同一个教训：面板自己不留正文。
import { useTranslation } from "../i18n";
import CodeEditor from "./CodeEditor";
import { EscapePriority, useEscape } from "../lib/useEscape";
import { statusMessageProps } from "../lib/statusSemantics";
import type { Format } from "../lib/format";

export interface TargetTuneDraft {
  content: string;
  errors: string[];
}

interface Props {
  /** 正在微调哪个文件/配置：写进提示，避免用户不知道自己在改谁。 */
  label: string;
  format: Format;
  /** 宿主是否在前台：保活隐藏的页面不许抢 Esc。 */
  active?: boolean;
  draft: TargetTuneDraft;
  onDraftChange: (next: TargetTuneDraft) => void;
  /** 宿主负责校验：非法文本存不下来，错误写回 draft.errors 并留在编辑态。 */
  onSave: () => void;
  onCancel: () => void;
  /** 还原为右侧原内容（撤销微调）。 */
  onReset: () => void;
  resetDisabled: boolean;
  /** 保存后行级挑块标记失效的解释，宿主算好才传。 */
  notice?: string;
}

export default function TargetTunePanel({
  label,
  format,
  active,
  draft,
  onDraftChange,
  onSave,
  onCancel,
  onReset,
  resetDisabled,
  notice,
}: Props) {
  const { t } = useTranslation();
  /**
   * 收起编辑态：正文不销毁。草稿归宿主（DiffView 按文件存放），Esc 与「取消」走同一条路径，
   * 回来还是同一份字迹——所以这一条出口不需要确认（长文本守门要拦的是「一步到位的丢弃」）。
   * 真正会永久丢字的是「还原右侧原内容」，那条由宿主挂应用内二次确认守门。
   */
  const attemptTuneClose = () => onCancel();
  // 闸门与 Ctrl+F 同源：本页被保活隐藏时抽屉可能还开着，此时不许替前台视图吃掉 Esc。
  useEscape(active ?? true, attemptTuneClose, EscapePriority.overlay);

  return (
    <div className="apply-edit-panel diff-tune-panel">
      <div className="apply-edit-head">
        <span className="apply-edit-hint">
          {t("diff.manualTuneHint", { label })}
        </span>
        <div className="apply-edit-actions">
          <button className="btn btn-ghost btn-sm" type="button" onClick={onReset} disabled={resetDisabled}>
            {t("diff.manualTuneReset")}
          </button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={attemptTuneClose}>
            {t("common.cancel")}
          </button>
          <button className="btn btn-primary btn-sm" type="button" onClick={onSave}>
            {t("diff.manualTuneSave")}
          </button>
        </div>
      </div>
      {draft.errors.length > 0 && (
        <div className="apply-edit-errors" {...statusMessageProps("error")}>
          {draft.errors.map((error, index) => (
            <div key={index}>{error}</div>
          ))}
        </div>
      )}
      {notice && (
        <div className="diff-tune-notice" {...statusMessageProps("info")}>
          {notice}
        </div>
      )}
      <div className="apply-edit-editor">
        <CodeEditor
          value={draft.content}
          onChange={(content) => onDraftChange({ content, errors: [] })}
          format={format}
          ariaLabel={t("diff.manualTuneAria")}
          active={active}
          // Ctrl+S 与浏览/编辑态同一语义：焦点在这份正文里，保存就是保存它（R47）。
          onSave={onSave}
        />
      </div>
    </div>
  );
}
