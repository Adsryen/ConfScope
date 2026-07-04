import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "../i18n";
import { useTaskManager, useTaskList, type Task, type TaskStatus } from "../lib/taskmanager";
import { toast } from "../lib/toast";
import CopyButton from "./CopyButton";

interface Props {
  onNavigateToTask?: (taskId: string) => void;
}

/** 任务中心视图：展示任务列表，支持查看进度、取消、删除。 */
export default function TaskCenter({ onNavigateToTask }: Props) {
  const { t } = useTranslation();
  const manager = useTaskManager();
  const tasks = useTaskList(manager);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  useEffect(() => {
    if (selectedTask && tasks.some((task) => task.id === selectedTask.id)) return;
    setSelectedTask(tasks[0] ?? null);
  }, [selectedTask, tasks]);

  const handleCancel = useCallback(
    (taskId: string) => {
      manager.cancelTask(taskId);
      toast(t("tasks.cancelled"), "info");
    },
    [manager, t]
  );

  const handleDelete = useCallback(
    (taskId: string) => {
      manager.deleteTask(taskId);
      toast(t("tasks.deleted"), "success");
      if (selectedTask?.id === taskId) {
        setSelectedTask(null);
      }
    },
    [manager, selectedTask, t]
  );

  const handleClearCompleted = useCallback(() => {
    manager.clearCompleted();
    toast(t("tasks.cleared"), "success");
  }, [manager, t]);

  const getStatusLabel = (status: TaskStatus): string => {
    const labels: Record<TaskStatus, string> = {
      pending: t("tasks.statusPending"),
      running: t("tasks.statusRunning"),
      success: t("tasks.statusSuccess"),
      failed: t("tasks.statusFailed"),
      cancelled: t("tasks.statusCancelled"),
    };
    return labels[status] || status;
  };

  const getStatusClass = (status: TaskStatus): string => {
    const classes: Record<TaskStatus, string> = {
      pending: "task-status-pending",
      running: "task-status-running",
      success: "task-status-success",
      failed: "task-status-failed",
      cancelled: "task-status-cancelled",
    };
    return classes[status] || "";
  };

  const getTypeLabel = (type: string): string => {
    const labels: Record<string, string> = {
      export: t("tasks.typeExport"),
      backup: t("tasks.typeBackup"),
      apply: t("tasks.typeApply"),
      restore: t("tasks.typeRestore"),
    };
    return labels[type] || type;
  };

  const formatDuration = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  };

  return (
    <div className="page-surface data-page task-center">
      <div className="page-header">
        <div>
          <h3>{t("app.tasks")}</h3>
          <div className="page-subtitle">{tasks.length > 0 ? t("tasks.taskCount", { count: tasks.length }) : t("tasks.pageSubtitle")}</div>
        </div>
        <div className="page-actions data-summary">
          <span className="data-pill running">
            {t("tasks.runningCount", { count: tasks.filter((task) => task.status === "running").length })}
          </span>
          <span className="data-pill danger">
            {t("tasks.failedCount", { count: tasks.filter((task) => task.status === "failed").length })}
          </span>
          <button
            className="btn btn-ghost btn-sm"
            onClick={handleClearCompleted}
            disabled={!tasks.some((t) => t.status !== "running" && t.status !== "pending")}
          >
            {t("tasks.clearCompleted")}
          </button>
        </div>
      </div>

      <div className="data-split task-center-content">
        <div className="data-list task-list">
          {tasks.length === 0 ? (
            <div className="data-empty-state">
              <div>{t("tasks.empty")}</div>
              <span>{t("tasks.emptyHint")}</span>
            </div>
          ) : (
            tasks.map((task) => (
              <div
                key={task.id}
                className={`data-list-item task-item${selectedTask?.id === task.id ? " active" : ""}`}
                onClick={() => setSelectedTask(task)}
              >
                <span className={`data-item-accent ${task.status === "failed" ? "danger" : task.status}`} />
                <div className="task-item-header">
                  <span className={`task-status ${getStatusClass(task.status)}`}>{getStatusLabel(task.status)}</span>
                  <span className="task-type">{getTypeLabel(task.type)}</span>
                </div>
                <div className="task-item-name">{task.name}</div>
                {task.status === "running" && (
                  <div className="task-item-progress">
                    <div className="progress-bar">
                      <div className="progress-fill" style={{ width: `${task.progress}%` }} />
                    </div>
                    <span className="progress-text">{task.progress}%</span>
                  </div>
                )}
                <div className="task-item-meta">
                  <span className="task-time">
                    {task.endTime
                      ? t("tasks.elapsed", { time: formatDuration(task.elapsedTime) })
                      : t("tasks.startedAt", { time: new Date(task.startTime).toLocaleTimeString() })}
                  </span>
                  {task.failed > 0 && <span className="task-failed">{t("tasks.failedItems", { count: task.failed })}</span>}
                </div>
                <div className="task-item-actions">
                  {(task.status === "running" || task.status === "pending") && (
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCancel(task.id);
                      }}
                    >
                      {t("common.cancel")}
                    </button>
                  )}
                  {task.status !== "running" && (
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(task.id);
                      }}
                    >
                      {t("common.delete")}
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {selectedTask ? (
          <div className="data-detail task-detail">
            <div className="data-detail-header task-detail-header">
              <div>
                <h3 className="data-detail-title task-detail-title">{selectedTask.name}</h3>
                <div className="data-detail-subtitle">
                  {getTypeLabel(selectedTask.type)} · {getStatusLabel(selectedTask.status)}
                </div>
              </div>
              <div className="task-detail-actions">
                {onNavigateToTask && (
                  <button className="btn btn-ghost btn-sm" onClick={() => onNavigateToTask(selectedTask.id)}>
                    {t("tasks.openDetail")}
                  </button>
                )}
                <CopyButton text={JSON.stringify(selectedTask, null, 2)} label={t("tasks.copyTask")} />
              </div>
            </div>

            <div className="data-info-grid task-detail-info">
              <div className="info-row">
                <span className="info-label">{t("tasks.taskId")}:</span>
                <span className="info-value mono">{selectedTask.id}</span>
              </div>
              <div className="info-row">
                <span className="info-label">{t("tasks.type")}:</span>
                <span className="info-value">{getTypeLabel(selectedTask.type)}</span>
              </div>
              <div className="info-row">
                <span className="info-label">{t("tasks.status")}:</span>
                <span className={`info-value ${getStatusClass(selectedTask.status)}`}>{getStatusLabel(selectedTask.status)}</span>
              </div>
              <div className="info-row">
                <span className="info-label">{t("tasks.progress")}:</span>
                <span className="info-value">{selectedTask.progress}%</span>
              </div>
              <div className="info-row">
                <span className="info-label">{t("tasks.startTime")}:</span>
                <span className="info-value">{new Date(selectedTask.startTime).toLocaleString()}</span>
              </div>
              {selectedTask.endTime && (
                <div className="info-row">
                  <span className="info-label">{t("tasks.endTime")}:</span>
                  <span className="info-value">{new Date(selectedTask.endTime).toLocaleString()}</span>
                </div>
              )}
              {selectedTask.elapsedTime > 0 && (
                <div className="info-row">
                  <span className="info-label">{t("tasks.duration")}:</span>
                  <span className="info-value">{formatDuration(selectedTask.elapsedTime)}</span>
                </div>
              )}
              {selectedTask.error && (
                <div className="info-row">
                  <span className="info-label">{t("common.error")}:</span>
                  <span className="info-value error">{selectedTask.error}</span>
                </div>
              )}
            </div>

            {selectedTask.status === "running" && (
              <div className="task-detail-progress">
                <div className="progress-bar large">
                  <div className="progress-fill" style={{ width: `${selectedTask.progress}%` }} />
                </div>
                <div className="progress-stats">
                  <span>{t("tasks.completedStat", { count: selectedTask.completed })}</span>
                  <span>{t("tasks.failedStat", { count: selectedTask.failed })}</span>
                  <span>{t("tasks.totalStat", { count: selectedTask.total })}</span>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="data-detail task-detail">
            <div className="data-empty-state detail-empty">
              <div>{t("tasks.selectHint")}</div>
              <span>{t("tasks.selectHintDetail")}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
