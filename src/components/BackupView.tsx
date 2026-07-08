import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "../i18n";
import { listSnapshots, deleteSnapshot, type ConfigSnapshot, type Snapshot } from "../api/snapshot";
import {
  importSnapshotWebDAVPackage,
  listSnapshotWebDAVPackages,
  testSnapshotWebDAV,
  uploadSnapshotWebDAVPackage,
  type RemoteSnapshotWebDAVPackage,
} from "../api/snapshotWebDAV";
import { getSnapshotStats, formatSnapshotName, formatTime } from "../lib/snapshot";
import { snapshotConnectionId, snapshotNamespaceForDiff } from "../lib/snapshotConnection";
import { reportError } from "../lib/errorCenter";
import { toast } from "../lib/toast";
import { recordOperation } from "../store/operationHistory";
import { loadSnapshotWebDAVState, recordSnapshotWebDAVActivity, updateSnapshotWebDAVSettings } from "../store/snapshotWebDAV";
import { applyEntryRiskSummary, type ApplyEntryPayload, type ApplyEntryRef } from "../lib/applyEntry";
import ConfirmModal from "./ConfirmModal";
import CopyButton from "./CopyButton";

export interface BackupDiffJumpParams {
  snapshot: Snapshot;
  config: ConfigSnapshot;
  sourceConnectionId: string;
  sourceConnectionName: string;
  snapshotPath: string;
  namespace: string;
  group: string;
  dataId: string;
}

interface Props {
  onNavigateToDiff?: (params: BackupDiffJumpParams) => void;
  onStartApply?: (payload: ApplyEntryPayload) => void;
}

const DOCUMENT_KEY = "__document";
type SnapshotWebDAVBusy = "test" | "upload" | "list" | "import" | null;

function snapshotSourceNamespace(snapshot: Pick<Snapshot, "source">): string {
  return snapshot.source.namespace || snapshot.source.namespaceId || "public";
}

function snapshotSourceLabel(snapshot: Pick<Snapshot, "source">): string {
  return `${snapshot.source.connectionName} · ${snapshotSourceNamespace(snapshot)}`;
}

/** 备份管理视图：展示本地快照列表，支持查看、删除、对比。 */
function buildBackupApplyPayload(snapshot: Snapshot, config: ConfigSnapshot): ApplyEntryPayload {
  const namespace = snapshotNamespaceForDiff(snapshot);
  const displayNamespace = snapshotSourceNamespace(snapshot);
  const sourceRef: ApplyEntryRef = {
    provider: "local",
    connectionId: snapshotConnectionId(snapshot.id),
    namespace,
    group: config.group || "DEFAULT_GROUP",
    dataId: config.dataId,
    key: DOCUMENT_KEY,
  };
  const targetRef: ApplyEntryRef = {
    provider: "nacos",
    connectionId: snapshot.source.connectionId,
    namespace,
    group: config.group || "DEFAULT_GROUP",
    dataId: config.dataId,
    key: DOCUMENT_KEY,
  };
  const item = {
    ...targetRef,
    sourceRef,
    targetRef,
  };

  return {
    sourceType: "backup",
    scope: "config",
    source: {
      provider: "local",
      connectionId: snapshotConnectionId(snapshot.id),
      connectionName: snapshot.name || snapshot.id,
      namespace,
      label: `${snapshot.name || snapshot.id} / ${displayNamespace}`,
    },
    target: {
      provider: "nacos",
      connectionId: snapshot.source.connectionId,
      connectionName: snapshot.source.connectionName,
      namespace,
      label: `${snapshot.source.connectionName} / ${displayNamespace}`,
    },
    items: [item],
    rangeSummary: applyEntryRiskSummary([item]),
    origin: {
      mode: "backup",
      returnMode: "backup",
    },
  };
}

