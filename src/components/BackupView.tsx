import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "../i18n";
import { listSnapshots, deleteSnapshot, type Snapshot } from "../api/snapshot";
import { getSnapshotStats, formatSnapshotName, formatTime } from "../lib/snapshot";
import { reportError } from "../lib/errorCenter";
import { toast } from "../lib/toast";
import ConfirmModal from "./ConfirmModal";

interface Props {
  onNavigateToDiff?: (params: {
    leftConnId: string;
    rightConnId: string;
    namespace: string;
    group: string;
    dataId: string;
  }) => void;
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
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      reportError("加载快照列表失败", msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSnapshots();
  }, [loadSnapshots]);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await deleteSnapshot(id);
        toast.success("快照已删除");
        void loadSnapshots();
        if (selectedSnapshot?.id === id) {
          setSelectedSnapshot(null);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        reportError("删除快照失败", msg);
      }
      setShowDeleteConfirm(null);
    },
    [loadSnapshots, selectedSnapshot]
  );

  return (
    <div className="backup-view">
      <div className="backup-header">
        <h2 className="backup-title">本地备份</h2>
        <button
          className="btn btn-ghost btn-sm"
          onClick={loadSnapshots}
          disabled={loading}
          title="刷新列表"
        >
          ⟳
        </button>
      </div>

      {error && (
        <div className="inline-error" role="alert">
          <div className="inline-error-head">
            <span className="inline-error-title">加载失败</span>
          </div>
          <pre className="inline-error-body">{error}</pre>
        </div>
      )}

      {loading && <div className="pad-msg">加载中...</div>}

      {!loading && !error && snapshots.length === 0 && (
        <div className="pad-msg big">
          <div>暂无本地备份</div>
          <div className="backup-hint">在配置浏览或对比页面可以创建快照</div>
        </div>
      )}

      <div className="backup-content">
        <div className="backup-list">
          {snapshots.map((snap) => {
            const stats = getSnapshotStats(snap);
            const isActive = selectedSnapshot?.id === snap.id;
            return (
              <div
                key={snap.id}
                className={`backup-item${isActive ? " active" : ""}`}
                onClick={() => setSelectedSnapshot(snap)}
              >
                <div className="backup-item-name">{formatSnapshotName(snap)}</div>
                <div className="backup-item-meta">
                  <span className="backup-item-count">{stats.totalConfigs} 个配置</span>
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
                  title="删除快照"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>

        {selectedSnapshot && (
          <div className="backup-detail">
            <div className="backup-detail-header">
              <h3 className="backup-detail-title">{formatSnapshotName(selectedSnapshot)}</h3>
              <div className="backup-detail-actions">
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    const stats = getSnapshotStats(selectedSnapshot);
                    toast.info(`快照包含 ${stats.totalConfigs} 个配置`);
                  }}
                >
                  查看详情
                </button>
              </div>
            </div>

            <div className="backup-detail-info">
              <div className="info-row">
                <span className="info-label">来源连接:</span>
                <span className="info-value">{selectedSnapshot.source.connectionName}</span>
              </div>
              <div className="info-row">
                <span className="info-label">命名空间:</span>
                <span className="info-value">{selectedSnapshot.source.namespace || "public"}</span>
              </div>
              <div className="info-row">
                <span className="info-label">创建时间:</span>
                <span className="info-value">{formatTime(selectedSnapshot.createdAt)}</span>
              </div>
              <div className="info-row">
                <span className="info-label">配置数量:</span>
                <span className="info-value">{selectedSnapshot.configs.length}</span>
              </div>
            </div>

            <div className="backup-detail-configs">
              <h4>配置列表</h4>
              <div className="backup-configs-list">
                {selectedSnapshot.configs.map((cfg) => (
                  <div key={`${cfg.group}/${cfg.dataId}`} className="backup-config-item">
                    <span className="backup-config-dataid">{cfg.dataId}</span>
                    <span className="backup-config-group">{cfg.group}</span>
                    <span className="backup-config-type">{cfg.configType}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {showDeleteConfirm && (
        <ConfirmModal
          title="删除快照"
          message="确定要删除这个快照吗？此操作不可恢复。"
          confirmLabel="删除"
          cancelLabel="取消"
          onConfirm={() => handleDelete(showDeleteConfirm)}
          onCancel={() => setShowDeleteConfirm(null)}
        />
      )}
    </div>
  );
}
