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
import { getTaskManager } from "../lib/taskmanager";
import { toast } from "../lib/toast";
import {
  loadAppDataBackupState,
  recordAppDataBackupActivity,
  updateAppDataBackupPasswordSecretRef,
  updateAppDataWebDAVSettings,
  type AppDataBackupActivity,
  type AppDataWebDAVSettings,
} from "../store/appDataBackup";
import { deleteStoredSecret, resolveAppDataBackupPassword, saveAppDataBackupPassword } from "../lib/credentialSecrets";
import CopyButton from "./CopyButton";

interface Props {
  onRestored?: () => void;
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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

function InlineError({ title, message }: { title: string; message: string }) {
  const { t } = useTranslation();
  return (
    <div className="inline-error app-data-backup-error" role="alert">
      <div className="inline-error-head">
        <span className="inline-error-title">{title}</span>
        <div className="inline-error-actions">
          <CopyButton text={message} label={t("common.copyError")} />
        </div>
      </div>
      <pre className="inline-error-body">{message}</pre>
    </div>
  );
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
        <span>{t("appDataBackup.summaryCreatedAt", { createdAt: summary.createdAt })}</span>
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

export default function AppDataBackupPanel({ onRestored }: Props) {
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

  const refreshState = () => {
    const next = loadAppDataBackupState();
    setBackupState(next);
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
      const message = toErrorMessage(e);
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
      const message = toErrorMessage(e);
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
      setError(toErrorMessage(e));
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
      setError(toErrorMessage(e));
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
      const message = toErrorMessage(e);
      recordActivity("recovery_point", "failure", preview.target, message);
      setError(message);
    } finally {
      setBusy("");
    }
  };

  const saveWebDAVTarget = () => {
    clearMessages();
    const next = updateAppDataWebDAVSettings(currentWebDAVTarget());
    setBackupState(next);
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
      setBackupState(next);
      setSavedPasswordDraft("");
      setSavedPasswordConfirm("");
      setStatus({ ok: true, text: t("appDataBackup.savedPasswordSaved") });
      toast(t("appDataBackup.savedPasswordSaved"), "success");
    } catch (e) {
      setError(toErrorMessage(e));
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
      setBackupState(next);
      setStatus({ ok: true, text: t("appDataBackup.savedPasswordCleared") });
    } catch (e) {
      setError(toErrorMessage(e));
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
      setError(toErrorMessage(e));
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
      const message = toErrorMessage(e);
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
      setError(toErrorMessage(e));
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
      setError(toErrorMessage(e));
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
        <div className={`test-msg ${status.ok ? "ok" : "err"}`}>
          <span className="test-msg-text">{status.text}</span>
        </div>
      )}
      {error && <InlineError title={t("appDataBackup.operationFailed")} message={error} />}

