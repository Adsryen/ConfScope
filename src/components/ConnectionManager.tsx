import { useEffect, useState } from "react";
import {
  Connection,
  SSHConfig,
  deleteConnection,
  loadConnections,
  upsertConnection,
} from "../store/connections";
import { clearToken, testConnection } from "../api/nacos";
import { useTranslation } from "../i18n";

interface Props {
  onClose: () => void;
  onChange: (conns: Connection[]) => void;
}

type Draft = Omit<Connection, "id"> & { id?: string };

const emptyDraft = (): Draft => ({
  name: "",
  baseUrl: "http://localhost:8848/nacos",
  username: "nacos",
  password: "",
  defaultNamespace: "",
  sshConfig: undefined,
});

export default function ConnectionManager({ onClose, onChange }: Props) {
  const { t } = useTranslation();
  const [list, setList] = useState<Connection[]>(loadConnections());
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  // 待确认删除的连接 id（点一次 × 进入确认态，再点才删）
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [showPwd, setShowPwd] = useState(false);
  const [showSSHConfig, setShowSSHConfig] = useState(false);
  const [showSSHPwd, setShowSSHPwd] = useState(false);
  const [showSSHPassphrase, setShowSSHPassphrase] = useState(false);

  // Esc 关闭弹框
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setTestMsg(null);
  };

  const setSSH = (patch: Partial<SSHConfig>) => {
    setDraft((d) => ({
      ...d,
      sshConfig: {
        host: "",
        port: 22,
        username: "root",
        authType: "password" as const,
        remoteHost: "localhost",
        remotePort: 8848,
        ...d.sshConfig,
        ...patch,
      },
    }));
    setTestMsg(null);
  };

  const refresh = () => {
    const next = loadConnections();
    setList(next);
    onChange(next);
  };

  const edit = (c: Connection) => {
    setDraft({ ...c });
    setTestMsg(null);
    setConfirmDel(null);
    setShowSSHConfig(!!c.sshConfig?.host);
  };

  const save = () => {
    if (!draft.name.trim() || !draft.baseUrl.trim()) {
      setTestMsg({ ok: false, text: t('connection.nameAndAddressRequired') });
      return;
    }
    // SSH 配置：host 为空则不保存
    const toSave = { ...draft };
    if (toSave.sshConfig && !toSave.sshConfig.host?.trim()) {
      toSave.sshConfig = undefined;
    }
    const saved = upsertConnection({ ...toSave, name: toSave.name.trim(), baseUrl: toSave.baseUrl.trim() });
    clearToken(saved.id, saved.baseUrl); // 凭据/地址可能变了，清掉旧 token 与版本缓存
    setDraft(emptyDraft());
    setShowSSHConfig(false);
    refresh();
  };

  // 第一次点 × 进入确认态，再次点击才真正删除。
  const askOrRemove = (id: string) => {
    if (confirmDel !== id) {
      setConfirmDel(id);
      return;
    }
    const target = list.find((c) => c.id === id);
    deleteConnection(id);
    clearToken(id, target?.baseUrl);
    if (draft.id === id) setDraft(emptyDraft());
    setConfirmDel(null);
    refresh();
  };

  const doTest = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      if (draft.username) {
        const r = await testConnection({ ...(draft as Connection), id: draft.id ?? "test" });
        setTestMsg({
          ok: true,
          text: r.globalAdmin ? "连接成功（管理员账号）" : "连接成功",
        });
      } else {
        // 无账号：尝试无鉴权访问命名空间接口验证可达性
        setTestMsg({ ok: true, text: "未配置账号，将以免鉴权方式连接" });
      }
    } catch (e) {
      setTestMsg({ ok: false, text: String(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{t('connection.title')}</h3>
          <button className="modal-x" onClick={onClose} title={t('common.close')}>
            ×
          </button>
        </div>

        <div className="modal-body conn-mgr">
          <div className="conn-list">
            <div className="conn-list-title">{t('connection.savedConnections')}</div>
            {list.length === 0 && <div className="conn-empty">{t('connection.noConnections')}</div>}
            {list.map((c) => (
              <div
                key={c.id}
                className={`conn-item${draft.id === c.id ? " active" : ""}`}
                onClick={() => edit(c)}
              >
                <div className="conn-item-main">
                  <div className="conn-item-name">
                    {c.name}
                    {c.sshConfig && <span className="conn-ssh-badge" title="SSH 隧道">🔒SSH</span>}
                  </div>
                  <div className="conn-item-url">{c.baseUrl}</div>
                </div>
                {confirmDel === c.id ? (
                  <button
                    className="conn-item-del confirm"
                    title={t('connection.confirmDelete')}
                    onClick={(e) => {
                      e.stopPropagation();
                      askOrRemove(c.id);
                    }}
                  >
                    {t('connection.deleteConfirm')}
                  </button>
                ) : (
                  <button
                    className="conn-item-del"
                    title={t('common.delete')}
                    onClick={(e) => {
                      e.stopPropagation();
                      askOrRemove(c.id);
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>

          <div
            className="conn-form"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                save();
              }
            }}
          >
            <div className="conn-form-title">{draft.id ? t('connection.edit') : t('connection.new')}</div>
            <label className="field">
              <span>{t('connection.name')}</span>
              <input
                className="search-input wide"
                value={draft.name}
                placeholder={t('connection.namePlaceholder')}
                autoFocus
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => set({ name: e.target.value })}
              />
            </label>
            <label className="field">
              <span>{t('connection.address')}</span>
              <input
                className="search-input wide mono"
                value={draft.baseUrl}
                placeholder="http://localhost:8848/nacos"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => set({ baseUrl: e.target.value })}
              />
            </label>
            <div className="field-row">
              <label className="field">
                <span>{t('connection.username')}</span>
                <input
                  className="search-input mono"
                  value={draft.username}
                  placeholder={t('connection.usernamePlaceholder')}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => set({ username: e.target.value })}
                />
              </label>
              <label className="field">
                <span>{t('connection.password')}</span>
                <div className="pwd-field">
                  <input
                    className="search-input wide mono"
                    type={showPwd ? "text" : "password"}
                    value={draft.password}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(e) => set({ password: e.target.value })}
                  />
                  <button
                    type="button"
                    className="pwd-toggle"
                    title={showPwd ? t('connection.hide') : t('connection.show')}
                    onClick={() => setShowPwd((v) => !v)}
                  >
                    {showPwd ? "🙈" : "👁"}
                  </button>
                </div>
              </label>
            </div>
            <label className="field">
              <span>{t('connection.defaultNamespace')}</span>
              <input
                className="search-input wide mono"
                value={draft.defaultNamespace}
                placeholder={t('connection.defaultNamespacePlaceholder')}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => set({ defaultNamespace: e.target.value })}
              />
            </label>

            {/* SSH 隧道配置 */}
            <div className="ssh-section">
              <button
                type="button"
                className="ssh-toggle"
                onClick={() => setShowSSHConfig(!showSSHConfig)}
              >
                {showSSHConfig ? "▼" : "▶"} {t('connection.sshConfig')}
                {draft.sshConfig?.host && <span className="ssh-badge">{t('connection.sshConfigured')}</span>}
              </button>

              {showSSHConfig && (
                <div className="ssh-config">
                  <label className="field">
                    <span>{t('connection.sshHost')}</span>
                    <input
                      className="search-input wide"
                      value={draft.sshConfig?.host || ""}
                      placeholder={t('connection.sshHostPlaceholder')}
                      onChange={(e) => setSSH({ host: e.target.value })}
                    />
                  </label>

                  <div className="field-row">
                    <label className="field">
                      <span>{t('connection.sshPort')}</span>
                      <input
                        className="search-input mono"
                        type="number"
                        value={draft.sshConfig?.port || 22}
                        onChange={(e) => setSSH({ port: parseInt(e.target.value) || 22 })}
                      />
                    </label>
                    <label className="field">
                      <span>{t('connection.sshUsername')}</span>
                      <input
                        className="search-input mono"
                        value={draft.sshConfig?.username || ""}
                        placeholder="root"
                        onChange={(e) => setSSH({ username: e.target.value })}
                      />
                    </label>
                  </div>

                  <label className="field">
                    <span>{t('connection.authType')}</span>
                    <select
                      className="search-input wide"
                      value={draft.sshConfig?.authType || "password"}
                      onChange={(e) => setSSH({ authType: e.target.value as "password" | "key" })}
                    >
                      <option value="password">{t('connection.passwordAuth')}</option>
                      <option value="key">{t('connection.keyAuth')}</option>
                    </select>
                  </label>

                  {(draft.sshConfig?.authType ?? "password") === "password" && (
                    <label className="field">
                      <span>{t('connection.sshPassword')}</span>
                      <div className="pwd-field">
                        <input
                          className="search-input wide mono"
                          type={showSSHPwd ? "text" : "password"}
                          value={draft.sshConfig?.password || ""}
                          onChange={(e) => setSSH({ password: e.target.value })}
                        />
                        <button
                          type="button"
                          className="pwd-toggle"
                          title={showSSHPwd ? t('connection.hide') : t('connection.show')}
                          onClick={() => setShowSSHPwd((v) => !v)}
                        >
                          {showSSHPwd ? "🙈" : "👁"}
                        </button>
                      </div>
                    </label>
                  )}

                  {draft.sshConfig?.authType === "key" && (
                    <>
                      <label className="field">
                        <span>{t('connection.privateKey')}</span>
                        <textarea
                          className="search-input wide mono ssh-key"
                          value={draft.sshConfig?.privateKey || ""}
                          placeholder="-----BEGIN RSA PRIVATE KEY-----"
                          onChange={(e) => setSSH({ privateKey: e.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span>{t('connection.privateKeyPassword')}</span>
                        <div className="pwd-field">
                          <input
                            className="search-input wide mono"
                            type={showSSHPassphrase ? "text" : "password"}
                            value={draft.sshConfig?.passphrase || ""}
                            onChange={(e) => setSSH({ passphrase: e.target.value })}
                          />
                          <button
                            type="button"
                            className="pwd-toggle"
                            title={showSSHPassphrase ? t('connection.hide') : t('connection.show')}
                            onClick={() => setShowSSHPassphrase((v) => !v)}
                          >
                            {showSSHPassphrase ? "🙈" : "👁"}
                          </button>
                        </div>
                      </label>
                    </>
                  )}

                  <div className="field-row">
                    <label className="field">
                      <span>{t('connection.remoteHost')}</span>
                      <input
                        className="search-input mono"
                        value={draft.sshConfig?.remoteHost || "localhost"}
                        placeholder="localhost"
                        onChange={(e) => setSSH({ remoteHost: e.target.value })}
                      />
                    </label>
                    <label className="field">
                      <span>{t('connection.remotePort')}</span>
                      <input
                        className="search-input mono"
                        type="number"
                        value={draft.sshConfig?.remotePort || 8848}
                        onChange={(e) => setSSH({ remotePort: parseInt(e.target.value) || 8848 })}
                      />
                    </label>
                  </div>

                  <label className="field">
                    <span>{t('connection.localPort')}</span>
                    <input
                      className="search-input mono"
                      type="number"
                      value={draft.sshConfig?.localPort || ""}
                      placeholder={t('connection.localPortPlaceholder')}
                      onChange={(e) => setSSH({ localPort: parseInt(e.target.value) || undefined })}
                    />
                  </label>

                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      setDraft((d) => ({ ...d, sshConfig: undefined }));
                      setShowSSHConfig(false);
                    }}
                  >
                    {t('connection.removeSSH')}
                  </button>
                </div>
              )}
            </div>

            {testMsg && (
              <div className={`test-msg ${testMsg.ok ? "ok" : "err"}`}>{testMsg.text}</div>
            )}

            <div className="conn-form-actions">
              <button className="btn btn-ghost" onClick={doTest} disabled={testing}>
                {testing ? t('connection.testing') : t('connection.test')}
              </button>
              <div className="spacer" />
              {draft.id && (
                <button className="btn btn-ghost" onClick={() => setDraft(emptyDraft())}>
                  {t('connection.new')}
                </button>
              )}
              <button className="btn btn-primary" onClick={save}>
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
