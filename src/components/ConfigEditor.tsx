import { useRef, useState } from "react";
import { Connection, connectionDisplayLabel } from "../store/connections";
import { EscapePriority, useEscape } from "../lib/useEscape";
import { Format, FORMATS, nacosType } from "../lib/format";
import { reportError } from "../lib/errorCenter";
import { validateConfigIssues } from "../lib/validate";
import { useTranslation } from "../i18n";
import { recordOperation } from "../store/operationHistory";
import AlertModal, { type AlertItem } from "./AlertModal";
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
  const connectionName = conn.name || connectionDisplayLabel(conn);
  const namespaceLabel = namespace || "public";

  // 编辑器自身的 Esc：交给分层注册表。内部的校验提示（confirm）与自绘下拉（dropdown）
  // 优先级更高，打开时先吃掉 Esc，不会再出现「一次 Esc 同时关下拉和编辑器」。
  useEscape(active, onClose, EscapePriority.overlay);

  const save = () => {
    if (!dataId.trim()) {
      setError(t('config.dataIdRequired'));
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
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{t("config.newConfigTitle")}</h3>
          <button className="modal-x" onClick={onClose} title={t("common.close")} aria-label={t("common.close")}>
            ×
          </button>
        </div>
        <div className="modal-body editor-body">
          <div className="field-row">
            <label className="field">
              <span>{t('config.dataId')}</span>
              <input
                className="search-input wide mono"
                value={dataId}
                placeholder={t('config.dataIdPlaceholder')}
                autoFocus
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => setDataId(e.target.value)}
              />
            </label>
            <label className="field">
              <span>{t('config.groupLabel')}</span>
              <input
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
                active={active}
              />
            </div>
          </label>
          {error && (
            <div className="test-msg err">
              <span>{error}</span>
              <CopyButton text={error} label={t("common.copyError")} />
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? t('config.publishing') : t('config.publish')}
          </button>
        </div>
      </div>

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
