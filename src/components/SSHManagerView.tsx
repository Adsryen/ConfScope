import { useState } from "react";
import { probeSSHHostKey, testSSHConnection, trustSSHHostKey, type HostKeyStatus } from "../api/ssh";
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
import {
  SSH_SECRET_FIELDS,
  SSH_SECRET_LABEL_KEYS,
  loadSSHSecretsForEdit,
  settleSSHSecrets,
  type LargeSecretPointer,
  type SSHSecretField,
} from "../lib/credentialSecrets";
import NumberField from "./NumberField";
import PasswordField from "./PasswordField";
import ConfirmModal from "./ConfirmModal";
import AlertModal from "./AlertModal";
import { reportError } from "../lib/errorCenter";
import { PORT_MAX, PORT_MIN, SSH_DEFAULT_PORT, portIssue, sshPortIssues } from "../lib/ports";
import { errorText } from "../lib/errorText";
import { statusMessageProps } from "../lib/statusSemantics";

type Draft = {
  id?: string;
  name: string;
  config: SSHConfig;
  /**
   * 打开表单时档案上的凭据指针（轮142 C）。明文与指针一起留在内存里，
   * 但只有指针会落盘——config 里的明文在 upsert 前会被 settleSSHSecrets 清掉。
   */
  secretRefs?: Partial<Record<SSHSecretField, LargeSecretPointer>>;
  /** 打开表单那一刻读回来的值＝保存时判定「用户动没动」的基线（只活在内存，不落盘）。 */
  secretBaseline?: Record<string, string>;
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
  // 主机密钥裁决未通过时挂起确认/阻断弹层。config 用探测那一刻的快照：
  // 确认并连接时再走完整流程，不会读到用户在弹层里改动的草稿（弹层有焦点陷阱，实际上改不到）。
  const [hostKeyPrompt, setHostKeyPrompt] = useState<{ status: HostKeyStatus; config: SSHConfig } | null>(null);

  const referencedProfileIds = new Set(connections.map((conn) => conn.sshProfileId).filter(Boolean));
  const referencedProfiles = profiles.filter((profile) => referencedProfileIds.has(profile.id)).length;
  const inlineSSHCount = connections.filter((conn) => conn.sshConfig && !conn.sshProfileId).length;
  const selectedRefs = draft.id ? listSSHProfileReferences(draft.id, t) : [];
  const activeRefs = blockedRefs.length > 0 ? blockedRefs : selectedRefs;
  const currentProfile = draft.id ? profiles.find((profile) => profile.id === draft.id) : undefined;
  const draftTitle = draft.name.trim() || currentProfile?.name || t('settings.newSSHProfile');
  // 指针在、状态 stored 的字段：值来自系统凭据库，本地数据文件里不存明文（轮142 C 就近说明）。
  const storedSecretLabels = SSH_SECRET_FIELDS.filter((field) => draft.secretRefs?.[field]?.status === "stored").map(
    (field) => t(SSH_SECRET_LABEL_KEYS[field])
  );
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

  /**
   * 打开档案（轮142 C）：凭据迁到系统凭据库后本地只剩指针，表单必须先把值读回来，
   * 否则用户点开一条隧道看到的是空密码——这正是用户报的「连密码也看不到」。
   * 读库失败不阻断编辑：那一条留空 + 提示重新填写，其余字段照常可改可存。
   */
  const openProfile = async (profile: SSHProfile) => {
    const snapshot = await loadSSHSecretsForEdit(profile.config, profile.sshSecretRefs);
    setDraft({
      id: profile.id,
      name: profile.name,
      config: normalizeSSHConfig({ ...profile.config, ...snapshot.values }),
      secretRefs: profile.sshSecretRefs,
      secretBaseline: snapshot.baseline,
    });
    clearTransient();
    const secretFields = (names: string[]) => names.map((field) => t(SSH_SECRET_LABEL_KEYS[field as SSHSecretField])).join(" / ");
    if (snapshot.unavailable.length > 0) {
      setMessage({ ok: false, text: t("credentials.editUnreadable", { fields: secretFields(snapshot.unavailable.map((item) => item.field)) }) });
      return;
    }
    const hydrated = SSH_SECRET_FIELDS.filter((field) => snapshot.values[field] && !(profile.config[field] ?? ""));
    if (hydrated.length > 0) {
      setMessage({ ok: true, text: t("credentials.editLoaded", { fields: secretFields([...hydrated]) }) });
    }
  };

  const edit = (profile: SSHProfile) => {
    void openProfile(profile);
  };

  // 端口非法的唯一判据（R24）：与输入框下的行内错误、保存按钮的禁用与 title 同源，不再各写一套
  const portBlock = sshPortIssues(draft.config, {
    port: t("connection.sshPort"),
    localPort: t("connection.localPortShort"),
  })[0];

  const save = async () => {
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
    // 凭据结算（轮142 C）：编辑已有档案才走三路判定。新建档案沿用迁移前的老形状
    // （明文留在内联，由设置页「迁移凭据」统一入库）——此刻还没有档案 id，指针没有归属。
    let inlineConfig = config;
    let secretRefs = draft.secretRefs;
    let secretBaseline = draft.secretBaseline ?? {};
    let settleFailed: string | null = null;
    if (draft.id) {
      const settled = await settleSSHSecrets({
        namespace: "ssh-profile",
        ownerId: draft.id,
        draft: config,
        baseline: draft.secretBaseline ?? {},
        refs: draft.secretRefs,
      });
      inlineConfig = normalizeSSHConfig({ ...config, ...settled.inline });
      secretRefs = settled.pointers;
      secretBaseline = settled.baseline;
      const noticeText = (kind: "write" | "delete") => {
        const names = settled.notices
          .filter((item) => item.kind === kind)
          .map((item) => t(SSH_SECRET_LABEL_KEYS[item.field as SSHSecretField]))
          .join(" / ");
        if (!names) return null;
        return t(kind === "write" ? "credentials.editWriteFailed" : "credentials.editDeleteFailed", { fields: names });
      };
      settleFailed = [noticeText("write"), noticeText("delete")].filter((text): text is string => !!text).join("；");
    }
    const saved = upsertSSHProfile({
      id: draft.id,
      name: draft.name.trim(),
      config: inlineConfig,
      sshSecretRefs: secretRefs,
    });
    // 表单继续显示用户刚填的值（明文只在内存这一份），落盘的那份该清的已经清了。
    setDraft({ id: saved.id, name: saved.name, config, secretRefs, secretBaseline });
    refresh();
    const savedText = t("settings.sshProfileSaved");
    setMessage({ ok: !settleFailed, text: settleFailed ? `${savedText}｜${settleFailed}` : savedText });
    setBlockedRefs([]);
    setPendingSaveImpact(false);
  };

  const remove = async (profile: SSHProfile) => {
    const refs = listSSHProfileReferences(profile.id, t);
    if (refs.length > 0) {
      // 拦下来 = 把这条档案摊开给用户看（轮142 C：以前直接铺内联值，迁过凭据的档案一片空白）
      await openProfile(profile);
      setBlockedRefs(refs);
      setMessage({ ok: false, text: t('settings.sshProfileDeleteBlocked').replace("{count}", String(refs.length)) });
      return;
    }
    deleteSSHProfile(profile.id);
    if (draft.id === profile.id) newProfile();
    refresh();
    setMessage({ ok: true, text: t('settings.sshProfileDeleted') });
    setBlockedRefs([]);
    setPendingSaveImpact(false);
  };

  // 探测先行（r104）：先问主机密钥裁决，trusted 才真正拨号；
  // 未信任/已变更不建连，分别交给确认对话与硬阻断提示。
  const runSshTest = async (config: SSHConfig) => {
    const snapshotKey = sshTestKey(config);
    const startedAt = Date.now();
    setTestingKey(snapshotKey);
    setMessage({ ok: true, text: t('settings.sshProfileTesting') });
    setBlockedRefs([]);
    setPendingSaveImpact(false);
    let promptOpened = false;
    try {
      const status = await probeSSHHostKey(config);
      if (status.status === "trusted") {
        const result = await testSSHConnection(config);
        setMessage({
          ok: true,
          text: t('settings.sshProfileTestSuccess').replace("{time}", latencyText(result, startedAt)),
        });
        return;
      }
      if (status.status === "hostKeyUnknown" || status.status === "hostKeyChanged") {
        promptOpened = true;
        // 先收掉忙态再开弹层：用户在弹层里斟酌时，页面测试按钮不挂「测试中」。
        setTestingKey((current) => (current === snapshotKey ? null : current));
        setHostKeyPrompt({ status, config });
        if (status.status === "hostKeyUnknown") {
          setMessage({
            ok: false,
            text: t('ssh.hostKeyUnknownPrompt', {
              recordId: status.recordId,
              keyType: status.keyType ?? "",
              fingerprint: status.fingerprint ?? "",
              path: status.knownHostsPath,
            }),
          });
        } else {
          const blockedText = t('ssh.hostKeyChangedBlocked', {
            recordId: status.recordId,
            recordFingerprint: status.recordFingerprint ?? "",
            keyType: status.keyType ?? "",
            fingerprint: status.fingerprint ?? "",
            path: status.knownHostsPath,
          });
          setMessage({ ok: false, text: blockedText });
          // 变更是安全事件：消息中心留一条可回看的记录，不占即时播报。
          reportError({
            title: t('ssh.hostKeyChangedTitle'),
            message: blockedText,
            source: "ssh",
            toast: false,
          });
        }
        return;
      }
      // 防御分支：裁决值超出已知四值时按阻断处理，不静默放行。
      setMessage({ ok: false, text: t('ssh.hostKeyVerdictUnknown', { verdict: String(status.status) }) });
    } catch (e) {
      setMessage({
        ok: false,
        text: t('settings.sshProfileTestFailed')
          .replace("{error}", errorText(e))
          .replace("{time}", fallbackLatencyText(startedAt)),
      });
    } finally {
      if (!promptOpened) {
        setTestingKey((current) => (current === snapshotKey ? null : current));
      }
    }
  };

  const testSSHProfile = async () => {
    if (portBlock) {
      setMessage({ ok: false, text: portBlock });
      return;
    }
    const config = normalizeSSHConfig({ ...draft.config });
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
    await runSshTest(config);
  };

  // 首次未知主机：确认 = 写入记录并再走一遍完整流程（此时探测应已 trusted 直通拨号）。
  const confirmHostKey = async () => {
    const prompt = hostKeyPrompt;
    if (!prompt || prompt.status.status !== "hostKeyUnknown") return;
    const { status, config } = prompt;
    setHostKeyPrompt(null);
    if (!status.keyBase64) {
      setMessage({ ok: false, text: t('ssh.hostKeyMissingPayload') });
      return;
    }
    const snapshotKey = sshTestKey(config);
    setTestingKey(snapshotKey);
    setMessage({ ok: true, text: t('ssh.hostKeyTrusting') });
    try {
      await trustSSHHostKey(status.host, status.port, status.keyType ?? "", status.keyBase64);
      await runSshTest(config);
    } catch (e) {
      setTestingKey((current) => (current === snapshotKey ? null : current));
      const failedText = t('ssh.hostKeyTrustFailed', { error: errorText(e) });
      setMessage({ ok: false, text: failedText });
      reportError({
        title: t('ssh.hostKeyConfirmTitle'),
        message: failedText,
        source: "ssh",
        toast: false,
      });
    }
  };

  // 首次未知主机：拒绝 = 不写记录、不拨号、不留半截连接。
  const cancelHostKey = () => {
    if (!hostKeyPrompt || hostKeyPrompt.status.status !== "hostKeyUnknown") return;
    setHostKeyPrompt(null);
    setMessage({ ok: false, text: t('ssh.hostKeyRejected') });
  };

  // 指纹变更：单按钮确认弹层，关掉即结束；全界面不提供任何放行入口。
  const dismissHostKey = () => {
    setHostKeyPrompt(null);
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
                    onClick={() => void remove(profile)}
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
                {storedSecretLabels.length > 0 && (
                  <div className="settings-panel-note secret-source-note">
                    {t("credentials.vaultNote", { fields: storedSecretLabels.join(" / ") })}
                  </div>
                )}
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
                    <PasswordField
                      label={t('connection.sshPassword')}
                      value={draft.config.password || ""}
                      name="ssh-manager-password"
                      autoComplete="current-password"
                      className="search-input wide mono"
                      onChange={(v) => setConfig({ password: v })}
                    />
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
                      <PasswordField
                        label={t('connection.privateKeyPassword')}
                        value={draft.config.passphrase || ""}
                        name="ssh-manager-passphrase"
                        autoComplete="off"
                        className="search-input wide mono"
                        onChange={(v) => setConfig({ passphrase: v })}
                      />
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

        {/* 首次未知主机：四条事实进 details（主机:端口 / 算法 / SHA256 指纹 / 记录文件），
            指纹是纯文本要点，word-break 折行不截断，天然可选中复制。 */}
        {hostKeyPrompt && hostKeyPrompt.status.status === "hostKeyUnknown" && (
          <ConfirmModal
            title={t('ssh.hostKeyConfirmTitle')}
            message={t('ssh.hostKeyConfirmMessage')}
            details={[
              `${t('ssh.hostKeyDetailEndpoint')}: ${hostKeyPrompt.status.host}:${hostKeyPrompt.status.port}`,
              `${t('ssh.hostKeyDetailKeyType')}: ${hostKeyPrompt.status.keyType ?? ""}`,
              `${t('ssh.hostKeyDetailFingerprint')}: ${hostKeyPrompt.status.fingerprint ?? ""}`,
              `${t('ssh.hostKeyDetailKnownHostsPath')}: ${hostKeyPrompt.status.knownHostsPath}`,
            ]}
            confirmLabel={t('ssh.hostKeyConfirmButton')}
            onConfirm={confirmHostKey}
            onCancel={cancelHostKey}
          />
        )}
        {/* 指纹变更：硬阻断。AlertModal 单按钮（知道了），footer 不出现第二个放行按钮。
            本页是条件挂载（App 的 mode === "ssh" 三元链），弹层只可能在前台渲染，
            active 取组件默认 true，与 SettingsView / BackupView 的传法一致。 */}
        {hostKeyPrompt && hostKeyPrompt.status.status === "hostKeyChanged" && (
          <AlertModal
            title={t('ssh.hostKeyChangedTitle')}
            messages={[
              t('ssh.hostKeyChangedWarning'),
              `${t('ssh.hostKeyChangedRecord')}: ${hostKeyPrompt.status.recordFingerprint ?? ""}`,
              `${t('ssh.hostKeyChangedPresented')}: ${hostKeyPrompt.status.keyType ?? ""}（${t('ssh.hostKeyDetailFingerprint')} ${hostKeyPrompt.status.fingerprint ?? ""}）`,
              `${t('ssh.hostKeyChangedPath')}: ${hostKeyPrompt.status.knownHostsPath}`,
              `${t('ssh.hostKeyChangedRecordId')}: ${hostKeyPrompt.status.recordId}`,
              t('ssh.hostKeyChangedGuidance'),
            ]}
            onClose={dismissHostKey}
          />
        )}
      </div>
    </div>
  );
}
