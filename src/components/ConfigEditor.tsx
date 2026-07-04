import { useEffect, useState } from "react";
import { Connection, connectionDisplayLabel } from "../store/connections";
import { publishConfig } from "../api/nacos";
import { Format, FORMATS, nacosType } from "../lib/format";
import { reportError } from "../lib/errorCenter";
import { toast } from "../lib/toast";
import { validateConfig } from "../lib/validate";
import { useTranslation } from "../i18n";
import { recordOperation } from "../store/operationHistory";
import AlertModal from "./AlertModal";
import CodeEditor from "./CodeEditor";
import CopyButton from "./CopyButton";
import Select from "./Select";

interface Props {
  conn: Connection;
  namespace: string;
  onClose: () => void;
  onSaved: (dataId: string, group: string) => void;
}

/** 新建配置：填写 dataId / group / 格式 / 内容并发布到 Nacos。 */
export default function ConfigEditor({ conn, namespace, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const [dataId, setDataId] = useState("");
  const [group, setGroup] = useState("DEFAULT_GROUP");
  const [fmt, setFmt] = useState<Format>("YAML");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validateErrs, setValidateErrs] = useState<string[]>([]);
  const connectionName = conn.name || connectionDisplayLabel(conn);
  const namespaceLabel = namespace || "public";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    if (!dataId.trim()) {
      setError(t('config.dataIdRequired'));
      return;
    }
    const problems = validateConfig(content, fmt);
    if (problems.length) {
      setValidateErrs(problems); // 弹框提示并禁止发布
      return;
    }
    setSaving(true);
    setError(null);
    const targetDataId = dataId.trim();
    const targetGroup = group.trim() || "DEFAULT_GROUP";
    const configType = nacosType(fmt);
    try {
      await publishConfig(conn, namespace, targetDataId, targetGroup, content, configType);
      recordOperation({
        type: "publish",
        result: "success",
        connectionId: conn.id,
        connectionName,
        namespace: namespaceLabel,
        group: targetGroup,
        dataId: targetDataId,
        content,
        afterContent: content,
        configType,
        rollbackable: false,
        rollbackReason: "operationHistory.rollbackMissingContent",
      });
      toast(t('config.configCreated'));
      onSaved(targetDataId, targetGroup);
    } catch (e) {
      const message = String(e);
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
        title: "新建配置失败",
        source: `${connectionName} / ${namespaceLabel} / ${targetGroup} / ${targetDataId}`,
        message,
        detail: message,
        actionLabel: "重试发布",
        onAction: () => save(),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{t('config.newConfigTitle')}</h3>
          <button className="modal-x" onClick={onClose} title={t('common.close')}>
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
                value={content}
                onChange={setContent}
                format={fmt}
                placeholder={t('config.contentPlaceholder')}
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
          title={t('config.validateFailed')}
          messages={validateErrs}
          onClose={() => setValidateErrs([])}
        />
      )}
    </div>
  );
}
