import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "../i18n";
import { listSnapshots, deleteSnapshot, type ConfigSnapshot, type Snapshot } from "../api/snapshot";
import { getSnapshotStats, formatSnapshotName, formatTime } from "../lib/snapshot";
import { snapshotNamespaceForDiff } from "../lib/snapshotConnection";
import { reportError } from "../lib/errorCenter";
import { toast } from "../lib/toast";
import ConfirmModal from "./ConfirmModal";
import CopyButton from "./CopyButton";

export interface BackupDiffJumpParams {
  snapshot: Snapshot;
  config: ConfigSnapshot;
  sourceConnectionId: string;
  sourceConnectionName: string;
  namespace: string;
  group: string;
  dataId: string;
}

interface Props {
  onNavigateToDiff?: (params: BackupDiffJumpParams) => void;
}

/** 备份管理视图：展示本地快照列表，支持查看、删除、对比。 */
export default function BackupView({ onNavigateToDiff }: Props) {
  const { t } = useTranslation();
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<Snapshot | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);

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
      try {
        await deleteSnapshot(id);
        toast(t("backup.deleted"), "success");
        void loadSnapshots();
        if (selectedSnapshot?.id === id) {
          setSelectedSnapshot(null);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        reportError({ title: t("backup.deleteFailed"), message: msg, detail: msg });
      }
      setShowDeleteConfirm(null);
    },
    [loadSnapshots, selectedSnapshot, t]
  );

  const selectedStats = selectedSnapshot ? getSnapshotStats(selectedSnapshot) : null;
  const jumpToDiff = (snapshot: Snapshot, config: ConfigSnapshot) => {
    if (!onNavigateToDiff) return;
    onNavigateToDiff({
      snapshot,
      config,
      sourceConnectionId: snapshot.source.connectionId,
      sourceConnectionName: snapshot.source.connectionName,
      namespace: snapshotNamespaceForDiff(snapshot),
      group: config.group || "DEFAULT_GROUP",
      dataId: config.dataId,
    });
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
                    {snap.source.connectionName} · {snap.source.namespace || "public"}
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
                    {selectedSnapshot.source.connectionName} · {selectedSnapshot.source.namespace || "public"}
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
                  <span className="info-value">{selectedSnapshot.source.namespace || "public"}</span>
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
