import { useId, useRef, useState } from "react";
import { Connection, connectionDisplayLabel } from "../store/connections";
import { EscapePriority, useEscape } from "../lib/useEscape";
import { useDialogFocus } from "../lib/useDialogFocus";
import { useOverlayDismiss } from "../lib/useOverlayDismiss";
import { Format, FORMATS, nacosType } from "../lib/format";
import { reportError } from "../lib/errorCenter";
import { validateConfigIssues } from "../lib/validate";
import { statusMessageProps } from "../lib/statusSemantics";
import { useTranslation } from "../i18n";
import { recordOperation } from "../store/operationHistory";
import AlertModal, { type AlertItem } from "./AlertModal";
import ConfirmModal from "./ConfirmModal";
import CodeEditor, { type CodeEditorHandle } from "./CodeEditor";
import CopyButton from "./CopyButton";
import Select from "./Select";

interface Props {
  conn: Connection;
  namespace: string;
  onClose: () => void;
  onSaved: (dataId: string, group: string) => void;
  /** 宿主页面被保活隐藏时传 false：不响应 Esc，避免其他模式的按键关掉隐藏的新建草稿。 */
  active?: boolean;
}

/** 新建配置：填写 dataId / group / 格式 / 内容并发布到 Nacos。 */
export default function ConfigEditor({ conn, namespace, onClose, active = true }: Props) {
  const { t } = useTranslation();
  const [dataId, setDataId] = useState("");
  // 默认 group 跟随连接配置（留空/DEFAULT_GROUP → DEFAULT_GROUP）
  const [group, setGroup] = useState(() => {
    const g = (conn.defaultGroup ?? "").trim();
    return g && g !== "DEFAULT_GROUP" ? g : "DEFAULT_GROUP";
  });
  const [fmt, setFmt] = useState<Format>("YAML");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validateErrs, setValidateErrs] = useState<AlertItem[]>([]);
  const editorRef = useRef<CodeEditorHandle>(null);
  // 打开瞬间的内容快照：判「脏」只比 dataId 与正文（轮5 登记的 R36，波13 落地）。
  // group/fmt 的改动不算——那是下拉一拨就有的动作，拦住只会被用户当成「怎么关不掉了」。
  const initialRef = useRef({ dataId, content });
  const [askDiscard, setAskDiscard] = useState(false);
  const connectionName = conn.name || connectionDisplayLabel(conn);
  const namespaceLabel = namespace || "public";

  const isDirty = () => dataId !== initialRef.current.dataId || content !== initialRef.current.content;
  // 四处出口（Esc / 点遮罩 / × / 底部「取消」）都必须走这里，不许再留直连 onClose 的旁路：
  // 手写半天的 YAML 以前点一下遮罩就永久没了，没有撤销也没有确认。
  const attemptClose = () => {
    if (isDirty()) setAskDiscard(true);
    else onClose();
  };

  // 编辑器自身的 Esc：交给分层注册表。内部的校验提示（confirm）与自绘下拉（dropdown）
  // 优先级更高，打开时先吃掉 Esc，不会再出现「一次 Esc 同时关下拉和编辑器」。
  useEscape(active, attemptClose, EscapePriority.overlay);

  // 焦点陷阱：宿主页面被保活隐藏时（active=false）交出职责，
  // 里面的「放弃草稿」确认框与校验错误框各自还有一层陷阱，内层优先。
  const modalRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocus({ active, containerRef: modalRef });
  const overlayDismiss = useOverlayDismiss(attemptClose);

  const save = () => {
    if (!dataId.trim()) {
      setError(t("config.dataIdRequired"));
      return;
    }
    const problems = validateConfigIssues(content, fmt);
    if (problems.length) {
      setValidateErrs(problems.map((p) => ({ text: p.message, line: p.line }))); // 弹框提示并禁止发布
      return;
    }
    setSaving(true);
    setError(null);
    const targetDataId = dataId.trim();
    const targetGroup = group.trim() || "DEFAULT_GROUP";
    const configType = nacosType(fmt);
    const message = t("api.directWriteRequiresApplyPlan");
    recordOperation({
      type: "publish",
      result: "failure",
      connectionId: conn.id,
      connectionName,
      namespace: namespaceLabel,
      group: targetGroup,
      dataId: targetDataId,
      content,
      afterContent: content,
      configType,
      rollbackable: false,
      rollbackReason: "operationHistory.rollbackOnlySuccess",
      error: message,
    });
    setError(message);
    reportError({
      title: t("config.createConfigFailed"),
      source: `${connectionName} / ${namespaceLabel} / ${targetGroup} / ${targetDataId}`,
      message,
      detail: message,
      actionLabel: t("config.retryPublish"),
      onAction: () => save(),
    });
    setSaving(false);
  };

  return (
    <div
      className="modal-overlay"
      // useOverlayDismiss 已判「点击是否落在遮罩自身」：内层确认框/校验框的遮罩铺满视口，
      // 关它们的那一下会冒泡到这层，若不挡掉就会立刻被 attemptClose 重新问一遍（R36 的坑，R53 收进同一实现）。
      {...overlayDismiss}
    >
      <div
        ref={modalRef}
        className="modal modal-lg"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3 id={titleId}>{t("config.newConfigTitle")}</h3>
          <button className="modal-x" onClick={attemptClose} title={t("common.close")} aria-label={t("common.close")}>
            ×
          </button>
        </div>
        <div className="modal-body editor-body">
          <div className="field-row">
            <label className="field">
              <span>{t('config.dataId')}</span>
              <input
                type="text"
                className="search-input wide mono"
                value={dataId}
                placeholder={t('config.dataIdPlaceholder')}
                autoFocus
                data-dialog-autofocus=""
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => setDataId(e.target.value)}
              />
            </label>
            <label className="field">
              <span>{t('config.groupLabel')}</span>
              <input
                type="text"
                className="search-input mono"
                value={group}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => setGroup(e.target.value)}
              />
            </label>
            <label className="field" style={{ flex: "0 0 130px" }}>
              <span>{t('config.formatLabel')}</span>
              <Select
                className="wide"
                value={fmt}
                options={FORMATS.map((f) => ({ value: f, label: f }))}
                onChange={(v) => setFmt(v as Format)}
              />
            </label>
          </div>
          <label className="field">
            <span>{t('config.contentLabel')}</span>
            <div className="editor-host fixed">
              <CodeEditor
                ref={editorRef}
                value={content}
                onChange={setContent}
                format={fmt}
                placeholder={t("config.contentPlaceholder")}
                onSave={save}
                ariaLabel={t("config.contentLabel")}
                active={active}
              />
            </div>
          </label>
          {error && (
            <div className="test-msg err" {...statusMessageProps("error")}>
              <span>{error}</span>
              <CopyButton text={error} label={t("common.copyError")} />
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={attemptClose}>
            {t("common.cancel")}
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving} title={t("config.saveShortcutHint")}>
            {saving ? t("config.publishing") : t("config.publish")}
          </button>
        </div>
      </div>

      {askDiscard && (
        <ConfirmModal
          active={active}
          danger
          title={t("config.discardDraftTitle")}
          message={t("config.discardDraftMessage", { dataId: dataId.trim() || t("config.unnamedDraft") })}
          confirmLabel={t("config.discardDraftConfirm")}
          onConfirm={onClose}
          onCancel={() => setAskDiscard(false)}
        />
      )}

      {validateErrs.length > 0 && (
        <AlertModal
          title={t("config.validateFailed")}
          messages={validateErrs}
          onClose={() => setValidateErrs([])}
          active={active}
          onJumpToLine={(line) => {
            setValidateErrs([]);
            editorRef.current?.revealLine(line);
          }}
        />
      )}
    </div>
  );
}
