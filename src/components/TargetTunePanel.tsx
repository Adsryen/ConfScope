// 变更向导第三步「选择变更」的人工微调弹层（轮60 起为抽屉，r136 改为弹窗）。
//
// 为什么要有它：跨环境同步时来源侧的值常常不能原样落到目标（内网地址、密码、namespace、
// 租户名都不一样）。第三步原本只能整块从左边挑到右，挑完就得进计划，用户没有一处能手写
// 最终要落到右侧的内容。
//
// 为什么是弹层而不是内嵌抽屉（r136）：用户手写的正是最终要写进生产的那一份，抽屉被写死
// 300px，一屏只有十几行，改到哪儿全凭记忆。现在共用 EditorDialog，标题直接告诉用户在改哪个
// 文件——弹层挡住背后，列表位置已经认不出文件了。
//
// 状态归属：草稿由宿主（DiffView）按文件存放并传进来。以前编辑态挂在明细组件自己的
// useState 上，切换选中项时不会重置，A 文件写了一半的内容会显示在 B 文件上，保存就把 A 的
// 正文塞进了 B 的计划（轮7 R60）。这里沿用同一个教训：面板自己不留正文。
import { useTranslation } from "../i18n";
import CodeEditor from "./CodeEditor";
import EditorDialog from "./EditorDialog";
import { statusMessageProps } from "../lib/statusSemantics";
import type { Format } from "../lib/format";

export interface TargetTuneDraft {
  content: string;
  errors: string[];
}

interface Props {
  /** 正在微调哪个文件/配置：写进弹窗标题，用户不能靠被挡住的列表位置认文件。 */
  label: string;
  format: Format;
  /** 宿主是否在前台：保活隐藏的页面不许抢 Esc、也不许把焦点陷阱伸到别的界面上。 */
  active?: boolean;
  draft: TargetTuneDraft;
  onDraftChange: (next: TargetTuneDraft) => void;
  /** 宿主负责校验：非法文本存不下来，错误写回 draft.errors 并留在弹窗内。 */
  onSave: () => void;
  onCancel: () => void;
  /** 还原为右侧原内容（撤销微调）。 */
  onReset: () => void;
  resetDisabled: boolean;
}

export default function TargetTunePanel({ label, format, active, draft, onDraftChange, onSave, onCancel, onReset, resetDisabled }: Props) {
  const { t } = useTranslation();
  /**
   * 收起弹层：正文不销毁。草稿归宿主（DiffView 按文件存放），四条出口（× / 取消 / Esc / 点遮罩）
   * 走同一条路径，回来还是同一份字迹——所以这些出口不需要确认（长文本守门要拦的是「一步到位的丢弃」）。
   * 真正会永久丢字的只有「还原右侧原内容」，那条由宿主挂应用内二次确认守门。
   */
  const attemptTuneClose = () => onCancel();

  return (
    <EditorDialog
      title={t("diff.manualTuneDialogTitle", { label })}
      hint={t("diff.manualTuneHint")}
      active={active}
      onClose={attemptTuneClose}
      footer={
        <>
          <button className="btn btn-ghost btn-sm" type="button" onClick={onReset} disabled={resetDisabled}>
            {t("diff.manualTuneReset")}
          </button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={attemptTuneClose}>
            {t("common.cancel")}
          </button>
          <button className="btn btn-primary btn-sm" type="button" onClick={onSave}>
            {t("diff.manualTuneSave")}
          </button>
        </>
      }
    >
      <div className="apply-edit-panel diff-tune-panel">
        {draft.errors.length > 0 && (
          <div className="apply-edit-errors" {...statusMessageProps("error")}>
            {draft.errors.map((error, index) => (
              <div key={index}>{error}</div>
            ))}
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
    </EditorDialog>
  );
}
