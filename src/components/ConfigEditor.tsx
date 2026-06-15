import { useEffect, useState } from "react";
import { Connection } from "../store/connections";
import { publishConfig } from "../api/nacos";
import { Format, FORMATS, nacosType } from "../lib/format";
import Select from "./Select";

interface Props {
  conn: Connection;
  namespace: string;
  onClose: () => void;
  onSaved: (dataId: string, group: string) => void;
}

/** 新建配置：填写 dataId / group / 格式 / 内容并发布到 Nacos。 */
export default function ConfigEditor({ conn, namespace, onClose, onSaved }: Props) {
  const [dataId, setDataId] = useState("");
  const [group, setGroup] = useState("DEFAULT_GROUP");
  const [fmt, setFmt] = useState<Format>("YAML");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    if (!dataId.trim()) {
      setError("dataId 不能为空");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await publishConfig(
        conn,
        namespace,
        dataId.trim(),
        group.trim() || "DEFAULT_GROUP",
        content,
        nacosType(fmt)
      );
      onSaved(dataId.trim(), group.trim() || "DEFAULT_GROUP");
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>新建配置</h3>
          <button className="modal-x" onClick={onClose} title="关闭">
            ×
          </button>
        </div>
        <div className="modal-body editor-body">
          <div className="field-row">
            <label className="field">
              <span>dataId</span>
              <input
                className="search-input wide mono"
                value={dataId}
                placeholder="application.yaml"
                autoFocus
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => setDataId(e.target.value)}
              />
            </label>
            <label className="field">
              <span>group</span>
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
              <span>格式</span>
              <Select
                className="wide"
                value={fmt}
                options={FORMATS.map((f) => ({ value: f, label: f }))}
                onChange={(v) => setFmt(v as Format)}
              />
            </label>
          </div>
          <label className="field">
            <span>内容</span>
            <textarea
              className="editor-area mono"
              value={content}
              placeholder="在此输入配置内容…"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setContent(e.target.value)}
            />
          </label>
          {error && <div className="test-msg err">{error}</div>}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? "发布中…" : "发布"}
          </button>
        </div>
      </div>
    </div>
  );
}
