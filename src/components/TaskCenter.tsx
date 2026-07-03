import { useCallback, useState } from "react";
import { useTranslation } from "../i18n";
import { useTaskManager, useTaskList, type Task, type TaskStatus } from "../lib/taskmanager";
import { toast } from "../lib/toast";

interface Props {
  onNavigateToTask?: (taskId: string) => void;
}

/** 任务中心视图：展示任务列表，支持查看进度、取消、删除。 */
export default function TaskCenter({ onNavigateToTask }: Props) {
  const { t } = useTranslation();
  const manager = useTaskManager();
  const tasks = useTaskList(manager);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  const handleCancel = useCallback(
    (taskId: string) => {
      manager.cancelTask(taskId);
      toast.info("任务已取消");
    },
    [manager]
  );

  const handleDelete = useCallback(
    (taskId: string) => {
      manager.deleteTask(taskId);
      toast.success("任务已删除");
      if (selectedTask?.id === taskId) {
        setSelectedTask(null);
      }
    },
    [manager, selectedTask]
  );

  const handleClearCompleted = useCallback(() => {
    manager.clearCompleted();
    toast.success("已清除已完成任务");
  }, [manager]);

  const getStatusLabel = (status: TaskStatus): string => {
    const labels: Record<TaskStatus, string> = {
      pending: "待执行",
      running: "运行中",
      success: "成功",
      failed: "失败",
      cancelled: "已取消",
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
      export: "导出",
      backup: "备份",
      apply: "应用",
      restore: "恢复",
    };
    return labels[type] || type;
  };

  const formatTime = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  };

  return (
    <div className="task-center">
      <div className="task-center-header">
        <h2 className="task-center-title">任务中心</h2>
        <div className="task-center-actions">
          <button
            className="btn btn-ghost btn-sm"
            onClick={handleClearCompleted}
            disabled={!tasks.some((t) => t.status !== "running" && t.status !== "pending")}
          >
            清除已完成
          </button>
        </div>
      </div>

      <div className="task-center-content">
        <div className="task-list">
          {tasks.length === 0 ? (
            <div className="pad-msg big">暂无任务</div>
          ) : (
            tasks.map((task) => (
              <div
                key={task.id}
                className={`task-item ${selectedTask?.id === task.id ? "active" : ""}`}
                onClick={() => setSelectedTask(task)}
              >
                <div className="task-item-header">
                  <span className={`task-status ${getStatusClass(task.status)}`}>
                    {getStatusLabel(task.status)}
                  </span>
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
                      ? `耗时 ${formatTime(task.elapsedTime)}`
                      : `开始于 ${new Date(task.startTime).toLocaleTimeString()}`}
                  </span>
                  {task.failed > 0 && <span className="task-failed">{task.failed} 失败</span>}
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
                      取消
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
                      删除
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {selectedTask && (
          <div className="task-detail">
            <div className="task-detail-header">
              <h3 className="task-detail-title">{selectedTask.name}</h3>
              <div className="task-detail-actions">
                {onNavigateToTask && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => onNavigateToTask(selectedTask.id)}
                  >
                    查看详情
                  </button>
                )}
              </div>
            </div>

            <div className="task-detail-info">
              <div className="info-row">
                <span className="info-label">任务 ID:</span>
                <span className="info-value mono">{selectedTask.id}</span>
              </div>
              <div className="info-row">
                <span className="info-label">类型:</span>
                <span className="info-value">{getTypeLabel(selectedTask.type)}</span>
              </div>
              <div className="info-row">
                <span className="info-label">状态:</span>
                <span className={`info-value ${getStatusClass(selectedTask.status)}`}>
                  {getStatusLabel(selectedTask.status)}
                </span>
              </div>
              <div className="info-row">
                <span className="info-label">进度:</span>
                <span className="info-value">{selectedTask.progress}%</span>
              </div>
              <div className="info-row">
                <span className="info-label">开始时间:</span>
                <span className="info-value">
                  {new Date(selectedTask.startTime).toLocaleString()}
                </span>
              </div>
              {selectedTask.endTime && (
                <div className="info-row">
                  <span className="info-label">结束时间:</span>
                  <span className="info-value">
                    {new Date(selectedTask.endTime).toLocaleString()}
                  </span>
                </div>
              )}
              {selectedTask.elapsedTime > 0 && (
                <div className="info-row">
                  <span className="info-label">耗时:</span>
                  <span className="info-value">{formatTime(selectedTask.elapsedTime)}</span>
                </div>
              )}
              {selectedTask.error && (
                <div className="info-row">
                  <span className="info-label">错误:</span>
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
                  <span>已完成: {selectedTask.completed}</span>
                  <span>失败: {selectedTask.failed}</span>
                  <span>总计: {selectedTask.total}</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
