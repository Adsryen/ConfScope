import { useState } from "react";
import { TestSSHConnection } from "../../wailsjs/go/app/App";
import { useTranslation } from "../i18n";
import type { Connection, SSHConfig } from "../store/connections";
import {
  deleteSSHProfile,
  listSSHProfileReferences,
  loadSSHProfiles,
  normalizeSSHConfig,
  upsertSSHProfile,
  type SSHProfile,
} from "../store/sshProfiles";
import NumberField from "./NumberField";
import { PORT_MAX, PORT_MIN, SSH_DEFAULT_PORT, portIssue, sshPortIssues } from "../lib/ports";
import { errorText } from "../lib/errorText";
import { statusMessageProps } from "../lib/statusSemantics";

type Draft = {
  id?: string;
  name: string;
  config: SSHConfig;
};

const emptyDraft = (): Draft => ({
  name: "",
  config: {
    host: "",
    port: SSH_DEFAULT_PORT,
    username: "root",
    authType: "password",
  },
});

function fallbackLatencyText(startedAt: number): string {
  return `${Math.max(1, Date.now() - startedAt)}ms`;
}

function latencyText(result: unknown, startedAt: number): string {
  const latencyMs = typeof result === "object" && result !== null && "latencyMs" in result
    ? Number((result as { latencyMs?: unknown }).latencyMs)
    : NaN;
  if (Number.isFinite(latencyMs) && latencyMs >= 0) {
    return `${Math.max(1, Math.round(latencyMs))}ms`;
  }
  return fallbackLatencyText(startedAt);
}

function sshTestKey(config: SSHConfig): string {
  return JSON.stringify(normalizeSSHConfig(config));
}

interface Props {
  // 轮47 R47-04：连接列表由 App 下发（它本来就持有这份 state）。
  // 原来这里渲染期 loadConnections()，读到的值与 props 是同一份真值，却依赖
  // 「全站无 memo + App 每次动作全量重渲染」这个隐含前提——一旦给页面加 memo 当场变陈旧。
  connections: Connection[];
}

