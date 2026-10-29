// 长文本编辑弹层的共用外壳（r136）。
//
// 为什么要有它：变更向导第三步「微调右侧」和第四步「编辑目标内容」原来是内嵌在结果区上方的一块抽屉，
// 编辑区被写死 300px / 360px——用户手写的正是最终要落到生产的那份正文，一屏只看得到十几行，
// 改哪儿全凭记忆（用户原话：「这个微调页面不应该内嵌，应该做成弹窗，才能看到更多的内容」）。
// 两处共用这一份外壳，尺寸、焦点、Esc、遮罩这四件事只有一套口径，不会再各修各的、各自漂移。
//
// 外壳只管壳：草稿、校验、保存语义都留在宿主。理由和轮7 R60 同源——
// 编辑态一旦挂在面板自己的 useState 上，切换选中项时不重置，A 文件写了一半会显示到 B 文件上。
//
// 出口语义（本轮定死，别再翻）：`onClose` = **收起**，不是丢弃。手写的字迹留在宿主草稿里，
// 重开还是同一份；因此这四条出口（× / 取消 / Esc / 点遮罩）都不需要二次确认。
// 永久丢弃只有「还原原内容」和「离开本页时放弃草稿」两条出口，各自带应用内 ConfirmModal。
import { useEffect, useId, useRef, type ReactNode } from "react";
import { useTranslation } from "../i18n";
import { useDialogFocus } from "../lib/useDialogFocus";
import { useOverlayDismiss } from "../lib/useOverlayDismiss";
import { EscapePriority, useEscape } from "../lib/useEscape";

interface Props {
  /** 标题：必须带上「正在改哪一份内容」。弹层挡住背后的一切，用户不能再靠列表位置认文件。 */
  title: string;
  /** 标题下的一句提示（可省略）。同一个 label 别在标题和提示里各写一遍。 */
  hint?: string;
  /**
   * 宿主页面是否在前台。配置对比页被保活隐藏时弹层虽然看不见，却仍会在 Esc 分层表里排在高位，
   * 并把焦点陷阱伸到其他模式的界面上——等于替别的视图吃掉按键。传 false 交出这两条职责。
   */
  active?: boolean;
  /** 收起弹层：四条出口共用。语义是收起不是销毁（见文件头）。 */
  onClose: () => void;
  /** 底部动作区，由宿主决定按钮顺序与危险程度（保存类动作放最右，与新建配置弹框一致）。 */
  footer?: ReactNode;
  children: ReactNode;
}

/** 通用「编辑一份长文本」弹层：dialog 语义 + 焦点陷阱 + 遮罩单一实现 + 弹性高度的编辑区。 */
export default function EditorDialog({ title, hint, active, onClose, footer, children }: Props) {
  const { t } = useTranslation();
  const modalRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const hintId = useId();
  const visible = active ?? true;

  // Esc 走分层注册表：内层的确认框（confirm 档）盖在本层上时，一次 Esc 只关那一层。
  useEscape(visible, onClose, EscapePriority.overlay);
  useDialogFocus({ active: visible, containerRef: modalRef });
  const overlayDismiss = useOverlayDismiss(onClose);

  // 初始焦点给正文，不给 ×：陷阱的默认落点是容器内首个可聚焦元素，也就是关闭按钮——
  // 弹层一开焦点就在 × 上，回车等于关窗，用户想直接打字/Ctrl+F 还得先点一下。
  // 这段 effect 排在 useDialogFocus 之后，覆盖它的默认落点；不碰选区（不擅自把光标甩到文首或文末）。
  useEffect(() => {
    if (!visible) return;
    const textarea = modalRef.current?.querySelector<HTMLTextAreaElement>(".code-editor-ta");
    textarea?.focus();
  }, [visible]);

  return (
    <div
      className="modal-overlay"
      // 遮罩关闭只认 useOverlayDismiss 这一份实现：在弹层里选长文本、拖到遮罩上松手，
      // click 会派发到两者最近的共同祖先（= 遮罩），写 onClick={onClose} 的弹层就是这么连草稿一起没的（R53）。
      {...overlayDismiss}
    >
      <div
        ref={modalRef}
        className="modal modal-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...(hint ? { "aria-describedby": hintId } : {})}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3 id={titleId}>{title}</h3>
          <button className="modal-x" type="button" onClick={onClose} title={t("common.close")} aria-label={t("common.close")}>
            ×
          </button>
        </div>
        <div className="modal-body editor-body editor-dialog-body">
          {hint && (
            <p id={hintId} className="apply-edit-hint">
              {hint}
            </p>
          )}
          {children}
        </div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
