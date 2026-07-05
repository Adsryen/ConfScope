import { beforeEach, describe, it, expect, vi } from "vitest";
import { createTaskManager, getTaskManager } from "./taskmanager";

function clearSharedTasks() {
  const manager = getTaskManager();
  for (const task of manager.listTasks()) {
    if (task.status === "running" || task.status === "pending") {
      manager.cancelTask(task.id);
    }
    manager.deleteTask(task.id);
  }
}

describe("createTaskManager", () => {
  beforeEach(() => {
    clearSharedTasks();
  });

  it("creates a task", () => {
    const manager = createTaskManager();
    const task = manager.createTask("导出配置", "export");

    expect(task.id).toBeTruthy();
    expect(task.name).toBe("导出配置");
    expect(task.type).toBe("export");
    expect(task.status).toBe("pending");
    expect(task.progress).toBe(0);
  });

  it("creates tasks as non-cancellable with empty scope by default", () => {
    const manager = createTaskManager();
    const task = manager.createTask("Export", "export");

    expect(task).toMatchObject({
      scope: "",
      cancellable: false,
    });
  });

  it("preserves task scope and cancellable options", () => {
    const manager = createTaskManager();
    const task = Reflect.apply(manager.createTask, manager, [
      "Backup",
      "backup",
      { scope: "dev / public / 2 configs", cancellable: true },
    ]);

    expect(task).toMatchObject({
      name: "Backup",
      type: "backup",
      scope: "dev / public / 2 configs",
      cancellable: true,
    });
  });

  it("lists tasks", () => {
    const manager = createTaskManager();
    manager.createTask("任务1", "export");
    manager.createTask("任务2", "backup");
    manager.createTask("任务3", "apply");

    const tasks = manager.listTasks();
    expect(tasks).toHaveLength(3);
  });

  it("gets a task by id", () => {
    const manager = createTaskManager();
    const task = manager.createTask("测试任务", "export");

    const got = manager.getTask(task.id);
    expect(got).toBeDefined();
    expect(got?.id).toBe(task.id);
  });

  it("starts a task", () => {
    const manager = createTaskManager();
    const task = manager.createTask("测试任务", "export");

    manager.startTask(task.id);
    const updated = manager.getTask(task.id);

    expect(updated?.status).toBe("running");
  });

  it("updates progress", () => {
    const manager = createTaskManager();
    const task = manager.createTask("测试任务", "export");
    manager.startTask(task.id);

    manager.updateProgress(task.id, 5, 0);
    const updated = manager.getTask(task.id);

    expect(updated?.completed).toBe(5);
    // total is set to 5 (completed + failed), so progress is 100%
    expect(updated?.progress).toBe(100);
  });

  it("completes a task successfully", () => {
    const manager = createTaskManager();
    const task = manager.createTask("测试任务", "export");
    manager.startTask(task.id);

    manager.completeTask(task.id, true);
    const updated = manager.getTask(task.id);

    expect(updated?.status).toBe("success");
    expect(updated?.progress).toBe(100);
    expect(updated?.endTime).toBeTruthy();
  });

  it("completes a task with failure", () => {
    const manager = createTaskManager();
    const task = manager.createTask("测试任务", "export");
    manager.startTask(task.id);

    manager.completeTask(task.id, false, "网络错误");
    const updated = manager.getTask(task.id);

    expect(updated?.status).toBe("failed");
    expect(updated?.error).toBe("网络错误");
  });

  it("cancels a task", () => {
    const manager = createTaskManager();
    const task = manager.createTask("测试任务", "export");
    manager.startTask(task.id);

    manager.cancelTask(task.id);
    const updated = manager.getTask(task.id);

    expect(updated?.status).toBe("cancelled");
  });

  it("deletes a non-running task", () => {
    const manager = createTaskManager();
    const task = manager.createTask("测试任务", "export");

    manager.deleteTask(task.id);
    expect(manager.getTask(task.id)).toBeUndefined();
  });

  it("does not delete a running task", () => {
    const manager = createTaskManager();
    const task = manager.createTask("测试任务", "export");
    manager.startTask(task.id);

    manager.deleteTask(task.id);
    expect(manager.getTask(task.id)).toBeDefined();
  });

  it("clears completed tasks", () => {
    const manager = createTaskManager();
    const task1 = manager.createTask("成功任务", "export");
    const task2 = manager.createTask("失败任务", "backup");
    const task3 = manager.createTask("运行中任务", "apply");

    manager.startTask(task1.id);
    manager.completeTask(task1.id, true);

    manager.startTask(task2.id);
    manager.completeTask(task2.id, false, "错误");

    manager.startTask(task3.id);

    manager.clearCompleted();

    const tasks = manager.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(task3.id);
  });

  it("notifies listeners on task update", () => {
    const manager = createTaskManager();
    const listener = vi.fn();

    const unsubscribe = manager.onTaskUpdate(listener);

    const task = manager.createTask("测试任务", "export");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }));

    manager.startTask(task.id);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    manager.cancelTask(task.id);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("returns the same shared manager across callers", () => {
    const first = getTaskManager();
    const second = getTaskManager();

    const task = first.createTask("共享备份任务", "backup");

    expect(second.getTask(task.id)?.name).toBe("共享备份任务");
  });

  it("notifies list subscribers after deleting and clearing tasks", () => {
    const manager = createTaskManager();
    const listener = vi.fn();
    const unsubscribe = manager.onTaskUpdate(listener);
    const task = manager.createTask("可删除任务", "export");

    manager.deleteTask(task.id);

    expect(manager.listTasks()).toHaveLength(0);
    expect(listener).toHaveBeenCalledTimes(2);

    const done = manager.createTask("已完成任务", "backup");
    manager.startTask(done.id);
    manager.completeTask(done.id, true);
    listener.mockClear();

    manager.clearCompleted();

    expect(manager.listTasks()).toHaveLength(0);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });
});