export default function BackupView({ onNavigateToDiff, onStartApply }: Props) {
  const { t } = useTranslation();
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<Snapshot | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);
  const [snapshotWebDAV, setSnapshotWebDAV] = useState(() => loadSnapshotWebDAVState().webdav);
  const [packagePassword, setPackagePassword] = useState("");
  const [remoteSnapshots, setRemoteSnapshots] = useState<RemoteSnapshotWebDAVPackage[]>([]);
  const [snapshotWebDAVBusy, setSnapshotWebDAVBusy] = useState<SnapshotWebDAVBusy>(null);
  const [snapshotWebDAVError, setSnapshotWebDAVError] = useState<string | null>(null);
  const [snapshotWebDAVStatus, setSnapshotWebDAVStatus] = useState<string | null>(null);

  const loadSnapshots = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listSnapshots();
      setSnapshots(list || []);
      setSelectedSnapshot((current) => (current && list?.some((snap) => snap.id === current.id) ? current : (list?.[0] ?? null)));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      reportError({ title: t("backup.loadFailed"), message: msg, detail: msg });
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadSnapshots();
  }, [loadSnapshots]);

  const handleDelete = useCallback(
    async (id: string) => {
      const deletingSnapshot = snapshots.find((snap) => snap.id === id) ?? null;
      try {
        await deleteSnapshot(id);
        if (deletingSnapshot) {
          recordOperation({
            type: "snapshot_delete",
            result: "success",
            connectionId: deletingSnapshot.source.connectionId,
            connectionName: deletingSnapshot.source.connectionName,
            namespace: snapshotSourceNamespace(deletingSnapshot),
            group: "*",
            dataId: "*",
            rollbackable: false,
            rollbackReason: "operationHistory.rollbackSnapshotOnly",
            resourceId: deletingSnapshot.id,
            resourceName: formatSnapshotName(deletingSnapshot),
          });
        }
        toast(t("backup.deleted"), "success");
        void loadSnapshots();
        if (selectedSnapshot?.id === id) {
          setSelectedSnapshot(null);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (deletingSnapshot) {
          recordOperation({
            type: "snapshot_delete",
            result: "failure",
            connectionId: deletingSnapshot.source.connectionId,
            connectionName: deletingSnapshot.source.connectionName,
            namespace: snapshotSourceNamespace(deletingSnapshot),
            group: "*",
            dataId: "*",
            rollbackable: false,
            rollbackReason: "operationHistory.rollbackOnlySuccess",
            resourceId: deletingSnapshot.id,
            resourceName: formatSnapshotName(deletingSnapshot),
            error: msg,
          });
        }
        reportError({ title: t("backup.deleteFailed"), message: msg, detail: msg });
      }
      setShowDeleteConfirm(null);
    },
    [loadSnapshots, selectedSnapshot, snapshots, t]
  );

  const currentSnapshotWebDAVTarget = useCallback(() => {
    const next = updateSnapshotWebDAVSettings({
      ...snapshotWebDAV,
      enabled: true,
    });
    setSnapshotWebDAV(next.webdav);
    return next.webdav;
  }, [snapshotWebDAV]);

  const saveSnapshotWebDAVTarget = () => {
    const target = currentSnapshotWebDAVTarget();
    setSnapshotWebDAVStatus(t("backup.webdavSaved"));
    setSnapshotWebDAVError(null);
    toast(t("backup.webdavSaved"), "success");
    return target;
  };

  const requireSnapshotWebDAVTarget = () => {
    const target = currentSnapshotWebDAVTarget();
    if (!target.url.trim()) {
      const message = t("backup.webdavUrlRequired");
      setSnapshotWebDAVError(message);
      return null;
    }
    return target;
  };

  const requirePackagePassword = () => {
    if (!packagePassword.trim()) {
      const message = t("backup.packagePasswordRequired");
      setSnapshotWebDAVError(message);
      return false;
    }
    return true;
  };

  const testSnapshotWebDAVTarget = async () => {
    const target = requireSnapshotWebDAVTarget();
    if (!target) return;
    setSnapshotWebDAVBusy("test");
    setSnapshotWebDAVError(null);
    try {
      await testSnapshotWebDAV(target);
      recordSnapshotWebDAVActivity({ type: "test", status: "success", target: target.url, message: t("backup.webdavTestPassed") });
      setSnapshotWebDAVStatus(t("backup.webdavTestPassed"));
      toast(t("backup.webdavTestPassed"), "success");
    } catch (e) {
      const message = String(e);
      recordSnapshotWebDAVActivity({ type: "test", status: "failure", target: target.url, message });
      setSnapshotWebDAVError(message);
      reportError({ title: t("backup.webdavOperationFailed"), message, detail: message });
    } finally {
      setSnapshotWebDAVBusy(null);
    }
  };

  const refreshRemoteSnapshots = async () => {
    const target = requireSnapshotWebDAVTarget();
    if (!target) return;
    setSnapshotWebDAVBusy("list");
    setSnapshotWebDAVError(null);
    try {
      const list = await listSnapshotWebDAVPackages(target);
      const visible = list.filter((item) => item.name.toLowerCase().endsWith(".cssnapshot"));
      setRemoteSnapshots(visible);
      recordSnapshotWebDAVActivity({ type: "list", status: "success", target: target.rootPath, message: t("backup.remoteSnapshotsLoaded") });
      setSnapshotWebDAVStatus(t("backup.remoteSnapshotsLoaded"));
    } catch (e) {
      const message = String(e);
      recordSnapshotWebDAVActivity({ type: "list", status: "failure", target: target.rootPath, message });
      setSnapshotWebDAVError(message);
      reportError({ title: t("backup.webdavOperationFailed"), message, detail: message });
    } finally {
      setSnapshotWebDAVBusy(null);
    }
  };

  const uploadSelectedSnapshot = async () => {
    if (!selectedSnapshot) return;
    const target = requireSnapshotWebDAVTarget();
    if (!target || !requirePackagePassword()) return;
    setSnapshotWebDAVBusy("upload");
    setSnapshotWebDAVError(null);
    try {
      const remote = await uploadSnapshotWebDAVPackage(target, selectedSnapshot.id, packagePassword);
      setRemoteSnapshots((current) => [remote, ...current.filter((item) => item.path !== remote.path)]);
      recordSnapshotWebDAVActivity({ type: "upload", status: "success", target: remote.path, message: t("backup.snapshotUploaded") });
      setSnapshotWebDAVStatus(t("backup.snapshotUploaded"));
      toast(t("backup.snapshotUploaded"), "success");
    } catch (e) {
      const message = String(e);
      recordSnapshotWebDAVActivity({ type: "upload", status: "failure", target: selectedSnapshot.id, message });
      setSnapshotWebDAVError(message);
      reportError({ title: t("backup.webdavOperationFailed"), message, detail: message });
    } finally {
      setSnapshotWebDAVBusy(null);
    }
  };

  const importRemoteSnapshot = async (remote: RemoteSnapshotWebDAVPackage) => {
    const target = requireSnapshotWebDAVTarget();
    if (!target || !requirePackagePassword()) return;
    setSnapshotWebDAVBusy("import");
    setSnapshotWebDAVError(null);
    try {
      const imported = await importSnapshotWebDAVPackage(target, remote.path, packagePassword);
      recordSnapshotWebDAVActivity({ type: "import", status: "success", target: remote.path, message: t("backup.snapshotImported") });
      setSnapshotWebDAVStatus(t("backup.snapshotImported"));
      toast(t("backup.snapshotImported"), "success");
      await loadSnapshots();
      setSelectedSnapshot(imported);
    } catch (e) {
      const message = String(e);
      recordSnapshotWebDAVActivity({ type: "import", status: "failure", target: remote.path, message });
      setSnapshotWebDAVError(message);
      reportError({ title: t("backup.webdavOperationFailed"), message, detail: message });
    } finally {
      setSnapshotWebDAVBusy(null);
    }
  };

  const selectedStats = selectedSnapshot ? getSnapshotStats(selectedSnapshot) : null;
  const jumpToDiff = (snapshot: Snapshot, config: ConfigSnapshot) => {
    if (!onNavigateToDiff) return;
    onNavigateToDiff({
      snapshot,
      config,
      sourceConnectionId: snapshot.source.connectionId,
      sourceConnectionName: snapshot.source.connectionName,
      snapshotPath: snapshot.path,
      namespace: snapshotNamespaceForDiff(snapshot),
      group: config.group || "DEFAULT_GROUP",
      dataId: config.dataId,
    });
  };
  const startApply = (snapshot: Snapshot, config: ConfigSnapshot) => {
    onStartApply?.(buildBackupApplyPayload(snapshot, config));
  };

  return (
    <div className="page-surface data-page backup-view">
      <div className="page-header">
        <div>
          <h3>{t("app.backup")}</h3>
          <div className="page-subtitle">
            {snapshots.length > 0 ? t("backup.snapshotCount", { count: snapshots.length }) : t("backup.pageSubtitle")}
          </div>
        </div>
        <div className="page-actions data-summary">
          <span className="data-pill">
            {t("backup.totalConfigs", { count: snapshots.reduce((sum, snap) => sum + snap.configs.length, 0) })}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={loadSnapshots} disabled={loading} title={t("backup.refresh")}>
            ⟳ {t("backup.refresh")}
          </button>
        </div>
      </div>

      {error && (
        <div className="inline-error" role="alert">
          <div className="inline-error-head">
            <span className="inline-error-title">{t("backup.loadFailed")}</span>
            <CopyButton text={error} label={t("common.copyError")} />
          </div>
          <pre className="inline-error-body">{error}</pre>
        </div>
      )}

      {loading && <div className="pad-msg">{t("common.loading")}</div>}

      {!loading && !error && snapshots.length === 0 && (
        <div className="data-empty-state page-empty">
          <div>{t("backup.empty")}</div>
          <span>{t("backup.emptyHint")}</span>
        </div>
      )}

      {snapshots.length > 0 && (
        <div className="data-split backup-content">
          <div className="data-list backup-list">
            {snapshots.map((snap) => {
              const stats = getSnapshotStats(snap);
              const isActive = selectedSnapshot?.id === snap.id;
              return (
                <div
                  key={snap.id}
                  className={`data-list-item backup-item${isActive ? " active" : ""}`}
                  onClick={() => setSelectedSnapshot(snap)}
                >
                  <span className="data-item-accent backup" />
                  <div className="backup-item-name">{formatSnapshotName(snap)}</div>
                  <div className="backup-item-meta">
                    <span className="backup-item-count">{t("backup.configCount", { count: stats.totalConfigs })}</span>
                    <span className="backup-item-time">{formatTime(snap.createdAt)}</span>
                  </div>
                  <div className="backup-item-source">
                    {snapshotSourceLabel(snap)}
                  </div>
                  <button
                    className="btn btn-ghost btn-sm backup-item-delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowDeleteConfirm(snap.id);
                    }}
                    title={t("backup.delete")}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>

          {selectedSnapshot && (
            <div className="data-detail backup-detail">
              <div className="data-detail-header backup-detail-header">
                <div>
                  <h3 className="data-detail-title backup-detail-title">{formatSnapshotName(selectedSnapshot)}</h3>
                  <div className="data-detail-subtitle">
                    {snapshotSourceLabel(selectedSnapshot)}
                  </div>
                </div>
                <CopyButton text={JSON.stringify(selectedSnapshot, null, 2)} label={t("backup.copySnapshot")} />
              </div>

              <div className="data-info-grid backup-detail-info">
                <div className="info-row">
                  <span className="info-label">{t("backup.sourceConnection")}:</span>
                  <span className="info-value">{selectedSnapshot.source.connectionName}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">{t("backup.namespace")}:</span>
                  <span className="info-value">{snapshotSourceNamespace(selectedSnapshot)}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">{t("backup.createdAt")}:</span>
                  <span className="info-value">{formatTime(selectedSnapshot.createdAt)}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">{t("backup.configTotal")}:</span>
                  <span className="info-value">{selectedStats?.totalConfigs ?? selectedSnapshot.configs.length}</span>
                </div>
              </div>

              <div className="backup-webdav-panel" aria-labelledby="backup-webdav-title">
                <div className="data-section-head backup-webdav-head">
                  <div>
                    <h4 id="backup-webdav-title">{t("backup.webdavTitle")}</h4>
                    <span>{t("backup.webdavHint")}</span>
                  </div>
                  {snapshotWebDAVStatus && <span className="backup-webdav-status">{snapshotWebDAVStatus}</span>}
                </div>

                {snapshotWebDAVError && (
                  <div className="inline-error backup-webdav-error" role="alert">
                    <div className="inline-error-head">
                      <span className="inline-error-title">{t("backup.webdavOperationFailed")}</span>
                      <CopyButton text={snapshotWebDAVError} label={t("common.copyError")} />
                    </div>
                    <pre className="inline-error-body">{snapshotWebDAVError}</pre>
                  </div>
                )}

                <div className="backup-webdav-grid">
                  <label className="field">
                    <span>{t("backup.webdavUrl")}</span>
                    <input
                      className="search-input"
                      value={snapshotWebDAV.url}
                      onChange={(e) => setSnapshotWebDAV((current) => ({ ...current, url: e.target.value }))}
                    />
                  </label>
                  <label className="field">
                    <span>{t("backup.webdavUsername")}</span>
                    <input
                      className="search-input"
                      value={snapshotWebDAV.username}
                      onChange={(e) => setSnapshotWebDAV((current) => ({ ...current, username: e.target.value }))}
                    />
                  </label>
                  <label className="field">
                    <span>{t("backup.webdavPassword")}</span>
                    <input
                      className="search-input"
                      type="password"
                      value={snapshotWebDAV.password}
                      onChange={(e) => setSnapshotWebDAV((current) => ({ ...current, password: e.target.value }))}
                    />
                  </label>
                  <label className="field">
                    <span>{t("backup.remoteFolder")}</span>
                    <input
                      className="search-input"
                      value={snapshotWebDAV.rootPath}
                      onChange={(e) => setSnapshotWebDAV((current) => ({ ...current, rootPath: e.target.value }))}
                    />
                  </label>
                  <label className="field backup-webdav-package-password">
                    <span>{t("backup.packagePassword")}</span>
                    <input
                      className="search-input"
                      type="password"
                      value={packagePassword}
                      onChange={(e) => setPackagePassword(e.target.value)}
                    />
                  </label>
                </div>

                <div className="backup-webdav-actions">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={saveSnapshotWebDAVTarget}>
                    {t("backup.saveWebdavTarget")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => void testSnapshotWebDAVTarget()}
                    disabled={snapshotWebDAVBusy === "test"}
                  >
                    {snapshotWebDAVBusy === "test" ? t("backup.testingWebdav") : t("backup.testWebdav")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => void uploadSelectedSnapshot()}
                    disabled={snapshotWebDAVBusy === "upload"}
                  >
                    {snapshotWebDAVBusy === "upload" ? t("backup.uploadingSnapshot") : t("backup.uploadSelectedSnapshot")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => void refreshRemoteSnapshots()}
                    disabled={snapshotWebDAVBusy === "list"}
                  >
                    {snapshotWebDAVBusy === "list" ? t("backup.refreshingRemote") : t("backup.refreshRemoteSnapshots")}
                  </button>
                </div>

                <div className="backup-remote-list">
                  {remoteSnapshots.length === 0 ? (
                    <div className="settings-empty">{t("backup.noRemoteSnapshots")}</div>
                  ) : (
                    remoteSnapshots.map((remote) => (
                      <div key={remote.path} className="backup-remote-item">
                        <div className="backup-remote-main">
                          <strong>{remote.name}</strong>
                          <span>
                            {t("backup.remoteSnapshotMeta", {
                              provider: remote.provider || "-",
                              configCount: remote.configCount,
                              size: remote.size,
                              modifiedAt: remote.modifiedAt || "-",
                            })}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => void importRemoteSnapshot(remote)}
                          disabled={snapshotWebDAVBusy === "import"}
                        >
                          {t("backup.importRemoteSnapshot", { name: remote.name })}
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="backup-detail-configs">
                <div className="data-section-head">
                  <h4>{t("backup.configList")}</h4>
                  <span>{t("backup.configCount", { count: selectedSnapshot.configs.length })}</span>
                </div>
                <div className="backup-configs-list">
                  {selectedSnapshot.configs.map((cfg) => (
                    <div key={`${cfg.group}/${cfg.dataId}`} className="backup-config-item">
                      <div className="backup-config-main">
                        <span className="backup-config-dataid">{cfg.dataId}</span>
                        <span className="backup-config-group">{cfg.group}</span>
                        <span className="backup-config-type">{cfg.configType}</span>
                      </div>
                      {onNavigateToDiff && (
                        <button
                          className="btn btn-ghost btn-sm backup-config-compare"
                          onClick={() => jumpToDiff(selectedSnapshot, cfg)}
                          disabled={!selectedSnapshot.path}
                          title={selectedSnapshot.path ? t("backup.compareWithCloud") : t("backup.snapshotPathMissing")}
                        >
                          {t("backup.compareWithCloud")}
                        </button>
                      )}
                      {onStartApply && (
                        <button className="btn btn-ghost btn-sm" onClick={() => startApply(selectedSnapshot, cfg)}>
                          {t("backup.startApply")}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {showDeleteConfirm && (
        <ConfirmModal
          title={t("backup.delete")}
          message={t("backup.deleteConfirm")}
          confirmLabel={t("common.delete")}
          cancelLabel={t("common.cancel")}
          onConfirm={() => handleDelete(showDeleteConfirm)}
          onCancel={() => setShowDeleteConfirm(null)}
        />
      )}
    </div>
  );
}
