import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "../i18n";
import { useTaskManager, useTaskList, type Task, type TaskStatus } from "../lib/taskmanager";
import { toast } from "../lib/toast";
import CopyButton from "./CopyButton";
import { clickableRowProps } from "../lib/clickableRow";
import { formatClock, formatDateTime } from "../lib/formatDateTime";
import { useScrollResetOnContentChange } from "../lib/useScrollResetOnContentChange";

interface Props {
  onNavigateToTask?: (taskId: string) => void;
}

/** 任务中心视图：展示任务列表，支持查看进度、取消、删除。 */
export default function TaskCenter({ onNavigateToTask }: Props) {
  const { t } = useTranslation();
  const manager = useTaskManager();
  const tasks = useTaskList(manager);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  // 切换任务时错误详情复用同一节点，不归零就停在上一份报错的偏移处（轮13 波29 / R49）。
  const errorRef = useRef<HTMLPreElement>(null);
  useScrollResetOnContentChange(errorRef, [selectedTask?.id ?? "", selectedTask?.error ?? ""]);

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

      {/* R102-D4：列表一条任务都没有时收成单列，别再并排两条空态（见 styles.css .list-empty）。
          选中项由上面的 effect 归位——tasks 为空时必然是 null，所以这个判据就够，不必再比 selectedTask。 */}
      <div className={`data-split task-center-content${tasks.length === 0 ? " list-empty" : ""}`}>
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
                {...clickableRowProps(() => setSelectedTask(task), { role: "group", selected: selectedTask?.id === task.id })}
              >
                <span className={`data-item-accent ${task.status === "failed" ? "danger" : task.status}`} />
                <div className="task-item-header">
                  <span className={`task-status ${getStatusClass(task.status)}`}>{getStatusLabel(task.status)}</span>
                  <span className="task-type">{getTypeLabel(task.type)}</span>
                </div>
                <div className="task-item-name" title={task.name}>
                  {task.name}
                </div>
                {task.scope && (
                  <div className="task-item-scope" title={task.scope}>
                    {task.scope}
                  </div>
                )}
                {task.status === "running" && (
                  <div className="task-item-progress">
                    <div
                      className="progress-bar"
                      role="progressbar"
                      aria-label={t("tasks.progress")}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={task.progress}
                    >
                      <div className="progress-fill" style={{ width: `${task.progress}%` }} />
                    </div>
                    <span className="progress-text">{task.progress}%</span>
                  </div>
                )}
                <div className="task-item-meta">
                  <span className="task-time">
                    {task.endTime
                      ? t("tasks.elapsed", { time: formatDuration(task.elapsedTime) })
                      : t("tasks.startedAt", { time: formatClock(task.startTime) })}
                  </span>
                  {task.failed > 0 && <span className="task-failed">{t("tasks.failedItems", { count: task.failed })}</span>}
                </div>
                <div className="task-item-actions">
                  {task.cancellable && (task.status === "running" || task.status === "pending") && (
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
              {selectedTask.scope && (
                <div className="info-row">
                  <span className="info-label">{t("tasks.scope")}:</span>
                  <span className="info-value">{selectedTask.scope}</span>
                </div>
              )}
              <div className="info-row">
                <span className="info-label">{t("tasks.progress")}:</span>
                <span className="info-value">{selectedTask.progress}%</span>
              </div>
              <div className="info-row">
                <span className="info-label">{t("tasks.startTime")}:</span>
                <span className="info-value">{formatDateTime(selectedTask.startTime)}</span>
              </div>
              {selectedTask.endTime && (
                <div className="info-row">
                  <span className="info-label">{t("tasks.endTime")}:</span>
                  <span className="info-value">{formatDateTime(selectedTask.endTime)}</span>
                </div>
              )}
              {selectedTask.elapsedTime > 0 && (
                <div className="info-row">
                  <span className="info-label">{t("tasks.duration")}:</span>
                  <span className="info-value">{formatDuration(selectedTask.elapsedTime)}</span>
                </div>
              )}
              {selectedTask.error && (
                <div className="task-detail-error">
                  <div className="data-section-head">
                    <span className="info-label">{t("tasks.errorDetail")}</span>
                    <CopyButton text={selectedTask.error} label={t("common.copyError")} />
                  </div>
                  <pre className="history-detail-error" tabIndex={0} role="region" aria-label={t("tasks.errorDetail")} ref={errorRef}>
                    {selectedTask.error}
                  </pre>
                </div>
              )}
            </div>

            {selectedTask.status === "running" && (
              <div className="task-detail-progress">
                <div
                  className="progress-bar large"
                  role="progressbar"
                  aria-label={t("tasks.progress")}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={selectedTask.progress}
                >
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
