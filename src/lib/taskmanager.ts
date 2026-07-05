// 前端任务管理器
import { useEffect, useState } from "react";

/** 任务状态 */
export type TaskStatus = "pending" | "running" | "success" | "failed" | "cancelled";

/** 任务类型 */
export type TaskType = "export" | "backup" | "apply" | "restore";

/** 任务信息 */
export interface Task {
  id: string;
  name: string;
  type: TaskType;
  scope: string;
  cancellable: boolean;
  status: TaskStatus;
  progress: number; // 0-100
  total: number;
  completed: number;
  failed: number;
  error: string;
  startTime: string;
  endTime: string | null;
  elapsedTime: number; // 毫秒
}

/** 任务创建选项 */
export interface TaskOptions {
  scope?: string;
  cancellable?: boolean;
}

/** 任务更新回调 */
export type TaskUpdateCallback = (task: Task) => void;

/** 任务管理器 */
export interface TaskManager {
  /** 创建任务 */
  createTask: (name: string, type: TaskType, options?: TaskOptions) => Task;
  /** 获取任务 */
  getTask: (id: string) => Task | undefined;
  /** 列出所有任务 */
  listTasks: () => Task[];
  /** 开始任务 */
  startTask: (id: string) => void;
  /** 更新进度 */
  updateProgress: (id: string, completed: number, failed: number, total?: number) => void;
  /** 完成任务 */
  completeTask: (id: string, success: boolean, error?: string) => void;
  /** 取消任务 */
  cancelTask: (id: string) => void;
  /** 删除任务 */
  deleteTask: (id: string) => void;
  /** 清除已完成任务 */
  clearCompleted: () => void;
  /** 订阅任务更新 */
  onTaskUpdate: (callback: TaskUpdateCallback) => () => void;
}

/** 创建任务管理器 */
export function createTaskManager(): TaskManager {
  let tasks = new Map<string, Task>();
  const listeners = new Set<TaskUpdateCallback>();

  const notify = (task: Task) => {
    listeners.forEach((cb) => cb(task));
  };

  const generateId = () => {
    return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  };

  return {
    createTask: (name, type, options = {}) => {
      const task: Task = {
        id: generateId(),
        name,
        type,
        scope: options.scope ?? "",
        cancellable: options.cancellable ?? false,
        status: "pending",
        progress: 0,
        total: 0,
        completed: 0,
        failed: 0,
        error: "",
        startTime: new Date().toISOString(),
        endTime: null,
        elapsedTime: 0,
      };
      tasks = new Map(tasks).set(task.id, task);
      notify(task);
      return task;
    },

    getTask: (id) => tasks.get(id),

    listTasks: () => Array.from(tasks.values()),

    startTask: (id) => {
      const task = tasks.get(id);
      if (task && task.status === "pending") {
        const updated = { ...task, status: "running" as TaskStatus };
        tasks = new Map(tasks).set(id, updated);
        notify(updated);
      }
    },

    updateProgress: (id, completed, failed, totalOverride) => {
      const task = tasks.get(id);
      if (task) {
        const total = totalOverride ?? (task.total > 0 ? task.total : completed + failed);
        const progress = total > 0 ? Math.round(((completed + failed) / total) * 100) : 0;
        const updated = { ...task, completed, failed, progress, total };
        tasks = new Map(tasks).set(id, updated);
        notify(updated);
      }
    },

    completeTask: (id, success, error = "") => {
      const task = tasks.get(id);
      if (task) {
        const now = new Date().toISOString();
        const elapsed = Date.now() - new Date(task.startTime).getTime();
        const updated = {
          ...task,
          status: (success ? "success" : "failed") as TaskStatus,
          progress: success ? 100 : task.progress,
          endTime: now,
          elapsedTime: elapsed,
          error: success ? "" : error,
        };
        tasks = new Map(tasks).set(id, updated);
        notify(updated);
      }
    },

    cancelTask: (id) => {
      const task = tasks.get(id);
      if (task && (task.status === "running" || task.status === "pending")) {
        const now = new Date().toISOString();
        const elapsed = Date.now() - new Date(task.startTime).getTime();
        const updated = {
          ...task,
          status: "cancelled" as TaskStatus,
          endTime: now,
          elapsedTime: elapsed,
        };
        tasks = new Map(tasks).set(id, updated);
        notify(updated);
      }
    },

    deleteTask: (id) => {
      const task = tasks.get(id);
      if (task && task.status !== "running") {
        const newTasks = new Map(tasks);
        newTasks.delete(id);
        tasks = newTasks;
        notify(task);
      }
    },

    clearCompleted: () => {
      const newTasks = new Map<string, Task>();
      let removed: Task | null = null;
      tasks.forEach((task, id) => {
        if (task.status === "running" || task.status === "pending") {
          newTasks.set(id, task);
        } else if (!removed) {
          removed = task;
        }
      });
      tasks = newTasks;
      if (removed) notify(removed);
    },

    onTaskUpdate: (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
  };
}

let sharedTaskManager: TaskManager | null = null;

/** 获取全局任务管理器。 */
export function getTaskManager(): TaskManager {
  if (!sharedTaskManager) {
    sharedTaskManager = createTaskManager();
  }
  return sharedTaskManager;
}

/** 使用任务管理器的 Hook */
export function useTaskManager(): TaskManager {
  return getTaskManager();
}

/** 使用任务列表的 Hook */
export function useTaskList(manager: TaskManager): Task[] {
  const [tasks, setTasks] = useState<Task[]>(() => manager.listTasks());

  useEffect(() => {
    const unsubscribe = manager.onTaskUpdate(() => {
      setTasks(manager.listTasks());
    });
    return unsubscribe;
  }, [manager]);

  return tasks;
}
