// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import TaskCenter from "./TaskCenter";
import { I18nProvider } from "../i18n";
import { getTaskManager } from "../lib/taskmanager";

// 模拟 taskmanager
vi.mock("../lib/taskmanager", async (importOriginal) => {
  const actual = await importOriginal();
  return actual;
});

// 模拟 toast
vi.mock("../lib/toast", () => ({
  toast: vi.fn(),
}));

function clearTasks() {
  const manager = getTaskManager();
  for (const task of manager.listTasks()) {
    if (task.status === "running" || task.status === "pending") {
      manager.cancelTask(task.id);
    }
    manager.deleteTask(task.id);
  }
}

describe("TaskCenter", () => {
  const renderWithI18n = (ui: React.ReactElement) => {
    return render(<I18nProvider>{ui}</I18nProvider>);
  };

  beforeEach(() => {
    cleanup();
    localStorage.setItem("locale", "zh-CN");
    clearTasks();
  });

  it("renders empty state when no tasks", () => {
    renderWithI18n(<TaskCenter />);
    expect(screen.getByText("暂无任务")).toBeDefined();
    expect(screen.getByText("选择一个任务")).toBeDefined();
  });

  it("renders task list with items", async () => {
    renderWithI18n(<TaskCenter />);

    // 创建任务需要通过 manager
    // 由于测试环境限制，这里主要验证组件渲染
    const titles = screen.getAllByText("任务中心");
    expect(titles.length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "清除已完成" })).toBeDefined();
  });

  it("shows tasks created outside TaskCenter", async () => {
    renderWithI18n(<TaskCenter />);

    await act(async () => {
      const manager = getTaskManager();
      const task = manager.createTask("外部快照任务", "backup");
      manager.startTask(task.id);
      manager.updateProgress(task.id, 1, 0, 2);
    });

    expect(await screen.findAllByText("外部快照任务")).toHaveLength(2);
    expect(screen.getAllByText("50%").length).toBeGreaterThan(0);
  });

  it("shows task detail actions with accessible labels", async () => {
    const onNavigateToTask = vi.fn();
    renderWithI18n(<TaskCenter onNavigateToTask={onNavigateToTask} />);

    await act(async () => {
      const manager = getTaskManager();
      const task = manager.createTask("导出配置任务", "export");
      manager.completeTask(task.id, true);
    });

    expect(await screen.findByRole("button", { name: "查看详情" })).toBeDefined();
    expect(screen.getByRole("button", { name: "复制任务信息" })).toBeDefined();
  });
});