export default function SSHManagerView({ connections }: Props) {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<SSHProfile[]>(() => loadSSHProfiles());
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [blockedRefs, setBlockedRefs] = useState<string[]>([]);
  const [pendingSaveImpact, setPendingSaveImpact] = useState(false);
  const [testingKey, setTestingKey] = useState<string | null>(null);

  const referencedProfileIds = new Set(connections.map((conn) => conn.sshProfileId).filter(Boolean));
  const referencedProfiles = profiles.filter((profile) => referencedProfileIds.has(profile.id)).length;
  const inlineSSHCount = connections.filter((conn) => conn.sshConfig && !conn.sshProfileId).length;
  const selectedRefs = draft.id ? listSSHProfileReferences(draft.id, t) : [];
  const activeRefs = blockedRefs.length > 0 ? blockedRefs : selectedRefs;
  const currentProfile = draft.id ? profiles.find((profile) => profile.id === draft.id) : undefined;
  const draftTitle = draft.name.trim() || currentProfile?.name || t('settings.newSSHProfile');
  const currentTestKey = sshTestKey(draft.config);
  const testingCurrent = testingKey === currentTestKey;

  const clearTransient = () => {
    setBlockedRefs([]);
    setPendingSaveImpact(false);
  };

  const refresh = () => setProfiles(loadSSHProfiles());

  const newProfile = () => {
    setDraft(emptyDraft());
    clearTransient();
  };

  const setConfig = (patch: Partial<SSHConfig>) => {
    setDraft((current) => ({
      ...current,
      config: normalizeSSHConfig({ ...current.config, ...patch }),
    }));
    clearTransient();
  };

  const edit = (profile: SSHProfile) => {
    setDraft({
      id: profile.id,
      name: profile.name,
      config: { ...profile.config },
    });
    clearTransient();
  };

  // 端口非法的唯一判据（R24）：与输入框下的行内错误、保存按钮的禁用与 title 同源，不再各写一套
  const portBlock = sshPortIssues(draft.config, {
    port: t("connection.sshPort"),
    localPort: t("connection.localPortShort"),
  })[0];

  const save = () => {
    if (portBlock) {
      setMessage({ ok: false, text: portBlock });
      return;
    }
    const config = normalizeSSHConfig(draft.config);
    if (!draft.name.trim() || !config.host.trim() || !config.username.trim()) {
      setMessage({ ok: false, text: t('settings.sshProfileRequired') });
      return;
    }
    if (draft.id && !pendingSaveImpact) {
      const refs = listSSHProfileReferences(draft.id, t);
      if (refs.length > 0) {
        setBlockedRefs(refs);
        setPendingSaveImpact(true);
        setMessage({
          ok: false,
          text: t('settings.sshProfileUpdateImpact').replace("{count}", String(refs.length)),
        });
        return;
      }
    }
    const saved = upsertSSHProfile({
      id: draft.id,
      name: draft.name.trim(),
      config,
    });
    setDraft({ id: saved.id, name: saved.name, config: { ...saved.config } });
    refresh();
    setMessage({ ok: true, text: t('settings.sshProfileSaved') });
    setBlockedRefs([]);
    setPendingSaveImpact(false);
  };

  const remove = (profile: SSHProfile) => {
    const refs = listSSHProfileReferences(profile.id, t);
    if (refs.length > 0) {
      setDraft({
        id: profile.id,
        name: profile.name,
        config: { ...profile.config },
      });
      setBlockedRefs(refs);
      setMessage({ ok: false, text: t('settings.sshProfileDeleteBlocked').replace("{count}", String(refs.length)) });
      return;
    }
    deleteSSHProfile(profile.id);
    if (draft.id === profile.id) setDraft(emptyDraft());
    refresh();
    setMessage({ ok: true, text: t('settings.sshProfileDeleted') });
    setBlockedRefs([]);
    setPendingSaveImpact(false);
  };

  const testSSHProfile = async () => {
    if (portBlock) {
      setMessage({ ok: false, text: portBlock });
      return;
    }
    const config = normalizeSSHConfig({ ...draft.config });
    const snapshotKey = sshTestKey(config);
    if (!config.host.trim() || !config.username.trim()) {
      setMessage({ ok: false, text: t('settings.sshProfileRequired') });
      return;
    }
    if (config.authType === "password" && !config.password?.trim()) {
      setMessage({ ok: false, text: t('connection.passwordRequired') });
      return;
    }
    if (config.authType === "key" && !config.privateKey?.trim()) {
      setMessage({ ok: false, text: t('connection.keyRequired') });
      return;
    }

    const startedAt = Date.now();
    setTestingKey(snapshotKey);
    setMessage({ ok: true, text: t('settings.sshProfileTesting') });
    setBlockedRefs([]);
    setPendingSaveImpact(false);
    try {
      const result = await TestSSHConnection(config);
      setMessage({
        ok: true,
        text: t('settings.sshProfileTestSuccess').replace("{time}", latencyText(result, startedAt)),
      });
    } catch (e) {
      setMessage({
        ok: false,
        text: t('settings.sshProfileTestFailed')
          .replace("{error}", errorText(e))
          .replace("{time}", fallbackLatencyText(startedAt)),
      });
    } finally {
      setTestingKey((current) => (current === snapshotKey ? null : current));
    }
  };

  return (
    <div className="page-surface ssh-manager-page">
      <div className="page-header">
        <div>
          <h3>{t('app.sshTunnels')}</h3>
          <div className="page-subtitle">{t('ssh.pageSubtitle')}</div>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={newProfile}>{t('settings.newSSHProfile')}</button>
        </div>
      </div>

      <div className="ssh-overview">
        <div className="ssh-metric">
          <span>{t('ssh.metricProfiles')}</span>
          <strong>{profiles.length}</strong>
        </div>
        <div className="ssh-metric">
          <span>{t('ssh.metricReferenced')}</span>
          <strong>{referencedProfiles}</strong>
        </div>
        <div className="ssh-metric">
          <span>{t('ssh.metricInline')}</span>
          <strong>{inlineSSHCount}</strong>
        </div>
      </div>

      <div className="ssh-manager-body">
        <aside className="ssh-profile-panel">
          <div className="ssh-panel-head">
            <h4>{t('settings.sshProfiles')}</h4>
            <p>{t('ssh.profileListSubtitle')}</p>
          </div>
          <div className="ssh-profile-list">
            {profiles.length === 0 && <div className="settings-empty">{t('settings.noSSHProfiles')}</div>}
            {profiles.map((profile) => {
              const refs = listSSHProfileReferences(profile.id, t);
              // 端点一行摆三个字段，窄列表里必然截断 → title 用同一段文本兜住全文
              const endpoint = `${profile.config.username}@${profile.config.host}:${profile.config.port || 22}`;
              return (
                <div className={`ssh-profile-item${draft.id === profile.id ? " active" : ""}`} key={profile.id}>
                  <button className="ssh-profile-main" onClick={() => edit(profile)}>
                    <span className="ssh-profile-name" title={profile.name}>
                      {profile.name}
                    </span>
                    <span className="ssh-profile-endpoint" title={endpoint}>
                      {profile.config.username}@{profile.config.host}:{profile.config.port || 22}
                    </span>
                    <span className="ssh-profile-tags">
                      <span>{profile.config.authType === "key" ? t('connection.keyAuth') : t('connection.passwordAuth')}</span>
                      <span>{t('ssh.referenceCount').replace("{count}", String(refs.length))}</span>
                    </span>
                  </button>
                  <button
                    className="conn-item-del"
                    title={t("common.delete")}
                    aria-label={t("common.delete")}
                    onClick={() => remove(profile)}
                  >
                    x
                  </button>
                </div>
              );
            })}
          </div>
        </aside>

        <section className="ssh-detail-panel">
          <div className="ssh-detail-head">
            <div>
              <h4>{draftTitle}</h4>
              <p>{draft.id ? t('ssh.editingProfile') : t('ssh.creatingProfile')}</p>
            </div>
            <div className="ssh-detail-badges">
              <span>{draft.config.authType === "key" ? t('connection.keyAuth') : t('connection.passwordAuth')}</span>
              <span>{selectedRefs.length ? t('ssh.referenceCount').replace("{count}", String(selectedRefs.length)) : t('ssh.noReferencesShort')}</span>
            </div>
          </div>

          <div className="ssh-detail-grid">
            <div className="ssh-form-column">
              <section className="ssh-manager-section">
                <div className="ssh-section-title">
                  <h5>{t('ssh.basicInfo')}</h5>
                  <p>{t('ssh.basicInfoHint')}</p>
                </div>
                <div className="ssh-manager-form">
                  <label className="field">
                    <span>{t('settings.sshProfileName')}</span>
                    <input
                      type="text"
                      className="search-input wide"
                      value={draft.name}
                      placeholder={t('settings.sshProfileNamePlaceholder')}
                      onChange={(e) => {
                        setDraft((current) => ({ ...current, name: e.target.value }));
                        clearTransient();
                      }}
                    />
                  </label>
                  <label className="field">
                    <span>{t('connection.sshHost')}</span>
                    <input
                      type="text"
                      className="search-input wide"
                      value={draft.config.host}
                      placeholder={t('connection.sshHostPlaceholder')}
                      onChange={(e) => setConfig({ host: e.target.value })}
                    />
                  </label>
                  <div className="field-row">
                    <label className="field">
                      <span>{t('connection.sshPort')}</span>
                      <NumberField
                        value={draft.config.port}
                        min={PORT_MIN}
                        max={PORT_MAX}
                        fallback={SSH_DEFAULT_PORT}
                        validate={(next) => portIssue(next, { label: t("connection.sshPort") })}
                        onChange={(port) => setConfig({ port })}
                      />
                    </label>
                    <label className="field">
                      <span>{t('connection.sshUsername')}</span>
                      <input
                        type="text"
                        className="search-input mono"
                        spellCheck={false}
                        value={draft.config.username}
                        onChange={(e) => setConfig({ username: e.target.value })}
                      />
                    </label>
                  </div>
                </div>
              </section>

              <section className="ssh-manager-section">
                <div className="ssh-section-title">
                  <h5>{t('ssh.authInfo')}</h5>
                  <p>{t('ssh.authInfoHint')}</p>
                </div>
                <div className="ssh-manager-form">
                  <label className="field">
                    <span>{t('connection.authType')}</span>
                    <select
                      className="search-input wide"
                      value={draft.config.authType}
                      onChange={(e) => setConfig({ authType: e.target.value as "password" | "key" })}
                    >
                      <option value="password">{t('connection.passwordAuth')}</option>
                      <option value="key">{t('connection.keyAuth')}</option>
                    </select>
                  </label>
                  {draft.config.authType === "password" ? (
                    <label className="field">
                      <span>{t('connection.sshPassword')}</span>
                      <input
                        className="search-input wide mono"
                        type="password"
                        value={draft.config.password || ""}
                        onChange={(e) => setConfig({ password: e.target.value })}
                      />
                    </label>
                  ) : (
                    <>
                      <label className="field">
                        <span>{t('connection.privateKey')}</span>
                        <textarea
                          className="search-input wide mono ssh-key"
                          spellCheck={false}
                          value={draft.config.privateKey || ""}
                          placeholder="-----BEGIN RSA PRIVATE KEY-----"
                          onChange={(e) => setConfig({ privateKey: e.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span>{t('connection.privateKeyPassword')}</span>
                        <input
                          className="search-input wide mono"
                          type="password"
                          value={draft.config.passphrase || ""}
                          onChange={(e) => setConfig({ passphrase: e.target.value })}
                        />
                      </label>
                    </>
                  )}
                </div>
              </section>

              <section className="ssh-manager-section">
                <div className="ssh-section-title">
                  <h5>{t('ssh.localPolicy')}</h5>
                  <p>{t('ssh.localPolicyHint')}</p>
                </div>
                <div className="ssh-manager-form compact">
                  <label className="field">
                    <span>{t('connection.localPort')}</span>
                    <NumberField
                      value={draft.config.localPort}
                      min={PORT_MIN}
                      max={PORT_MAX}
                      placeholder={t("connection.localPortPlaceholder")}
                      validate={(next) => portIssue(next, { label: t("connection.localPortShort"), optional: true })}
                      onChange={(localPort) => setConfig({ localPort })}
                    />
                  </label>
                </div>
              </section>

              {message && (
                <div className={`test-msg ${message.ok ? "ok" : "err"}`} {...statusMessageProps(message.ok ? "success" : "error")}>
                  {message.text}
                </div>
              )}
              <div className="conn-form-actions">
                <div className="spacer" />
                <button className="btn btn-ghost" onClick={testSSHProfile} disabled={testingCurrent}>
                  {testingCurrent ? t('settings.sshProfileTesting') : t('settings.sshProfileTest')}
                </button>
                <span className="btn-guard" title={portBlock}>
                  {/* 越界时禁用保存，但按钮本身收不到鼠标事件，title 挂在外层才看得到原因（R19） */}
                  <button className="btn btn-primary" onClick={save} disabled={!!portBlock} aria-disabled={!!portBlock}>
                    {pendingSaveImpact ? t("settings.sshProfileConfirmSave") : t("common.save")}
                  </button>
                </span>
              </div>
            </div>

            <aside className="ssh-side-column">
              <section className="ssh-manager-section">
                <div className="ssh-section-title">
                  <h5>{t('ssh.references')}</h5>
                  <p>{t('ssh.referencesHint')}</p>
                </div>
                {activeRefs.length > 0 ? (
                  <div className="settings-ref-list ssh-ref-list">
                    {activeRefs.map((ref) => (
                      <span key={ref}>{ref}</span>
                    ))}
                  </div>
                ) : (
                  <div className="ssh-empty-note">{t('ssh.noReferences')}</div>
                )}
              </section>
            </aside>
          </div>
        </section>
      </div>
    </div>
  );
}
