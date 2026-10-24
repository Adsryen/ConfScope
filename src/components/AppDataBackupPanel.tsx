import { useEffect, useState } from "react";
import { getAppInfo, getCurrentPlatform } from "../api/app";
import {
  createAppDataRecoveryPoint,
  downloadAppDataWebDAVBackup,
  listAppDataSnapshotFiles,
  listAppDataWebDAVBackups,
  readAppDataBackupFile,
  restoreAppDataSnapshotFiles,
  selectAppDataBackupOpenFile,
  selectAppDataBackupSaveFile,
  testAppDataWebDAV,
  uploadAppDataWebDAVBackup,
  writeAppDataBackupFile,
  type AppDataBackupPackageMeta,
  type AppDataBackupPackageSummary,
  type RemoteAppDataBackup,
} from "../api/appDataBackup";
import { useTranslation } from "../i18n";
import {
  collectPortableAppDataBackupPayload,
  restoreAppDataBackupPayload,
  summarizeAppDataBackupPayload,
  validateAppDataBackupPayload,
  type AppDataBackupPayload,
  type AppDataBackupSummary,
} from "../lib/appDataBackup";
import { formatBytes } from "../lib/formatBytes";
import { formatDateTime } from "../lib/formatDateTime";
import { getTaskManager } from "../lib/taskmanager";
import { useKeepVisible } from "../lib/useKeepVisible";
import { toast } from "../lib/toast";
import BusyLabel from "./BusyLabel";
import InlineError from "./InlineError";
import PasswordField from "./PasswordField";
import {
  loadAppDataBackupState,
  recordAppDataBackupActivity,
  updateAppDataBackupPasswordSecretRef,
  updateAppDataWebDAVSettings,
  type AppDataBackupActivity,
  type AppDataBackupState,
  type AppDataWebDAVSettings,
} from "../store/appDataBackup";
import { deleteStoredSecret, resolveAppDataBackupPassword, saveAppDataBackupPassword } from "../lib/credentialSecrets";
import { errorText } from "../lib/errorText";
import { statusMessageProps } from "../lib/statusSemantics";

interface Props {
  onRestored?: () => void;
  /**
   * 活动列表变化时上报（轮47 R47-03）。
   * 设置页的「最后备份」原来在渲染体里自己 loadAppDataBackupState()：
   * 它只在设置页恰好重渲染时才更新——反映的是渲染时序，不是数据。
   * 改成由面板在唯一的状态落地函数里上报，读方拿到的永远是写完的那一刻。
   */
  onActivitiesChange?: (activities: AppDataBackupActivity[]) => void;
}

interface PreviewState {
  source: "local" | "webdav";
  target: string;
  password: string;
  payload: AppDataBackupPayload;
  summary: AppDataBackupSummary;
  packageSummary: AppDataBackupPackageSummary;
}

const DEFAULT_PLATFORM = "unknown";
const DEFAULT_APP_VERSION = "dev";

function defaultBackupName(): string {
  const stamp = new Date().toISOString().replace(/-/g, "").replace("T", "-").replace(/:/g, "").slice(0, 15);
  return `confscope-app-data-${stamp}.csbackup`;
}

function normalizeRootPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "/confscope";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function readAppInfoSafe() {
  return Promise.resolve().then(() => getAppInfo());
}

function readPlatformSafe() {
  return Promise.resolve().then(() => getCurrentPlatform());
}

function activityLabel(type: AppDataBackupActivity["type"], t: (key: string) => string): string {
  switch (type) {
    case "local_export":
      return t("appDataBackup.activityLocalExport");
    case "local_restore":
      return t("appDataBackup.activityLocalRestore");
    case "webdav_upload":
      return t("appDataBackup.activityWebdavUpload");
    case "webdav_restore":
      return t("appDataBackup.activityWebdavRestore");
    case "recovery_point":
      return t("appDataBackup.activityRecoveryPoint");
  }
}