      <section className="app-data-backup-password-settings" aria-labelledby="app-data-backup-password-title">
        <div className="app-data-backup-area-head">
          <div>
            <h6 id="app-data-backup-password-title">{t("appDataBackup.savedPasswordTitle")}</h6>
            <span>{t("appDataBackup.savedPasswordHint")}</span>
          </div>
          {backupState.backupPasswordSecretRef?.status === "stored" && <strong>{t("appDataBackup.savedPasswordConfigured")}</strong>}
        </div>
        <div className="app-data-backup-fields">
          <label className="field">
            <span>{t("appDataBackup.savedPassword")}</span>
            <input className="search-input" type="password" value={savedPasswordDraft} onChange={(e) => setSavedPasswordDraft(e.target.value)} />
          </label>
          <label className="field">
            <span>{t("appDataBackup.confirmSavedPassword")}</span>
            <input className="search-input" type="password" value={savedPasswordConfirm} onChange={(e) => setSavedPasswordConfirm(e.target.value)} />
          </label>
        </div>
        <div className="app-data-backup-action-row">
          <button type="button" className="btn btn-primary btn-sm" onClick={saveBackupPassword} disabled={busy === "backup-password-save"}>
            {busy === "backup-password-save" ? t("appDataBackup.savingPassword") : t("appDataBackup.savePassword")}
          </button>
          {backupState.backupPasswordSecretRef?.status === "stored" && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={clearBackupPassword} disabled={busy === "backup-password-clear"}>
              {busy === "backup-password-clear" ? t("appDataBackup.clearingPassword") : t("appDataBackup.clearSavedPassword")}
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
              <label className="field">
                <span>{t("appDataBackup.localBackupPassword")}</span>
                <input className="search-input" type="password" value={exportPassword} onChange={(e) => setExportPassword(e.target.value)} />
              </label>
              <label className="field">
                <span>{t("appDataBackup.confirmLocalBackupPassword")}</span>
                <input className="search-input" type="password" value={exportConfirm} onChange={(e) => setExportConfirm(e.target.value)} />
              </label>
            </div>
            <div className="app-data-backup-action-row">
              <button type="button" className="btn btn-primary btn-sm" onClick={exportLocalBackup} disabled={busy === "local-export"}>
                {busy === "local-export" ? t("appDataBackup.exporting") : t("appDataBackup.exportEncryptedFile")}
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
            <label className="field">
              <span>{t("appDataBackup.restorePassword")}</span>
              <input className="search-input" type="password" value={restorePassword} onChange={(e) => setRestorePassword(e.target.value)} />
            </label>
            <div className="app-data-backup-action-row">
              <button type="button" className="btn btn-primary btn-sm" onClick={previewLocalBackup} disabled={busy === "local-preview"}>
                {busy === "local-preview" ? t("appDataBackup.previewing") : t("appDataBackup.previewLocalBackup")}
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
                <input className="search-input" value={webdavDraft.url} onChange={(e) => setWebdavDraft({ ...webdavDraft, url: e.target.value })} />
              </label>
              <label className="field">
                <span>{t("appDataBackup.webdavUsername")}</span>
                <input className="search-input" value={webdavDraft.username} onChange={(e) => setWebdavDraft({ ...webdavDraft, username: e.target.value })} />
              </label>
              <label className="field">
                <span>{t("appDataBackup.webdavPassword")}</span>
                <input className="search-input" type="password" value={webdavDraft.password} onChange={(e) => setWebdavDraft({ ...webdavDraft, password: e.target.value })} />
              </label>
              <label className="field">
                <span>{t("appDataBackup.remoteFolder")}</span>
                <input className="search-input" value={webdavDraft.rootPath} onChange={(e) => setWebdavDraft({ ...webdavDraft, rootPath: e.target.value })} />
              </label>
            </div>
            <div className="app-data-backup-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={saveWebDAVTarget}>
                {t("appDataBackup.saveWebdavTarget")}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={testWebDAVTarget} disabled={busy === "webdav-test"}>
                {busy === "webdav-test" ? t("appDataBackup.testingWebdav") : t("appDataBackup.testWebdav")}
              </button>
            </div>
          </div>

          <div className="app-data-backup-step">
            <div className="app-data-backup-block-head">
              <strong>{t("appDataBackup.cloudBackupActions")}</strong>
              <span>{t("appDataBackup.cloudBackupActionsHint")}</span>
            </div>
            <div className="app-data-backup-remote-tools">
              <label className="field">
                <span>{t("appDataBackup.webdavBackupPassword")}</span>
                <input className="search-input" type="password" value={webdavBackupPassword} onChange={(e) => setWebdavBackupPassword(e.target.value)} />
              </label>
              <button type="button" className="btn btn-primary btn-sm" onClick={uploadWebDAVBackup} disabled={busy === "webdav-upload"}>
                {busy === "webdav-upload" ? t("appDataBackup.uploading") : t("appDataBackup.uploadCurrentData")}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={refreshRemoteBackups} disabled={busy === "webdav-list"}>
                {busy === "webdav-list" ? t("appDataBackup.refreshing") : t("appDataBackup.refreshRemoteList")}
              </button>
            </div>

            <label className="field app-data-backup-remote-password">
              <span>{t("appDataBackup.remoteRestorePassword")}</span>
              <input className="search-input" type="password" value={remoteRestorePassword} onChange={(e) => setRemoteRestorePassword(e.target.value)} />
            </label>

            <div className="app-data-backup-remote-list">
              {remoteBackups.length === 0 ? (
                <div className="settings-empty">{t("appDataBackup.noRemoteBackups")}</div>
              ) : (
                remoteBackups.map((remote) => (
                  <div className="app-data-backup-remote-row" key={remote.path}>
                    <div>
                      <strong>{remote.name}</strong>
                      <span>{t("appDataBackup.remoteMeta", { size: remote.size, modifiedAt: remote.modifiedAt || "-" })}</span>
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
          <button type="button" className="btn btn-primary btn-sm" onClick={restorePreview} disabled={busy === "restore"}>
            {busy === "restore" ? t("appDataBackup.restoring") : t("appDataBackup.restoreThisBackup")}
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
                <time>{activity.createdAt}</time>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