function SummaryPreview({ preview }: { preview: PreviewState }) {
  const { t } = useTranslation();
  const summary = preview.summary;
  return (
    <div className="app-data-backup-preview" aria-label={t("appDataBackup.previewTitle")}>
      <div className="app-data-backup-preview-head">
        <strong>{t("appDataBackup.previewTitle")}</strong>
        <span>{preview.target}</span>
      </div>
      <div className="app-data-backup-summary-grid">
        <span>{t("appDataBackup.summaryVersion", { version: summary.appVersion })}</span>
        <span>{t("appDataBackup.summaryPlatform", { platform: summary.sourcePlatform })}</span>
        {/*
          轮67 R67-WP4：备份包里的时间是 UTC ISO 原文（2026-10-23T01:23:45.678Z），
          和本机时刻差 8 小时、带 Z 带毫秒，用户没法判断这份件新不新 → 走时间事实源。
        */}
        <span>{t("appDataBackup.summaryCreatedAt", { createdAt: formatDateTime(summary.createdAt) })}</span>
        <span>{t("appDataBackup.summaryConnections", { count: summary.sections.connections })}</span>
        <span>{t("appDataBackup.summarySshProfiles", { count: summary.sections.sshProfiles })}</span>
        <span>{t("appDataBackup.summaryApplyPlans", { count: summary.sections.applyPlans })}</span>
        <span>{t("appDataBackup.summaryApplyVerifications", { count: summary.sections.applyVerifications })}</span>
        <span>{t("appDataBackup.summaryHistory", { count: summary.sections.operationHistory })}</span>
        <span>{t("appDataBackup.summarySnapshots", { count: summary.sections.snapshots })}</span>
        <span>{summary.includesSensitiveData ? t("appDataBackup.sensitiveIncluded") : t("appDataBackup.sensitiveNone")}</span>
      </div>
    </div>
  );
}

export default function AppDataBackupPanel({ onRestored, onActivitiesChange }: Props) {
  const { t } = useTranslation();
  const [appVersion, setAppVersion] = useState(DEFAULT_APP_VERSION);
  const [sourcePlatform, setSourcePlatform] = useState(DEFAULT_PLATFORM);
  const [backupState, setBackupState] = useState(() => loadAppDataBackupState());
  const [webdavDraft, setWebdavDraft] = useState<AppDataWebDAVSettings>(() => loadAppDataBackupState().webdav);
  const [exportPassword, setExportPassword] = useState("");
  const [exportConfirm, setExportConfirm] = useState("");
  const [savedPasswordDraft, setSavedPasswordDraft] = useState("");
  const [savedPasswordConfirm, setSavedPasswordConfirm] = useState("");
  const [restorePath, setRestorePath] = useState("");
  const [restorePassword, setRestorePassword] = useState("");
  const [webdavBackupPassword, setWebdavBackupPassword] = useState("");
  const [remoteRestorePassword, setRemoteRestorePassword] = useState("");
  const [remoteBackups, setRemoteBackups] = useState<RemoteAppDataBackup[]>([]);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState("");
  // 提示落在面板最顶部，动作按钮却在 2762px 内容的下方：不把它滚进可视区，
  // 用户在底部点完只看到「什么都没发生」（轮67 / R67-WP1，实测提示 top=-221）。
  const statusRef = useKeepVisible<HTMLDivElement>(!!status, status?.text ?? "");
  const errorRef = useKeepVisible<HTMLDivElement>(!!error, error);
  const [busy, setBusy] = useState("");

  useEffect(() => {
    readAppInfoSafe()
      .then((info) => setAppVersion(info.version || DEFAULT_APP_VERSION))
      .catch(() => setAppVersion(DEFAULT_APP_VERSION));
    readPlatformSafe()
      .then((platform) => setSourcePlatform(platform || DEFAULT_PLATFORM))
      .catch(() => setSourcePlatform(DEFAULT_PLATFORM));
  }, []);

  const clearMessages = () => {
    setError("");
    setStatus(null);
  };

  // 面板内所有「读盘后落地」的唯一出口：设 state 同时把活动列表上报给读方。
  const applyBackupState = (next: AppDataBackupState) => {
    setBackupState(next);
    onActivitiesChange?.(next.activities);
  };

  const refreshState = () => {
    const next = loadAppDataBackupState();
    applyBackupState(next);
    setWebdavDraft(next.webdav);
  };

  const buildMeta = async (): Promise<AppDataBackupPackageMeta> => {
    let version = appVersion;
    let platform = sourcePlatform;
    try {
      const info = await readAppInfoSafe();
      version = info.version || version || DEFAULT_APP_VERSION;
      setAppVersion(version);
    } catch {
      version = version || DEFAULT_APP_VERSION;
    }
    try {
      platform = (await readPlatformSafe()) || platform || DEFAULT_PLATFORM;
      setSourcePlatform(platform);
    } catch {
      platform = platform || DEFAULT_PLATFORM;
    }
    return {
      appVersion: version,
      sourcePlatform: platform,
      createdAt: new Date().toISOString(),
    };
  };

  const currentWebDAVTarget = (): AppDataWebDAVSettings => ({
    enabled: true,
    url: webdavDraft.url.trim(),
    username: webdavDraft.username.trim(),
    password: webdavDraft.password,
    rootPath: normalizeRootPath(webdavDraft.rootPath),
    passwordSecretRef: webdavDraft.password ? undefined : webdavDraft.passwordSecretRef,
  });

  const collectCurrentBackupPayload = (meta: AppDataBackupPackageMeta) =>
    collectPortableAppDataBackupPayload(meta, { listSnapshotFiles: listAppDataSnapshotFiles });

  const resolveBackupPassword = async (operationPassword: string): Promise<string> => {
    if (operationPassword.trim()) return operationPassword;
    const pointer = backupState.backupPasswordSecretRef;
    if (!pointer || pointer.status !== "stored") return "";
    return resolveAppDataBackupPassword(pointer);
  };

  const requireBackupPassword = async (operationPassword: string): Promise<string | null> => {
    const password = await resolveBackupPassword(operationPassword);
    if (!password.trim()) {
      setError(t("appDataBackup.passwordRequired"));
      return null;
    }
    return password;
  };

  const recordActivity = (
    type: AppDataBackupActivity["type"],
    statusValue: AppDataBackupActivity["status"],
    target: string,
    message: string
  ) => {
    recordAppDataBackupActivity({
      type,
      status: statusValue,
      target,
      message,
    });
    refreshState();
  };

  const runWithTask = async <T,>(name: string, type: "backup" | "restore", scope: string, action: () => Promise<T>): Promise<T> => {
    const manager = getTaskManager();
    const task = manager.createTask(name, type, { scope });
    manager.startTask(task.id);
    try {
      const result = await action();
      manager.updateProgress(task.id, 1, 0, 1);
      manager.completeTask(task.id, true);
      return result;
    } catch (e) {
      const message = errorText(e);
      manager.updateProgress(task.id, 0, 1, 1);
      manager.completeTask(task.id, false, message);
      throw e;
    }
  };

  const exportLocalBackup = async () => {
    clearMessages();
    if (exportPassword && exportPassword !== exportConfirm) {
      setError(t("appDataBackup.passwordMismatch"));
      return;
    }
    setBusy("local-export");
    try {
      const password = await requireBackupPassword(exportPassword);
      if (!password) return;
      const path = await selectAppDataBackupSaveFile(defaultBackupName());
      if (!path) return;
      await runWithTask(t("appDataBackup.localExportTask"), "backup", path, async () => {
        const meta = await buildMeta();
        const payload = await collectCurrentBackupPayload(meta);
        await writeAppDataBackupFile(path, JSON.stringify(payload), password, meta);
      });
      recordActivity("local_export", "success", path, t("appDataBackup.localExported"));
      setStatus({ ok: true, text: t("appDataBackup.localExported") });
      toast(t("appDataBackup.localExported"), "success");
    } catch (e) {
      const message = errorText(e);
      recordActivity("local_export", "failure", "", message);
      setError(message);
    } finally {
      setBusy("");
    }
  };

  const chooseLocalBackup = async () => {
    clearMessages();
    setBusy("local-choose");
    try {
      const path = await selectAppDataBackupOpenFile();
      if (path) {
        setRestorePath(path);
        setPreview(null);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };

  const previewLocalBackup = async () => {
    clearMessages();
    if (!restorePath) {
      setError(t("appDataBackup.localFileRequired"));
      return;
    }
    setBusy("local-preview");
    try {
      const password = await requireBackupPassword(restorePassword);
      if (!password) return;
      const decrypted = await readAppDataBackupFile(restorePath, password);
      const parsed = validateAppDataBackupPayload(JSON.parse(decrypted.plaintextJson));
      setPreview({
        source: "local",
        target: restorePath,
        password,
        payload: parsed,
        summary: summarizeAppDataBackupPayload(parsed),
        packageSummary: decrypted.summary,
      });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };

  const restorePreview = async () => {
    if (!preview) return;
    clearMessages();
    setBusy("restore");
    const activityType = preview.source === "local" ? "local_restore" : "webdav_restore";
    try {
      await runWithTask(t("appDataBackup.restoreTask"), "restore", preview.target, async () => {
        const meta = await buildMeta();
        const currentPayload = await collectCurrentBackupPayload(meta);
        await createAppDataRecoveryPoint(JSON.stringify(currentPayload), preview.password, meta);
        restoreAppDataBackupPayload(preview.payload);
        if (preview.payload.data.snapshots.length > 0) {
          await restoreAppDataSnapshotFiles(preview.payload.data.snapshots);
        }
      });
      recordActivity("recovery_point", "success", preview.target, t("appDataBackup.recoveryPointCreated"));
      recordActivity(activityType, "success", preview.target, t("appDataBackup.restoreCompleted"));
      setStatus({ ok: true, text: t("appDataBackup.restoreCompleted") });
      toast(t("appDataBackup.restoreCompleted"), "success");
      if (onRestored) {
        onRestored();
      } else {
        window.location.reload();
      }
    } catch (e) {
      const message = errorText(e);
      recordActivity("recovery_point", "failure", preview.target, message);
      setError(message);
    } finally {
      setBusy("");
    }
  };

  const saveWebDAVTarget = () => {
    clearMessages();
    const next = updateAppDataWebDAVSettings(currentWebDAVTarget());
    applyBackupState(next);
    setWebdavDraft(next.webdav);
    setStatus({ ok: true, text: t("appDataBackup.webdavSaved") });
  };

  const saveBackupPassword = async () => {
    clearMessages();
    if (!savedPasswordDraft.trim()) {
      setError(t("appDataBackup.passwordRequired"));
      return;
    }
    if (savedPasswordDraft !== savedPasswordConfirm) {
      setError(t("appDataBackup.passwordMismatch"));
      return;
    }
    setBusy("backup-password-save");
    try {
      const pointer = await saveAppDataBackupPassword(savedPasswordDraft);
      const next = updateAppDataBackupPasswordSecretRef(pointer);
      applyBackupState(next);
      setSavedPasswordDraft("");
      setSavedPasswordConfirm("");
      setStatus({ ok: true, text: t("appDataBackup.savedPasswordSaved") });
      toast(t("appDataBackup.savedPasswordSaved"), "success");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };

  const clearBackupPassword = async () => {
    const pointer = backupState.backupPasswordSecretRef;
    if (!pointer) return;
    clearMessages();
    setBusy("backup-password-clear");
    try {
      await deleteStoredSecret(pointer);
      const next = updateAppDataBackupPasswordSecretRef();
      applyBackupState(next);
      setStatus({ ok: true, text: t("appDataBackup.savedPasswordCleared") });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };

  const testWebDAVTarget = async () => {
    clearMessages();
    const target = currentWebDAVTarget();
    if (!target.url) {
      setError(t("appDataBackup.webdavUrlRequired"));
      return;
    }
    setBusy("webdav-test");
    try {
      await testAppDataWebDAV(target);
      setStatus({ ok: true, text: t("appDataBackup.webdavTestPassed") });
      toast(t("appDataBackup.webdavTestPassed"), "success");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };

  const uploadWebDAVBackup = async () => {
    clearMessages();
    const target = currentWebDAVTarget();
    if (!target.url) {
      setError(t("appDataBackup.webdavUrlRequired"));
      return;
    }
    setBusy("webdav-upload");
    try {
      const password = await requireBackupPassword(webdavBackupPassword);
      if (!password) return;
      const remote = await runWithTask(t("appDataBackup.webdavUploadTask"), "backup", target.rootPath, async () => {
        const meta = await buildMeta();
        const payload = await collectCurrentBackupPayload(meta);
        return uploadAppDataWebDAVBackup(target, JSON.stringify(payload), password, meta);
      });
      recordActivity("webdav_upload", "success", remote.path, t("appDataBackup.webdavUploaded"));
      setRemoteBackups((items) => [remote, ...items.filter((item) => item.path !== remote.path)]);
      setStatus({ ok: true, text: t("appDataBackup.webdavUploaded") });
      toast(t("appDataBackup.webdavUploaded"), "success");
    } catch (e) {
      const message = errorText(e);
      recordActivity("webdav_upload", "failure", target.rootPath, message);
      setError(message);
    } finally {
      setBusy("");
    }
  };

  const refreshRemoteBackups = async () => {
    clearMessages();
    const target = currentWebDAVTarget();
    if (!target.url) {
      setError(t("appDataBackup.webdavUrlRequired"));
      return;
    }
    setBusy("webdav-list");
    try {
      setRemoteBackups(await listAppDataWebDAVBackups(target));
      setStatus({ ok: true, text: t("appDataBackup.remoteListLoaded") });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };

  const previewRemoteBackup = async (remote: RemoteAppDataBackup) => {
    clearMessages();
    const target = currentWebDAVTarget();
    setBusy(`webdav-preview:${remote.path}`);
    try {
      const password = await requireBackupPassword(remoteRestorePassword);
      if (!password) return;
      const decrypted = await downloadAppDataWebDAVBackup(target, remote.path, password);
      const parsed = validateAppDataBackupPayload(JSON.parse(decrypted.plaintextJson));
      setPreview({
        source: "webdav",
        target: remote.path,
        password,
        payload: parsed,
        summary: summarizeAppDataBackupPayload(parsed),
        packageSummary: decrypted.summary,
      });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="app-data-backup-panel">
      <div className="settings-subsection-head">
        <h5>{t("appDataBackup.title")}</h5>
        <div className="settings-panel-description">{t("appDataBackup.description")}</div>
      </div>

      {status && (
        <div ref={statusRef} className={`test-msg ${status.ok ? "ok" : "err"}`} {...statusMessageProps(status.ok ? "success" : "error")}>
          <span className="test-msg-text">{status.text}</span>
        </div>
      )}
      {error && <InlineError containerRef={errorRef} title={t("appDataBackup.operationFailed")} message={error} extraClassName="app-data-backup-error" />}

      <section className="app-data-backup-password-settings" aria-labelledby="app-data-backup-password-title">
        <div className="app-data-backup-area-head">
          <div>
            <h6 id="app-data-backup-password-title">{t("appDataBackup.savedPasswordTitle")}</h6>
            <span>{t("appDataBackup.savedPasswordHint")}</span>
          </div>
          {backupState.backupPasswordSecretRef?.status === "stored" && <strong>{t("appDataBackup.savedPasswordConfigured")}</strong>}
        </div>
        <div className="app-data-backup-fields">
          <PasswordField
            label={t("appDataBackup.savedPassword")}
            value={savedPasswordDraft}
            name="app-data-saved-backup-password"
            autoComplete="new-password"
            className="search-input"
            onChange={setSavedPasswordDraft}
          />
          <PasswordField
            label={t("appDataBackup.confirmSavedPassword")}
            value={savedPasswordConfirm}
            name="app-data-saved-backup-password-confirm"
            autoComplete="new-password"
            className="search-input"
            onChange={setSavedPasswordConfirm}
          />
        </div>
        <div className="app-data-backup-action-row">
          <button type="button" className="btn btn-primary btn-sm" onClick={saveBackupPassword} disabled={busy === "backup-password-save"}>
            <BusyLabel busy={busy === "backup-password-save"} idle={t("appDataBackup.savePassword")} busyText={t("appDataBackup.savingPassword")} />
          </button>
          {backupState.backupPasswordSecretRef?.status === "stored" && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={clearBackupPassword} disabled={busy === "backup-password-clear"}>
              <BusyLabel busy={busy === "backup-password-clear"} idle={t("appDataBackup.clearSavedPassword")} busyText={t("appDataBackup.clearingPassword")} />
            </button>
          )}
        </div>
      </section>

      <section className="app-data-backup-work-area app-data-backup-local" aria-labelledby="app-data-backup-local-title">
        <div className="app-data-backup-area-head">
          <div>
            <h6 id="app-data-backup-local-title">{t("appDataBackup.localSectionTitle")}</h6>
            <span>{t("appDataBackup.localSectionHint")}</span>
          </div>
        </div>
        <div className="app-data-backup-split">
          <div className="app-data-backup-step">
            <div className="app-data-backup-block-head">
              <strong>{t("appDataBackup.localBackup")}</strong>
              <span>{t("appDataBackup.localBackupHint")}</span>
            </div>
            <div className="app-data-backup-fields">
              <PasswordField
                label={t("appDataBackup.localBackupPassword")}
                value={exportPassword}
                name="app-data-local-backup-password"
                autoComplete="new-password"
                className="search-input"
                onChange={setExportPassword}
              />
              <PasswordField
                label={t("appDataBackup.confirmLocalBackupPassword")}
                value={exportConfirm}
                name="app-data-local-backup-password-confirm"
                autoComplete="new-password"
                className="search-input"
                onChange={setExportConfirm}
              />
            </div>
            <div className="app-data-backup-action-row">
              <button type="button" className="btn btn-primary btn-sm" onClick={exportLocalBackup} disabled={busy === "local-export"}>
                <BusyLabel busy={busy === "local-export"} idle={t("appDataBackup.exportEncryptedFile")} busyText={t("appDataBackup.exporting")} />
              </button>
            </div>
          </div>

          <div className="app-data-backup-step">
            <div className="app-data-backup-block-head">
              <strong>{t("appDataBackup.localRestore")}</strong>
              <span>{t("appDataBackup.localRestoreHint")}</span>
            </div>
            <div className="app-data-backup-file-row">
              <button type="button" className="btn btn-ghost btn-sm" onClick={chooseLocalBackup} disabled={busy === "local-choose"}>
                {t("appDataBackup.chooseLocalBackup")}
              </button>
              {restorePath && <span className="app-data-backup-path">{restorePath}</span>}
            </div>
            <PasswordField
              label={t("appDataBackup.restorePassword")}
              value={restorePassword}
              name="app-data-restore-password"
              autoComplete="off"
              className="search-input"
              onChange={setRestorePassword}
            />
            <div className="app-data-backup-action-row">
              {/* 轮74 C2：预览只是「看一眼再决定」，与远端那颗预览同为次要动作，不再抢主色 */}
              <button type="button" className="btn btn-ghost btn-sm" onClick={previewLocalBackup} disabled={busy === "local-preview"}>
                <BusyLabel busy={busy === "local-preview"} idle={t("appDataBackup.previewLocalBackup")} busyText={t("appDataBackup.previewing")} />
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="app-data-backup-work-area app-data-backup-cloud" aria-labelledby="app-data-backup-cloud-title">
        <div className="app-data-backup-area-head">
          <div>
            <h6 id="app-data-backup-cloud-title">{t("appDataBackup.cloudSectionTitle")}</h6>
            <span>{t("appDataBackup.cloudSectionHint")}</span>
          </div>
        </div>
        <div className="app-data-backup-cloud-grid">
          <div className="app-data-backup-step">
            <div className="app-data-backup-block-head">
              <strong>{t("appDataBackup.webdavBackup")}</strong>
              <span>{t("appDataBackup.webdavHint")}</span>
            </div>
            <div className="app-data-backup-webdav-grid">
              <label className="field">
                <span>{t("appDataBackup.webdavUrl")}</span>
                <input
                  type="text"
                  className="search-input"
                  value={webdavDraft.url}
                  onChange={(e) => setWebdavDraft({ ...webdavDraft, url: e.target.value })}
                />
              </label>
              <label className="field">
                <span>{t("appDataBackup.webdavUsername")}</span>
                <input
                  type="text"
                  className="search-input"
                  value={webdavDraft.username}
                  onChange={(e) => setWebdavDraft({ ...webdavDraft, username: e.target.value })}
                />
              </label>
              <PasswordField
                label={t("appDataBackup.webdavPassword")}
                value={webdavDraft.password}
                name="app-data-webdav-login-password"
                autoComplete="current-password"
                className="search-input"
                onChange={(v) => setWebdavDraft({ ...webdavDraft, password: v })}
              />
              <label className="field">
                <span>{t("appDataBackup.remoteFolder")}</span>
                <input
                  type="text"
                  className="search-input"
                  value={webdavDraft.rootPath}
                  onChange={(e) => setWebdavDraft({ ...webdavDraft, rootPath: e.target.value })}
                />
              </label>
            </div>
            <div className="app-data-backup-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={saveWebDAVTarget}>
                {t("appDataBackup.saveWebdavTarget")}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={testWebDAVTarget} disabled={busy === "webdav-test"}>
                <BusyLabel busy={busy === "webdav-test"} idle={t("appDataBackup.testWebdav")} busyText={t("appDataBackup.testingWebdav")} />
              </button>
            </div>
          </div>

          <div className="app-data-backup-step">
            <div className="app-data-backup-block-head">
              <strong>{t("appDataBackup.cloudBackupActions")}</strong>
              <span>{t("appDataBackup.cloudBackupActionsHint")}</span>
            </div>
            <div className="app-data-backup-remote-tools">
              <PasswordField
                label={t("appDataBackup.webdavBackupPassword")}
                value={webdavBackupPassword}
                name="app-data-webdav-backup-password"
                autoComplete="new-password"
                className="search-input"
                onChange={setWebdavBackupPassword}
              />
              <button type="button" className="btn btn-primary btn-sm" onClick={uploadWebDAVBackup} disabled={busy === "webdav-upload"}>
                <BusyLabel busy={busy === "webdav-upload"} idle={t("appDataBackup.uploadCurrentData")} busyText={t("appDataBackup.uploading")} />
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={refreshRemoteBackups} disabled={busy === "webdav-list"}>
                <BusyLabel busy={busy === "webdav-list"} idle={t("appDataBackup.refreshRemoteList")} busyText={t("appDataBackup.refreshing")} />
              </button>
            </div>

            <PasswordField
              label={t("appDataBackup.remoteRestorePassword")}
              value={remoteRestorePassword}
              name="app-data-remote-restore-password"
              autoComplete="off"
              className="search-input"
              onChange={setRemoteRestorePassword}
            />

            <div className="app-data-backup-remote-list">
              {remoteBackups.length === 0 ? (
                <div className="settings-empty">{t("appDataBackup.noRemoteBackups")}</div>
              ) : (
                remoteBackups.map((remote) => (
                  <div className="app-data-backup-remote-row" key={remote.path}>
                    <div>
                      <strong>{remote.name}</strong>
                      {/*
                        轮67 R67-WP4：2MB 的备份件原先直出 "2097152 bytes · <服务器原始串>"，
                        字节数没有量级、时间是 RFC1123 英文月份，两列都没法读。
                      */}
                      <span>{t("appDataBackup.remoteMeta", { size: formatBytes(remote.size), modifiedAt: formatDateTime(remote.modifiedAt, { fallback: "—" }) })}</span>
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => previewRemoteBackup(remote)}
                      disabled={busy === `webdav-preview:${remote.path}`}
                    >
                      {t("appDataBackup.previewRemoteBackup", { name: remote.name })}
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </section>

      {preview && (
        <section className="app-data-backup-restore-confirm" aria-labelledby="app-data-backup-restore-title">
          <div className="app-data-backup-area-head">
            <div>
              <h6 id="app-data-backup-restore-title">{t("appDataBackup.restoreSectionTitle")}</h6>
              <span>{t("appDataBackup.restoreSectionHint")}</span>
            </div>
          </div>
          <SummaryPreview preview={preview} />
          <div className="app-data-backup-restore-warning">{t("appDataBackup.restoreWarning")}</div>
          {/* 轮74 C2：这颗是「用备份件覆盖本机数据」的提交键，走实心危险档——
              原先与「保存密码」「导出」同为 btn-primary，一整片蓝里读不出哪一步会动现有数据 */}
          <button type="button" className="btn btn-danger-fill btn-sm" onClick={restorePreview} disabled={busy === "restore"}>
            <BusyLabel busy={busy === "restore"} idle={t("appDataBackup.restoreThisBackup")} busyText={t("appDataBackup.restoring")} />
          </button>
        </section>
      )}

      <section className="app-data-backup-activities" aria-labelledby="app-data-backup-activity-title">
        <div className="app-data-backup-block-head">
          <h6 id="app-data-backup-activity-title">{t("appDataBackup.activityTitle")}</h6>
          <span>{t("appDataBackup.activityHint")}</span>
        </div>
        {backupState.activities.length === 0 ? (
          <div className="settings-empty">{t("appDataBackup.noActivities")}</div>
        ) : (
          <div className="app-data-backup-activity-list">
            {backupState.activities.slice(0, 6).map((activity) => (
              <div className="app-data-backup-activity" key={activity.id}>
                <span className={`app-data-backup-dot ${activity.status}`} />
                <div>
                  <strong>{activityLabel(activity.type, t)}</strong>
                  <span>{activity.message}</span>
                </div>
                <time dateTime={activity.createdAt}>{formatDateTime(activity.createdAt, { seconds: false })}</time>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
